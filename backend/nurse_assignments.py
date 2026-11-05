"""Nurse-to-IPD-patient assignment and per-nurse workload.

An assignment links one currently admitted patient (an admission with an active bed
allocation) to one nurse login (users.username) for an optional shift. Only one
assignment can be active per admission and shift (unique index in
migrations_nurse_assignments.sql); assigning again for the same admission and shift
hands the patient over and ends the previous assignment.

Workload for a nurse = their active assigned patients plus, for those patients, the
eMAR doses due today / overdue and the ward indents still awaiting pharmacy, and the
doses that nurse personally charted today (emar_records.administered_by).

Read-only helpers are used by the role dashboard; writes go through routers/nursing.py.
"""
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

import legacy_queries as lq

SHIFTS = ("Morning", "Evening", "Night")

# Job titles treated as nursing staff (case-insensitive substring match).
NURSE_TITLE_KEYWORDS = ("nurs", "matron", "ward sister")


def is_nurse_title(job_role: Optional[str]) -> bool:
    job = (job_role or "").strip().lower()
    return any(k in job for k in NURSE_TITLE_KEYWORDS)


def _norm(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _now_sql() -> str:
    return "(NOW() AT TIME ZONE 'Asia/Kolkata')"


def list_nurses(db: Session, hospital_id: int) -> list[dict]:
    rows = db.execute(text("""
        SELECT username, COALESCE(NULLIF(full_name, ''), username) AS full_name, job_role
        FROM users
        WHERE hospital_id = :h AND COALESCE(status, 'active') = 'active'
          AND user_type NOT IN ('admin', 'super_admin')
        ORDER BY full_name
    """), {"h": hospital_id}).fetchall()
    return [dict(r._mapping) for r in rows if is_nurse_title(r._mapping["job_role"])]


def list_active(db: Session, hospital_id: int, nurse: Optional[str] = None) -> list[dict]:
    """Active assignments whose admission is still occupying a bed."""
    params = {"h": hospital_id, "n": _norm(nurse)}
    nurse_clause = "AND LOWER(pa.assigned_nurse) = :n" if nurse else ""
    rows = db.execute(text(f"""
        SELECT pa.id, pa.admission_id, pa.patient_id, pa.patient_name, pa.ward, pa.room, pa.bed, pa.shift,
               pa.priority, pa.assigned_nurse, COALESCE(NULLIF(u.full_name, ''), pa.assigned_nurse) AS nurse_name,
               pa.created_by, to_char(pa.created_at, 'YYYY-MM-DD HH24:MI') AS assigned_at
        FROM patient_assignments pa
        JOIN bed_allocations ba ON ba.admission_id = pa.admission_id AND ba.status = 'active' AND ba.released_at IS NULL
        LEFT JOIN users u ON LOWER(u.username) = LOWER(pa.assigned_nurse) AND u.hospital_id = pa.hospital_id
        WHERE pa.status = 'active' AND pa.hospital_id = :h AND pa.admission_id IS NOT NULL {nurse_clause}
        ORDER BY pa.ward, pa.bed, pa.shift NULLS FIRST
    """), params).fetchall()
    return [dict(r._mapping) for r in rows]


def assigned_patient_ids(db: Session, hospital_id: int, nurse: str) -> set[str]:
    return {str(r["patient_id"]) for r in list_active(db, hospital_id, nurse)}


class AssignmentError(ValueError):
    pass


def assign(db: Session, hospital_id: int, *, admission_id: int, nurse_username: str,
           shift: Optional[str], priority: Optional[str], actor: str) -> dict:
    shift = (shift or "").strip() or None
    if shift and shift not in SHIFTS:
        raise AssignmentError(f"Shift must be one of: {', '.join(SHIFTS)}.")
    nurse = db.execute(text("""
        SELECT username, job_role, user_type FROM users
        WHERE LOWER(username) = :u AND hospital_id = :h AND COALESCE(status, 'active') = 'active'
    """), {"u": _norm(nurse_username), "h": hospital_id}).fetchone()
    if not nurse or nurse._mapping["user_type"] in ("admin", "super_admin") or not is_nurse_title(nurse._mapping["job_role"]):
        raise AssignmentError("Select an active nursing employee.")

    bed = db.execute(text("""
        SELECT ba.admission_id, ba.patient_id, ba.ward, ba.room_no, ba.bed_no,
               TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')) AS patient_name
        FROM bed_allocations ba
        JOIN admissions a ON a.id = ba.admission_id
        LEFT JOIN patients p ON p.patient_id = ba.patient_id
        WHERE ba.admission_id = :a AND ba.status = 'active' AND ba.released_at IS NULL
          AND COALESCE(a.hospital_id, :h) = :h
        ORDER BY ba.id DESC LIMIT 1
    """), {"a": admission_id, "h": hospital_id}).fetchone()
    if not bed:
        raise AssignmentError("Only currently admitted (bed-allocated) patients can be assigned.")
    b = bed._mapping

    # Hand-over: end the current assignment for this admission + shift, then create the new one.
    db.execute(text(f"""
        UPDATE patient_assignments SET status = 'ended', ended_at = {_now_sql()}, ended_by = :actor,
               updated_by = :actor, updated_at = {_now_sql()}
        WHERE admission_id = :a AND status = 'active' AND COALESCE(shift, '') = COALESCE(:s, '')
    """), {"a": admission_id, "s": shift, "actor": actor})
    new_id = db.execute(text(f"""
        INSERT INTO patient_assignments (hospital_id, admission_id, patient_id, patient_name, ward, room, bed,
                                         assigned_nurse, priority, shift, status, admission_date, created_by,
                                         updated_by, created_at, updated_at)
        SELECT :h, :a, :p, :pn, :w, :r, :b, :n, :prio, :s, 'active', a.admission_date, :actor, :actor,
               {_now_sql()}, {_now_sql()}
        FROM admissions a WHERE a.id = :a
        RETURNING id
    """), {"h": hospital_id, "a": admission_id, "p": b["patient_id"], "pn": b["patient_name"] or b["patient_id"],
           "w": b["ward"], "r": b["room_no"], "b": b["bed_no"], "n": nurse._mapping["username"],
           "prio": (priority or "").strip() or None, "s": shift, "actor": actor}).scalar()
    db.commit()
    return {"id": new_id, "admission_id": admission_id, "patient_id": b["patient_id"],
            "assigned_nurse": nurse._mapping["username"], "shift": shift}


def end(db: Session, hospital_id: int, assignment_id: int, actor: str) -> bool:
    res = db.execute(text(f"""
        UPDATE patient_assignments SET status = 'ended', ended_at = {_now_sql()}, ended_by = :actor,
               updated_by = :actor, updated_at = {_now_sql()}
        WHERE id = :id AND hospital_id = :h AND status = 'active'
    """), {"id": assignment_id, "h": hospital_id, "actor": actor})
    db.commit()
    return res.rowcount == 1


def workload(db: Session, hospital_id: int, day: Optional[str] = None, nurse: Optional[str] = None) -> list[dict]:
    """Per-nurse workload for `day` (default today, IST). One row per nurse (or just `nurse`)."""
    day = day or lq.current_ist_datetime().date().isoformat()
    nurses = list_nurses(db, hospital_id)
    if nurse:
        nurses = [n for n in nurses if _norm(n["username"]) == _norm(nurse)] or \
                 [{"username": nurse, "full_name": nurse, "job_role": ""}]
    rows = db.execute(text(f"""
        WITH active AS (
            SELECT LOWER(pa.assigned_nurse) AS nurse, pa.admission_id, pa.patient_id
            FROM patient_assignments pa
            JOIN bed_allocations ba ON ba.admission_id = pa.admission_id AND ba.status = 'active' AND ba.released_at IS NULL
            WHERE pa.status = 'active' AND pa.hospital_id = :h AND pa.admission_id IS NOT NULL
        )
        SELECT a.nurse,
               COUNT(DISTINCT a.admission_id) AS patients,
               (SELECT COUNT(*) FROM emar_records e
                 WHERE e.admission_id IN (SELECT admission_id FROM active x WHERE x.nurse = a.nurse)
                   AND e.status = 'pending' AND DATE(e.scheduled_time) = DATE(:day)) AS doses_due,
               (SELECT COUNT(*) FROM emar_records e
                 WHERE e.admission_id IN (SELECT admission_id FROM active x WHERE x.nurse = a.nurse)
                   AND e.status = 'pending' AND e.scheduled_time < {_now_sql()} - INTERVAL '30 minutes'
                   AND DATE(e.scheduled_time) <= DATE(:day)) AS overdue,
               (SELECT COUNT(*) FROM ward_indents w
                 WHERE w.admission_id IN (SELECT admission_id FROM active x WHERE x.nurse = a.nurse)
                   AND w.status IN ('pending', 'processing', 'partially_issued')) AS pending_indents
        FROM active a GROUP BY a.nurse
    """), {"h": hospital_id, "day": day}).fetchall()
    by_nurse = {r._mapping["nurse"]: dict(r._mapping) for r in rows}
    given = db.execute(text("""
        SELECT LOWER(administered_by) AS nurse, COUNT(*) AS c FROM emar_records
        WHERE status = 'given' AND DATE(administered_at) = DATE(:day) GROUP BY 1
    """), {"day": day}).fetchall()
    given_map = {r._mapping["nurse"]: int(r._mapping["c"]) for r in given}

    out = []
    for n in nurses:
        key = _norm(n["username"])
        w = by_nurse.get(key, {})
        out.append({
            "username": n["username"], "full_name": n["full_name"], "job_role": n.get("job_role") or "",
            "patients": int(w.get("patients") or 0), "doses_due": int(w.get("doses_due") or 0),
            "overdue": int(w.get("overdue") or 0), "pending_indents": int(w.get("pending_indents") or 0),
            "doses_given": given_map.get(key, 0),
        })
    return out


def unassigned_admissions(db: Session, hospital_id: int) -> list[dict]:
    """Admitted patients with no active nurse assignment."""
    rows = db.execute(text("""
        SELECT ba.admission_id, ba.patient_id, ba.ward, ba.bed_no,
               TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')) AS patient_name
        FROM bed_allocations ba
        JOIN admissions a ON a.id = ba.admission_id
        LEFT JOIN patients p ON p.patient_id = ba.patient_id
        WHERE ba.status = 'active' AND ba.released_at IS NULL AND COALESCE(a.hospital_id, :h) = :h
          AND NOT EXISTS (SELECT 1 FROM patient_assignments pa
                          WHERE pa.admission_id = ba.admission_id AND pa.status = 'active')
        ORDER BY ba.ward, ba.bed_no
    """), {"h": hospital_id}).fetchall()
    return [dict(r._mapping) for r in rows]
