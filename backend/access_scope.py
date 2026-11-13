"""Employee-wise data scoping.

An employee whose job title is Doctor and who is linked to a doctor profile
(users.doctor_name -> the name used in doctor_schedules / appointments) only sees
patients that doctor is responsible for.

A patient "belongs" to a doctor when any clinical record names that doctor:
OP appointments, prescriptions, IP bed allocations, ER encounters, OT surgeries,
diagnostic orders / lab requests, or ward rounds. The set is computed by one
PostgreSQL query per request and cached on request.state.

Enforcement has two parts:
  * patient_access_guard -- attached to every API router in main.py. Any request
    that names a patient directly (patient_id) or indirectly (admission_id,
    order_id, document_id, ...) in its path or query string is refused with 404
    when the patient is outside the doctor's set. This is what blocks direct API
    calls, for reads and writes alike.
  * patient_scope / filter_rows -- list endpoints drop rows outside the set.

Admins, super admins and every non-doctor employee are unrestricted here; their
access stays governed by module permissions as before.
"""
from typing import Iterable, Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

import security
from database import get_db
from deps import get_current_user_optional

# Every table that ties a patient to a named doctor. Comparison is trimmed and case-insensitive.
_DOCTOR_PATIENTS_SQL = text("""
    SELECT patient_id FROM appointments    WHERE LOWER(TRIM(doctor_name))         = :d
    UNION SELECT patient_id FROM prescriptions   WHERE LOWER(TRIM(doctor_name))         = :d
    UNION SELECT patient_id FROM bed_allocations WHERE LOWER(TRIM(assigned_doctor))     = :d
    UNION SELECT patient_id FROM encounters      WHERE LOWER(TRIM(attending_doctor))    = :d
    UNION SELECT patient_id FROM ot_surgeries    WHERE LOWER(TRIM(surgeon_name))        = :d
    UNION SELECT patient_id FROM diag_orders     WHERE LOWER(TRIM(referring_clinician)) = :d
    UNION SELECT patient_id FROM diagnostics     WHERE LOWER(TRIM(doctor_name))         = :d
    UNION SELECT patient_id FROM doctor_rounds   WHERE LOWER(TRIM(doctor_name))         = :d
    UNION SELECT patient_id FROM doctor_clinical_notes WHERE LOWER(TRIM(doctor_name))   = :d
    UNION SELECT patient_id FROM admissions      WHERE LOWER(TRIM(substring(notes from 'Consulting doctor: ([^|]*)'))) = :d
    UNION SELECT patient_id FROM doctor_patient_transfers WHERE LOWER(TRIM(to_doctor)) = :d OR LOWER(TRIM(from_doctor)) = :d
""")

# Path/query parameter -> SQL returning the patient that record belongs to.
_INT_RESOURCE_PATIENT_SQL = {
    "admission_id": "SELECT patient_id FROM admissions WHERE id = :v",
    "allocation_id": "SELECT patient_id FROM bed_allocations WHERE id = :v",
    "encounter_id": "SELECT patient_id FROM encounters WHERE id = :v",
    "surgery_id": "SELECT patient_id FROM ot_surgeries WHERE id = :v",
    "document_id": "SELECT patient_id FROM documents WHERE id = :v",
    "summary_id": "SELECT patient_id FROM discharge_summaries WHERE id = :v",
    "diagnostic_id": "SELECT patient_id FROM diagnostics WHERE id = :v",
    "certificate_id": "SELECT patient_id FROM certificates WHERE id = :v",
    "invoice_id": "SELECT patient_id FROM invoices WHERE id = :v",
    "emar_id": "SELECT patient_id FROM emar_records WHERE id = :v",
    "indent_id": "SELECT patient_id FROM ward_indents WHERE id = :v",
    "prescription_id": "SELECT patient_id FROM prescriptions WHERE id = :v",
}
# These names are reused by other modules (pharmacy items, stock items...), so only
# resolve them under the diagnostics API.
_DIAG_RESOURCE_PATIENT_SQL = {
    "order_id": "SELECT patient_id FROM diag_orders WHERE id = :v",
    "item_id": "SELECT o.patient_id FROM diag_order_items i JOIN diag_orders o ON o.id = i.order_id WHERE i.id = :v",
    "report_id": (
        "SELECT o.patient_id FROM diag_reports r JOIN diag_order_items i ON i.id = r.order_item_id "
        "JOIN diag_orders o ON o.id = i.order_id WHERE r.id = :v"
    ),
}

_NOT_FOUND = "Patient not found"


def doctor_patient_ids(db: Session, doctor_name: str) -> set[str]:
    key = (doctor_name or "").strip().lower()
    if not key:
        return set()
    rows = db.execute(_DOCTOR_PATIENTS_SQL, {"d": key}).fetchall()
    return {str(r[0]) for r in rows if r[0] is not None}


def allowed_patient_ids(request: Request, db: Session, user: Optional[dict]) -> Optional[set[str]]:
    """Patients this login may see, or None when the login is unrestricted."""
    doctor = security.scoped_doctor_name(user) if user else None
    if not doctor:
        return None
    cached = getattr(request.state, "allowed_patient_ids", None)
    if cached is None:
        cached = doctor_patient_ids(db, doctor)
        request.state.allowed_patient_ids = cached
    return cached


def patient_scope(request: Request, db: Session = Depends(get_db),
                  user: Optional[dict] = Depends(get_current_user_optional)) -> Optional[set[str]]:
    """Dependency for list endpoints: None = no restriction, else the allowed patient ids."""
    return allowed_patient_ids(request, db, user)


def _row_value(row, key):
    if isinstance(row, dict):
        return row.get(key)
    getter = getattr(row, "get", None)
    if callable(getter):
        return getter(key)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def filter_rows(rows: Iterable, allowed: Optional[set[str]], key: str = "patient_id") -> list:
    rows = list(rows or [])
    if allowed is None:
        return rows
    return [r for r in rows if str(_row_value(r, key) or "") in allowed]


def ensure_patient_allowed(allowed: Optional[set[str]], patient_id) -> None:
    if allowed is not None and patient_id not in (None, "") and str(patient_id) not in allowed:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)


def _lookup_patient(db: Session, sql: str, raw_value) -> tuple[bool, Optional[str]]:
    """(resolved, patient_id). resolved=False when the id is not an int or the record does not exist."""
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return False, None
    row = db.execute(text(sql), {"v": value}).fetchone()
    if not row:
        return False, None
    return True, (str(row[0]) if row[0] is not None else None)


def patient_access_guard(request: Request, db: Session = Depends(get_db),
                         user: Optional[dict] = Depends(get_current_user_optional)) -> None:
    """Router-level dependency that blocks a doctor login from any other doctor's patient."""
    doctor = security.scoped_doctor_name(user) if user else None
    if not doctor:
        return
    allowed = allowed_patient_ids(request, db, user)
    params = {**dict(request.query_params), **dict(request.path_params)}
    is_diag = request.url.path.startswith("/api/diag/")

    if params.get("patient_id"):
        ensure_patient_allowed(allowed, params["patient_id"])

    lookups = dict(_INT_RESOURCE_PATIENT_SQL)
    if is_diag:
        lookups.update(_DIAG_RESOURCE_PATIENT_SQL)
    for name, sql in lookups.items():
        if name not in params:
            continue
        resolved, patient_id = _lookup_patient(db, sql, params[name])
        if resolved:
            # A record with no patient attached is never shown to a scoped doctor.
            if patient_id is None:
                raise HTTPException(status_code=404, detail=_NOT_FOUND)
            ensure_patient_allowed(allowed, patient_id)

    # /admissions/{identifier}/summary-data accepts either an admission id or a patient id.
    if "identifier" in params:
        resolved, patient_id = _lookup_patient(db, _INT_RESOURCE_PATIENT_SQL["admission_id"], params["identifier"])
        ensure_patient_allowed(allowed, patient_id if resolved else params["identifier"])

    # Appointments belong to exactly one doctor: other doctors' appointments are off limits
    # even when the patient is shared.
    if "appointment_id" in request.path_params:
        try:
            appt_id = int(request.path_params["appointment_id"])
        except (TypeError, ValueError):
            return
        row = db.execute(text("SELECT doctor_name FROM appointments WHERE id = :v"), {"v": appt_id}).fetchone()
        if row and (row[0] or "").strip().lower() != doctor.strip().lower():
            raise HTTPException(status_code=404, detail="Appointment not found")
