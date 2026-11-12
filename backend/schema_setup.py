"""Create or upgrade the database schema at application startup (idempotent)."""
import os

from sqlalchemy import text
import logging

from database import engine

logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = ["migrations_billing_v2.sql", "migrations_insurance_providers.sql", "migrations_user_types.sql", "migrations_grn_item_fields.sql", "migrations_diag_turnaround.sql", "migrations_schema_gaps.sql", "migrations_diag_external_sale.sql", "migrations_patient_reach_surveys.sql", "migrations_ward_indent_ip_orders.sql", "migrations_discharge_summaries.sql", "migrations_diag_result_reagent_lot.sql", "migrations_user_doctor_link.sql", "migrations_nurse_assignments.sql", "migrations_diag_service_types.sql", "migrations_patient_phone_country.sql", "migrations_phone_country_codes.sql", "migrations_pharmacy_profit_indexes.sql", "migrations_admission_payer.sql", "migrations_supplier_payments.sql"]
LOCK_ID = 7482915001


def ensure_schema():
    from models import Base

    # Session-level advisory lock: only one process migrates at a time.
    with engine.connect() as lock_conn:
        lock_conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_ID})
        try:
            Base.metadata.create_all(engine)
            for name in MIGRATIONS:
                path = os.path.join(BASE_DIR, "migrations", name)
                if not os.path.exists(path):
                    logger.info(f"[schema] skip {name} (not found)")
                    continue
                raw = engine.raw_connection()
                try:
                    cur = raw.cursor()
                    with open(path, "r", encoding="utf-8") as f:
                        cur.execute(f.read())
                    raw.commit()
                    logger.info(f"[schema] applied {name}")
                except Exception:
                    raw.rollback()
                    raise
                finally:
                    raw.close()
        finally:
            lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_ID})
            lock_conn.commit()
