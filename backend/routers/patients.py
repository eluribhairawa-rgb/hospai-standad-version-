import csv
import io
import os
from datetime import datetime

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id, get_current_user
from access_scope import patient_scope, filter_rows
from common import rows_to_dicts, row_to_dict, validate_required_fields, log_audit_event, client_ip, normalize_payment_mode
import legacy_queries as lq
import legacy_sql
import patient_journey
import discharge_summary
from storage import ObjectStorage
from ocr import extract_text_from_image
from export_utils import generate_pdf, generate_word

router = APIRouter(prefix="/api", tags=["patients"])
STORAGE = ObjectStorage()

def _normalize_phone_for_country(value, country_code=None, required=False, field_label="Mobile number"):
    """(digits, error) for a phone checked against its country's length (rules in phone.py)."""
    from phone import validate_phone
    digits, _code, error = validate_phone(value, country_code, required=required, label=field_label)
    return digits, error


def _primary_country_code(payload):
    """The dialling code the primary mobile was validated against (unknown codes fall back to +91)."""
    from phone import clean_country_code
    return clean_country_code(payload.get("phone_country_code") or payload.get("primary_country_code"))


def _secondary_country_codes(payload):
    """Dialling codes for the alternate (family) and emergency mobiles, normalised."""
    from phone import clean_country_code
    return clean_country_code(payload.get("family_country_code")), clean_country_code(payload.get("emergency_country_code"))


def _validate_patient_registration_payload(payload, is_update=False):
    errors = {}
    first_name = str(payload.get("name") or "").strip()
    age = str(payload.get("age") or "").strip()
    phone_country_code = str(payload.get("phone_country_code") or payload.get("primary_country_code") or "+91").strip() or "+91"
    family_country_code = str(payload.get("family_country_code") or "+91").strip() or "+91"
    emergency_country_code = str(payload.get("emergency_country_code") or "+91").strip() or "+91"
    phone, phone_error = _normalize_phone_for_country(payload.get("phone"), phone_country_code, required=True, field_label="Primary mobile")
    family_mobile, family_mobile_error = _normalize_phone_for_country(payload.get("family_mobile"), family_country_code, required=False, field_label="Alternate mobile")
    emergency_mobile, emergency_mobile_error = _normalize_phone_for_country(payload.get("emergency_mobile"), emergency_country_code, required=False, field_label="Emergency mobile")

    address = str(payload.get("address") or "").strip()
    dob = str(payload.get("dob") or "").strip()

    if not first_name:
        errors["name"] = "First name is required."
    if dob:
        parts = dob.split("-")
        if len(parts) != 3 or len(parts[0]) != 4:
            errors["dob"] = "Date of Birth must have a 4-digit year (YYYY-MM-DD)."
        else:
            try:
                from datetime import date
                d_year = int(parts[0])
                d_month = int(parts[1])
                d_day = int(parts[2])
                b_date = date(d_year, d_month, d_day)
                if b_date > date.today():
                    errors["dob"] = "Date of Birth cannot be in the future."
                elif d_year < 1900:
                    errors["dob"] = "Date of Birth cannot be earlier than 1900."
            except Exception:
                errors["dob"] = "Invalid Date of Birth."
    if age:
        try:
            age_value = int(float(age))
            if age_value < 0 or age_value > 150:
                errors["age"] = "Age must be between 0 and 150."
        except (TypeError, ValueError):
            errors["age"] = "Age must be a valid number."
    if phone_error:
        errors["phone"] = phone_error
    if family_mobile_error:
        errors["family_mobile"] = family_mobile_error
    if emergency_mobile_error:
        errors["emergency_mobile"] = emergency_mobile_error
    return errors, phone, family_mobile, emergency_mobile


def _get_patient_or_404(db, patient_id, hospital_id):
    patient = lq.get_patient(db, patient_id, hospital_id=hospital_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    return patient


@router.get("/patients")
def patients_list(q: str | None = None, visit_status: str | None = None, db: Session = Depends(get_db),
                   user: dict = Depends(require_permissions("patients.read")), hospital_id: int = Depends(current_hospital_id),
                   scope: set | None = Depends(patient_scope)):
    query = (q or "").strip()
    vs = (visit_status or "").strip().lower()
    patients = lq.search_patients(db, query, hospital_id=hospital_id, visit_status=vs) if query else lq.get_all_patients(db, hospital_id=hospital_id, visit_status=vs)
    return {"patients": rows_to_dicts(filter_rows(patients, scope))}


@router.get("/insurance-providers")
def insurance_providers_list(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    return {"providers": rows_to_dicts(lq.list_insurance_providers(db))}


@router.post("/insurance-providers")
def insurance_providers_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["name"])
    try:
        from phone import validate_phone
        contact_digits, contact_code, contact_error = validate_phone(
            payload.get("contact_phone"), payload.get("contact_phone_country_code"), label="Contact phone")
        if contact_error:
            raise HTTPException(status_code=400, detail=contact_error)
        provider = lq.create_insurance_provider(
            db, payload.get("name"),
            contact_person=payload.get("contact_person"),
            contact_phone=contact_digits or None,
            contact_phone_country_code=contact_code,
            notes=payload.get("notes"),
            username=user.get("username"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "insurance_providers", str(provider["id"]), {"name": provider["name"]})
    return {"provider": row_to_dict(provider)}


@router.get("/patients/next-id")
def patients_next_id(db: Session = Depends(get_db), user: dict = Depends(get_current_user),
                      hospital_id: int = Depends(current_hospital_id)):
    return {"patient_id": lq.generate_patient_id(db, hospital_id=hospital_id)}


@router.post("/patients")
def patients_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    validation_errors, normalized_phone, normalized_family_mobile, normalized_emergency_mobile = _validate_patient_registration_payload(payload)
    if validation_errors:
        raise HTTPException(status_code=400, detail={"error": "Patient registration validation failed.", "fields": validation_errors})

    duplicate = lq.check_duplicate_patient(db, payload.get("name"), payload.get("last_name"), payload.get("dob"),
                                            payload.get("gender"), normalized_phone, hospital_id=hospital_id)
    if duplicate:
        raise HTTPException(status_code=409, detail={
            "error": f"Patient already exists with UHID: {duplicate['patient_id']}.",
            "duplicate": row_to_dict(duplicate),
        })

    patient_id = lq.generate_patient_id(db, hospital_id=hospital_id)

    allergy_text = str(payload.get("allergies") or "").strip()
    no_known_allergies = bool(payload.get("no_known_allergies"))
    allergy_status = "has_allergies" if allergy_text else ("confirmed_none" if no_known_allergies else "not_recorded")

    data = {
        "patient_id": patient_id,
        "name": str(payload.get("name") or "").strip(),
        "middle_name": str(payload.get("middle_name") or "").strip() or None,
        "last_name": str(payload.get("last_name") or "").strip(),
        "dob": payload.get("dob") if payload.get("dob") else None,
        "age": int(float(payload.get("age"))) if payload.get("age") else None,
        "weight": float(payload.get("weight")) if payload.get("weight") else None,
        "height": float(payload.get("height")) if payload.get("height") else None,
        "gender": str(payload.get("gender") or "").strip() if payload.get("gender") else None,
        "pregnant": 1 if (str(payload.get("gender") or "").strip().lower() == "female" and payload.get("pregnant")) else 0,
        "allergies": allergy_text or None,
        "allergy_status": allergy_status,
        "symptoms": payload.get("symptoms") if payload.get("symptoms") else None,
        "phone": normalized_phone,
        "phone_country_code": _primary_country_code(payload),
        "address": str(payload.get("address") or "").strip() if payload.get("address") else None,
        "emergency_contact": str(payload.get("emergency_contact") or "").strip() if payload.get("emergency_contact") else None,
        "emergency_relation": str(payload.get("emergency_relation") or "").strip() if payload.get("emergency_relation") else None,
        "family_mobile": normalized_family_mobile or None,
        "family_country_code": _secondary_country_codes(payload)[0] if normalized_family_mobile else None,
        "emergency_country_code": _secondary_country_codes(payload)[1] if normalized_emergency_mobile else None,
        "marital_status": str(payload.get("marital_status") or "").strip() or None,
        "nationality": str(payload.get("nationality") or "").strip() or None,
        "email": str(payload.get("email") or "").strip() or None,
        "emergency_mobile": normalized_emergency_mobile or None,
        "insurance_provider": str(payload.get("insurance_provider") or "").strip() or None,
        "insurance_policy_no": str(payload.get("insurance_policy_no") or "").strip() or None,
    }
    lq.add_patient(db, data, hospital_id=hospital_id)
    visit_type = str(payload.get("visit_type") or "OP").strip().upper()
    admission_id = lq.add_admission(db, patient_id, "Inpatient registration", hospital_id=hospital_id) if visit_type == "IP" else None
    
    encounter_id = None
    if visit_type == "EMERGENCY":
        encounter_id, _ = lq.create_encounter(db, {
            "patient_id": patient_id,
            "encounter_type": "EMERGENCY",
            "created_by": user.get("username"),
            "status": "active"
        })
        
    log_audit_event(db, user, client_ip(request), "create", "patients", patient_id, {"admission_id": admission_id})
    return {"status": "ok", "patient_id": patient_id, "admission_id": admission_id, "encounter_id": encounter_id}


@router.get("/patients/{patient_id}/last-consultation")
def get_patient_last_consultation(patient_id: str, db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("patients.read")), hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    appointments = lq.list_appointments(db, patient_id=patient_id)
    completed = [a for a in appointments if str(a["status"] or "").strip().lower() in ("completed", "finished", "consulted", "done")]
    if not completed:
        return None
    return row_to_dict(completed[-1])


@router.get("/patients/{patient_id}/active-admission")
def patient_active_admission(patient_id: str, db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("patients.read")), hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    import legacy_sql
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id as admission_id, a.admission_date, a.notes,
                   b.id as allocation_id, b.ward, b.room_no, b.bed_no,
                   COALESCE(b.amount_per_day, b.daily_charge, 0) as amount_per_day,
                   b.allocated_at, b.status as bed_status, b.assigned_doctor
            FROM admissions a
            LEFT JOIN bed_allocations b ON (b.admission_id = a.id OR b.patient_id = a.patient_id) AND b.status = 'active'
            WHERE a.patient_id = ? AND a.discharge_date IS NULL AND COALESCE(a.notes, '') != 'Initial registration'
            ORDER BY a.admission_date DESC LIMIT 1
            """,
            (patient_id,),
        )
        row = cursor.fetchone()
        if row:
            return {
                "is_inpatient": True, "admission_id": row["admission_id"], "allocation_id": row["allocation_id"],
                "ward": row["ward"] or "General", "room_no": row["room_no"] or "", "bed_no": row["bed_no"] or "Pending Allotment",
                "amount_per_day": float(row["amount_per_day"] or 0),
                "allocated_at": str(row["allocated_at"]) if row["allocated_at"] else None,
                "admission_date": str(row["admission_date"]) if row["admission_date"] else None,
                "assigned_doctor": row["assigned_doctor"],
            }
        return {"is_inpatient": False}


@router.post("/patients/{patient_id}/verify-insurance")
def patients_verify_insurance(patient_id: str, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.dispense")), hospital_id: int = Depends(current_hospital_id)):
    """Records that a staff member has checked this patient's insurance is
    active and covers the treatment -- same manual eligibility check any
    real pharmacy does (phone/portal with the TPA or insurer) before billing
    them. There is no live insurer API to call, so this is the honest
    record of that human verification step, not an automated pass/fail."""
    patient = lq.get_patient(db, patient_id, hospital_id=hospital_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    if not patient["insurance_provider"] or not patient["insurance_policy_no"]:
        raise HTTPException(status_code=400, detail="This patient has no insurance provider/policy number on record. Update their registration first.")
    payload = payload or {}
    reference = str(payload.get("reference") or "").strip() or None
    username = user.get("username")
    import legacy_sql
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE patients
            SET insurance_verified = TRUE, insurance_verified_by = ?, insurance_verified_at = CURRENT_TIMESTAMP, insurance_verification_ref = ?
            WHERE patient_id = ? AND hospital_id = ?
            """,
            (username, reference, patient_id, hospital_id),
        )
        conn.commit()
    log_audit_event(db, user, client_ip(request), "verify", "patients", patient_id, {"insurance_provider": patient["insurance_provider"], "reference": reference})
    return {"status": "ok", "verified_by": username, "reference": reference}


@router.get("/patients/{patient_id}")
def patients_read(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                   hospital_id: int = Depends(current_hospital_id)):
    patient = lq.get_patient_details(db, patient_id, hospital_id=hospital_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    return {"patient": patient}


@router.get("/patients/{patient_id}/journey")
def patients_journey(patient_id: str, encounter_type: str | None = None, encounter_id: int | None = None,
                      db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    journey = patient_journey.get_patient_journey(db, patient_id, encounter_type, encounter_id)
    if journey is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return journey


def _discharge_records(db, patient_id, hospital_id, encounter_type, encounter_id):
    if not lq.get_patient_details(db, patient_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Patient not found")
    try:
        records = discharge_summary.gather_patient_records(db, patient_id, encounter_type, encounter_id)
    except discharge_summary.EncounterNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if records is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return records


def _summary_error(exc):
    if isinstance(exc, discharge_summary.ConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/patients/{patient_id}/discharge-summary")
def patients_discharge_summary_data(patient_id: str, encounter_type: str | None = None, encounter_id: int | None = None,
                                    db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                                    hospital_id: int = Depends(current_hospital_id)):
    records = _discharge_records(db, patient_id, hospital_id, encounter_type, encounter_id)
    enc = records.get("encounter")
    meds, source = discharge_summary.build_discharge_medications(records)
    saved = discharge_summary.get_summary_for_encounter(db, hospital_id, patient_id, enc["type"], enc["id"]) if enc else None
    return {"records": records, "saved": saved, "prescribed_medications": meds, "medication_source": source}


@router.post("/patients/{patient_id}/discharge-summary/generate")
def patients_discharge_summary_generate(patient_id: str, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                        user: dict = Depends(require_permissions("patients.read")),
                                        hospital_id: int = Depends(current_hospital_id)):
    records = _discharge_records(db, patient_id, hospital_id, payload.get("encounter_type"), payload.get("encounter_id"))
    enc = records.get("encounter")
    if not enc:
        raise HTTPException(status_code=400, detail="This patient has no OP, IP or emergency visit to summarise yet.")
    try:
        result = discharge_summary.generate_discharge_summary(records, discharge_summary.catalogue_drug_words(db))
    except RuntimeError as exc:
        log_audit_event(db, user, client_ip(request), "ai_generate_failed", "discharge_summaries", f"{patient_id}:{enc['type']}:{enc['id']}", {"error": str(exc)[:300]})
        raise HTTPException(status_code=502, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "ai_generate", "discharge_summaries", f"{patient_id}:{enc['type']}:{enc['id']}",
                    {"model": result.get("model"), "removed_sentences": len(result.get("warnings") or [])})
    saved = discharge_summary.get_summary_for_encounter(db, hospital_id, patient_id, enc["type"], enc["id"])
    return {"records": records, **result, "saved": saved}


@router.put("/patients/{patient_id}/discharge-summary")
def patients_discharge_summary_save(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("patients.write")),
                                    hospital_id: int = Depends(current_hospital_id)):
    validate_required_fields(payload, ["encounter_type", "encounter_id", "content"])
    records = _discharge_records(db, patient_id, hospital_id, payload.get("encounter_type"), payload.get("encounter_id"))
    try:
        saved = discharge_summary.save_draft(db, hospital_id, patient_id, records["encounter"], payload, user.get("username"))
    except (ValueError, PermissionError, discharge_summary.ConflictError) as exc:
        db.rollback()
        raise _summary_error(exc)
    log_audit_event(db, user, client_ip(request), "save_draft", "discharge_summaries", str(saved["id"]),
                    {"version": saved["current_version"], "patient_id": patient_id, "encounter": f"{records['encounter']['type']}:{records['encounter']['id']}"})
    return {"summary": saved}


@router.get("/patients/{patient_id}/discharge-summaries")
def patients_discharge_summaries_list(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                                      hospital_id: int = Depends(current_hospital_id)):
    if not lq.get_patient_details(db, patient_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Patient not found")
    return {"summaries": discharge_summary.list_summaries(db, hospital_id, patient_id)}


@router.get("/discharge-summaries/{summary_id}")
def discharge_summary_read(summary_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                           hospital_id: int = Depends(current_hospital_id)):
    summary = discharge_summary.get_summary(db, hospital_id, summary_id)
    if not summary:
        raise HTTPException(status_code=404, detail="Discharge summary not found")
    return {"summary": summary}


@router.get("/discharge-summaries/{summary_id}/versions/{version}")
def discharge_summary_version_read(summary_id: int, version: int, db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("patients.read")), hospital_id: int = Depends(current_hospital_id)):
    row = discharge_summary.get_summary_version(db, hospital_id, summary_id, version)
    if not row:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"version": row}


# submit: any clinical staff; approve / return / finalize / amend: doctors (clinical.author)
_SUMMARY_ACTION_PERMISSION = {"submit": "patients.write", "approve": "clinical.author", "return": "clinical.author",
                              "finalize": "clinical.author", "amend": "clinical.author"}


@router.post("/discharge-summaries/{summary_id}/{action}")
def discharge_summary_action(summary_id: int, action: str, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("patients.read")), hospital_id: int = Depends(current_hospital_id)):
    import security
    permission = _SUMMARY_ACTION_PERMISSION.get(action)
    if not permission:
        raise HTTPException(status_code=404, detail="Unknown action")
    if permission not in security.resolve_user_permissions(user):
        raise HTTPException(status_code=403, detail={"error": "Forbidden", "required_permissions": [permission]})
    current = discharge_summary.get_summary(db, hospital_id, summary_id, include_versions=False)
    if not current:
        raise HTTPException(status_code=404, detail="Discharge summary not found")
    snapshot = None
    if action == "finalize":
        # Freeze exactly what the summary was written from.
        snapshot = _discharge_records(db, current["patient_id"], hospital_id, current["encounter_type"], current["encounter_id"])
    try:
        summary = discharge_summary.transition(db, hospital_id, summary_id, action, user.get("username"), note=payload.get("note"),
                                               expected_version=payload.get("expected_version"), records_snapshot=snapshot)
    except (ValueError, PermissionError, discharge_summary.ConflictError) as exc:
        db.rollback()
        raise _summary_error(exc)
    log_audit_event(db, user, client_ip(request), action, "discharge_summaries", str(summary_id),
                    {"version": summary["current_version"], "status": summary["status"], "note": payload.get("note")})
    return {"summary": summary}


@router.put("/patients/{patient_id}")
def patients_update(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    validation_errors, normalized_phone, normalized_family_mobile, normalized_emergency_mobile = _validate_patient_registration_payload(payload, is_update=True)
    if validation_errors:
        raise HTTPException(status_code=400, detail={"error": "Patient validation failed.", "fields": validation_errors})

    payload["phone"] = normalized_phone
    payload["phone_country_code"] = _primary_country_code(payload)
    family_code, emergency_code = _secondary_country_codes(payload)
    if normalized_family_mobile:
        payload["family_mobile"] = normalized_family_mobile
        payload["family_country_code"] = family_code
    if normalized_emergency_mobile:
        payload["emergency_mobile"] = normalized_emergency_mobile
        payload["emergency_country_code"] = emergency_code

    allergy_text = str(payload.get("allergies") or "").strip()
    no_known_allergies = bool(payload.get("no_known_allergies"))
    payload["allergy_status"] = "has_allergies" if allergy_text else ("confirmed_none" if no_known_allergies else "not_recorded")
    payload["allergies"] = allergy_text or None

    updated = lq.update_patient(db, patient_id, payload, hospital_id=hospital_id)
    if not updated:
        raise HTTPException(status_code=500, detail="Patient update failed")
    log_audit_event(db, user, client_ip(request), "update", "patients", patient_id, payload)
    return {"status": "ok"}


@router.delete("/patients/{patient_id}")
def patients_delete(patient_id: str, request: Request, db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    if not lq.delete_patient(db, patient_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Patient not found")
    log_audit_event(db, user, client_ip(request), "delete", "patients", patient_id)
    return {"status": "ok"}


@router.get("/patients/{patient_id}/admissions")
def admissions_list(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                     hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    return {"admissions": rows_to_dicts(lq.get_admissions(db, patient_id, hospital_id=hospital_id))}


@router.put("/admissions/{admission_id}/payer")
def admission_payer_update(admission_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    try:
        payer = lq.normalize_admission_payer(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT patient_id, discharge_date FROM admissions WHERE id = ? AND hospital_id = ?", (admission_id, hospital_id))
        adm = cursor.fetchone()
        if not adm:
            raise HTTPException(status_code=404, detail="Admission not found")
        if adm["discharge_date"]:
            raise HTTPException(status_code=409, detail="This admission is already discharged; its payer can no longer be changed.")
        lq.set_admission_payer(cursor, admission_id, payer, adm["patient_id"])
        conn.commit()
    log_audit_event(db, user, client_ip(request), "update", "admissions", str(admission_id),
                    {"payer_type": payer["payer_type"], "insurance_provider": payer["insurance_provider"]})
    return {"status": "ok", **payer}


@router.post("/patients/{patient_id}/admissions")
def admissions_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    notes = payload.get("notes", "")
    from routers.clinical import _validate_vitals_in_notes
    vitals_err = _validate_vitals_in_notes(notes)
    if vitals_err:
        raise HTTPException(status_code=400, detail=vitals_err)

    try:
        payer = lq.normalize_admission_payer(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        admission_id = lq.add_admission(db, patient_id, notes, hospital_id=hospital_id, payer=payer)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "admissions", str(admission_id),
                    {"patient_id": patient_id, "payer_type": payer["payer_type"], "insurance_provider": payer["insurance_provider"]})

    review_fee = payload.get("review_fee")
    if review_fee:
        try:
            review_fee_val = float(review_fee)
            if review_fee_val > 0:
                payment_mode = normalize_payment_mode(payload.get("payment_mode"))
                invoice_no = f"INV-OP-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
                invoice_id = lq.create_invoice(db, {
                    "invoice_no": invoice_no, "patient_id": patient_id, "module": "OP",
                    "doctor_name": payload.get("doctor_name"), "total_amount": review_fee_val, "paid_amount": 0,
                    "advance_amount": 0, "refunded_amount": 0, "payment_status": "due", "created_by": user.get("username"),
                })
                lq.record_invoice_payment(db, invoice_id, {"amount": review_fee_val, "payment_mode": payment_mode})
        except (ValueError, TypeError):
            pass
    return {"admission_id": admission_id}


@router.get("/patients/{patient_id}/documents")
def documents_list(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                    hospital_id: int = Depends(current_hospital_id)):
    _get_patient_or_404(db, patient_id, hospital_id)
    return {"documents": rows_to_dicts(lq.get_documents(db, patient_id, hospital_id=hospital_id))}


@router.post("/patients/{patient_id}/documents")
def documents_create(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.write")),
                      hospital_id: int = Depends(current_hospital_id), file: UploadFile = File(...),
                      doc_type: str = Form("document"), admission_id: str | None = Form(None),
                      ocr_text: str = Form(""), ocr_language: str = Form("en")):
    _get_patient_or_404(db, patient_id, hospital_id)
    file_bytes = file.file.read()
    if len(file_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File is too large (max 10MB).")
    filepath = STORAGE.store(doc_type, file.filename or "document", file_bytes, file.content_type)
    document_id = lq.add_document(
        db, patient_id, int(admission_id) if admission_id else None, doc_type, filepath, ocr_text, ocr_language,
        file_name=file.filename, mime_type=file.content_type, file_data=None, hospital_id=hospital_id,
    )
    return {"document_id": document_id, "file_path": filepath, "stored_in_db": False}


@router.get("/documents/{document_id}/file")
def document_file(document_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                   hospital_id: int = Depends(current_hospital_id)):
    document = lq.get_document(db, document_id, hospital_id=hospital_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    mime_type = document["mime_type"] or "application/octet-stream"
    file_name = document["file_name"] or os.path.basename(document["file_path"] or "") or "document.bin"

    file_data = document["file_data"]
    if file_data:
        return StreamingResponse(io.BytesIO(file_data), media_type=mime_type, headers={"Content-Disposition": f'inline; filename="{file_name}"'})
    file_bytes = STORAGE.read(document["file_path"])
    if file_bytes:
        return StreamingResponse(io.BytesIO(file_bytes), media_type=mime_type, headers={"Content-Disposition": f'inline; filename="{file_name}"'})
    raise HTTPException(status_code=404, detail="Document file content unavailable")


@router.delete("/documents/{document_id}")
def document_delete(document_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.write")),
                     hospital_id: int = Depends(current_hospital_id)):
    document = lq.get_document(db, document_id, hospital_id=hospital_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if not lq.delete_document(db, document_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Document not found")
    STORAGE.delete(document["file_path"])
    return {"status": "ok"}


@router.post("/documents/{document_id}/ocr")
def document_process_ocr(document_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    document = lq.get_document(db, document_id, hospital_id=hospital_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    payload = payload if isinstance(payload, dict) else {}
    requested_language = payload.get("language") or document["ocr_language"] or "en"
    file_name = document["file_name"] or os.path.basename(document["file_path"] or "") or "document"

    file_bytes = document["file_data"]
    if not file_bytes:
        file_path = document["file_path"]
        if not file_path:
            raise HTTPException(status_code=404, detail="Document file content unavailable")
        file_bytes = STORAGE.read(file_path)
        if not file_bytes:
            raise HTTPException(status_code=404, detail="Document file content unavailable")

    ocr_text = extract_text_from_image(file_bytes, requested_language, document["doc_type"], filename=file_name)
    if isinstance(ocr_text, str) and ocr_text.startswith("OCR Error:"):
        raise HTTPException(status_code=400, detail=ocr_text)

    if not lq.update_document_ocr(db, document_id, ocr_text, requested_language, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"document_id": document_id, "ocr_text": ocr_text, "ocr_language": requested_language, "updated": True}


@router.post("/ocr")
def ocr_extract(user: dict = Depends(require_permissions("patients.write")), file: UploadFile = File(...),
                 language: str = Form("en"), doc_type: str = Form("document")):
    content = file.file.read()
    text = extract_text_from_image(content, language, doc_type, filename=file.filename)
    return {"text": text}


@router.post("/export/pdf")
def export_pdf(payload: dict = Body(...), user: dict = Depends(require_permissions("patients.read"))):
    pdf_bytes = generate_pdf(payload.get("patient_name", ""), payload.get("doc_type", "document"), payload.get("ocr_text", ""), payload.get("date"), hospital_id=user.get("hospital_id"))
    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="document.pdf"'})


@router.post("/export/word")
def export_word(payload: dict = Body(...), user: dict = Depends(require_permissions("patients.read"))):
    word_bytes = generate_word(payload.get("patient_name", ""), payload.get("doc_type", "document"), payload.get("ocr_text", ""), payload.get("date"), hospital_id=user.get("hospital_id"))
    return StreamingResponse(io.BytesIO(word_bytes), media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                              headers={"Content-Disposition": 'attachment; filename="document.docx"'})


@router.get("/export/patients/csv")
def export_patients_csv(q: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                         hospital_id: int = Depends(current_hospital_id), scope: set | None = Depends(patient_scope)):
    query = (q or "").strip()
    patients = lq.search_patients(db, query, hospital_id=hospital_id) if query else lq.get_all_patients(db, hospital_id=hospital_id)
    patients = filter_rows(patients, scope)

    csv_stream = io.StringIO()
    writer = csv.writer(csv_stream)
    headers = ["patient_id", "name", "middle_name", "last_name", "dob", "age", "weight", "height", "gender",
               "pregnant", "allergies", "symptoms", "phone", "created_at", "updated_at"]
    writer.writerow(headers)
    for row in patients:
        item = row_to_dict(row)
        row_values = []
        for header in headers:
            val = item.get(header)
            if header == "pregnant":
                val = "" if str(item.get("gender") or "").strip().lower() != "female" else ("Yes" if val else "No")
            row_values.append(val if val is not None else "")
        writer.writerow(row_values)

    filename_suffix = datetime.now().strftime("%Y%m%d_%H%M%S")
    return StreamingResponse(io.BytesIO(csv_stream.getvalue().encode("utf-8-sig")), media_type="text/csv",
                              headers={"Content-Disposition": f'attachment; filename="patients_{filename_suffix}.csv"'})
