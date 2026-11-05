"""Nurse-to-IPD-patient assignments and per-nurse workload.

Access (enforced here, never by the client):
  * view   -- admins / super admins, or employees granted the Inpatient (ip-management) module.
  * manage -- admins / super admins, or nursing supervisors (Head Nurse, Nurse In-charge,
              Nursing Supervisor, Matron...) who also hold ip-management and patients.write.
  * workload -- managers see every nurse; any other employee sees only their own row.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import nurse_assignments as na
import security
from access_scope import filter_rows, patient_scope
from common import client_ip, log_audit_event
from database import get_db
from deps import current_hospital_id, require_permissions

router = APIRouter(prefix="/api/nursing", tags=["nursing"])

IPD_MODULE = "ip-management"
SUPERVISOR_KEYWORDS = ("head", "in-charge", "incharge", "in charge", "supervisor", "superintendent", "matron", "sister")


def _is_admin(user: dict) -> bool:
    return user.get("user_type") in ("admin", "super_admin")


def _has_ipd(user: dict) -> bool:
    return _is_admin(user) or IPD_MODULE in (user.get("module_access") or [])


def can_manage(user: dict) -> bool:
    if _is_admin(user):
        return True
    job = (user.get("job_role") or "").lower()
    return (_has_ipd(user) and "patients.write" in security.resolve_user_permissions(user)
            and na.is_nurse_title(job) and any(k in job for k in SUPERVISOR_KEYWORDS))


def require_ipd_view(user: dict = Depends(require_permissions("patients.read"))) -> dict:
    if not _has_ipd(user):
        raise HTTPException(status_code=403, detail={"error": "Forbidden", "message": "Inpatient module access is required."})
    return user


def require_ipd_manage(user: dict = Depends(require_permissions("patients.write"))) -> dict:
    if not can_manage(user):
        raise HTTPException(status_code=403, detail={"error": "Forbidden",
                                                     "message": "Only administrators and nursing supervisors can assign nurses."})
    return user


@router.get("/assignments")
def assignments_list(mine: bool = False, db: Session = Depends(get_db), user: dict = Depends(require_ipd_view),
                     hospital_id: int = Depends(current_hospital_id), scope=Depends(patient_scope)):
    manage = can_manage(user)
    # A doctor-linked login only ever sees its own patients (same rule as every clinical list).
    return {
        "assignments": filter_rows(na.list_active(db, hospital_id, user.get("username") if mine else None), scope),
        "unassigned": filter_rows(na.unassigned_admissions(db, hospital_id), scope) if manage else [],
        "nurses": na.list_nurses(db, hospital_id) if manage else [],
        "shifts": list(na.SHIFTS),
        "can_manage": manage,
        "me": user.get("username"),
    }


@router.post("/assignments")
def assignments_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_ipd_manage), hospital_id: int = Depends(current_hospital_id)):
    try:
        admission_id = int(payload.get("admission_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="admission_id is required.")
    try:
        result = na.assign(db, hospital_id, admission_id=admission_id, nurse_username=payload.get("nurse_username") or "",
                           shift=payload.get("shift"), priority=payload.get("priority"), actor=user.get("username"))
    except na.AssignmentError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "assign_nurse", "patient_assignments", str(result["id"]),
                    {"admission_id": admission_id, "nurse": result["assigned_nurse"], "shift": result["shift"]})
    return {"status": "ok", "assignment": result}


@router.post("/assignments/{assignment_id}/end")
def assignments_end(assignment_id: int, request: Request, db: Session = Depends(get_db),
                    user: dict = Depends(require_ipd_manage), hospital_id: int = Depends(current_hospital_id)):
    if not na.end(db, hospital_id, assignment_id, user.get("username")):
        raise HTTPException(status_code=404, detail="Active assignment not found")
    log_audit_event(db, user, client_ip(request), "end_nurse_assignment", "patient_assignments", str(assignment_id), {})
    return {"status": "ok"}


@router.get("/workload")
def workload(date: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_ipd_view),
             hospital_id: int = Depends(current_hospital_id)):
    nurse = None if can_manage(user) else user.get("username")
    return {"workload": na.workload(db, hospital_id, day=date, nurse=nurse), "scope": "all" if nurse is None else "self"}
