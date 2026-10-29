import os
from contextlib import contextmanager
from datetime import timedelta, timezone

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

engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
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
