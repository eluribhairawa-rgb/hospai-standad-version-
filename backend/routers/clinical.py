import logging
import re
from datetime import datetime

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, require_hospital_overview, current_hospital_id
from access_scope import patient_scope, ensure_patient_allowed
from common import rows_to_dicts, validate_required_fields, log_audit_event, client_ip, normalize_payment_mode, normalize_department_name
import legacy_queries as lq
import legacy_sql
import prescription_suggestions
import role_dashboard
import security
from qwen_ocr import extract_prescription_fields, prescription_identity_check

router = APIRouter(prefix="/api", tags=["clinical"])
logger = logging.getLogger(__name__)


def _validate_vitals_in_notes(notes):
    if not notes:
        return None
    m = re.search(r"Temp:\s*(.*?)(?=\s*\||$)", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+(\.\d+)?$", m.group(1).strip()):
        return "Temperature must contain only numeric values."
    m = re.search(r"Pulse:\s*(.*?)(?=\s*\||$)", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+$", m.group(1).strip()):
        return "Pulse must be a whole number."
    m = re.search(r"SPO2:\s*(.*?)(?=\s*\||$)", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+(\.\d+)?$", m.group(1).strip()):
        return "SpO2 must be a valid number."
    m = re.search(r"BP:\s*(.*?)(?=\s*\||$)", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+\s*/\s*\d+$", m.group(1).strip()):
        return "Blood Pressure must be in systolic/diastolic format with valid positive whole numbers."
    m = re.search(r"Weight:\s*(.*?)\s*kg", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+(\.\d+)?$", m.group(1).strip()):
        return "Weight must be a valid number."
    m = re.search(r"Height:\s*(.*?)\s*cm", notes, re.IGNORECASE)
    if m and not re.match(r"^\d+(\.\d+)?$", m.group(1).strip()):
        return "Height must be a valid number."
    return None


# ---------------------------------------------------------------- stats --

@router.get("/stats")
@router.get("/dashboard/stats")
def stats(date: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
          hospital_id: int = Depends(current_hospital_id)):
    return lq.get_patient_stats(db, hospital_id=hospital_id, selected_date=date)


@router.get("/dashboard/analytics")
def dashboard_analytics(request: Request, days: int = 14, date: str | None = None, db: Session = Depends(get_db),
                         user: dict = Depends(require_hospital_overview("patients.read")),
                         hospital_id: int = Depends(current_hospital_id)):
    permissions = security.resolve_user_permissions(user)
    include_employee = "admin.use" in permissions
    return lq.get_dashboard_analytics(db, days=days, include_employee=include_employee, hospital_id=hospital_id, selected_date=date)


@router.get("/dashboard/hospital-summary")
@router.get("/dashboard/summary")
@router.get("/hospital/summary")
def dashboard_hospital_summary(date: str | None = None, db: Session = Depends(get_db),
                                user: dict = Depends(require_hospital_overview("patients.read"))):
    return lq.get_hospital_dashboard_summary(db, selected_date=date)


@router.get("/dashboard/revenue-breakdown")
def dashboard_revenue_breakdown(date: str | None = None, period: str = "today", db: Session = Depends(get_db),
                                user: dict = Depends(require_hospital_overview("patients.read"))):
    """Revenue by module (OP, IP, Pharmacy, Lab) for the day or month to date; rows add up to the total."""
    import revenue_details
    try:
        return revenue_details.revenue_breakdown(db, date, period)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/dashboard/revenue-details")
def dashboard_revenue_details(category: str, date: str | None = None, period: str = "today", db: Session = Depends(get_db),
                              user: dict = Depends(require_hospital_overview("patients.read"))):
    """Patient-level payments / sales behind one revenue row (or the bills still due)."""
    import revenue_details
    try:
        return revenue_details.revenue_details(db, date, period, category)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/dashboard/payment-mode-details")
def dashboard_payment_mode_details(mode: str | None = None, date: str | None = None, period: str = "today", db: Session = Depends(get_db),
                                   user: dict = Depends(require_hospital_overview("patients.read"))):
    """Patient-level transactions behind a payment mode (Cash, Card, UPI, or all)."""
    import revenue_details
    try:
        return revenue_details.payment_mode_details(db, date, period, mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/dashboard/my")
def dashboard_my(date: str | None = None, db: Session = Depends(get_db),
                 user: dict = Depends(require_permissions("patients.read")),
                 hospital_id: int = Depends(current_hospital_id)):
    """Personal dashboard for non-admin employees (persona and scope are decided server-side).

    Admins / super admins get persona "admin" back and keep the executive dashboard.
    """
    return role_dashboard.build_role_dashboard(db, user, selected_date=date, hospital_id=hospital_id)


# ------------------------------------------------------------ appointments --

@router.get("/appointments")
def appointments_list(date: str | None = None, status: str | None = None, visit_type: str | None = None,
                       doctor_name: str | None = None, patient_id: str | None = None,
                       db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    # A doctor login only ever sees their own queue, whatever filter the client sends.
    doctor_name = security.scoped_doctor_name(user) or doctor_name
    rows = lq.list_appointments(db, appointment_date=date, status=status, visit_type=visit_type,
                                 doctor_name=doctor_name, patient_id=patient_id)
    return {"appointments": rows_to_dicts(rows)}


@router.get("/doctors-history")
def doctors_history_list(doctor_name: str | None = None, from_date: str | None = None, to_date: str | None = None,
                          department: str | None = None, db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("patients.read")),
                          hospital_id: int = Depends(current_hospital_id)):
    doctor_name = security.scoped_doctor_name(user) or doctor_name
    rows = lq.list_doctors_history(db, hospital_id=hospital_id, doctor_name=doctor_name, from_date=from_date, to_date=to_date, department=department)
    return {"history": rows_to_dicts(rows)}


def _registered_patient(db, patient_id, hospital_id):
    """The patient with exactly this UHID in the current hospital, or None."""
    row = db.execute(text(
        "SELECT patient_id, TRIM(COALESCE(name, '') || ' ' || COALESCE(last_name, '')) AS patient_name "
        "FROM patients WHERE patient_id = :pid AND hospital_id = :hid"),
        {"pid": patient_id, "hid": hospital_id}).fetchone()
    return dict(row._mapping) if row else None


@router.post("/appointments")
def appointments_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("patients.write")),
                         hospital_id: int = Depends(current_hospital_id)):
    validate_required_fields(payload, ["patient_name", "visit_type", "appointment_date"])
    own_doctor = security.scoped_doctor_name(user)
    if own_doctor:
        # A doctor login can only add patients to their own queue.
        payload["doctor_name"] = own_doctor
    vitals_err = _validate_vitals_in_notes(payload.get("notes"))
    if vitals_err:
        raise HTTPException(status_code=400, detail=vitals_err)

    # The UHID must belong to a registered patient; the registered name is what gets booked.
    patient_id = str(payload.get("patient_id") or "").strip()
    if patient_id:
        registered = _registered_patient(db, patient_id, hospital_id)
        if not registered:
            raise HTTPException(status_code=400, detail=f"UHID {patient_id} is not a registered patient. Register the patient first.")
        payload["patient_id"] = registered["patient_id"]
        payload["patient_name"] = registered["patient_name"] or payload.get("patient_name")

    # The fee always comes from the Doctor Scheduling master (op_fees.py); the amount sent is ignored.
    import op_fees
    try:
        consultation_fee, fee_kind = op_fees.resolve_consultation_fee(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    payload["consultation_fee"] = consultation_fee

    appointment_date_str = str(payload.get("appointment_date") or "")
    if appointment_date_str:
        try:
            app_date_str = appointment_date_str.split("T")[0].split(" ")[0]
            if app_date_str < datetime.now().strftime("%Y-%m-%d"):
                raise HTTPException(status_code=400, detail="Appointment date cannot be earlier than today's date.")
        except HTTPException:
            raise
        except Exception:
            pass
    try:
        appointment_id, token_no, invoice_id, payment_id = lq.create_op_appointment_with_invoice(
            db, payload, consultation_fee, user.get("username"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except IntegrityError as exc:
        db.rollback()
        if "idx_unique_active_appointment" in str(exc):
            # Two submissions for the same patient raced past the active-entry check.
            raise HTTPException(status_code=400, detail="Patient already has an active queue entry. Please complete or cancel the existing consultation first.")
        raise HTTPException(status_code=400, detail="Could not schedule appointment: the patient, doctor or invoice details conflict with existing records.")
    except Exception:
        db.rollback()
        # Details (SQL, patient data) go to the server log, not the user's screen.
        logger.exception("Could not schedule appointment")
        raise HTTPException(status_code=500, detail="Could not schedule appointment or generate token. Please try again.")

    try:
        log_audit_event(db, user, client_ip(request), "create", "appointments", str(appointment_id),
                         {"patient_name": payload.get("patient_name"), "token_no": token_no, "invoice_id": invoice_id, "payment_id": payment_id})
    except Exception:
        pass
    return {"appointment_id": appointment_id, "token_no": token_no, "invoice_id": invoice_id, "payment_id": payment_id}


@router.put("/appointments/{appointment_id}")
def appointments_update(appointment_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("patients.write"))):
    # Ownership is checked by access_scope.patient_access_guard; here we only stop reassignment.
    own_doctor = security.scoped_doctor_name(user)
    if own_doctor and "doctor_name" in payload:
        payload["doctor_name"] = own_doctor
    try:
        updated = lq.update_appointment(db, appointment_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Appointment not found")
    log_audit_event(db, user, client_ip(request), "update", "appointments", str(appointment_id), {"status": payload.get("status")})
    return {"status": "ok"}


@router.post("/appointments/razorpay/order")
def appointments_razorpay_order(payload: dict = Body(...), user: dict = Depends(require_permissions("patients.write"))):
    from common import require_razorpay_configured, to_amount_paise, create_razorpay_order
    require_razorpay_configured()
    validate_required_fields(payload, ["amount"])
    amount_paise = to_amount_paise(payload.get("amount"))
    if not amount_paise:
        raise HTTPException(status_code=400, detail="amount must be a positive number")
    try:
        order = create_razorpay_order(amount_paise, receipt=payload.get("receipt"), notes=payload.get("notes"))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"order": order}


@router.post("/appointments/razorpay/verify")
def appointments_razorpay_verify(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("patients.write"))):
    from common import require_razorpay_configured, verify_razorpay_signature
    require_razorpay_configured()
    validate_required_fields(payload, ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "amount"])
    if not verify_razorpay_signature(payload["razorpay_order_id"], payload["razorpay_payment_id"], payload["razorpay_signature"]):
        raise HTTPException(status_code=400, detail="Payment signature verification failed.")
    try:
        amount = float(payload.get("amount") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="amount must be numeric")

    appointment_payload = payload.get("appointment") or {}
    if not isinstance(appointment_payload, dict):
        raise HTTPException(status_code=400, detail="appointment must be an object.")
    validate_required_fields(appointment_payload, ["patient_name", "visit_type", "appointment_date"])

    try:
        appointment_id, token_no = lq.create_appointment(db, {
            "patient_id": appointment_payload.get("patient_id"),
            "patient_name": appointment_payload.get("patient_name"),
            "visit_type": appointment_payload.get("visit_type", "OP"),
            "department": appointment_payload.get("department"),
            "doctor_name": appointment_payload.get("doctor_name"),
            "appointment_date": appointment_payload.get("appointment_date"),
            "status": appointment_payload.get("status", "scheduled"),
            "appointment_kind": appointment_payload.get("appointment_kind", "new"),
            "follow_up_for": appointment_payload.get("follow_up_for"),
            "notes": appointment_payload.get("notes"),
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    invoice_no = f"INV-OP-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    invoice_id = lq.create_invoice(db, {
        "invoice_no": invoice_no, "patient_id": appointment_payload.get("patient_id"), "module": "OP",
        "doctor_name": appointment_payload.get("doctor_name"), "total_amount": amount, "paid_amount": 0,
        "advance_amount": 0, "refunded_amount": 0, "payment_status": "due", "created_by": user.get("username"),
    })
    payment_mode = normalize_payment_mode(payload.get("payment_mode"))
    payment_id = lq.record_invoice_payment(db, invoice_id, {
        "amount": amount, "payment_mode": payment_mode, "gateway_ref": payload.get("razorpay_payment_id"),
        "converted_from_mode": payload.get("converted_from_mode"), "converted_to_mode": payload.get("converted_to_mode"),
    })
    log_audit_event(db, user, client_ip(request), "create", "appointments", str(appointment_id), {
        "patient_name": appointment_payload.get("patient_name"), "token_no": token_no,
        "invoice_id": invoice_id, "invoice_payment_id": payment_id, "gateway_ref": payload.get("razorpay_payment_id"),
    })
    return {"appointment_id": appointment_id, "token_no": token_no, "invoice_id": invoice_id, "payment_id": payment_id}


# --------------------------------------------------------------- op module --

@router.get("/op/summary")
def op_summary(date: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    return lq.get_op_summary(db, date)


@router.get("/op/doctor-schedules")
def op_doctor_schedules_list(date: str | None = None, doctor_name: str | None = None, status: str | None = None,
                              department: str | None = None, db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("patients.read"))):
    schedules = rows_to_dicts(lq.list_doctor_schedules(db, schedule_date=date, doctor_name=doctor_name, status=status, department=department))
    for s in schedules:
        if s.get("status") != "leave" and (s.get("booked_count") or 0) >= (s.get("slot_capacity") or 12):
            s["status"] = "full"
    return {"schedules": schedules}


@router.post("/op/doctor-schedules")
def op_doctor_schedules_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["doctor_name"])
    if not payload.get("schedule_date"):
        payload["schedule_date"] = None
    if not payload.get("start_time"):
        payload["start_time"] = "09:00"
    if not payload.get("end_time"):
        payload["end_time"] = "13:00"
    try:
        schedule_id = lq.create_doctor_schedule(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "doctor_schedules", str(schedule_id), {"doctor_name": payload.get("doctor_name")})
    return {"schedule_id": schedule_id}


@router.get("/op/doctors")
def op_doctors_list(department: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    rows = lq.list_doctor_schedules(db, department=department)
    seen = {}
    for row in rows:
        name = (row["doctor_name"] or "").strip()
        if not name or name in seen:
            continue
        seen[name] = {
            "doctor_name": name, "department": row["department"] or "",
            "consultation_fee": row["consultation_fee"] or 0, "review_fee": row["review_fee"] or 0,
            "status": row["status"] or "available",
        }
    return {"doctors": list(seen.values())}


@router.put("/op/doctor-schedules/{schedule_id}")
def op_doctor_schedules_update(schedule_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.write"))):
    try:
        updated = lq.update_doctor_schedule(db, schedule_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Doctor schedule not found")
    log_audit_event(db, user, client_ip(request), "update", "doctor_schedules", str(schedule_id), {"schedule_id": schedule_id})
    return {"status": "ok"}


@router.delete("/op/doctor-schedules/{schedule_id}")
def op_doctor_schedules_delete(schedule_id: int, request: Request, db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.write"))):
    if not lq.delete_doctor_schedule(db, schedule_id):
        raise HTTPException(status_code=404, detail="Doctor schedule not found")
    log_audit_event(db, user, client_ip(request), "delete", "doctor_schedules", str(schedule_id), {"schedule_id": schedule_id})
    return {"status": "ok"}


# ------------------------------------------------------------ prescriptions --

@router.post("/ocr/prescription-fields")
def prescription_ocr_fields(patient_id: str = Form(...), file: UploadFile = File(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("patients.write")),
                            scope: set | None = Depends(patient_scope), hospital_id: int = Depends(current_hospital_id)):
    """Reads an uploaded prescription, but only hands the contents back when the UHID / patient
    name printed on it belong to the selected patient. The patient is looked up here, not trusted
    from the browser."""
    patient = lq.get_patient(db, patient_id, hospital_id=hospital_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Select a registered patient before uploading a prescription.")
    ensure_patient_allowed(scope, patient["patient_id"])
    expected_name = " ".join(" ".join(str(patient.get(k) or "").strip() for k in ("name", "middle_name", "last_name")).split())

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    try:
        fields = extract_prescription_fields(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    identity = prescription_identity_check(fields, patient["patient_id"], expected_name)
    if not identity["ok"]:
        # Nothing from the sheet is returned: it is not this patient's prescription.
        raise HTTPException(status_code=409, detail=identity["message"])
    return {"fields": fields, "identity": identity}


@router.post("/prescriptions")
def prescriptions_create(payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("patients.write")),
                          scope: set | None = Depends(patient_scope)):
    patient_id = payload.get("patient_id")
    appointment_id = payload.get("appointment_id")
    if appointment_id:
        try:
            appointment_id = int(appointment_id)
        except (ValueError, TypeError):
            appointment_id = None
    else:
        appointment_id = None

    if not patient_id:
        raise HTTPException(status_code=400, detail="patient_id is required")
    ensure_patient_allowed(scope, patient_id)
    own_doctor = security.scoped_doctor_name(user)
    if own_doctor:
        # Prescriptions written from a doctor login are always signed as that doctor.
        payload["doctor_name"] = own_doctor
        if appointment_id:
            appt = db.execute(text("SELECT doctor_name FROM appointments WHERE id = :v"), {"v": appointment_id}).fetchone()
            if appt and (appt[0] or "").strip().lower() != own_doctor.lower():
                raise HTTPException(status_code=404, detail="Appointment not found")

    medicines = payload.get("medicines", [])
    save_token = (payload.get("save_token") or "").strip() or None
    # Drafts (complete_consultation: false) are never sent - only the finished e-Rx reaches the pharmacy.
    # Nothing to dispense -> nothing to send.
    has_medicines = any((m.get("medicine_name") or m.get("medicine") or "").strip() for m in medicines)
    sends_to_pharmacy = bool(payload.get("send_to_pharmacy")) and payload.get("complete_consultation", True) is not False and has_medicines
    dispense_status = "sent_to_pharmacy" if sends_to_pharmacy else "not_sent"
    ip_order = None

    with legacy_sql.get_connection(db) as conn:
        try:
            cursor = conn.cursor()
            # An admitted patient's prescription goes to IP Dispense as a medication
            # order (and from there to the eMAR), not to the OP pharmacy queue.
            active_admission_id = lq.active_ip_admission(cursor, patient_id)
            ip_admission_id = active_admission_id if sends_to_pharmacy else None
            if ip_admission_id:
                dispense_status = "ip_order"
            prescription_id = None
            is_update = False

            if save_token:
                cursor.execute("SELECT id FROM prescriptions WHERE save_token = ? AND patient_id = ?", (save_token, patient_id))
                existing_token = cursor.fetchone()
                if existing_token:
                    prescription_id = existing_token[0]
                    is_update = True

            if is_update and prescription_id:
                cursor.execute(
                    """
                    UPDATE prescriptions
                    SET doctor_name = ?, department = ?, diagnosis = ?, lab_tests = ?, advice = ?, follow_up_date = ?,
                        lab_fbs = ?, lab_ppbs = ?, lab_hba1c = ?, lab_tchol = ?, lab_ldl = ?, lab_tgl = ?, lab_vitd = ?,
                        save_token = ?, dispense_status = ?
                    WHERE id = ?
                    """,
                    (payload.get("doctor_name"), payload.get("department"), payload.get("diagnosis"), payload.get("lab_tests"),
                     payload.get("advice"), payload.get("follow_up_date") or None, payload.get("lab_fbs") or None,
                     payload.get("lab_ppbs") or None, payload.get("lab_hba1c") or None, payload.get("lab_tchol") or None,
                     payload.get("lab_ldl") or None, payload.get("lab_tgl") or None, payload.get("lab_vitd") or None,
                     save_token, dispense_status, prescription_id),
                )
                cursor.execute("DELETE FROM prescription_medicines WHERE prescription_id = ?", (prescription_id,))
            else:
                cursor.execute(
                    """
                    INSERT INTO prescriptions (appointment_id, patient_id, doctor_name, department, diagnosis, lab_tests, advice, follow_up_date,
                        lab_fbs, lab_ppbs, lab_hba1c, lab_tchol, lab_ldl, lab_tgl, lab_vitd, save_token, dispense_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (appointment_id, patient_id, payload.get("doctor_name"), payload.get("department"), payload.get("diagnosis"),
                     payload.get("lab_tests"), payload.get("advice"), payload.get("follow_up_date") or None,
                     payload.get("lab_fbs") or None, payload.get("lab_ppbs") or None, payload.get("lab_hba1c") or None,
                     payload.get("lab_tchol") or None, payload.get("lab_ldl") or None, payload.get("lab_tgl") or None,
                     payload.get("lab_vitd") or None, save_token, dispense_status),
                )
                prescription_id = cursor.lastrowid

            for med in medicines:
                med_name = med.get("medicine_name") or med.get("medicine") or ""
                if not med_name:
                    continue
                cursor.execute(
                    """
                    INSERT INTO prescription_medicines (prescription_id, medicine_name, dosage, frequency, duration, instructions, is_custom, freq_custom)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (prescription_id, med_name, med.get("dosage") or "", med.get("frequency") or "", med.get("duration") or "",
                     med.get("instructions"), 1 if med.get("is_custom") else 0, med.get("freq_custom") or None),
                )

            if active_admission_id:
                # Links the prescription to the stay (discharge summary, patient journey).
                cursor.execute("UPDATE prescriptions SET admission_id = ? WHERE id = ?", (active_admission_id, prescription_id))
            if ip_admission_id:
                ip_order = lq.create_ip_order_from_prescription(
                    cursor, prescription_id, patient_id, ip_admission_id, payload.get("doctor_name"), medicines, user.get("username"),
                )

            if sends_to_pharmacy and appointment_id:
                # Re-saving the same consultation replaces its earlier, not-yet-dispensed e-Rx
                # instead of queueing a duplicate at the pharmacy.
                cursor.execute(
                    "UPDATE prescriptions SET dispense_status = 'superseded' WHERE appointment_id = ? AND id <> ? AND dispense_status = 'sent_to_pharmacy'",
                    (appointment_id, prescription_id),
                )

            if payload.get("complete_consultation") and appointment_id:
                cursor.execute(
                    "UPDATE appointments SET status = 'completed', "
                    "consultation_started_at = COALESCE(consultation_started_at, CURRENT_TIMESTAMP), "
                    "consultation_completed_at = COALESCE(consultation_completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
                    (appointment_id,),
                )

            conn.commit()
            return {"success": True, "prescription_id": prescription_id, "ip_order": ip_order}
        except ValueError as e:
            conn.rollback()
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            conn.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save prescription: {e}")


@router.get("/prescriptions/suggestions")
def prescriptions_suggestions(diagnosis: str | None = None, doctor_name: str | None = None, db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("patients.read"))):
    return prescription_suggestions.suggest_for_diagnosis(db, diagnosis, doctor_name)


@router.get("/prescriptions")
def prescriptions_list(patient_id: str | None = None, db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("patients.read"))):
    if not patient_id:
        raise HTTPException(status_code=400, detail="patient_id is required")
    with legacy_sql.get_connection(db) as conn:
        try:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, appointment_id, patient_id, doctor_name, department, diagnosis, lab_tests, advice, follow_up_date, created_at,
                       lab_fbs, lab_ppbs, lab_hba1c, lab_tchol, lab_ldl, lab_tgl, lab_vitd
                FROM prescriptions WHERE patient_id = ? ORDER BY created_at DESC
                """,
                (patient_id,),
            )
            prescriptions = rows_to_dicts(cursor.fetchall())
            if prescriptions:
                presc_ids = [p["id"] for p in prescriptions]
                placeholders = ",".join(["?"] * len(presc_ids))
                cursor.execute(
                    f"""
                    SELECT id, prescription_id, medicine_name, dosage, frequency, duration, instructions, is_custom, freq_custom
                    FROM prescription_medicines WHERE prescription_id IN ({placeholders}) ORDER BY id ASC
                    """,
                    presc_ids,
                )
                meds = rows_to_dicts(cursor.fetchall())
                from collections import defaultdict
                meds_by_presc = defaultdict(list)
                for m in meds:
                    meds_by_presc[m["prescription_id"]].append(m)
                for p in prescriptions:
                    p["medicines"] = meds_by_presc.get(p["id"], [])
            return {"prescriptions": prescriptions}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch prescriptions: {e}")


# --------------------------------------------------------------- registration --

@router.get("/registration/departments")
def registration_departments_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                                   hospital_id: int = Depends(current_hospital_id)):
    return {"departments": rows_to_dicts(lq.list_departments(db, hospital_id=hospital_id))}


@router.post("/registration/departments")
def registration_departments_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("patients.write")),
                                     hospital_id: int = Depends(current_hospital_id)):
    department_name = normalize_department_name(payload.get("department_name"))
    existing = next(
        (row for row in rows_to_dicts(lq.list_departments(db, hospital_id=hospital_id))
         if (row.get("department_name") or "").strip().lower() == department_name.lower()), None,
    )
    if existing:
        return {"department_id": existing.get("id"), "department_name": existing.get("department_name"), "already_exists": True}
    department_id = lq.create_department(db, {"department_name": department_name}, hospital_id=hospital_id)
    log_audit_event(db, user, client_ip(request), "create", "departments", str(department_id), {"department_name": department_name})
    return {"department_id": department_id, "department_name": department_name}


@router.delete("/registration/departments/{department_id}")
def registration_departments_delete(department_id: int, request: Request, db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("patients.write")),
                                     hospital_id: int = Depends(current_hospital_id)):
    success, message = lq.delete_department_safe(db, department_id, hospital_id=hospital_id)
    if not success:
        raise HTTPException(status_code=400, detail=message)
    log_audit_event(db, user, client_ip(request), "delete", "departments", str(department_id), {"deleted": True})
    return {"success": True}


@router.get("/registration/consents")
def registration_consents_list(patient_id: str | None = None, db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.read"))):
    return {"consents": rows_to_dicts(lq.list_patient_consents(db, patient_id=patient_id))}


@router.post("/registration/consents")
def registration_consents_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["patient_name", "consent_type", "signed_by"])
    consent_id = lq.create_patient_consent(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "patient_consents", str(consent_id), {"patient_name": payload.get("patient_name")})
    return {"consent_id": consent_id}


@router.put("/registration/consents/{consent_id}")
def registration_consents_update(consent_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("patients.write"))):
    if not lq.update_patient_consent(db, consent_id, payload):
        raise HTTPException(status_code=404, detail="Consent not found")
    log_audit_event(db, user, client_ip(request), "update", "patient_consents", str(consent_id), {"consent_id": consent_id})
    return {"status": "ok"}


@router.get("/registration/insurance")
def registration_insurance_list(patient_id: str | None = None, db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("patients.read"))):
    return {"verifications": rows_to_dicts(lq.list_insurance_verifications(db, patient_id=patient_id))}


@router.post("/registration/insurance")
def registration_insurance_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["patient_name", "insurer_name"])
    verification_id = lq.create_insurance_verification(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "insurance_verifications", str(verification_id), {"patient_name": payload.get("patient_name")})
    return {"verification_id": verification_id}


@router.put("/registration/insurance/{verification_id}")
def registration_insurance_update(verification_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("patients.write"))):
    if not lq.update_insurance_verification(db, verification_id, payload):
        raise HTTPException(status_code=404, detail="Insurance verification not found")
    log_audit_event(db, user, client_ip(request), "update", "insurance_verifications", str(verification_id), {"verification_id": verification_id})
    return {"status": "ok"}
