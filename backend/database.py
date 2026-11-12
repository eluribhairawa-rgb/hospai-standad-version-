import os
from contextlib import contextmanager
from datetime import timedelta, timezone

import psycopg2.extensions
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

BASE_DIR = os.path.dirname(__file__)
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
# Same .env resolution order as the original Flask app: project root first,
# then backend/.env, neither overriding already-set environment variables.
load_dotenv(os.path.join(PROJECT_ROOT, ".env"), override=False)
load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)

DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is required. Set it in your .env file, e.g. "
        "DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/hospai"
    )
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg2://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://") and not DATABASE_URL.startswith("postgresql+"):
    DATABASE_URL = "postgresql+psycopg2://" + DATABASE_URL[len("postgresql://"):]

# Time storage is universal: timestamptz columns hold UTC whatever the server's own time zone.
# Every connection works in IST so day boundaries (CURRENT_DATE, ::date, to_char) and naive
# datetimes written by the app mean hospital local time, never the host's zone.
APP_TIMEZONE = "Asia/Kolkata"


def _timestamptz_as_ist(value, cur):
    """Hand timestamptz values to the app as naive IST datetimes, exactly as the app has always
    seen them (the frontend reads an offset-less timestamp as IST)."""
    parsed = psycopg2.extensions.PYDATETIMETZ(value, cur)
    if parsed is None:
        return None
    return parsed.astimezone(IST_TIMEZONE).replace(tzinfo=None) if parsed.tzinfo else parsed


psycopg2.extensions.register_type(psycopg2.extensions.new_type(psycopg2.extensions.PYDATETIMETZ.values, "TIMESTAMPTZ_IST", _timestamptz_as_ist))

engine = create_engine(
    DATABASE_URL, pool_pre_ping=True, future=True,
    connect_args={"options": f"-c timezone={APP_TIMEZONE}"},
    pool_size=int(os.getenv("DB_POOL_SIZE") or 10),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW") or 20),
    pool_timeout=float(os.getenv("DB_POOL_TIMEOUT") or 10),
    pool_recycle=1800,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

IST_TIMEZONE = timezone(timedelta(hours=5, minutes=30))
DEFAULT_HOSPITAL_CODE = (os.getenv("DEFAULT_HOSPITAL_CODE") or "hosp-default").strip().lower()


def get_db():
    """FastAPI dependency: yields a SQLAlchemy Session per-request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Set on a session by get_audited_db(): legacy_sql's conn.commit() then only flushes, and
# common.log_audit_event() commits the action and its audit row in one transaction.
DEFER_COMMIT_KEY = "defer_commit_until_audit"


def get_audited_db():
    """FastAPI dependency for routes that log every write to audit_logs. A write whose
    audit row cannot be stored is rolled back instead of being saved unaudited, and a
    request that fails part-way leaves nothing half-committed."""
    db = SessionLocal()
    db.info[DEFER_COMMIT_KEY] = True
    try:
        yield db
    finally:
        db.close()


@contextmanager
def db_session():
    """Context-manager form for use outside request handlers (startup, scripts)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
