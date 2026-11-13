from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id
from access_scope import patient_scope, filter_rows
from common import rows_to_dicts, row_to_dict, validate_required_fields, log_audit_event, client_ip
import legacy_queries as lq
import legacy_sql
import security

router = APIRouter(prefix="/api", tags=["employees-bed"])


# ------------------------------------------------------------- employees --

@router.get("/employees")
def employees_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.read")),
                    hospital_id: int = Depends(current_hospital_id)):
    return {"employees": rows_to_dicts(lq.get_all_employees(db, hospital_id=hospital_id))}


@router.post("/employees")
def employees_create(payload: dict = Body(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("admin.users.create")), hospital_id: int = Depends(current_hospital_id)):
    result = security.signup_employee(db, payload, allow_admin_creation=True, hospital_id=hospital_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result)
    return result


@router.get("/employees/stats")
def employees_stats(db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.read")),
                     hospital_id: int = Depends(current_hospital_id)):
    return lq.get_employee_stats(db, hospital_id=hospital_id)


@router.get("/employees/search")
def employees_search(q: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.read")),
                      hospital_id: int = Depends(current_hospital_id)):
    if not q:
        return {"employees": []}
    return {"employees": rows_to_dicts(lq.search_employees(db, q, hospital_id=hospital_id))}


@router.get("/employees/{employee_id}")
def employees_get(employee_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.read")),
                   hospital_id: int = Depends(current_hospital_id)):
    employee = lq.get_employee(db, employee_id=employee_id, hospital_id=hospital_id)
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"employee": row_to_dict(employee)}


@router.put("/employees/{employee_id}")
def employees_update(employee_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("admin.users.update")), hospital_id: int = Depends(current_hospital_id)):
    phones, phone_error = security.normalize_user_phones(payload, partial=True)
    if phone_error:
        raise HTTPException(status_code=400, detail=phone_error)
    if not lq.update_employee(db, employee_id, {**payload, **phones}, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"status": "ok"}


@router.delete("/employees/{employee_id}")
def employees_delete(employee_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.deactivate"))):
    try:
        deleted = lq.delete_employee(db, employee_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"status": "ok"}


@router.post("/employees/{employee_id}/activate")
def employees_activate(employee_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.deactivate")),
                        hospital_id: int = Depends(current_hospital_id)):
    if not lq.activate_employee(db, employee_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"status": "active"}


@router.post("/employees/{employee_id}/deactivate")
def employees_deactivate(employee_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.users.deactivate")),
                          hospital_id: int = Depends(current_hospital_id)):
    if not lq.deactivate_employee(db, employee_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"status": "inactive"}


# --------------------------------------------------- extended patient mgmt --

@router.get("/patients/{patient_id}/vitals")
def patient_vitals_list(patient_id: str, admission_id: int | None = None, db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("patients.read"))):
    return {"vitals": [row_to_dict(v) for v in lq.get_patient_vitals(db, patient_id, admission_id=admission_id)]}


@router.post("/patients/{patient_id}/vitals")
def patient_vitals_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("patients.write"))):
    try:
        vital_id = lq.record_vitals(db, patient_id, payload, user.get("username"),
                                     encounter_id=payload.get("encounter_id"), admission_id=payload.get("admission_id"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "patient_vitals", str(vital_id), {"patient_id": patient_id})
    return {"status": "ok", "vital_id": vital_id}


@router.get("/nursing/care-logs")
def nursing_care_logs_list(patient_id: str | None = None, admission_id: int | None = None, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("patients.read")), scope: set | None = Depends(patient_scope)):
    return {"logs": filter_rows(rows_to_dicts(lq.list_nursing_care_logs(db, patient_id=patient_id, admission_id=admission_id)), scope)}


@router.post("/nursing/care-logs")
def nursing_care_logs_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["patient_id", "activity"])
    log_id = lq.create_nursing_care_log(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "nursing_care_logs", str(log_id), {"patient_id": payload["patient_id"]})
    return {"status": "ok", "log_id": log_id}


@router.get("/patients/{patient_id}/encounters")
def patient_encounters(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    return {"encounters": rows_to_dicts(lq.list_encounters(db, patient_id=patient_id))}


@router.post("/patients/{patient_id}/encounters")
def patient_encounter_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["encounter_type"])
    encounter_id, encounter_no = lq.create_encounter(db, {
        "patient_id": patient_id, "encounter_type": payload.get("encounter_type", "OP"),
        "insurance_provider": payload.get("insurance_provider"), "insurance_policy_no": payload.get("insurance_policy_no"),
        "is_accident": payload.get("is_accident", False), "referral_source": payload.get("referral_source"),
        "referral_name": payload.get("referral_name"), "status": payload.get("status", "active"),
        "created_by": user.get("username"),
        "appointment_id": payload.get("appointment_id"), "chief_complaint": payload.get("chief_complaint"),
        "triage_priority": payload.get("triage_priority"), "attendant_name": payload.get("attendant_name"),
        "attending_doctor": payload.get("attending_doctor"),
    })
    log_audit_event(db, user, client_ip(request), "create", "encounters", str(encounter_id), {"patient_id": patient_id})
    return {"encounter_id": encounter_id, "encounter_no": encounter_no}


@router.get("/encounters")
def encounters_list(encounter_type: str | None = None, active_only: bool = False, db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.read")), scope: set | None = Depends(patient_scope)):
    rows = lq.list_encounters(db, encounter_type=encounter_type, active_only=active_only)
    return {"encounters": rows_to_dicts(filter_rows(rows, scope))}


@router.post("/encounters/{encounter_id}/triage")
def encounter_set_triage(encounter_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["triage_priority"])
    lq.set_encounter_triage(db, encounter_id, payload["triage_priority"], user.get("username"))
    log_audit_event(db, user, client_ip(request), "triage", "encounters", str(encounter_id), {"triage_priority": payload["triage_priority"]})
    return {"status": "ok"}


@router.post("/encounters/{encounter_id}/disposition")
def encounter_set_disposition(encounter_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    validate_required_fields(payload, ["disposition"])
    disposition = payload["disposition"]
    try:
        admission_id = None
        if disposition == "admitted":
            admission_id = lq.admit_from_encounter(db, encounter_id, user.get("username"), hospital_id=hospital_id, notes=payload.get("notes"))
        else:
            lq.set_encounter_disposition(db, encounter_id, disposition, payload.get("notes"), user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    log_audit_event(db, user, client_ip(request), "disposition", "encounters", str(encounter_id),
                     {"disposition": disposition, "admission_id": admission_id})
    return {"status": "ok", "admission_id": admission_id}


@router.get("/patients/{patient_id}/beds")
def patient_beds(patient_id: str, active_only: bool = False, db: Session = Depends(get_db),
                  user: dict = Depends(require_permissions("patients.read"))):
    return {"beds": rows_to_dicts(lq.list_bed_allocations(db, patient_id=patient_id, active_only=active_only))}


@router.post("/patients/{patient_id}/beds")
def patient_bed_assign(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["admission_id", "ward", "room_no", "bed_no"])
    try:
        bed_id = lq.assign_bed(db, {
            "admission_id": payload.get("admission_id"), "patient_id": patient_id, "ward": payload.get("ward"),
            "room_no": payload.get("room_no"), "bed_no": payload.get("bed_no"), "status": payload.get("status", "active"),
        })
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "bed_allocations", str(bed_id), {"patient_id": patient_id})
    return {"bed_allocation_id": bed_id}


@router.get("/patients/{patient_id}/medications")
def patient_medications(patient_id: str, pending_only: bool = False, db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("patients.read"))):
    return {"medications": rows_to_dicts(lq.list_medication_schedules(db, patient_id, pending_only=pending_only))}


@router.post("/patients/{patient_id}/medications")
def patient_medications_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["medicine_name"])
    schedule_id = lq.add_medication_schedule(db, {
        "patient_id": patient_id, "medicine_name": payload.get("medicine_name"), "dosage": payload.get("dosage"),
        "schedule_time": payload.get("schedule_time") or lq.current_ist_datetime().isoformat(timespec="seconds"),
        "administered": payload.get("administered", False), "alert_enabled": payload.get("alert_enabled", True),
        "notes": payload.get("notes"),
    })
    log_audit_event(db, user, client_ip(request), "create", "medication_schedules", str(schedule_id), {"patient_id": patient_id})
    return {"schedule_id": schedule_id}


@router.get("/patients/{patient_id}/notes")
def patient_notes(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    return {"notes": rows_to_dicts(lq.list_observation_notes(db, patient_id))}


@router.post("/patients/{patient_id}/notes")
def patient_notes_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["note"])
    note_id = lq.add_observation_note(db, {
        "patient_id": patient_id, "admission_id": payload.get("admission_id"), "doctor_name": payload.get("doctor_name"),
        "note": payload.get("note"), "treatment_plan": payload.get("treatment_plan"),
    })
    log_audit_event(db, user, client_ip(request), "create", "observation_notes", str(note_id), {"patient_id": patient_id})
    return {"note_id": note_id}


@router.get("/patients/{patient_id}/certificates")
def patient_certificates(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    return {"certificates": rows_to_dicts(lq.list_certificates(db, patient_id))}


@router.post("/patients/{patient_id}/certificates")
def patient_certificates_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["certificate_type", "title", "body"])
    certificate_id = lq.create_certificate(db, {
        "patient_id": patient_id, "admission_id": payload.get("admission_id"), "certificate_type": payload.get("certificate_type"),
        "title": payload.get("title"), "body": payload.get("body"), "issued_by": user.get("username"),
    })
    log_audit_event(db, user, client_ip(request), "create", "certificates", str(certificate_id),
                     {"patient_id": patient_id, "certificate_type": payload.get("certificate_type")})
    return {"certificate_id": certificate_id}


@router.delete("/certificates/{certificate_id}")
def patient_certificates_delete(certificate_id: int, request: Request, db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("patients.write"))):
    if not lq.delete_certificate(db, certificate_id):
        raise HTTPException(status_code=404, detail="Certificate not found")
    log_audit_event(db, user, client_ip(request), "delete", "certificates", str(certificate_id), {"certificate_id": certificate_id})
    return {"status": "ok"}


@router.get("/patients/{patient_id}/movements")
def patient_movements(patient_id: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    return {"movements": rows_to_dicts(lq.list_patient_movements(db, patient_id))}


@router.post("/patients/{patient_id}/movements")
def patient_movements_create(patient_id: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["to_department"])
    movement_id = lq.add_patient_movement(db, {
        "patient_id": patient_id, "admission_id": payload.get("admission_id"), "from_department": payload.get("from_department"),
        "to_department": payload.get("to_department"), "moved_by": user.get("username"),
    })
    log_audit_event(db, user, client_ip(request), "create", "patient_movements", str(movement_id), {"patient_id": patient_id})
    return {"movement_id": movement_id}


# ------------------------------------------------------------------- bed --

def _get_or_create_active_admission(db: Session, patient_id, hospital_id, requested_admission_id=None):
    """The admission a new bed belongs to: the one the caller names (if it is this
    patient's and not discharged), else the patient's open admission, else a new
    one. A discharged admission is never reused -- a new stay must not inherit an
    old stay's bed, pharmacy and discharge charges."""
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        if requested_admission_id:
            cursor.execute(
                "SELECT id, discharge_date FROM admissions WHERE id = ? AND patient_id = ? AND hospital_id = ?",
                (requested_admission_id, patient_id, hospital_id),
            )
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=400, detail="That admission does not belong to this patient.")
            if row["discharge_date"]:
                raise HTTPException(status_code=409, detail="That admission is already discharged. Create a new admission first.")
            return row["id"]
        cursor.execute(
            """
            SELECT id FROM admissions
            WHERE patient_id = ? AND hospital_id = ? AND discharge_date IS NULL
              AND COALESCE(notes, '') != 'Initial registration'
            ORDER BY admission_date DESC LIMIT 1
            """,
            (patient_id, hospital_id),
        )
        row = cursor.fetchone()
        if row:
            return row[0]
    try:
        return lq.add_admission(db, patient_id, "Bed allocation admission", hospital_id=hospital_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/bed/config")
def get_bed_config(db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                    hospital_id: int = Depends(current_hospital_id)):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT capacity FROM bed_config WHERE hospital_id = ?", (hospital_id,))
        row = cursor.fetchone()
        capacity = row[0] if row else 50
        cursor.execute(
            "SELECT COUNT(*) FROM bed_allocations WHERE status = 'active' AND admission_id IN (SELECT id FROM admissions WHERE hospital_id = ?)",
            (hospital_id,),
        )
        occupied_count = cursor.fetchone()[0]
    return {"capacity": capacity, "occupied_count": occupied_count}


@router.post("/bed/config")
def update_bed_config(payload: dict = Body(...), db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.write")),
                       hospital_id: int = Depends(current_hospital_id)):
    capacity = int(payload.get("capacity", 50))
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT capacity FROM bed_config WHERE hospital_id = ?", (hospital_id,))
        if cursor.fetchone():
            cursor.execute("UPDATE bed_config SET capacity = ? WHERE hospital_id = ?", (capacity, hospital_id))
        else:
            cursor.execute("INSERT INTO bed_config (hospital_id, capacity) VALUES (?, ?)", (hospital_id, capacity))
        conn.commit()
    return {"status": "success", "capacity": capacity}


@router.get("/bed/occupancy")
def get_bed_occupancy(db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                       hospital_id: int = Depends(current_hospital_id), scope: set | None = Depends(patient_scope)):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT b.id, b.patient_id, b.ward, b.room_no, b.bed_no, b.amount_per_day, b.total_days, b.total_amount, b.allocated_at,
                   p.name, p.last_name, b.admission_id,
                   a.payer_type, a.insurance_provider, a.insurance_policy_no, a.insurance_preauth_no
            FROM bed_allocations b JOIN patients p ON b.patient_id = p.patient_id
            JOIN admissions a ON a.id = b.admission_id
            WHERE b.status = 'active' AND a.hospital_id = ?
            ORDER BY b.allocated_at DESC
            """,
            (hospital_id,),
        )
        rows = cursor.fetchall()
        occupied = [{
            "id": r[0], "patient_id": r[1], "ward": r[2], "room_no": r[3], "bed_no": r[4], "amount_per_day": r[5],
            "total_days": r[6], "total_amount": r[7], "allocated_at": r[8], "patient_name": f"{r[9]} {r[10]}".strip(),
            "admission_id": r[11], "payer_type": r[12] or "self", "insurance_provider": r[13],
            "insurance_policy_no": r[14], "insurance_preauth_no": r[15],
        } for r in rows]
    return {"occupied": filter_rows(occupied, scope)}


@router.post("/bed/allot")
def allot_bed_api(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                   user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    patient_id = payload.get("patient_id")
    ward = payload.get("ward")
    room_no = payload.get("room_no")
    bed_no = payload.get("bed_no")
    amount_per_day = float(payload.get("amount_per_day") or 0)
    total_days = int(payload.get("total_days") or 0)
    total_amount = float(payload.get("total_amount") or 0)
    if not patient_id or not ward or not room_no or not bed_no:
        raise HTTPException(status_code=400, detail="Missing required fields")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        if len(patient_id) == 4 and patient_id.isdigit():
            cursor.execute("SELECT patient_id FROM patients WHERE hospital_id = ? AND patient_id LIKE ?", (hospital_id, f"%{patient_id}"))
            row = cursor.fetchone()
            if row:
                patient_id = row[0]
            else:
                raise HTTPException(status_code=404, detail="Patient not found matching those last 4 digits")
        else:
            cursor.execute("SELECT patient_id FROM patients WHERE hospital_id = ? AND patient_id = ?", (hospital_id, patient_id))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Patient not found")

    admission_id = _get_or_create_active_admission(db, patient_id, hospital_id, payload.get("admission_id"))

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, patient_id FROM bed_allocations
            WHERE status = 'active' AND LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?) AND patient_id != ?
            """,
            (ward, bed_no, patient_id),
        )
        occupant = cursor.fetchone()
        if occupant:
            raise HTTPException(status_code=409, detail=f"Bed {bed_no} in {ward} is already occupied by patient {occupant[1]}.")
        try:
            lq.ensure_not_currently_admitted(cursor, patient_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        # The daily rate is the bed's tariff from Bed Management; the amount sent by the client is not trusted.
        cursor.execute("SELECT daily_rate FROM hospital_beds WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)", (ward, bed_no))
        tariff = cursor.fetchone()
        if tariff and tariff[0] is not None:
            amount_per_day = float(tariff[0])
            total_amount = amount_per_day * total_days
        cursor.execute("SELECT ward, bed_no FROM bed_allocations WHERE patient_id = ? AND status = 'active'", (patient_id,))
        previous_beds = cursor.fetchall()
        cursor.execute("UPDATE bed_allocations SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE patient_id = ? AND status = 'active'", (patient_id,))
        for prev in previous_beds:
            cursor.execute(
                "UPDATE hospital_beds SET status = 'available' WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
                (prev["ward"], prev["bed_no"]),
            )
        cursor.execute(
            """
            INSERT INTO bed_allocations (admission_id, patient_id, ward, room_no, bed_no, amount_per_day, total_days, total_amount, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
            """,
            (admission_id, patient_id, ward, room_no, bed_no, amount_per_day, total_days, total_amount),
        )
        bed_id = cursor.lastrowid
        cursor.execute(
            "UPDATE hospital_beds SET status = 'occupied' WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
            (ward, bed_no),
        )
        conn.commit()

    log_audit_event(db, user, client_ip(request), "create", "bed_allocations", str(bed_id), {"patient_id": patient_id})
    return {"status": "success", "bed_allocation_id": bed_id}


@router.post("/bed/release/{allocation_id}")
def release_bed_api(allocation_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.write"))):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT ward, bed_no FROM bed_allocations WHERE id = ?", (allocation_id,))
        row = cursor.fetchone()
        cursor.execute("UPDATE bed_allocations SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE id = ?", (allocation_id,))
        if row:
            cursor.execute(
                "UPDATE hospital_beds SET status = 'available' WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
                (row["ward"], row["bed_no"]),
            )
        conn.commit()
    return {"status": "success"}


@router.get("/bed/history")
def get_bed_history_all(patient_id: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                         scope: set | None = Depends(patient_scope)):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT b.id, b.patient_id, b.ward, b.room_no, b.bed_no, b.amount_per_day, b.total_days, b.total_amount, b.allocated_at, b.released_at, b.status,
                   p.name, p.last_name
            FROM bed_allocations b JOIN patients p ON b.patient_id = p.patient_id
        """
        params = []
        if patient_id:
            query += " WHERE b.patient_id = ?"
            params.append(patient_id)
        query += " ORDER BY b.allocated_at DESC"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        history = [{
            "id": r[0], "patient_id": r[1], "ward": r[2], "room_no": r[3], "bed_no": r[4], "amount_per_day": r[5],
            "total_days": r[6], "total_amount": r[7], "allocated_at": r[8], "released_at": r[9], "status": r[10],
            "patient_name": f"{r[11]} {r[12]}".strip(),
        } for r in rows]
    return {"history": filter_rows(history, scope)}


@router.get("/admissions/discharged")
def admissions_discharged_list(from_date: str | None = None, to_date: str | None = None, q: str | None = None,
                                db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                                hospital_id: int = Depends(current_hospital_id), scope: set | None = Depends(patient_scope)):
    rows = lq.list_discharged_admissions(db, hospital_id=hospital_id, from_date=from_date, to_date=to_date, q=q)
    return {"discharged": rows_to_dicts(filter_rows(rows, scope))}


# ------------------------------------------------------- bed requests --

@router.get("/bed/requests")
def get_bed_requests(db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                      hospital_id: int = Depends(current_hospital_id), scope: set | None = Depends(patient_scope)):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id as admission_id, a.patient_id, a.admission_date, a.notes,
                   p.name as patient_name, p.last_name, p.age, p.gender, p.phone
            FROM admissions a
            JOIN patients p ON p.patient_id = a.patient_id
            LEFT JOIN bed_allocations b ON (b.admission_id = a.id OR b.patient_id = a.patient_id) AND b.status = 'active'
            WHERE a.hospital_id = ?
              AND a.discharge_date IS NULL
              AND b.id IS NULL
              AND COALESCE(a.notes, '') != 'Initial registration'
            ORDER BY a.admission_date DESC
            """,
            (hospital_id,),
        )
        rows = cursor.fetchall()
        requests_list = []
        for r in rows:
            notes_str = str(r["notes"] or "")
            parsed = {}
            for part in notes_str.split("|"):
                if ":" in part:
                    k, v = part.split(":", 1)
                    parsed[k.strip().lower().replace(" ", "_")] = v.strip()
            full_name = f"{r['patient_name'] or ''} {r['last_name'] or ''}".strip()
            requests_list.append({
                "admission_id": r["admission_id"], "patient_id": r["patient_id"],
                "patient_name": full_name or r["patient_id"], "age": r["age"], "gender": r["gender"], "phone": r["phone"],
                "admission_date": r["admission_date"].isoformat() if r["admission_date"] else None,
                "notes": notes_str, "admission_type": parsed.get("admission_type") or "Inpatient",
                "department": parsed.get("department") or "", "consulting_doctor": parsed.get("consulting_doctor") or "",
                "preferred_ward": parsed.get("preferred_ward") or parsed.get("ward") or "General Ward",
                "reason": parsed.get("reason") or notes_str,
            })
    return {"requests": filter_rows(requests_list, scope)}


# --------------------------------------------------- hospital_beds inventory --
# Real per-bed inventory (ICU/General Ward/Single Room with rates), distinct
# from the legacy capacity-counter (`/api/bed/config`) above, which is left
# untouched.

@router.get("/beds")
def api_list_hospital_beds(ward: str | None = None, status: str | None = None, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("patients.read"))):
    return lq.list_hospital_beds(db, ward=ward, status=status)


@router.post("/beds")
def api_create_hospital_bed(payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("patients.write"))):
    try:
        new_id = lq.create_hospital_bed(db, payload.get("ward"), payload.get("room_no"), payload.get("bed_no"),
                                         payload.get("daily_rate"), payload.get("bed_type", "Standard"), payload.get("notes", ""))
        return {"status": "success", "bed_id": new_id}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/beds/status")
def api_update_hospital_bed_status(payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("patients.write"))):
    try:
        lq.update_bed_status_by_number(db, payload.get("ward"), payload.get("bed_no"), payload.get("status", "available"))
        return {"status": "success"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ------------------------------------------------------------- discharge --
# Consolidated inpatient discharge: stay duration + bed charges + unbilled
# running pharmacy + confirmed diagnostics, settled into one final invoice.

@router.get("/bed/allocations/{allocation_id}/discharge-bill")
def bed_allocation_discharge_bill_preview(allocation_id: int, db: Session = Depends(get_db),
                                           user: dict = Depends(require_permissions("billing.read"))):
    try:
        return lq.get_discharge_bill_preview(db, allocation_id=allocation_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/bed/allocations/{allocation_id}/discharge")
def bed_allocation_discharge_execute(allocation_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("patients.write"))):
    payload = dict(payload or {})
    payload["allocation_id"] = allocation_id
    try:
        return lq.settle_inpatient_discharge(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/admissions/{admission_id}/discharge-bill")
def admission_discharge_bill_preview(admission_id: int, db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("billing.read"))):
    try:
        return lq.get_discharge_bill_preview(db, admission_id=admission_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/admissions/{admission_id}/discharge")
def admission_discharge_execute(admission_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("patients.write"))):
    payload = dict(payload or {})
    payload["admission_id"] = admission_id
    try:
        return lq.settle_inpatient_discharge(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/admissions/{identifier}/summary-data")
def admission_summary_data(identifier: str, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("patients.read"))):
    try:
        return lq.get_admission_clinical_history(db, identifier)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

