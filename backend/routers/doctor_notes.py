"""Doctor Clinicals: the attending doctor's daily clinical notes for an admitted patient.

Notes are stored in doctor_clinical_notes (linked by admission_id and the doctor's user id) and are read
back by the Inpatient Patients profile, the Patient Journey and the Discharge Summary. Only a login linked
to a doctor can write; admins can read. A doctor works only on patients assigned to them (consulting
doctor on the admission form, or the doctor on the bed allocation)."""
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from common import client_ip, log_audit_event
from database import get_db
from deps import current_hospital_id, require_permissions
import legacy_sql
import nurse_assignments
import patient_journey
import security

router = APIRouter(prefix="/api", tags=["doctor-notes"])

READINESS = ("not_assessed", "not_ready", "improving", "ready_24h", "ready")
TEXT_FIELDS = ("subjective", "objective_analysis", "diagnosis", "treatment_plan", "prognosis",
               "presenting_complaints", "clinical_course", "key_investigations", "procedures", "treatment_given",
               "condition_at_discharge", "advice", "follow_up")
MAX_FIELD = 5000


def _is_admin(user):
    return (user or {}).get("user_type") in ("admin", "super_admin")


def _writer(user):
    """('doctor', doctor name) for a doctor-linked login, ('nurse', None) for nursing staff; anyone else may not write."""
    doctor = security.scoped_doctor_name(user)
    if doctor:
        return "doctor", doctor
    if not _is_admin(user) and nurse_assignments.is_nurse_title((user or {}).get("job_role")):
        return "nurse", None
    raise HTTPException(status_code=403, detail="Only attending doctors and nurses can record clinical notes.")


def _attending_doctor(cursor, admission_id):
    cursor.execute("SELECT to_doctor FROM doctor_patient_transfers WHERE admission_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", (admission_id,))
    moved = cursor.fetchone()
    if moved and moved["to_doctor"]:
        return moved["to_doctor"]
    cursor.execute("SELECT notes FROM admissions WHERE id = ?", (admission_id,))
    adm = cursor.fetchone()
    doctor = patient_journey.parse_admission_notes(adm["notes"] if adm else "").get("consulting_doctor")
    if doctor:
        return doctor
    cursor.execute("SELECT assigned_doctor FROM bed_allocations WHERE admission_id = ? AND COALESCE(assigned_doctor, '') <> '' ORDER BY allocated_at DESC LIMIT 1", (admission_id,))
    row = cursor.fetchone()
    return row["assigned_doctor"] if row else None


def _clean_payload(payload):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Note content must be an object.")
    out = {}
    for key in TEXT_FIELDS:
        value = payload.get(key)
        if value is not None and not isinstance(value, (str, int, float)):
            raise HTTPException(status_code=400, detail=f"'{key}' must be text.")
        value = str(value or "").strip()
        if len(value) > MAX_FIELD:
            raise HTTPException(status_code=400, detail=f"'{key}' is longer than {MAX_FIELD} characters.")
        out[key] = value or None
    readiness = str(payload.get("discharge_readiness") or "not_assessed").strip().lower()
    if readiness not in READINESS:
        raise HTTPException(status_code=400, detail="Invalid discharge readiness.")
    out["discharge_readiness"] = readiness
    if not any(out[k] for k in TEXT_FIELDS):
        raise HTTPException(status_code=400, detail="Enter at least one clinical finding before saving.")
    return out


def _assigned_to(cursor, admission_id, doctor):
    """True when this doctor currently looks after the admission (latest transfer, else the admission's
    consulting doctor, else the doctor on its bed allocation)."""
    key = str(doctor or "").strip().lower()
    return bool(key) and str(_attending_doctor(cursor, admission_id) or "").strip().lower() == key


def _serialize(row):
    d = dict(row)
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None and hasattr(d[k], "isoformat"):
            d[k] = d[k].isoformat()
    return d


@router.get("/doctor-notes/my-patients")
def doctor_notes_my_patients(db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read")),
                             hospital_id: int = Depends(current_hospital_id)):
    """Currently admitted patients assigned to the logged-in doctor (admins see every admitted patient)."""
    doctor = security.scoped_doctor_name(user)
    is_nurse = (not doctor) and (not _is_admin(user)) and nurse_assignments.is_nurse_title(user.get("job_role"))
    if not doctor and not is_nurse and not _is_admin(user):
        raise HTTPException(status_code=403, detail="Doctor Clinicals is for attending doctors and nurses.")
    mine = nurse_assignments.assigned_patient_ids(db, hospital_id, user.get("username")) if is_nurse else set()
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id AS admission_id, a.patient_id, a.admission_date, a.notes,
                   TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.middle_name, '') || ' ' || COALESCE(p.last_name, '')) AS patient_name,
                   p.age, p.gender,
                   ba.ward, ba.room_no, ba.bed_no, ba.assigned_doctor, tr.to_doctor, tr.to_department,
                   (SELECT COUNT(*) FROM doctor_clinical_notes n WHERE n.admission_id = a.id) AS note_count,
                   (SELECT n.created_at FROM doctor_clinical_notes n WHERE n.admission_id = a.id ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS last_note_at,
                   (SELECT n.discharge_readiness FROM doctor_clinical_notes n WHERE n.admission_id = a.id ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS discharge_readiness
            FROM admissions a
            JOIN patients p ON p.patient_id = a.patient_id
            LEFT JOIN LATERAL (
                SELECT ward, room_no, bed_no, assigned_doctor FROM bed_allocations
                WHERE admission_id = a.id ORDER BY (status = 'active') DESC, allocated_at DESC LIMIT 1
            ) ba ON TRUE
            LEFT JOIN LATERAL (
                SELECT to_doctor, to_department FROM doctor_patient_transfers t
                WHERE t.admission_id = a.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1
            ) tr ON TRUE
            WHERE a.discharge_date IS NULL AND a.hospital_id = ? AND COALESCE(a.notes, '') != 'Initial registration'
            ORDER BY a.admission_date DESC
            """,
            (hospital_id,),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        moved_out = set()
        if doctor:
            cursor.execute("SELECT DISTINCT admission_id FROM doctor_patient_transfers WHERE LOWER(TRIM(from_doctor)) = ?", (doctor.strip().lower(),))
            moved_out = {r["admission_id"] for r in cursor.fetchall()}
    out = []
    for r in rows:
        info = patient_journey.parse_admission_notes(r.get("notes"))
        consulting = r.get("to_doctor") or info.get("consulting_doctor") or r.get("assigned_doctor") or ""
        department = r.get("to_department") or info.get("department")
        transferred_to = None
        if doctor:
            key = doctor.strip().lower()
            if consulting.strip().lower() != key:
                # Handed over by this doctor: still listed (read only) so the history stays reachable.
                if r["admission_id"] not in moved_out:
                    continue
                transferred_to = consulting
        out.append({
            "admission_id": r["admission_id"], "patient_id": r["patient_id"], "patient_name": r["patient_name"],
            "age": r["age"], "gender": r["gender"], "ward": r["ward"], "room_no": r["room_no"], "bed_no": r["bed_no"],
            "admitted_at": r["admission_date"].isoformat() if hasattr(r["admission_date"], "isoformat") else r["admission_date"],
            "reason": info.get("reason"), "department": department, "consulting_doctor": consulting,
            "note_count": r["note_count"], "last_note_at": r["last_note_at"].isoformat() if r["last_note_at"] else None,
            "discharge_readiness": r["discharge_readiness"],
            "assigned_to_me": r["patient_id"] in mine,
            "transferred_to": transferred_to,
        })
    if is_nurse:
        out.sort(key=lambda p: not p["assigned_to_me"])
    return {"patients": out, "doctor": doctor, "role": "doctor" if doctor else ("nurse" if is_nurse else "admin")}


@router.get("/admissions/{admission_id}/doctor-notes")
def doctor_notes_list(admission_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM admissions WHERE id = ?", (admission_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Admission not found.")
        cursor.execute("SELECT * FROM doctor_clinical_notes WHERE admission_id = ? ORDER BY created_at DESC, id DESC", (admission_id,))
        return {"notes": [_serialize(r) for r in cursor.fetchall()]}


@router.post("/admissions/{admission_id}/doctor-notes")
def doctor_notes_create(admission_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    role, doctor = _writer(user)
    data = _clean_payload(payload)
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, patient_id, discharge_date FROM admissions WHERE id = ? FOR UPDATE", (admission_id,))
        adm = cursor.fetchone()
        if not adm:
            raise HTTPException(status_code=404, detail="Admission not found.")
        if adm["discharge_date"]:
            raise HTTPException(status_code=409, detail="This patient is already discharged; clinical notes can no longer be added.")
        if role == "doctor":
            if not _assigned_to(cursor, admission_id, doctor):
                raise HTTPException(status_code=403, detail="This patient is not assigned to you.")
            note_doctor, doctor_id = doctor, user.get("id")
        else:
            # A nurse records the note on behalf of the patient's attending doctor.
            note_doctor, doctor_id = _attending_doctor(cursor, admission_id), None
            if not note_doctor:
                raise HTTPException(status_code=409, detail="This admission has no attending doctor on record, so a nurse cannot enter a note for it.")
        columns = ["hospital_id", "admission_id", "patient_id", "doctor_id", "doctor_name", *TEXT_FIELDS, "discharge_readiness",
                   "created_by", "updated_by", "entered_role"]
        values = [hospital_id, admission_id, adm["patient_id"], doctor_id, note_doctor, *(data[k] for k in TEXT_FIELDS),
                  data["discharge_readiness"], user.get("username"), user.get("username"), role]
        cursor.execute(
            f"INSERT INTO doctor_clinical_notes ({', '.join(columns)}) VALUES ({', '.join(['?'] * len(columns))}) RETURNING id",
            tuple(values),
        )
        note_id = cursor.fetchone()[0]
        conn.commit()
    log_audit_event(db, user, client_ip(request), "create", "doctor_clinical_notes", str(note_id), {"admission_id": admission_id})
    return {"status": "ok", "note_id": note_id}


@router.put("/doctor-notes/{note_id}")
def doctor_notes_update(note_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("patients.write"))):
    role, doctor = _writer(user)
    data = _clean_payload(payload)
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT n.*, a.discharge_date FROM doctor_clinical_notes n JOIN admissions a ON a.id = n.admission_id WHERE n.id = ? FOR UPDATE OF n",
            (note_id,),
        )
        note = cursor.fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found.")
        if note["discharge_date"]:
            raise HTTPException(status_code=409, detail="This patient is already discharged; the note can no longer be edited.")
        if role == "doctor":
            if str(note["doctor_name"]).strip().lower() != doctor.strip().lower():
                raise HTTPException(status_code=403, detail="You can only edit your own notes.")
        elif str(note["created_by"] or "").strip().lower() != str(user.get("username") or "").strip().lower():
            raise HTTPException(status_code=403, detail="You can only edit notes you entered.")
        assignments = ", ".join(f"{k} = ?" for k in (*TEXT_FIELDS, "discharge_readiness"))
        cursor.execute(
            f"UPDATE doctor_clinical_notes SET {assignments}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (*(data[k] for k in TEXT_FIELDS), data["discharge_readiness"], user.get("username"), note_id),
        )
        conn.commit()
    log_audit_event(db, user, client_ip(request), "update", "doctor_clinical_notes", str(note_id), {"admission_id": note["admission_id"]})
    return {"status": "ok"}


@router.get("/admissions/{admission_id}/doctor-transfers")
def doctor_transfers_list(admission_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM doctor_patient_transfers WHERE admission_id = ? ORDER BY created_at DESC, id DESC", (admission_id,))
        return {"transfers": [_serialize(r) for r in cursor.fetchall()]}


@router.post("/admissions/{admission_id}/transfer-doctor")
def doctor_transfer_create(admission_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("patients.write")), hospital_id: int = Depends(current_hospital_id)):
    """Hand an admitted patient over to another doctor (and department). The receiving doctor then sees the patient
    and the full record; the transferring doctor keeps read access to the history."""
    doctor = security.scoped_doctor_name(user)
    if not doctor and not _is_admin(user):
        raise HTTPException(status_code=403, detail="Only the attending doctor or an administrator can transfer a patient.")
    to_doctor = str(payload.get("to_doctor") or "").strip()
    to_department = str(payload.get("to_department") or "").strip()
    reason = str(payload.get("reason") or "").strip()[:1000] or None
    if not to_department or not to_doctor:
        raise HTTPException(status_code=400, detail="Select the department and the doctor to transfer to.")
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, patient_id, notes, discharge_date FROM admissions WHERE id = ? FOR UPDATE", (admission_id,))
        adm = cursor.fetchone()
        if not adm:
            raise HTTPException(status_code=404, detail="Admission not found.")
        if adm["discharge_date"]:
            raise HTTPException(status_code=409, detail="This patient is already discharged and cannot be transferred.")
        current = _attending_doctor(cursor, admission_id)
        if doctor and not _assigned_to(cursor, admission_id, doctor):
            raise HTTPException(status_code=403, detail="Only the doctor currently looking after this patient can transfer them.")
        if str(current or "").strip().lower() == to_doctor.lower():
            raise HTTPException(status_code=409, detail="The patient is already under this doctor.")
        # The target must be a doctor set up in Doctor Scheduling.
        cursor.execute("SELECT 1 FROM doctor_schedules WHERE LOWER(TRIM(doctor_name)) = ? LIMIT 1", (to_doctor.lower(),))
        if not cursor.fetchone():
            raise HTTPException(status_code=400, detail=f"'{to_doctor}' is not a doctor set up in Doctor Scheduling.")
        info = patient_journey.parse_admission_notes(adm["notes"])
        cursor.execute("SELECT to_department FROM doctor_patient_transfers WHERE admission_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", (admission_id,))
        last = cursor.fetchone()
        from_department = (last["to_department"] if last else None) or info.get("department")
        cursor.execute(
            "INSERT INTO doctor_patient_transfers (hospital_id, admission_id, patient_id, from_doctor, from_department, to_doctor, to_department, reason, transferred_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (hospital_id, admission_id, adm["patient_id"], current, from_department, to_doctor, to_department, reason, user.get("username")),
        )
        transfer_id = cursor.fetchone()[0]
        # Beds, billing and the doctor-scope rules follow the doctor on the active bed allocation.
        cursor.execute("UPDATE bed_allocations SET assigned_doctor = ? WHERE admission_id = ? AND status = 'active'", (to_doctor, admission_id))
        conn.commit()
    log_audit_event(db, user, client_ip(request), "transfer_doctor", "doctor_patient_transfers", str(transfer_id),
                    {"admission_id": admission_id, "from": current, "to": to_doctor, "department": to_department})
    return {"status": "ok", "transfer_id": transfer_id, "to_doctor": to_doctor, "to_department": to_department}
