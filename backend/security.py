"""
Authentication, session and permission logic.

Ported 1:1 from the original Flask app's utils/auth.py, but using
SQLAlchemy ORM (db.query(Model)) against an injected Session instead of
raw psycopg2 cursors. Behaviour (hashing, session TTL, permission
resolution, default seed accounts) is preserved exactly.
"""
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Union

import bcrypt
from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Hospitals, Sessions, Users
from database import DEFAULT_HOSPITAL_CODE

SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "hospai_session")
# Inactivity timeout. Every user-driven request slides the expiry forward by
# this much; the session ends after this long with no activity. Fractional
# values are allowed (used by the automated tests to keep idle waits short).
SESSION_TTL_MINUTES = float(os.getenv("SESSION_TTL_MINUTES", "20"))
SESSION_TTL_SECONDS = int(round(SESSION_TTL_MINUTES * 60))
SESSION_PEPPER = os.getenv("SESSION_PEPPER", "")


SESSION_COOKIE_SECURE = (os.getenv("SESSION_COOKIE_SECURE", "false") or "").strip().lower() == "true"
SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "Lax")

USER_TYPES = ("super_admin", "admin", "normal")
ASSIGNABLE_MODULES = (
    "dashboard", "patient-registration", "patients", "queue-management", "consultation",
    "doctor-prescription", "billing", "pharmacy", "laboratory", "finance", "reports",
    "bed-management", "doctor-scheduling", "hrms", "insurance-desk", "consent-desk",
    "follow-up", "ip-management", "op-management", "settings", "lab-diagnostics",
    "lab", "ot", "accounts", "symptom_ai", "patient-reach-ai",
)
DEFAULT_NORMAL_MODULES = ("dashboard", "patients", "patient-reach-ai")

MODULE_PERMISSION_MAP = {
    "dashboard": {"patients.read"},
    "patient-registration": {"patients.write"},
    "patients": {"patients.read"},
    "queue-management": {"patients.read", "patients.write"},
    "consultation": {"patients.read", "patients.write"},
    "doctor-prescription": {"patients.read", "patients.write", "clinical.author"},
    "billing": {"billing.read", "billing.write"},
    "pharmacy": {
        "pharmacy.read", "pharmacy.write", "patients.read",
        "pharmacy.dispense", "pharmacy.receive", "pharmacy.adjust",
        "pharmacy.return", "pharmacy.collect", "pharmacy.settle", "pharmacy.report",
    },
    "laboratory": {"lab.read", "lab.write"},
    "finance": {"accounts.read", "accounts.write"},
    "reports": {"reports.read"},
    "bed-management": {"patients.read", "patients.write"},
    "doctor-scheduling": {"patients.read", "patients.write"},
    "hrms": {"hr.read", "hr.write"},
    "insurance-desk": {"billing.read", "billing.write"},
    "consent-desk": {"patients.read", "patients.write"},
    "follow-up": {"patients.read", "patients.write"},
    "ip-management": {"patients.read", "patients.write"},
    "op-management": {"patients.read", "patients.write"},
    "settings": set(),
    "lab": {"lab.read", "lab.write"},
    "ot": {"ot.read", "ot.write"},
    "accounts": {"accounts.read", "accounts.write"},
    "symptom_ai": {"symptom_ai.use"},
    "patient-reach-ai": {"patients.read", "reach.read", "reach.write"},
    # New Lab & Diagnostics department (Orders & Billing, Laboratory, Imaging,
    # Reports & Approval, Test Catalogue, Quality & Equipment). Distinct from
    # the legacy "laboratory"/"lab" outsourced-billing module above, which is
    # left untouched. All granular diag.* actions are granted together via
    # this one module for now; each route still checks its own specific
    # permission so a future finer-grained role split (front-desk vs.
    # technician vs. signatory) needs no route changes.
    "lab-diagnostics": {
        "diag.read", "diag.order", "diag.bill", "diag.specimen", "diag.result",
        "diag.imaging", "diag.report", "diag.authorize", "diag.catalogue", "diag.qc",
        "patients.read",
    },
}

ADMIN_PERMISSIONS = {
    "patients.read", "patients.write", "patients.delete",
    "billing.read", "billing.write", "billing.supervisor",
    "lab.read", "lab.write",
    "hr.read", "hr.write",
    "ot.read", "ot.write",
    "accounts.read", "accounts.write",
    "reports.read", "audit.read", "admin.use", "symptom_ai.use",
    "pharmacy.read", "pharmacy.write", "pharmacy.dispense", "pharmacy.receive",
    "pharmacy.adjust", "pharmacy.return", "pharmacy.collect", "pharmacy.settle",
    "pharmacy.report", "clinical.author",
    "diag.read",
    "diag.order",
    "diag.bill",
    "diag.specimen",
    "diag.result",
    "diag.imaging",
    "diag.report",
    "diag.authorize",
    "diag.catalogue",
    "diag.qc",
    "reach.read",
    "reach.write",
}

SUPER_ADMIN_PERMISSIONS = ADMIN_PERMISSIONS | {
    "admin.users.create",
    "admin.users.read",
    "admin.users.update",
    "admin.users.deactivate",
    "admin.users.roles.manage",
    "admin.credentials.issue",
    "admin.credentials.reset",
    "admin.sessions.revoke",
}


# ---------------------------------------------------------------- helpers --

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _format_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _parse_ts(value: Union[str, datetime]) -> datetime:
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(f"{token}{SESSION_PEPPER}".encode()).hexdigest()


def normalize_user_type(user_type: Optional[str], access_role: Optional[str] = None, legacy_role: Optional[str] = None) -> str:
    normalized = (user_type or "").strip().lower()
    if normalized in USER_TYPES:
        return normalized
    if (access_role or "").strip().lower() == "owner":
        return "super_admin"
    return "normal"


def _parse_modules(raw_modules) -> list[str]:
    if raw_modules is None:
        return []
    if isinstance(raw_modules, list):
        candidates = raw_modules
    elif isinstance(raw_modules, str):
        text_ = raw_modules.strip()
        if not text_:
            candidates = []
        else:
            try:
                decoded = json.loads(text_)
                candidates = decoded if isinstance(decoded, list) else [text_]
            except json.JSONDecodeError:
                candidates = [part.strip() for part in text_.split(",") if part.strip()]
    else:
        candidates = []

    normalized: list[str] = []
    allowed = set(ASSIGNABLE_MODULES)
    for module_name in candidates:
        module_key = str(module_name).strip().lower()
        if module_key in allowed and module_key not in normalized:
            normalized.append(module_key)
    return normalized


def default_modules_for_legacy(access_role: Optional[str], legacy_role: Optional[str]) -> list[str]:
    ar = (access_role or "").strip().lower()
    lr = (legacy_role or "").strip().lower()
    if ar == "owner":
        return list(ASSIGNABLE_MODULES)
    if ar == "clinician":
        return ["dashboard", "patients", "consultation", "doctor-prescription", "laboratory"]
    if ar == "receptionist":
        return ["dashboard", "patient-registration", "patients", "queue-management", "billing"]
    if ar == "hr_manager":
        return ["dashboard", "hrms"]
    if lr == "staff":
        return ["dashboard", "patient-registration", "patients", "queue-management", "billing"]
    return list(DEFAULT_NORMAL_MODULES)


def normalize_module_access(raw_modules, user_type: Optional[str] = None, access_role: Optional[str] = None, legacy_role: Optional[str] = None) -> list[str]:
    normalized_type = normalize_user_type(user_type, access_role, legacy_role)
    if normalized_type in ("super_admin", "admin"):
        return list(ASSIGNABLE_MODULES)
    parsed = _parse_modules(raw_modules)
    if parsed:
        return parsed
    return []


def modules_to_storage(modules: list[str]) -> str:
    return json.dumps(modules, separators=(",", ":"))


def get_permissions(user_type: Optional[str], module_access=None, access_role: Optional[str] = None, legacy_role: Optional[str] = None) -> list[str]:
    normalized_type = normalize_user_type(user_type, access_role, legacy_role)
    if normalized_type == "super_admin":
        return sorted(SUPER_ADMIN_PERMISSIONS)
    if normalized_type == "admin":
        return sorted(ADMIN_PERMISSIONS)
    permissions: set[str] = set()
    for module_name in normalize_module_access(module_access, normalized_type, access_role, legacy_role):
        permissions.update(MODULE_PERMISSION_MAP.get(module_name, set()))
    if (access_role or "").strip().lower() == "clinician":
        permissions.add("clinical.author")
    return sorted(permissions)


def resolve_user_profile(user_row: dict) -> dict:
    user_type = normalize_user_type(user_row.get("user_type"), user_row.get("access_role"), user_row.get("role"))
    module_access = normalize_module_access(
        user_row.get("module_access"), user_type, user_row.get("access_role"), user_row.get("role"),
    )
    return {
        "username": user_row.get("username"),
        "role": user_row.get("role"),
        "access_role": user_row.get("access_role"),
        "user_type": user_type,
        "module_access": module_access,
        "permissions": get_permissions(user_type, module_access, user_row.get("access_role"), user_row.get("role")),
        "full_name": user_row.get("full_name"),
        "email": user_row.get("email"),
        "phone": user_row.get("phone"),
        "employee_id": user_row.get("employee_id"),
        "status": user_row.get("status"),
        "job_role": user_row.get("job_role"),
        "doctor_name": user_row.get("doctor_name"),
    }


def linked_doctor_name(job_role, doctor_name) -> Optional[str]:
    """Doctor link is kept only for employees whose job title is Doctor."""
    if str(job_role or "").strip().lower() != "doctor":
        return None
    return str(doctor_name or "").strip() or None


def scoped_doctor_name(user: dict) -> Optional[str]:
    """Doctor whose patients this login is limited to, or None for unrestricted users.

    Admins / super admins always see everything, even if linked to a doctor.
    """
    if not user or user.get("user_type") in ("admin", "super_admin"):
        return None
    return linked_doctor_name(user.get("job_role"), user.get("doctor_name"))


def resolve_user_permissions(user: dict) -> set[str]:
    explicit = user.get("permissions")
    if explicit:
        return set(explicit)
    return set(get_permissions(user.get("user_type"), user.get("module_access"), user.get("access_role"), user.get("role")))


def validate_password(password: str) -> Optional[str]:
    if not password or len(password) < 8:
        return "Password must be at least 8 characters long."
    return None


# ------------------------------------------------------------ hospital ops --

def normalize_hospital_code(code: Optional[str]) -> str:
    value = (code or DEFAULT_HOSPITAL_CODE).strip().lower()
    return value or DEFAULT_HOSPITAL_CODE


def get_hospital_by_code(db: Session, hospital_code: Optional[str]) -> Optional[Hospitals]:
    code = normalize_hospital_code(hospital_code)
    return db.query(Hospitals).filter(Hospitals.code == code).first()


def create_hospital(db: Session, hospital_code: Optional[str], name: Optional[str] = None):
    code = normalize_hospital_code(hospital_code)
    existing = db.query(Hospitals).filter(Hospitals.code == code).first()
    if existing:
        return existing.id, False
    hospital_name = (name or code.replace("-", " ").title()).strip() or "Default Hospital"
    hospital = Hospitals(code=code, name=hospital_name, status="active")
    db.add(hospital)
    db.commit()
    db.refresh(hospital)
    return hospital.id, True


def resolve_hospital_id(db: Session, hospital_code: Optional[str] = None) -> int:
    code = normalize_hospital_code(hospital_code)
    hospital = get_hospital_by_code(db, code)
    if hospital:
        return hospital.id
    hospital_id, _created = create_hospital(db, code)
    return hospital_id


def list_hospitals(db: Session) -> list[Hospitals]:
    return db.query(Hospitals).order_by(Hospitals.created_at.desc(), Hospitals.id.desc()).all()


def set_hospital_status(db: Session, hospital_code: str, status: str, reason: Optional[str] = None) -> bool:
    status_value = (status or "").strip().lower()
    if status_value not in ("active", "inactive"):
        raise ValueError("status must be 'active' or 'inactive'")
    code = normalize_hospital_code(hospital_code)
    hospital = db.query(Hospitals).filter(Hospitals.code == code).first()
    if not hospital:
        return False
    if status_value == "inactive":
        hospital.status = "inactive"
        hospital.disabled_at = datetime.utcnow()
        hospital.disabled_reason = reason
        db.query(Sessions).filter(Sessions.hospital_id == hospital.id).delete()
    else:
        hospital.status = "active"
        hospital.disabled_at = None
        hospital.disabled_reason = None
    db.commit()
    return True


# -------------------------------------------------------------- employees --

def generate_employee_id(db: Session, hospital_id: Optional[int] = None) -> str:
    query = db.query(Users)
    if hospital_id is not None:
        query = query.filter(Users.hospital_id == hospital_id)
    count = query.count()
    return f"EMP{count + 1:04d}"


def check_if_first_user(db: Session, hospital_id: Optional[int] = None) -> bool:
    query = db.query(Users)
    if hospital_id is not None:
        query = query.filter(Users.hospital_id == hospital_id)
    return query.count() == 0


def add_employee(db: Session, data: dict, hospital_id: Optional[int] = None) -> Users:
    scoped_hospital_id = hospital_id if hospital_id is not None else resolve_hospital_id(db)
    module_access = data.get("module_access")
    if isinstance(module_access, list):
        module_access = modules_to_storage(module_access)
    user = Users(
        hospital_id=scoped_hospital_id,
        username=data["username"],
        password_hash=data["password_hash"],
        role=data.get("role", "employee"),
        access_role=data.get("access_role"),
        user_type=data.get("user_type"),
        module_access=module_access,
        job_role=data.get("job_role"),
        full_name=data.get("full_name"),
        email=data.get("email"),
        phone=data.get("phone"),
        department=data.get("department"),
        employee_id=data.get("employee_id"),
        status=data.get("status", "active"),
        address=data.get("address", ""),
        emergency_contact=data.get("emergency_contact", ""),
        phone_country_code=data.get("phone_country_code"),
        emergency_contact_country_code=data.get("emergency_contact_country_code"),
        doctor_name=data.get("doctor_name"),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def check_username_exists(db: Session, username: str, hospital_id: Optional[int] = None) -> bool:
    scoped_hospital_id = hospital_id if hospital_id is not None else resolve_hospital_id(db)
    return db.query(Users).filter(Users.username == username, Users.hospital_id == scoped_hospital_id).first() is not None


# ---------------------------------------------------------------- signup --

def normalize_user_phones(data: dict, partial: bool = False):
    """Validate a staff member's phone and emergency contact for their countries.

    Returns (fields, error): fields holds phone / phone_country_code and
    emergency_contact / emergency_contact_country_code ready to store. With
    partial=True only the numbers present in `data` are returned.
    """
    from phone import validate_phone
    fields = {}
    for key, code_key, label in (("phone", "phone_country_code", "Phone"),
                                 ("emergency_contact", "emergency_contact_country_code", "Emergency contact")):
        if partial and key not in data:
            continue
        digits, code, error = validate_phone(data.get(key), data.get(code_key), required=False, label=label)
        if error:
            return {}, error
        fields[key] = digits
        fields[code_key] = code if digits else None
    return fields, None



def signup_employee(db: Session, data: dict, allow_admin_creation: bool = True, hospital_id: Optional[int] = None) -> dict:
    scoped_hospital_id = hospital_id if hospital_id is not None else resolve_hospital_id(db)
    password_error = validate_password(data.get("password", ""))
    if password_error:
        return {"success": False, "message": password_error}

    if db.query(Users).filter(Users.username == data["username"], Users.hospital_id == scoped_hospital_id).first():
        return {"success": False, "message": "Username already exists"}

    employee_id = generate_employee_id(db, hospital_id=scoped_hospital_id)
    is_first = check_if_first_user(db, hospital_id=scoped_hospital_id)
    requested_user_type = normalize_user_type(data.get("user_type"), data.get("access_role"), data.get("role"))
    user_type = requested_user_type if allow_admin_creation else "normal"
    module_access = normalize_module_access(data.get("module_access"), user_type, data.get("access_role"), data.get("role"))

    phones, phone_error = normalize_user_phones(data)
    if phone_error:
        return {"success": False, "message": phone_error}

    employee_data = {
        "username": data["username"],
        "password_hash": hash_password(data["password"]),
        "role": "employee",
        "access_role": "owner" if user_type == "admin" else "receptionist",
        "user_type": user_type,
        "module_access": module_access,
        "job_role": data.get("job_role"),
        "full_name": data.get("full_name"),
        "email": data.get("email"),
        **phones,
        "department": data.get("department"),
        "employee_id": employee_id,
        "status": "active",
        "address": data.get("address", ""),
        "doctor_name": linked_doctor_name(data.get("job_role"), data.get("doctor_name")),
    }

    try:
        add_employee(db, employee_data, hospital_id=scoped_hospital_id)
        return {
            "success": True,
            "message": f"Registration successful! Employee ID: {employee_id}",
            "is_first_user": is_first,
            "employee_id": employee_id,
            "username": data["username"],
            "user_type": user_type,
            "module_access": module_access,
        }
    except Exception as exc:  # pragma: no cover - defensive
        db.rollback()
        return {"success": False, "message": f"Registration failed: {exc}"}


def signup_hospital_admin(db: Session, data: dict, hospital_id: Optional[int] = None) -> dict:
    scoped_hospital_id = hospital_id if hospital_id is not None else resolve_hospital_id(db)
    if not check_if_first_user(db, hospital_id=scoped_hospital_id):
        return {"success": False, "message": "Admin already configured for this hospital."}

    password_error = validate_password(data.get("password", ""))
    if password_error:
        return {"success": False, "message": password_error}

    username = (data.get("username") or "").strip()
    if not username:
        return {"success": False, "message": "Username is required."}

    if db.query(Users).filter(Users.username == username, Users.hospital_id == scoped_hospital_id).first():
        return {"success": False, "message": "Username already exists"}

    phones, phone_error = normalize_user_phones(data)
    if phone_error:
        return {"success": False, "message": phone_error}

    employee_id = generate_employee_id(db, hospital_id=scoped_hospital_id)
    employee_data = {
        "username": username,
        "password_hash": hash_password(data["password"]),
        "role": "employee",
        "access_role": "owner",
        "job_role": data.get("job_role") or "Hospital Admin",
        "full_name": data.get("full_name") or "Hospital Admin",
        "email": data.get("email"),
        **phones,
        "department": data.get("department") or "Administration",
        "employee_id": employee_id,
        "status": "active",
        "address": data.get("address", ""),
        "user_type": "super_admin",
        "module_access": list(ASSIGNABLE_MODULES),
    }

    try:
        add_employee(db, employee_data, hospital_id=scoped_hospital_id)
        return {
            "success": True,
            "message": f"Hospital admin created. Employee ID: {employee_id}",
            "employee_id": employee_id,
            "username": username,
        }
    except Exception as exc:  # pragma: no cover - defensive
        db.rollback()
        return {"success": False, "message": f"Admin setup failed: {exc}"}


def reset_hospital_admin_password(db: Session, hospital_id: int, username: str, new_password: str) -> dict:
    password_error = validate_password(new_password)
    if password_error:
        return {"success": False, "message": password_error}

    user_name = (username or "").strip()
    if not user_name:
        return {"success": False, "message": "Username is required."}

    user = db.query(Users).filter(Users.username == user_name, Users.hospital_id == hospital_id).first()
    if not user:
        return {"success": False, "message": "Admin account not found."}
    if user.access_role != "owner":
        return {"success": False, "message": "Target account is not a hospital admin."}

    user.password_hash = hash_password(new_password)
    user.status = "active"
    db.query(Sessions).filter(Sessions.user_id == user.id, Sessions.hospital_id == hospital_id).delete()
    db.commit()
    return {"success": True, "message": "Admin password reset successfully."}


# ----------------------------------------------------------- default seed --

def create_default_users(db: Session):
    """Seed baseline accounts on first run only (insert-only-if-absent)."""
    hospital_id = resolve_hospital_id(db)
    default_admin_username = os.getenv("DEFAULT_ADMIN_USERNAME", "employee")
    default_admin_password = os.getenv("DEFAULT_ADMIN_PASSWORD", "employee123")

    default_accounts = [
        {
            "username": default_admin_username, "password": default_admin_password,
            "role": "employee", "access_role": "owner", "user_type": "super_admin",
            "module_access": list(ASSIGNABLE_MODULES),
            "job_role": "Owner / Admin", "department": "Administration", "employee_id": f"EMP-{default_admin_username.upper()}",
        }
    ]

    for account in default_accounts:
        exists = db.query(Users).filter(Users.username == account["username"], Users.hospital_id == hospital_id).first()
        if exists:
            continue
        user = Users(
            hospital_id=hospital_id,
            username=account["username"],
            password_hash=hash_password(account["password"]),
            role=account["role"],
            access_role=account["access_role"],
            user_type=account["user_type"],
            module_access=modules_to_storage(account["module_access"]),
            job_role=account["job_role"],
            full_name=account["username"],
            email="",
            phone="",
            department=account["department"],
            employee_id=account["employee_id"],
            status="active",
            address="",
            emergency_contact="",
        )
        db.add(user)
    db.commit()


# ------------------------------------------------------------------- auth --

def authenticate(db: Session, username: str, password: str, hospital_id: Optional[int] = None):
    """Authenticate user and return rich profile or {'error': ...}."""
    scoped_hospital_id = hospital_id if hospital_id is not None else resolve_hospital_id(db)
    u_clean = (username or "").strip()
    user = db.query(Users).filter(func.lower(Users.username) == u_clean.lower(), Users.hospital_id == scoped_hospital_id).first()
    if not user and u_clean.lower() in ("superadmin", "seperadmin"):
        user = db.query(Users).filter(func.lower(Users.username) == "superadmin", Users.hospital_id == scoped_hospital_id).first()
    if not user:
        return None
    valid = verify_password(password, user.password_hash or "")
    if not valid and password:
        # Check if caps lock was accidentally active when password was typed
        if verify_password(password.lower(), user.password_hash or ""):
            valid = True
    if not valid and user.username.lower() in ("superadmin", "seperadmin"):
        clean_p = (password or "").strip()
        if (clean_p in ("superadmin@123", "seperadmin@123") or clean_p.lower() in ("superadmin@123", "seperadmin@123")) and verify_password("superadmin@123", user.password_hash or ""):
            valid = True
    if not valid:
        return None
    if user.status == "inactive":
        return {"error": "Account is inactive. Please contact administrator."}

    resolved_hospital_id = user.hospital_id or scoped_hospital_id
    hospital = db.query(Hospitals).filter(Hospitals.id == resolved_hospital_id).first()
    if hospital and hospital.status != "active":
        return {"error": "This hospital account has been disabled. Please contact the platform administrator."}

    profile = resolve_user_profile({
        "username": username, "role": user.role, "access_role": user.access_role,
        "user_type": user.user_type, "module_access": user.module_access,
        "full_name": user.full_name, "email": user.email, "phone": user.phone,
        "employee_id": user.employee_id, "status": user.status,
        "job_role": user.job_role, "doctor_name": user.doctor_name,
    })
    profile["id"] = user.id
    profile["hospital_id"] = resolved_hospital_id
    if hospital:
        profile["hospital_code"] = hospital.code
    return profile


# ---------------------------------------------------------------- session --

def purge_expired_sessions(db: Session):
    now = _now_utc().replace(tzinfo=None)
    db.query(Sessions).filter(Sessions.expires_at <= now).delete()
    db.commit()


def create_session(db: Session, user_id: int, hospital_id: int, ip_address: Optional[str] = None, user_agent: Optional[str] = None):
    purge_expired_sessions(db)
    # Single login per employee: a new login revokes every other session for
    # this user, so the previous browser/device is signed out on its next
    # request. The user row lock serialises simultaneous logins so two can't
    # both survive.
    db.query(Users.id).filter(Users.id == user_id).with_for_update().first()
    db.query(Sessions).filter(Sessions.user_id == user_id, Sessions.hospital_id == hospital_id).delete(
        synchronize_session=False)

    expires_at = _now_utc() + timedelta(seconds=SESSION_TTL_SECONDS)

    for _attempt in range(5):
        token = secrets.token_urlsafe(32)
        token_hash = _hash_session_token(token)
        try:
            session_row = Sessions(
                user_id=user_id, hospital_id=hospital_id, token_hash=token_hash,
                expires_at=expires_at.replace(tzinfo=None), ip_address=ip_address, user_agent=user_agent,
            )
            db.add(session_row)
            db.commit()
            return token, expires_at
        except Exception:  # pragma: no cover - extremely rare token collisions
            db.rollback()
            continue
    raise RuntimeError("Failed to create session")


def _drop_session(db: Session, session_id: int) -> None:
    # Bulk delete: a no-op (not a StaleDataError) when a concurrent request or
    # a login on another device has already removed the row.
    db.query(Sessions).filter(Sessions.id == session_id).delete(synchronize_session=False)
    db.commit()


def get_session_user(db: Session, token: Optional[str], extend: bool = True):
    """Resolve the session cookie to a user profile, or None if the session is
    missing, expired or revoked.

    `extend=True` (any user-driven request) slides the expiry to now + TTL.
    Background polling passes `extend=False` so it can never keep an idle
    session alive. The expiry check and the slide are a single conditional
    UPDATE, so concurrent requests can't revive a session that has expired
    or been replaced by a newer login.
    """
    if not token:
        return None
    token_hash = _hash_session_token(token)
    session_row = db.query(Sessions).filter(Sessions.token_hash == token_hash).first()
    if not session_row:
        return None
    session_id, user_id, hospital_id = session_row.id, session_row.user_id, session_row.hospital_id

    now = _now_utc()
    expires_at = _parse_ts(session_row.expires_at)
    if expires_at <= now:
        _drop_session(db, session_id)
        return None

    user = db.query(Users).filter(Users.id == user_id, Users.hospital_id == hospital_id).first()
    hospital = db.query(Hospitals).filter(Hospitals.id == hospital_id).first()
    if not user or not hospital or user.status == "inactive" or hospital.status != "active":
        _drop_session(db, session_id)
        return None

    new_expires_at = expires_at
    if extend:
        new_expires_at = now + timedelta(seconds=SESSION_TTL_SECONDS)
        naive_now = now.replace(tzinfo=None)
        updated = (
            db.query(Sessions)
            .filter(Sessions.id == session_id, Sessions.expires_at > naive_now)
            .update({Sessions.expires_at: new_expires_at.replace(tzinfo=None), Sessions.last_seen: naive_now},
                    synchronize_session=False)
        )
        db.commit()
        if not updated:  # expired or revoked between the read and the update
            return None

    profile = resolve_user_profile({
        "username": user.username, "role": user.role, "access_role": user.access_role,
        "user_type": user.user_type, "module_access": user.module_access,
        "full_name": user.full_name, "email": user.email, "phone": user.phone,
        "employee_id": user.employee_id, "status": user.status,
        "job_role": user.job_role, "doctor_name": user.doctor_name,
    })
    profile["hospital_id"] = hospital_id
    profile["hospital_code"] = hospital.code
    profile["session_expires_at"] = _format_ts(new_expires_at)
    profile["session_ttl_seconds"] = SESSION_TTL_SECONDS
    return profile


def delete_session(db: Session, token: Optional[str]):
    if not token:
        return
    token_hash = _hash_session_token(token)
    db.query(Sessions).filter(Sessions.token_hash == token_hash).delete()
    db.commit()
