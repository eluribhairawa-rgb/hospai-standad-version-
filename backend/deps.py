import os
from typing import Optional

from fastapi import Cookie, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

import security
from database import get_db

PLATFORM_ADMIN_USERNAME = (os.getenv("PLATFORM_ADMIN_USERNAME") or "").strip()
PLATFORM_ADMIN_PASSWORD = (os.getenv("PLATFORM_ADMIN_PASSWORD") or "").strip()


def _request_session_token(request: Request) -> Optional[str]:
    token = request.cookies.get(security.SESSION_COOKIE_NAME)
    if token:
        return token
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return None


def get_current_user_optional(request: Request, db: Session = Depends(get_db)) -> Optional[dict]:
    token = _request_session_token(request)
    # Automatic polling (marked by the frontend) must not keep an idle
    # session alive; only real user-driven requests slide the expiry.
    extend = request.headers.get("X-Background-Refresh") != "1"
    user = security.get_session_user(db, token, extend=extend)
    db.close()  # release the pooled connection now; the route may open its own session
    if user and extend:
        # main.py turns this into the X-Session-Refreshed response header, which
        # tells the frontend the server-side idle timer was just reset.
        request.state.session_refreshed = True
    return user


def get_current_user(user: Optional[dict] = Depends(get_current_user_optional)) -> dict:
    """Equivalent of the original @require_session decorator."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


class require_permissions:
    """FastAPI dependency factory equivalent of @require_permissions(...)."""

    def __init__(self, *required_permissions: str):
        self.required_permissions = required_permissions

    def __call__(self, user: dict = Depends(get_current_user)) -> dict:
        user_permissions = security.resolve_user_permissions(user)
        if not all(p in user_permissions for p in self.required_permissions):
            raise HTTPException(
                status_code=403,
                detail={"error": "Forbidden", "required_permissions": list(self.required_permissions)},
            )
        return user


HOSPITAL_OVERVIEW_USER_TYPES = ("admin", "super_admin")


def can_view_hospital_overview(user: Optional[dict]) -> bool:
    """Hospital-wide executive figures (all revenue, collections, beds, every patient's activity).

    Explicitly limited to Admin and Super Admin. Module grants do not unlock it: the
    "reports" module covers the billing Reports & Day Close workflow only, and the
    Analysis page (module "analytics") is not assignable to normal employees.
    """
    return bool(user) and user.get("user_type") in HOSPITAL_OVERVIEW_USER_TYPES


class require_hospital_overview:
    """Dependency for executive-dashboard data: the given permissions plus hospital-overview access."""

    def __init__(self, *required_permissions: str):
        self.base = require_permissions(*required_permissions)

    def __call__(self, user: dict = Depends(get_current_user)) -> dict:
        user = self.base(user)
        if not can_view_hospital_overview(user):
            raise HTTPException(
                status_code=403,
                detail={"error": "Forbidden", "message": "Hospital-wide dashboard data is limited to "
                                                          "Admin and Super Admin logins."},
            )
        return user


def validate_hospital_code(value: str) -> str:
    import re
    code = (value or "").strip().lower()
    if not code:
        raise HTTPException(status_code=400, detail="hospital_code is required")
    if not re.fullmatch(r"[a-z0-9-]{3,64}", code):
        raise HTTPException(status_code=400, detail="hospital_code must contain only lowercase letters, numbers, and '-'")
    return code


def request_hospital_id(request: Request, db: Session = Depends(get_db)) -> int:
    requested_code = request.headers.get("X-Hospital-Code", "")
    code = None
    if requested_code:
        try:
            code = validate_hospital_code(requested_code)
        except HTTPException:
            code = None
    return security.resolve_hospital_id(db, code)


def current_hospital_id(
    request: Request,
    db: Session = Depends(get_db),
    user: Optional[dict] = Depends(get_current_user_optional),
) -> int:
    if user and user.get("hospital_id"):
        return int(user["hospital_id"])
    return request_hospital_id(request, db)


def current_hospital_id_for(user: dict, request: Request, db: Session) -> int:
    """Non-dependency helper for use inside a route body once `user` is
    already resolved via require_permissions()."""
    if user and user.get("hospital_id"):
        return int(user["hospital_id"])
    return request_hospital_id(request, db)


async def require_platform_admin(request: Request):
    body = {}
    try:
        if request.method in ("POST", "PUT"):
            body = await request.json()
    except Exception:
        body = {}
    username = (
        request.headers.get("X-Platform-Admin-Username")
        or request.query_params.get("platform_admin_username")
        or (body or {}).get("platform_admin_username")
        or ""
    ).strip()
    password = (
        request.headers.get("X-Platform-Admin-Password")
        or request.query_params.get("platform_admin_password")
        or (body or {}).get("platform_admin_password")
        or ""
    )

    admin_user = (os.getenv("PLATFORM_ADMIN_USERNAME") or os.getenv("ONBOARDING_ADMIN_USERNAME") or "").strip()
    admin_pass = (os.getenv("PLATFORM_ADMIN_PASSWORD") or os.getenv("ONBOARDING_ADMIN_PASSWORD") or "").strip()

    if not username and not password:
        if not admin_user or not admin_pass:
            raise HTTPException(status_code=503, detail="Platform admin credentials are not configured")
        raise HTTPException(status_code=403, detail="Platform admin authentication failed")

    if not admin_user or not admin_pass or username != admin_user or password != admin_pass:
        raise HTTPException(status_code=403, detail="Platform admin authentication failed")
    return True
