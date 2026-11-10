import os
from typing import Optional

from fastapi import APIRouter, Body, Cookie, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

import security
from database import get_db
from deps import (
    get_current_user, get_current_user_optional, require_permissions,
    request_hospital_id, current_hospital_id, validate_hospital_code, require_platform_admin,
)
from common import row_to_dict, rows_to_dicts
import legacy_queries as lq

router = APIRouter(prefix="/api", tags=["auth"])


def _session_cookie_kwargs(request: Request):
    secure_cookie = request.url.scheme == "https" or (os.getenv("SESSION_COOKIE_SECURE", "").lower() == "true")
    same_site = os.getenv("SESSION_COOKIE_SAMESITE", "Lax")
    if same_site not in ("Lax", "Strict", "None"):
        same_site = "Lax"
    return dict(httponly=True, secure=secure_cookie, samesite=same_site.lower(), path="/")


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/payments/razorpay/config")
def razorpay_config():
    from common import is_razorpay_configured, RAZORPAY_KEY_ID
    return {"configured": is_razorpay_configured(), "key_id": RAZORPAY_KEY_ID if is_razorpay_configured() else ""}


@router.get("/languages")
def languages():
    from ocr import LANGUAGE_NAMES
    return {"languages": LANGUAGE_NAMES}


@router.post("/auth/login")
def login(request: Request, response: Response, payload: dict = Body(...), db: Session = Depends(get_db)):
    hospital_id = request_hospital_id(request, db)
    user = security.authenticate(db, payload.get("username", ""), payload.get("password", ""), hospital_id=hospital_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if "error" in user:
        raise HTTPException(status_code=403, detail=user)
    session_token, expires_at = security.create_session(
        db, user_id=user["id"], hospital_id=user["hospital_id"],
        ip_address=request.headers.get("X-Forwarded-For", request.client.host if request.client else None),
        user_agent=request.headers.get("User-Agent"),
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Session-Refreshed"] = "1"
    response.set_cookie(security.SESSION_COOKIE_NAME, session_token, **_session_cookie_kwargs(request))
    user_payload = {k: v for k, v in user.items() if k != "id"}
    user_payload["session_expires_at"] = expires_at.isoformat()
    user_payload["session_ttl_seconds"] = security.SESSION_TTL_SECONDS
    return {"user": user_payload}


@router.post("/auth/signup")
def signup(request: Request, payload: dict = Body(...), db: Session = Depends(get_db)):
    result = security.signup_employee(db, payload, allow_admin_creation=False, hospital_id=request_hospital_id(request, db))
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result)
    return result


@router.get("/auth/check-username")
def check_username(request: Request, username: Optional[str] = None, db: Session = Depends(get_db)):
    if not username:
        raise HTTPException(status_code=400, detail={"available": False, "error": "username required"})
    available = not security.check_username_exists(db, username, hospital_id=request_hospital_id(request, db))
    return {"available": available}


@router.post("/auth/setup-admin")
def setup_hospital_admin(request: Request, response: Response, payload: dict = Body(...), db: Session = Depends(get_db), _admin=Depends(require_platform_admin)):
    hospital_id = request_hospital_id(request, db)
    result = security.signup_hospital_admin(db, payload, hospital_id=hospital_id)
    if not result.get("success"):
        message = (result.get("message") or "").lower()
        status = 409 if "already configured" in message else 400
        raise HTTPException(status_code=status, detail=result)

    user = security.authenticate(db, payload.get("username", ""), payload.get("password", ""), hospital_id=hospital_id)
    if not user:
        raise HTTPException(status_code=500, detail={"success": False, "message": "Admin created but automatic login failed."})

    session_token, _exp = security.create_session(
        db, user_id=user["id"], hospital_id=user["hospital_id"],
        ip_address=request.headers.get("X-Forwarded-For", request.client.host if request.client else None),
        user_agent=request.headers.get("User-Agent"),
    )
    response.status_code = 201
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(security.SESSION_COOKIE_NAME, session_token, **_session_cookie_kwargs(request))
    return {"success": True, "message": result["message"], "user": {k: v for k, v in user.items() if k != "id"}}


@router.get("/auth/session")
def auth_session(response: Response, user: Optional[dict] = Depends(get_current_user_optional)):
    response.headers["Cache-Control"] = "no-store"
    return {"user": user}


@router.post("/auth/logout")
def auth_logout(request: Request, response: Response, db: Session = Depends(get_db)):
    from deps import _request_session_token
    token = _request_session_token(request)
    security.delete_session(db, token)
    response.headers["Cache-Control"] = "no-store"
    response.delete_cookie(security.SESSION_COOKIE_NAME, path="/")
    return {"success": True}


@router.post("/admin/create-account")
def admin_create_account(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          hospital_id: int = Depends(current_hospital_id), _gate=Depends(require_permissions("admin.users.create"))):
    forced_payload = {**payload, "user_type": "super_admin", "module_access": list(security.ASSIGNABLE_MODULES)}
    result = security.signup_employee(db, forced_payload, allow_admin_creation=True, hospital_id=hospital_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result)
    return result


@router.get("/admin/users")
def admin_users_list(db: Session = Depends(get_db), _gate=Depends(require_permissions("admin.users.read"))):
    users = rows_to_dicts(lq.get_all_employees(db))
    for user in users:
        user["module_access"] = security.normalize_module_access(
            user.get("module_access"), user.get("user_type"), user.get("access_role"), user.get("role"),
        )
    return {"users": users}


@router.post("/admin/users")
def admin_users_create(payload: dict = Body(...), db: Session = Depends(get_db),
                        hospital_id: int = Depends(current_hospital_id), _gate=Depends(require_permissions("admin.users.create"))):
    requested_type = str(payload.get("user_type", "normal")).strip().lower()
    user_type = "super_admin" if requested_type == "super_admin" else ("admin" if requested_type == "admin" else "normal")
    module_access = list(security.ASSIGNABLE_MODULES) if user_type in ("super_admin", "admin") else payload.get("module_access", [])
    created_payload = {**payload, "user_type": user_type, "module_access": module_access}
    result = security.signup_employee(db, created_payload, allow_admin_creation=True, hospital_id=hospital_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result)
    return result


@router.put("/admin/users/{employee_id}")
def admin_users_update(employee_id: str, payload: dict = Body(...), db: Session = Depends(get_db), _gate=Depends(require_permissions("admin.users.update"))):
    target = lq.get_employee(db, employee_id=employee_id)
    if not target:
        raise HTTPException(status_code=404, detail="Employee not found")
    target = row_to_dict(target)
    requested_type = str(payload.get("user_type", target.get("user_type") or "normal")).strip().lower()
    user_type = "super_admin" if requested_type == "super_admin" else ("admin" if requested_type == "admin" else "normal")
    module_access = (
        list(security.ASSIGNABLE_MODULES) if user_type in ("super_admin", "admin")
        else security.normalize_module_access(payload.get("module_access", []), "normal")
    )
    phones, phone_error = security.normalize_user_phones(payload, partial=True)
    if phone_error:
        raise HTTPException(status_code=400, detail=phone_error)
    updated = lq.update_employee(db, employee_id, {
        **phones,
        "full_name": payload.get("full_name", target.get("full_name")),
        "email": payload.get("email", target.get("email")),
        "department": payload.get("department", target.get("department")),
        "status": payload.get("status", target.get("status") or "active"),
        "address": payload.get("address", target.get("address")),
        "job_role": payload.get("job_role", target.get("job_role")),
        "doctor_name": payload.get("doctor_name", target.get("doctor_name")),
        "access_role": "owner" if user_type == "super_admin" else payload.get("access_role", target.get("access_role")),
        "user_type": user_type,
        "module_access": module_access,
    })
    if not updated:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"success": True, "employee_id": employee_id, "module_access": module_access}


@router.post("/admin/users/{employee_id}/promote")
def admin_promote_user(employee_id: str, db: Session = Depends(get_db), _gate=Depends(require_permissions("admin.users.roles.manage"))):
    target = lq.get_employee(db, employee_id=employee_id)
    if not target:
        raise HTTPException(status_code=404, detail="Employee not found")
    promoted = lq.update_employee(db, employee_id, {
        "user_type": "super_admin", "access_role": "owner", "module_access": list(security.ASSIGNABLE_MODULES),
    })
    if not promoted:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"success": True, "employee_id": employee_id, "user_type": "super_admin"}


# ------------------------------------------------------------- platform --

platform_router = APIRouter(prefix="/api/platform", tags=["platform"])


@platform_router.get("/hospitals")
def platform_hospitals_list(db: Session = Depends(get_db), _gate=Depends(require_platform_admin)):
    return {"hospitals": rows_to_dicts(security.list_hospitals(db))}


@platform_router.post("/hospitals")
def platform_hospitals_create(payload: dict = Body(...), db: Session = Depends(get_db), _gate=Depends(require_platform_admin)):
    hospital_code = validate_hospital_code(payload.get("hospital_code", ""))
    hospital_id, created = security.create_hospital(db, hospital_code, payload.get("name"))
    hospital = security.get_hospital_by_code(db, hospital_code)
    return {"created": created, "hospital_id": hospital_id, "hospital": row_to_dict(hospital)}


@platform_router.post("/hospitals/{hospital_code}/disable")
def platform_hospital_disable(hospital_code: str, payload: dict = Body(default={}), db: Session = Depends(get_db), _gate=Depends(require_platform_admin)):
    code = validate_hospital_code(hospital_code)
    changed = security.set_hospital_status(db, code, "inactive", reason=(payload or {}).get("reason"))
    if not changed:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return {"success": True, "hospital": row_to_dict(security.get_hospital_by_code(db, code))}


@platform_router.post("/hospitals/{hospital_code}/enable")
def platform_hospital_enable(hospital_code: str, db: Session = Depends(get_db), _gate=Depends(require_platform_admin)):
    code = validate_hospital_code(hospital_code)
    changed = security.set_hospital_status(db, code, "active")
    if not changed:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return {"success": True, "hospital": row_to_dict(security.get_hospital_by_code(db, code))}


@platform_router.post("/hospitals/{hospital_code}/admin/reset-password")
def platform_admin_reset_password(hospital_code: str, payload: dict = Body(...), db: Session = Depends(get_db), _gate=Depends(require_platform_admin)):
    code = validate_hospital_code(hospital_code)
    hospital = security.get_hospital_by_code(db, code)
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    result = security.reset_hospital_admin_password(db, hospital.id, payload.get("username", ""), payload.get("new_password", ""))
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result)
    return result
