"""Analysis page drill-down: the records behind a number or chart segment.

Every figure on the Analysis page opens a table of the records it was counted from. Revenue and payment-mode
figures reuse the dashboard's own detail endpoints (revenue_details), so they add up exactly; the kinds below cover the
rest (registrations, gender, admissions, wards, beds, referrals, OP/IP volume, queue, billing, doctor payouts)."""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from deps import current_hospital_id, require_hospital_overview
import legacy_sql
import patient_journey

router = APIRouter(prefix="/api", tags=["analysis"])

LIMIT = 500


def _day(value):
    v = str(value or "").strip()[:10]
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="A valid date (YYYY-MM-DD) is required.")
    return v


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat(sep=" ", timespec="minutes")
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _name(alias="p"):
    return f"TRIM(COALESCE({alias}.name, '') || ' ' || COALESCE({alias}.middle_name, '') || ' ' || COALESCE({alias}.last_name, ''))"


def _result(title, columns, rows, note=None):
    return {"title": title, "columns": columns, "rows": [[_fmt(c) for c in r] for r in rows], "count": len(rows), "note": note}


def _fetch(cursor, sql, params=()):
    cursor.execute(sql, tuple(params))
    return [list(r) for r in cursor.fetchall()]


def _admission_rows(cursor, where, params):
    cursor.execute(
        f"""
        SELECT a.id, a.patient_id, {_name()}, a.admission_date, a.discharge_date, ba.ward, ba.bed_no, ba.assigned_doctor, a.notes
        FROM admissions a JOIN patients p ON p.patient_id = a.patient_id
        LEFT JOIN LATERAL (SELECT ward, bed_no, assigned_doctor FROM bed_allocations WHERE admission_id = a.id
                           ORDER BY (status = 'active') DESC, allocated_at DESC LIMIT 1) ba ON TRUE
        WHERE COALESCE(a.notes, '') != 'Initial registration' AND {where}
        ORDER BY a.admission_date DESC LIMIT {LIMIT}
        """, params)
    out = []
    for r in cursor.fetchall():
        doctor = (r[7] or patient_journey.parse_admission_notes(r[8]).get("consulting_doctor") or "")
        out.append([f"ADM-{r[0]}", r[1], r[2], r[3], r[4] or "Admitted", " / ".join(x for x in (r[5], r[6]) if x), doctor])
    return out


ADMISSION_COLUMNS = ["Admission", "UHID", "Patient", "Admitted", "Discharged", "Ward / Bed", "Doctor"]


@router.get("/analysis/drilldown")
def analysis_drilldown(kind: str, key: str = "", date: str | None = None, db: Session = Depends(get_db),
                       user: dict = Depends(require_hospital_overview("patients.read")),
                       hospital_id: int = Depends(current_hospital_id)):
    day = _day(date or datetime.now().strftime("%Y-%m-%d"))
    month = day[:7]
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        if kind == "registrations":
            d = _day(key)
            rows = _fetch(cursor, f"""SELECT p.patient_id, {_name()}, p.age, p.gender, p.phone, p.created_at FROM patients p
                                      WHERE p.hospital_id = ? AND DATE(p.created_at) = ? ORDER BY p.created_at DESC LIMIT {LIMIT}""", (hospital_id, d))
            return _result(f"Patients registered on {d}", ["UHID", "Patient", "Age", "Gender", "Phone", "Registered"], rows)

        if kind == "gender":
            value = key.strip().lower()
            if value not in ("male", "female"):
                raise HTTPException(status_code=400, detail="Unknown gender.")
            rows = _fetch(cursor, f"""SELECT p.patient_id, {_name()}, p.age, p.phone, p.created_at FROM patients p
                                      WHERE p.hospital_id = ? AND LOWER(TRIM(p.gender)) = ? ORDER BY p.created_at DESC LIMIT {LIMIT}""", (hospital_id, value))
            return _result(f"{value.title()} patients", ["UHID", "Patient", "Age", "Phone", "Registered"], rows)

        if kind == "admissions":
            status = key.strip().lower()
            if status not in ("active", "discharged"):
                raise HTTPException(status_code=400, detail="Unknown admission status.")
            where = "a.hospital_id = ? AND a.discharge_date " + ("IS NULL" if status == "active" else "IS NOT NULL")
            return _result(f"{status.title()} admissions", ADMISSION_COLUMNS, _admission_rows(cursor, where, (hospital_id,)))

        if kind in ("ward", "beds"):
            ward_clause, params = ("", (hospital_id,)) if kind == "beds" else ("AND LOWER(b.ward) = ?", (hospital_id, key.strip().lower()))
            rows = _fetch(cursor, f"""
                SELECT b.ward, b.room_no, b.bed_no, p.patient_id, {_name()}, b.allocated_at, b.assigned_doctor, b.amount_per_day
                FROM bed_allocations b JOIN patients p ON p.patient_id = b.patient_id JOIN admissions a ON a.id = b.admission_id
                WHERE b.status = 'active' AND a.hospital_id = ? {ward_clause} ORDER BY b.ward, b.bed_no""", params)
            title = "Occupied beds" if kind == "beds" else f"Occupied beds in {key}"
            return _result(title, ["Ward", "Room", "Bed", "UHID", "Patient", "Since", "Doctor", "Rate / day"], rows)

        if kind == "referral":
            source = key.strip().lower()
            rows = _fetch(cursor, f"""
                SELECT e.id, e.patient_id, {_name()}, e.arrival_at, COALESCE(NULLIF(TRIM(e.referral_source), ''), 'unknown'), e.chief_complaint, e.attending_doctor
                FROM encounters e LEFT JOIN patients p ON p.patient_id = e.patient_id
                WHERE to_char(e.arrival_at, 'YYYY-MM') = ? AND LOWER(COALESCE(NULLIF(TRIM(e.referral_source), ''), 'unknown')) = ?
                ORDER BY e.arrival_at DESC LIMIT {LIMIT}""", (month, source))
            return _result(f"Referrals from {key} ({month})", ["Encounter", "UHID", "Patient", "Arrived", "Source", "Complaint", "Doctor"], rows)

        if kind == "ipop":
            which = key.strip().lower()
            if which in ("daily_op", "monthly_op"):
                clause, param = ("DATE(a.appointment_date) = ?", day) if which == "daily_op" else ("to_char(a.appointment_date, 'YYYY-MM') = ?", month)
                rows = _fetch(cursor, f"""SELECT a.token_no, a.patient_id, a.patient_name, a.doctor_name, a.department, a.appointment_date, a.status
                                          FROM appointments a WHERE UPPER(a.visit_type) = 'OP' AND {clause} ORDER BY a.appointment_date DESC LIMIT {LIMIT}""", (param,))
                return _result(("OP visits on " + day) if which == "daily_op" else f"OP visits in {month}",
                               ["Token", "UHID", "Patient", "Doctor", "Department", "Appointment", "Status"], rows)
            if which in ("daily_ip", "monthly_ip"):
                clause, param = ("DATE(a.admission_date) = ?", day) if which == "daily_ip" else ("to_char(a.admission_date, 'YYYY-MM') = ?", month)
                return _result(("IP admissions on " + day) if which == "daily_ip" else f"IP admissions in {month}",
                               ADMISSION_COLUMNS, _admission_rows(cursor, clause, (param,)))
            raise HTTPException(status_code=400, detail="Unknown OP/IP figure.")

        if kind == "ops":
            which = key.strip().lower()
            if which == "queue":
                rows = _fetch(cursor, f"""SELECT a.token_no, a.patient_id, a.patient_name, a.doctor_name, a.department, a.appointment_date, a.status
                                          FROM appointments a WHERE DATE(COALESCE(a.appointment_date, a.created_at)) = ?
                                          ORDER BY a.appointment_date DESC LIMIT {LIMIT}""", (day,))
                return _result(f"Consultations on {day}", ["Token", "UHID", "Patient", "Doctor", "Department", "Appointment", "Status"], rows,
                               note="Completed = consultation finished; every other status is still pending.")
            if which == "billing":
                rows = _fetch(cursor, f"""SELECT i.invoice_no, i.patient_id, {_name()}, i.module, i.total_amount, i.paid_amount, i.due_amount, i.payment_status, i.created_at
                                          FROM invoices i LEFT JOIN patients p ON p.patient_id = i.patient_id
                                          WHERE DATE(i.created_at) = ? ORDER BY i.created_at DESC LIMIT {LIMIT}""", (day,))
                return _result(f"Invoices raised on {day}", ["Invoice", "UHID", "Patient", "Module", "Total", "Paid", "Due", "Status", "Created"], rows)
            if which == "payout":
                rows = _fetch(cursor, f"""SELECT d.id, d.payout_month, d.doctor_name, d.amount, d.paid_amount, d.due_amount, d.status, d.created_at
                                          FROM doctor_payouts d
                                          WHERE DATE(d.created_at) = ? OR d.payout_month = ? ORDER BY d.created_at DESC LIMIT {LIMIT}""", (day, month))
                return _result(f"Doctor payouts ({month})", ["#", "Month", "Doctor", "Amount", "Paid", "Due", "Status", "Created"], rows)
            raise HTTPException(status_code=400, detail="Unknown operations figure.")

    raise HTTPException(status_code=400, detail="Unknown drill-down.")
