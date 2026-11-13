"""
Business-logic query layer, ported from the current Flask app's
utils/database.py (includes the Lab & Diagnostics module, bed
management, and all other updates as of this sync).

All DB-touching functions here take `db: Session` (the FastAPI-injected
SQLAlchemy session) as their first argument and run their SQL through
`legacy_sql.get_connection(db)` / `legacy_sql.run(db, ...)` - i.e. the
SAME session FastAPI injected via Depends(get_db), never a separate
connection.
"""
import os
import json
import hashlib
import math
import re
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session
from database import IST_TIMEZONE, DEFAULT_HOSPITAL_CODE
from legacy_sql import get_connection
from security import (
    linked_doctor_name,
    resolve_hospital_id, get_hospital_by_code, create_hospital,
    generate_employee_id, add_employee, check_if_first_user,
    normalize_hospital_code,
)


def current_ist_datetime():
    return datetime.now(IST_TIMEZONE)



def current_ist_timestamp():
    return current_ist_datetime().isoformat(timespec="seconds")



def date_clause(column_name):
    return f"DATE(timezone('Asia/Kolkata', CAST({column_name} AS timestamptz)))"


class RevenueService:
    @staticmethod
    def get_today_collections(db, target_date):
        date_col_ip = date_clause("created_at")
        date_col_d = date_clause("created_at")
        date_col_ps = date_clause("sold_at")
        date_col_i = date_clause("created_at")

        with get_connection(db) as conn:
            cursor = conn.cursor()
            
            # invoice payments amount
            cursor.execute(f"SELECT COALESCE(SUM(amount), 0) FROM invoice_payments WHERE {date_col_ip} = DATE(?)", (target_date,))
            ip_paid = cursor.fetchone()[0] or 0.0
            
            # initial invoice payments that were paid on invoice creation but do not have entries in invoice_payments
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(
                    CASE
                        WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                        THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                        ELSE 0
                    END
                ), 0)
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                WHERE {date_col_i} = DATE(?)
                """,
                (target_date,)
            )
            i_initial_paid = cursor.fetchone()[0] or 0.0
            
            # diagnostics paid_amount
            cursor.execute(f"SELECT COALESCE(SUM(paid_amount), 0) FROM diagnostics WHERE {date_col_d} = DATE(?) AND (invoice_no IS NULL OR TRIM(invoice_no) = '')", (target_date,))
            d_paid = cursor.fetchone()[0] or 0.0
            
            # pharmacy sales amount
            cursor.execute(f"SELECT COALESCE(SUM(amount), 0) FROM pharmacy_sales WHERE {date_col_ps} = DATE(?) AND invoice_id IS NULL", (target_date,))
            ps_paid = cursor.fetchone()[0] or 0.0
            
            return float(ip_paid + i_initial_paid + d_paid + ps_paid)

    @staticmethod
    def get_today_lab_revenue(db, target_date):
        date_col_ip = date_clause("ip.created_at")
        date_col_i = date_clause("i.created_at")
        date_col_d = date_clause("created_at")
        with get_connection(db) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(ip.amount), 0)
                FROM invoice_payments ip
                JOIN invoices i ON i.id = ip.invoice_id
                WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') AND {date_col_ip} = DATE(?)
                """,
                (target_date,)
            )
            paid_ip = cursor.fetchone()[0] or 0.0

            cursor.execute(
                f"""
                SELECT COALESCE(SUM(
                    CASE
                        WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                        THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                        ELSE 0
                    END
                ), 0)
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') AND {date_col_i} = DATE(?)
                """,
                (target_date,)
            )
            paid_i = cursor.fetchone()[0] or 0.0

            cursor.execute(
                f"SELECT COALESCE(SUM(paid_amount), 0) FROM diagnostics WHERE {date_col_d} = DATE(?) AND (invoice_no IS NULL OR TRIM(invoice_no) = '')",
                (target_date,)
            )
            paid_d = cursor.fetchone()[0] or 0.0

            return float(paid_ip + paid_i + paid_d)

    @staticmethod
    def get_today_lab_earned(db, target_date):
        date_col_i = date_clause("created_at")
        date_col_d = date_clause("created_at")
        with get_connection(db) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(total_amount), 0)
                FROM invoices
                WHERE module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') AND {date_col_i} = DATE(?)
                """,
                (target_date,)
            )
            inv_earned = cursor.fetchone()[0] or 0.0

            cursor.execute(
                f"SELECT COALESCE(SUM(amount), 0) FROM diagnostics WHERE {date_col_d} = DATE(?) AND (invoice_no IS NULL OR TRIM(invoice_no) = '')",
                (target_date,)
            )
            d_earned = cursor.fetchone()[0] or 0.0

            return float(inv_earned + d_earned)

    @staticmethod
    def get_today_pharmacy_revenue(db, target_date):
        date_col_ps = date_clause("sold_at")
        with get_connection(db) as conn:
            cursor = conn.cursor()
            cursor.execute(f"SELECT COALESCE(SUM(amount), 0) FROM pharmacy_sales WHERE {date_col_ps} = DATE(?)", (target_date,))
            return float(cursor.fetchone()[0] or 0.0)

    @staticmethod
    def get_today_outstanding(db, target_date):
        date_col_i = date_clause("created_at")
        date_col_d = date_clause("created_at")
        with get_connection(db) as conn:
            cursor = conn.cursor()
            
            # today's unpaid invoices
            cursor.execute(f"SELECT COALESCE(SUM(due_amount), 0) FROM invoices WHERE {date_col_i} = DATE(?) AND due_amount > 0", (target_date,))
            i_due = cursor.fetchone()[0] or 0.0
            
            # today's unpaid diagnostics
            cursor.execute(f"SELECT COALESCE(SUM(due_amount), 0) FROM diagnostics WHERE {date_col_d} = DATE(?) AND due_amount > 0 AND (invoice_no IS NULL OR TRIM(invoice_no) = '')", (target_date,))
            d_due = cursor.fetchone()[0] or 0.0
            
            return float(i_due + d_due)

    @staticmethod
    def get_today_doctor_payout(db, target_date):
        date_col_dp = date_clause("COALESCE(paid_date, created_at)")
        with get_connection(db) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(
                    CASE
                        WHEN COALESCE(due_amount, 0) > 0 THEN due_amount
                        WHEN LOWER(COALESCE(status, '')) IN ('pending', 'partial') THEN GREATEST(COALESCE(amount, 0) - COALESCE(paid_amount, 0), 0)
                        ELSE 0
                    END
                ), 0)
                FROM doctor_payouts
                WHERE {date_col_dp} = DATE(?)
                """,
                (target_date,)
            )
            return float(cursor.fetchone()[0] or 0.0)



def ensure_lab_diagnostics_tables(conn):
    cursor = conn.cursor()
    id_column = "SERIAL PRIMARY KEY"

    # ---- Test Catalogue ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_services (
            id {id_column},
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            service_type TEXT NOT NULL CHECK(service_type IN ('LAB', 'IMAGING', 'OTHER')),
            department TEXT,
            active BOOLEAN DEFAULT TRUE,
            turnaround_time TEXT,
            preparation_requirements TEXT,
            specimen_type TEXT,
            container_type TEXT,
            modality TEXT,
            body_region TEXT,
            laterality TEXT,
            requires_scheduling BOOLEAN DEFAULT FALSE,
            report_template TEXT DEFAULT 'generic',
            rate REAL NOT NULL DEFAULT 0,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        SELECT column_name FROM information_schema.columns WHERE table_name = 'diag_services'
        """
    )
    diag_services_columns = {row[0] for row in cursor.fetchall()}
    if "turnaround_hours" not in diag_services_columns:
        cursor.execute("ALTER TABLE diag_services ADD COLUMN turnaround_hours REAL")

    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_service_parameters (
            id {id_column},
            service_id INTEGER NOT NULL REFERENCES diag_services(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            data_type TEXT NOT NULL DEFAULT 'numeric' CHECK(data_type IN ('numeric', 'text', 'qualitative')),
            unit TEXT,
            method TEXT,
            ref_low REAL,
            ref_high REAL,
            ref_text TEXT,
            critical_low REAL,
            critical_high REAL,
            sex_specific TEXT CHECK(sex_specific IS NULL OR sex_specific IN ('M', 'F')),
            age_min INTEGER,
            age_max INTEGER,
            display_order INTEGER DEFAULT 0,
            calc_formula TEXT,
            comments TEXT
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_service_pricing_history (
            id {id_column},
            service_id INTEGER NOT NULL REFERENCES diag_services(id) ON DELETE CASCADE,
            rate REAL NOT NULL,
            payer_type TEXT DEFAULT 'standard',
            effective_from DATE DEFAULT CURRENT_DATE,
            changed_by TEXT,
            changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_packages (
            id {id_column},
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            active BOOLEAN DEFAULT TRUE,
            rate REAL NOT NULL DEFAULT 0,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_package_items (
            id {id_column},
            package_id INTEGER NOT NULL REFERENCES diag_packages(id) ON DELETE CASCADE,
            service_id INTEGER NOT NULL REFERENCES diag_services(id) ON DELETE CASCADE,
            UNIQUE(package_id, service_id)
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_report_templates (
            id {id_column},
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            report_type TEXT NOT NULL CHECK(report_type IN ('LAB', 'IMAGING')),
            layout TEXT NOT NULL DEFAULT 'structured' CHECK(layout IN ('structured', 'narrative')),
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # ---- Orders & Billing ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_orders (
            id {id_column},
            order_no TEXT UNIQUE NOT NULL,
            patient_id TEXT,
            sale_type TEXT NOT NULL DEFAULT 'INTERNAL',
            walkin_name TEXT,
            walkin_mobile TEXT,
            walkin_age TEXT,
            walkin_gender TEXT,
            encounter_type TEXT NOT NULL CHECK(encounter_type IN ('OP', 'IP', 'EMERGENCY', 'EXTERNAL')),
            appointment_id INTEGER,
            admission_id INTEGER,
            external_source TEXT,
            referring_clinician TEXT,
            priority TEXT NOT NULL DEFAULT 'Routine' CHECK(priority IN ('Routine', 'Urgent', 'STAT')),
            clinical_indication TEXT,
            notes TEXT,
            source_document_id INTEGER,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed', 'cancelled')),
            invoice_id INTEGER,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_order_items (
            id {id_column},
            order_id INTEGER NOT NULL REFERENCES diag_orders(id) ON DELETE CASCADE,
            service_id INTEGER NOT NULL REFERENCES diag_services(id),
            service_name TEXT NOT NULL,
            department_type TEXT NOT NULL CHECK(department_type IN ('LAB', 'IMAGING', 'OTHER')),
            quantity INTEGER NOT NULL DEFAULT 1,
            rate REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            progress_status TEXT NOT NULL DEFAULT 'ordered',
            is_duplicate_repeat BOOLEAN DEFAULT FALSE,
            duplicate_reason TEXT,
            cancelled_at TIMESTAMP,
            cancel_reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        SELECT column_name FROM information_schema.columns WHERE table_name = 'diag_order_items'
        """
    )
    diag_item_columns = {row[0] for row in cursor.fetchall()}
    if "discharge_invoice_id" not in diag_item_columns:
        cursor.execute("ALTER TABLE diag_order_items ADD COLUMN discharge_invoice_id INTEGER")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_orders_patient ON diag_orders(patient_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_orders_admission ON diag_orders(admission_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_order_items_order ON diag_order_items(order_id)")

    # ---- Laboratory ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_specimens (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            specimen_no TEXT UNIQUE NOT NULL,
            container_type TEXT,
            collection_location TEXT,
            identity_verified BOOLEAN DEFAULT FALSE,
            collected_by TEXT,
            collected_at TIMESTAMP,
            collection_notes TEXT,
            status TEXT NOT NULL DEFAULT 'awaiting_collection' CHECK(status IN ('awaiting_collection', 'collected', 'received', 'rejected')),
            received_by TEXT,
            received_at TIMESTAMP,
            condition_on_receipt TEXT,
            rejection_reason TEXT,
            replaces_specimen_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_results (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            specimen_id INTEGER,
            parameter_id INTEGER,
            parameter_name TEXT NOT NULL,
            equipment_id INTEGER,
            value_text TEXT,
            value_numeric REAL,
            unit TEXT,
            method TEXT,
            ref_range_text TEXT,
            ref_low REAL,
            ref_high REAL,
            flag TEXT CHECK(flag IS NULL OR flag IN ('normal', 'high', 'low', 'critical_high', 'critical_low', 'abnormal')),
            is_draft BOOLEAN DEFAULT TRUE,
            entered_by TEXT,
            entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT,
            updated_at TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_external_referrals (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            vendor_id INTEGER,
            dispatched_at TIMESTAMP,
            dispatched_by TEXT,
            expected_turnaround TEXT,
            received_report_at TIMESTAMP,
            report_document_id INTEGER,
            local_review_status TEXT NOT NULL DEFAULT 'pending' CHECK(local_review_status IN ('pending', 'reviewed', 'released')),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_specimens_item ON diag_specimens(order_item_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_results_item ON diag_results(order_item_id)")

    # ---- Imaging ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_imaging_exams (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            modality TEXT,
            room TEXT,
            scheduled_at TIMESTAMP,
            expected_duration_min INTEGER DEFAULT 30,
            assigned_staff TEXT,
            prep_instructions TEXT,
            status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'arrived', 'prep', 'in_progress', 'completed', 'cancelled', 'no_show')),
            arrived_at TIMESTAMP,
            prep_completed_at TIMESTAMP,
            consent_recorded BOOLEAN DEFAULT FALSE,
            consent_notes TEXT,
            started_at TIMESTAMP,
            completed_at TIMESTAMP,
            performing_staff TEXT,
            image_available BOOLEAN DEFAULT FALSE,
            reschedule_reason TEXT,
            cancel_reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_imaging_item ON diag_imaging_exams(order_item_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_imaging_scheduled ON diag_imaging_exams(scheduled_at)")

    # ---- Reports & Approval ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_reports (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            report_type TEXT NOT NULL CHECK(report_type IN ('LAB', 'IMAGING')),
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'pending_review', 'returned_for_correction', 'authorized', 'released', 'amended')),
            is_preliminary BOOLEAN DEFAULT FALSE,
            content TEXT,
            template TEXT,
            drafted_by TEXT,
            drafted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            submitted_at TIMESTAMP,
            reviewed_by TEXT,
            return_reason TEXT,
            returned_at TIMESTAMP,
            authorized_by TEXT,
            authorized_at TIMESTAMP,
            released_at TIMESTAMP,
            previous_version_id INTEGER,
            amendment_reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_critical_alerts (
            id {id_column},
            order_item_id INTEGER NOT NULL REFERENCES diag_order_items(id) ON DELETE CASCADE,
            result_id INTEGER,
            report_id INTEGER,
            raised_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            contacted_person TEXT,
            contacted_at TIMESTAMP,
            contacted_by TEXT,
            ack_method TEXT CHECK(ack_method IS NULL OR ack_method IN ('verbal_readback', 'written', 'callback')),
            ack_at TIMESTAMP,
            escalated BOOLEAN DEFAULT FALSE,
            escalated_at TIMESTAMP,
            escalated_to TEXT,
            resolved_at TIMESTAMP,
            notes TEXT
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_reports_item ON diag_reports(order_item_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_reports_status ON diag_reports(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_critical_open ON diag_critical_alerts(resolved_at)")

    # ---- Quality & Equipment ----
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_equipment (
            id {id_column},
            asset_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            type TEXT,
            location TEXT,
            model TEXT,
            serial_no TEXT,
            operational_status TEXT NOT NULL DEFAULT 'ready' CHECK(operational_status IN ('ready', 'qc_hold', 'maintenance', 'down')),
            responsible_staff TEXT,
            next_maintenance_date DATE,
            next_calibration_date DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_qc_runs (
            id {id_column},
            equipment_id INTEGER NOT NULL REFERENCES diag_equipment(id),
            service_id INTEGER,
            control_material TEXT,
            control_lot TEXT,
            run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            operator TEXT,
            measurements TEXT,
            outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('passed', 'failed', 'pending')),
            reviewed_by TEXT,
            reviewed_at TIMESTAMP,
            notes TEXT
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_qc_holds (
            id {id_column},
            qc_run_id INTEGER NOT NULL REFERENCES diag_qc_runs(id),
            equipment_id INTEGER NOT NULL REFERENCES diag_equipment(id),
            service_id INTEGER,
            scope TEXT NOT NULL CHECK(scope IN ('equipment', 'assay')),
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'corrective_action_recorded', 'repeat_qc_pending', 'released')),
            corrective_action TEXT,
            assigned_to TEXT,
            repeat_qc_run_id INTEGER,
            released_by TEXT,
            released_at TIMESTAMP,
            release_notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_equipment_maintenance (
            id {id_column},
            equipment_id INTEGER NOT NULL REFERENCES diag_equipment(id),
            service_date DATE,
            service_type TEXT,
            findings TEXT,
            work_performed TEXT,
            responsible TEXT,
            completion_status TEXT NOT NULL DEFAULT 'completed' CHECK(completion_status IN ('scheduled', 'in_progress', 'completed')),
            next_due_date DATE,
            downtime_start TIMESTAMP,
            downtime_end TIMESTAMP,
            return_to_service_by TEXT,
            return_to_service_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_reagent_lots (
            id {id_column},
            item_name TEXT NOT NULL,
            lot_no TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,
            unit TEXT,
            expiry_date DATE,
            storage_location TEXT,
            supplier_ref TEXT,
            status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'quarantined', 'expired', 'consumed')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(item_name, lot_no)
        )
        """
    )
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS diag_stock_movements (
            id {id_column},
            reagent_lot_id INTEGER NOT NULL REFERENCES diag_reagent_lots(id),
            movement_type TEXT NOT NULL CHECK(movement_type IN ('receipt', 'consume', 'adjustment', 'quarantine', 'release')),
            delta_qty REAL NOT NULL,
            actor TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_qc_runs_equipment ON diag_qc_runs(equipment_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_qc_holds_status ON diag_qc_holds(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_diag_reagent_expiry ON diag_reagent_lots(expiry_date)")


# ==================== Patient operations ====================


def _extract_uhid_date(patient_id):
    parts = str(patient_id or "").split("-")
    if len(parts) >= 3 and parts[0] == "PAT" and parts[1].isdigit() and len(parts[1]) == 8:
        return parts[1]
    return None



def _extract_uhid_suffix(patient_id):
    """Return the numeric last-4 UHID suffix for PAT and legacy IDs."""
    value = str(patient_id or "").strip()
    digits = ""
    for ch in reversed(value):
        if ch.isdigit():
            digits = ch + digits
        elif digits:
            break
    if not digits:
        return None
    try:
        return int(digits[-4:])
    except (TypeError, ValueError):
        return None



def _format_uhid_with_suffix(patient_id, suffix, fallback_date=None):
    id_date = _extract_uhid_date(patient_id) or fallback_date or current_ist_datetime().strftime("%Y%m%d")
    return f"PAT-{id_date}-{int(suffix):04d}"



def _next_unique_uhid_suffix(used_suffixes):
    next_suffix = (max(used_suffixes) if used_suffixes else 1000) + 1
    while next_suffix in used_suffixes:
        next_suffix += 1
    if next_suffix > 9999:
        raise RuntimeError("UHID last-4 sequence exhausted. Please archive old test data or widen the UHID suffix length.")
    return next_suffix



def _period_based_uhid_start(dt):
    """Build a 4-digit UHID floor from year, month, ISO week, and day.

    The full UHID already carries YYYYMMDD. This suffix floor adds a compact
    date-period signal and then increments from there for each new patient.
    """
    iso_week = int(dt.strftime("%V"))
    seed = ((dt.year % 100) * 372) + (dt.month * 31) + iso_week + int(dt.strftime("%d"))
    return ((seed % 89) + 10) * 100 + 1



def _next_period_based_uhid_suffix(used_suffixes, dt):
    period_start = _period_based_uhid_start(dt)
    next_suffix = max(period_start, (max(used_suffixes) + 1) if used_suffixes else period_start)
    while next_suffix in used_suffixes:
        next_suffix += 1
    if next_suffix > 9999:
        raise RuntimeError("UHID year/month/week/day sequence exhausted. Please archive old test data or widen the UHID suffix length.")
    return next_suffix



def generate_patient_id(db, hospital_id=None):
    """Generate date-prefixed sequential patient IDs per hospital.

    Required desktop format:
    PAT-YYYYMMDD-0001, PAT-YYYYMMDD-0002, PAT-YYYYMMDD-0003 ...

    The last 4 digits are the client-facing sequence and always start at
    0001 for a clean database. Existing legacy IDs are respected so the next
    generated ID stays unique and does not overwrite client data.
    """
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    today = current_ist_datetime().strftime("%Y%m%d")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT patient_id FROM patients WHERE hospital_id = ?",
            (scoped_hospital_id,),
        )
        used_numbers = set()
        for row in cursor.fetchall():
            value = row["patient_id"] if hasattr(row, "keys") else row[0]
            suffix = _extract_uhid_suffix(value)
            if suffix is not None:
                used_numbers.add(int(suffix))
        next_number = 1
        while next_number in used_numbers:
            next_number += 1
        if next_number > 9999:
            raise RuntimeError("UHID last-4 sequence exhausted. Please archive old data or widen the UHID suffix length.")
        return f"PAT-{today}-{next_number:04d}"



def check_duplicate_patient(db, name, last_name, dob, gender, phone, hospital_id=None):
    """Reject only on:
      A name + last name match where DOB OR phone also matches (gender is
      NOT required -- it's sometimes miskeyed and shouldn't block a real
      duplicate catch).
      
      We explicitly ALLOW the same phone number to be used for different 
      family members (e.g., Ramesh Kumar and Suresh Kumar sharing 9876543210).
    NOTE: dob is a real DATE column and rejects an empty string. Blank DOB is
    an intentionally allowed, optional field -- normalize to NULL instead of
    crashing. IS NOT DISTINCT FROM (instead of =) correctly matches NULL to
    NULL, so DOB-less duplicate detection still works.
    """
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    normalized_dob = dob or None
    normalized_phone = "".join(ch for ch in str(phone or "") if ch.isdigit())
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT patient_id, name, last_name FROM patients
            WHERE hospital_id = ?
              AND LOWER(name) = LOWER(?)
              AND LOWER(last_name) = LOWER(?)
              AND (
                dob IS NOT DISTINCT FROM ?
                OR (? != '' AND REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '+91', ''), '+', '') = ?)
              )
            LIMIT 1
            """,
            (
                scoped_hospital_id,
                name, last_name, normalized_dob,
                normalized_phone, normalized_phone,
            ),
        )
        return cursor.fetchone()



def get_patient_by_phone(db, phone, hospital_id=None):
    normalized = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if not normalized:
        return None
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM patients
            WHERE hospital_id = ? AND REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '+91', ''), '+', '') = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (scoped_hospital_id, normalized),
        )
        return cursor.fetchone()



def add_patient(db, data, hospital_id=None):
    scoped_hospital_id = hospital_id or data.get("hospital_id") or resolve_hospital_id(db)
    
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO patients (hospital_id, patient_id, name, middle_name, last_name, dob, age, gender, pregnant, allergies, allergy_status, symptoms, phone, address, emergency_contact, emergency_relation, family_mobile, marital_status, nationality, email, emergency_mobile, insurance_provider, insurance_policy_no, phone_country_code, family_country_code, emergency_country_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                scoped_hospital_id,
                data["patient_id"],
                data["name"],
                data.get("middle_name", ""),
                data["last_name"],
                data.get("dob") or None,  # normalize blank DOB to NULL
                data.get("age"),
                data.get("gender"),
                (1 if data.get("pregnant") else 0) if str(data.get("gender") or "").strip().lower() == "female" else 0,
                data.get("allergies", ""),
                data.get("allergy_status") or "not_recorded",
                data.get("symptoms", ""),
                data.get("phone", ""),
                data.get("address", ""),
                data.get("emergency_contact", ""),
                data.get("emergency_relation", ""),
                data.get("family_mobile", ""),
                data.get("marital_status"),
                data.get("nationality"),
                data.get("email"),
                data.get("emergency_mobile"),
                data.get("insurance_provider") or None,
                data.get("insurance_policy_no") or None,
                data.get("phone_country_code") or "+91",
                data.get("family_country_code"),
                data.get("emergency_country_code"),
            ),
        )
        conn.commit()
        add_patient_vitals(db, data["patient_id"], data)
        return data["patient_id"]



def get_patient(db, patient_id, hospital_id=None):
    """Fetch a patient by full UHID, or by numeric UHID suffix for lookup screens."""
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    identifier = str(patient_id or "").strip()
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   (SELECT MAX(appointment_date)
                    FROM appointments a
                    WHERE a.patient_id = p.patient_id AND a.status = 'completed' AND a.visit_type = 'OP') AS last_consultation_date
            FROM patients p
            WHERE p.patient_id = ? AND p.hospital_id = ?
            """,
            (identifier, scoped_hospital_id),
        )
        row = cursor.fetchone()
        
        if not row and identifier.isdigit():
            suffix = identifier[-4:].zfill(4)
            cursor.execute(
                """
                SELECT p.*,
                       (SELECT MAX(appointment_date)
                        FROM appointments a
                        WHERE a.patient_id = p.patient_id AND a.status = 'completed' AND a.visit_type = 'OP') AS last_consultation_date
                FROM patients p
                WHERE p.hospital_id = ? AND p.patient_id LIKE ?
                ORDER BY p.created_at DESC
                LIMIT 1
                """,
                (scoped_hospital_id, f"%{suffix}"),
            )
            row = cursor.fetchone()
            
        if row:
            row_dict = dict(row)
            cursor.execute(
                "SELECT weight, height, bp, pulse, temperature, spo2 FROM patient_vitals WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1",
                (row_dict["patient_id"],)
            )
            vitals = cursor.fetchone()
            if vitals:
                for k, v in dict(vitals).items():
                    if v is not None:
                        row_dict[k] = v
            return row_dict
            
        return None



def get_patient_details(db, patient_id, hospital_id=None):
    """
    Safely retrieves a complete patient record including demographics, visits, and clinical info.
    Guaranteed not to throw 500 errors on missing relationships.
    """
    try:
        scoped_hospital_id = hospital_id or resolve_hospital_id(db)
        patient_row = get_patient(db, patient_id, hospital_id=scoped_hospital_id)
        if not patient_row:
            return None
            
        data = dict(patient_row)
        resolved_id = data.get("patient_id")
        
        # Ensure dates are JSON serializable
        for date_field in ["last_consultation_date", "created_at", "updated_at", "dob"]:
            if data.get(date_field) and hasattr(data[date_field], "isoformat"):
                data[date_field] = data[date_field].isoformat()
        
        # Safe Admissions
        try:
            admissions = get_admissions(db, resolved_id, hospital_id=scoped_hospital_id)
            data["admissions"] = [dict(a) for a in admissions] if admissions else []
        except Exception:
            data["admissions"] = []
            
        # Safe Encounters
        try:
            encounters = list_encounters(db, patient_id=resolved_id)
            data["encounters"] = [dict(e) for e in encounters] if encounters else []
        except Exception:
            data["encounters"] = []
            
        # Extract Department, Consulting Doctor, Referring Doctor
        # Typically from the latest admission
        data["department"] = None
        data["consulting_doctor"] = None
        data["referring_doctor"] = None
        
        if data["admissions"]:
            latest = data["admissions"][0]
            data["department"] = latest.get("department")
            data["consulting_doctor"] = latest.get("doctor_name")
            data["referring_doctor"] = latest.get("referring_doctor")

        if not data.get("department") or not data.get("consulting_doctor") or not data.get("weight") or not data.get("height"):
            try:
                appointments = list_appointments(db, patient_id=resolved_id)
                if appointments:
                    # list_appointments orders by appointment_date ASC, so the last element is the latest
                    latest_appt = appointments[-1]
                    if not data.get("department"):
                        data["department"] = latest_appt.get("department")
                    if not data.get("consulting_doctor"):
                        data["consulting_doctor"] = latest_appt.get("doctor_name")
                        
                    # Also fallback vitals from notes if missing
                    import re
                    notes = latest_appt.get("notes") or ""
                    if not data.get("weight") or str(data.get("weight")).strip() == "":
                        m = re.search(r"Weight:\s*([\d.]+)\s*kg", notes, re.IGNORECASE)
                        if m: data["weight"] = float(m.group(1))
                    if not data.get("height") or str(data.get("height")).strip() == "":
                        m = re.search(r"Height:\s*([\d.]+)\s*cm", notes, re.IGNORECASE)
                        if m: data["height"] = float(m.group(1))
                        
                    # Extract BP, Temp, Pulse, SpO2 for follow-up reflection
                    if "bp" not in data or str(data.get("bp")).strip() == "":
                        m = re.search(r"BP:\s*([\d]+/[\d]+)", notes, re.IGNORECASE)
                        if m: data["bp"] = m.group(1)
                    if "temperature" not in data or str(data.get("temperature")).strip() == "":
                        m = re.search(r"Temp:\s*([\d.]+)", notes, re.IGNORECASE)
                        if m: data["temperature"] = m.group(1)
                    if "pulse" not in data or str(data.get("pulse")).strip() == "":
                        m = re.search(r"Pulse:\s*([\d.]+)", notes, re.IGNORECASE)
                        if m: data["pulse"] = m.group(1)
                    if "spo2" not in data or str(data.get("spo2")).strip() == "":
                        m = re.search(r"SPO2:\s*([\d.]+)", notes, re.IGNORECASE)
                        if m: data["spo2"] = m.group(1)
            except Exception:
                pass
            
        # Clinical Info
        data["clinical_information"] = data.get("symptoms") or data.get("allergies")
        
        # Insurance Details (safe generic fallback)
        data["insurance_details"] = None
        
        # Extract vitals from encounters if missing
        if not data.get("weight") or not data.get("height") or not data.get("bp") or not data.get("temperature") or not data.get("pulse") or not data.get("spo2"):
            for e in reversed(data.get("encounters", [])):
                if not data.get("weight") and e.get("weight"): data["weight"] = e["weight"]
                if not data.get("height") and e.get("height"): data["height"] = e["height"]
                if not data.get("bp") and e.get("bp"): data["bp"] = e["bp"]
                if not data.get("temperature") and e.get("temperature"): data["temperature"] = e["temperature"]
                if not data.get("pulse") and e.get("pulse"): data["pulse"] = e["pulse"]
                if not data.get("spo2") and e.get("spo2"): data["spo2"] = e["spo2"]

        # Compute follow-up eligibility (7-day rule)
        data["eligible_for_free_followup"] = False
        data["last_consultation_date"] = None
        data["last_department"] = None
        data["last_doctor"] = None
        
        try:
            with get_connection(db) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT appointment_date, department, doctor_name 
                    FROM appointments 
                    WHERE patient_id = ? AND status = 'completed'
                    ORDER BY appointment_date DESC LIMIT 1
                    """,
                    (resolved_id,)
                )
                last_visit = cursor.fetchone()
                if last_visit:
                    data["last_consultation_date"] = last_visit["appointment_date"]
                    data["last_department"] = last_visit["department"]
                    data["last_doctor"] = last_visit["doctor_name"]
                    
                    from datetime import datetime
                    last_dt = datetime.strptime(str(last_visit["appointment_date"]).split("T")[0].split(" ")[0], "%Y-%m-%d")
                    curr_dt = datetime.now()
                    diff_days = (curr_dt - last_dt).days
                    if 0 <= diff_days <= 7:
                        data["eligible_for_free_followup"] = True
        except Exception:
            pass

        return data
    except Exception as e:
        import traceback
        traceback.print_exc()
        return None



def get_all_patients(db, hospital_id=None, visit_status=None):
    """visit_status: optional "ip" (has an active bed allocation) or "op"
    (no active bed allocation) to restrict results; None/"all" returns
    everyone. Note: every registration creates an `admissions` row
    regardless of OP/IP, so "inpatient" is determined by an active
    `bed_allocations` row, not by the admissions row alone.
    """
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   (SELECT MAX(appointment_date)
                    FROM appointments a
                    WHERE a.patient_id = p.patient_id AND a.status = 'completed' AND a.visit_type = 'OP') AS last_consultation_date,
                   (SELECT COUNT(*) > 0
                    FROM appointments a2
                    WHERE a2.patient_id = p.patient_id) AS has_appointments,
                   EXISTS(
                       SELECT 1 FROM bed_allocations ba
                       JOIN admissions ad ON ad.id = ba.admission_id
                       WHERE ad.patient_id = p.patient_id AND ba.status = 'active'
                   ) AS is_inpatient,
                   (SELECT a3.visit_type FROM appointments a3
                    WHERE a3.patient_id = p.patient_id ORDER BY a3.created_at DESC, a3.id DESC LIMIT 1) AS latest_visit_type,
                   (SELECT a4.doctor_name FROM appointments a4
                    WHERE a4.patient_id = p.patient_id ORDER BY a4.created_at DESC, a4.id DESC LIMIT 1) AS latest_doctor_name,
                   (SELECT a5.department FROM appointments a5
                    WHERE a5.patient_id = p.patient_id ORDER BY a5.created_at DESC, a5.id DESC LIMIT 1) AS latest_department,
                   (SELECT a6.appointment_date FROM appointments a6
                    WHERE a6.patient_id = p.patient_id ORDER BY a6.created_at DESC, a6.id DESC LIMIT 1) AS latest_appointment_date
            FROM patients p
            WHERE p.hospital_id = ?
            ORDER BY p.created_at DESC
            """,
            (scoped_hospital_id,),
        )
        rows = cursor.fetchall()
    normalized_status = (visit_status or "").strip().lower()
    if normalized_status == "ip":
        rows = [row for row in rows if row["is_inpatient"]]
    elif normalized_status == "op":
        rows = [row for row in rows if not row["is_inpatient"]]
    return rows



def _normalize_search_text(value):
    """Normalize text for patient search: case-insensitive, collapsed spaces."""
    return " ".join(str(value or "").lower().split())



def _digits_only(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())



def search_patients(db, query, hospital_id=None, visit_status=None):
    """Robust patient search by full/partial name, UHID, or phone.

    Supports queries like:
    - full name: "uday kiran"
    - partial name: "kir", "ram"
    - UHID/full or last digits: "PAT-20260623-0001", "0001", "1"
    - phone partial: "9876"

    visit_status: optional "ip" (has an active bed allocation) or "op" (does
    not) to restrict results; None/"all" returns everyone.
    """
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    normalized_query = _normalize_search_text(query)
    if not normalized_query:
        return []

    query_digits = _digits_only(normalized_query)
    query_tokens = [token for token in normalized_query.split() if token]

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   (SELECT MAX(appointment_date)
                    FROM appointments a
                    WHERE a.patient_id = p.patient_id AND a.status = 'completed' AND a.visit_type = 'OP') AS last_consultation_date,
                   (SELECT COUNT(*) > 0
                    FROM appointments a2
                    WHERE a2.patient_id = p.patient_id) AS has_appointments,
                   EXISTS(
                       SELECT 1 FROM bed_allocations ba
                       JOIN admissions ad ON ad.id = ba.admission_id
                       WHERE ad.patient_id = p.patient_id AND ba.status = 'active'
                   ) AS is_inpatient
            FROM patients p
            WHERE p.hospital_id = ?
            ORDER BY p.created_at DESC, p.id DESC
            """,
            (scoped_hospital_id,),
        )
        rows = cursor.fetchall()
        normalized_status = (visit_status or "").strip().lower()
        if normalized_status == "ip":
            rows = [row for row in rows if row["is_inpatient"]]
        elif normalized_status == "op":
            rows = [row for row in rows if not row["is_inpatient"]]

    def row_value(row, key):
        try:
            return row[key]
        except Exception:
            return ""

    def matches(row):
        first = row_value(row, "name")
        middle = row_value(row, "middle_name")
        last = row_value(row, "last_name")
        patient_id = row_value(row, "patient_id")
        phone = row_value(row, "phone")
        family_mobile = row_value(row, "family_mobile")
        emergency_contact = row_value(row, "emergency_contact")

        full_name_variants = [
            _normalize_search_text(" ".join(part for part in [first, middle, last] if part)),
            _normalize_search_text(" ".join(part for part in [first, last] if part)),
            _normalize_search_text(" ".join(part for part in [last, first] if part)),
            _normalize_search_text(first),
            _normalize_search_text(middle),
            _normalize_search_text(last),
        ]
        text_haystack = " | ".join(
            full_name_variants
            + [
                _normalize_search_text(patient_id),
                _normalize_search_text(phone),
                _normalize_search_text(family_mobile),
                _normalize_search_text(emergency_contact),
            ]
        )
        digit_haystack = " | ".join(
            _digits_only(value) for value in [patient_id, phone, family_mobile, emergency_contact]
        )

        if normalized_query in text_haystack:
            return True
        if query_tokens and all(token in text_haystack for token in query_tokens):
            return True
        if query_digits:
            if query_digits in digit_haystack:
                return True
            # Allow entering single/all suffix digits for PAT-YYYYMMDD-0001.
            patient_digits = _digits_only(patient_id)
            if patient_digits.endswith(query_digits) or patient_digits.endswith(query_digits.zfill(4)):
                return True
        return False

    matched_rows = [row for row in rows if matches(row)]

    results = []
    with get_connection(db) as conn:
        cursor = conn.cursor()
        for row in matched_rows:
            row_dict = dict(row)
            cursor.execute(
                "SELECT weight, height, bp, pulse, temperature, spo2 FROM patient_vitals WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1",
                (row_dict["patient_id"],)
            )
            vitals = cursor.fetchone()
            if vitals:
                for k, v in dict(vitals).items():
                    if v is not None:
                        row_dict[k] = v
            results.append(row_dict)

    return results


def get_patient_vitals(db, patient_id, admission_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if admission_id:
            cursor.execute(
                "SELECT * FROM patient_vitals WHERE patient_id = ? AND admission_id = ? ORDER BY recorded_at DESC",
                (patient_id, admission_id)
            )
        else:
            cursor.execute(
                "SELECT * FROM patient_vitals WHERE patient_id = ? ORDER BY recorded_at DESC",
                (patient_id,)
            )
        return cursor.fetchall()


def add_patient_vitals(db, patient_id, data):
    bp = str(data.get("bp") or "").strip() or None
    
    def parse_float(val):
        if val in ("", None, "null"): return None
        try: return float(val)
        except ValueError: return None
        
    def parse_int(val):
        if val in ("", None, "null"): return None
        try: return int(val)
        except ValueError: return None

    pulse = parse_int(data.get("pulse"))
    temperature = parse_float(data.get("temperature"))
    weight = parse_float(data.get("weight"))
    height = parse_float(data.get("height"))
    spo2 = parse_float(data.get("spo2"))

    if bp is None and pulse is None and temperature is None and weight is None and height is None and spo2 is None:
        return None

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM patient_vitals WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1",
            (patient_id,)
        )
        latest = cursor.fetchone()

        insert_new = True
        if latest:
            # Always prevent exact duplicates regardless of time, to avoid logging identical un-updated vitals
            if (
                latest.get("bp") == bp and 
                latest.get("pulse") == pulse and 
                latest.get("temperature") == temperature and 
                latest.get("weight") == weight and 
                latest.get("height") == height and 
                latest.get("spo2") == spo2
            ):
                insert_new = False
            else:
                # If they don't match exactly, we still might want to prevent duplicates if within 7 days 
                # but wait, if they don't match, they ARE updated, so we DO want to insert!
                pass
            
        if insert_new:
            cursor.execute(
                """
                INSERT INTO patient_vitals (patient_id, bp, pulse, temperature, weight, height, spo2)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (patient_id, bp, pulse, temperature, weight, height, spo2)
            )
            conn.commit()
            return cursor.lastrowid
        return None


def record_vitals(db, patient_id, data, username, encounter_id=None, admission_id=None):
    """Explicit nurse/triage charting action: unlike add_patient_vitals (an
    incidental side-effect of editing patient demographics, which
    deliberately skips an exact-duplicate reading), this always inserts a new
    timestamped row -- a repeat 'BP 120/80' at 2pm is still a real
    observation that happened, not noise to suppress."""
    def parse_float(val):
        if val in ("", None, "null"): return None
        try: return float(val)
        except (TypeError, ValueError): return None

    def parse_int(val):
        if val in ("", None, "null"): return None
        try: return int(val)
        except (TypeError, ValueError): return None

    pain_score = parse_int(data.get("pain_score"))
    if pain_score is not None and not (0 <= pain_score <= 10):
        raise ValueError("Pain score must be between 0 and 10.")

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name, last_name FROM patients WHERE patient_id = ?", (patient_id,))
        p = cursor.fetchone()
        patient_name = f"{p['name']} {p['last_name'] or ''}".strip() if p else None
        cursor.execute(
            """
            INSERT INTO patient_vitals (
                patient_id, bp, pulse, temperature, spo2, weight, height, admission_id, encounter_id, recorded_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                patient_id,
                str(data.get("bp") or "").strip() or None,
                parse_int(data.get("pulse")),
                parse_float(data.get("temperature")),
                parse_float(data.get("spo2")),
                parse_float(data.get("weight")),
                parse_float(data.get("height")),
                admission_id,
                parse_int(encounter_id),
                username,
            ),
        )
        vital_id = cursor.lastrowid
        conn.commit()
        return vital_id



def create_nursing_care_log(db, data, username):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name, last_name FROM patients WHERE patient_id = ?", (data["patient_id"],))
        p = cursor.fetchone()
        patient_name = f"{p['name']} {p['last_name'] or ''}".strip() if p else None
        cursor.execute(
            """
            INSERT INTO nursing_care_logs (
                patient_id, patient_name, admission_id, nurse_name, log_date, log_time, activity, remarks, status, created_by
            ) VALUES (?, ?, ?, ?, CURRENT_DATE, TO_CHAR(CURRENT_TIMESTAMP, 'HH24:MI'), ?, ?, 'recorded', ?)
            """,
            (data["patient_id"], patient_name, data.get("admission_id"), data.get("nurse_name") or username,
             data.get("activity"), data.get("remarks"), username),
        )
        log_id = cursor.lastrowid
        conn.commit()
        return log_id



def list_nursing_care_logs(db, patient_id=None, admission_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            clauses.append("patient_id = ?")
            params.append(patient_id)
        if admission_id:
            clauses.append("admission_id = ?")
            params.append(admission_id)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(f"SELECT * FROM nursing_care_logs{where_clause} ORDER BY id DESC", tuple(params))
        return cursor.fetchall()



def update_patient(db, patient_id, data, hospital_id=None):
    """Updates the fields present in `data`. A field the caller did not send keeps its
    stored value (an edit form that shows only some fields must not blank the rest,
    e.g. emergency contact, email or nationality)."""
    add_patient_vitals(db, patient_id, data)

    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM patients WHERE patient_id = ? AND hospital_id = ?", (patient_id, scoped_hospital_id))
        current = cursor.fetchone()
        if not current:
            return False

        def value(key, default=""):
            if key in data:
                return data[key]
            stored = current.get(key)
            return default if stored is None and default is not None else stored

        gender = value("gender", None)
        pregnant = data["pregnant"] if "pregnant" in data else current.get("pregnant")
        cursor.execute(
            """
            UPDATE patients SET name=?, middle_name=?, last_name=?, dob=?, age=?,
            gender=?, pregnant=?, allergies=?, allergy_status=?, symptoms=?, phone=?, address=?, emergency_contact=?, emergency_relation=?, family_mobile=?,
            marital_status=?, nationality=?, email=?, emergency_mobile=?, phone_country_code=?,
            family_country_code=?, emergency_country_code=?
            WHERE patient_id=? AND hospital_id=?
        """,
            (
                value("name"),
                value("middle_name"),
                value("last_name"),
                (data.get("dob") or None) if "dob" in data else current.get("dob"),  # normalize blank DOB to NULL
                value("age", None),
                gender,
                (1 if pregnant else 0) if str(gender or "").strip().lower() == "female" else 0,
                value("allergies"),
                value("allergy_status") or "not_recorded",
                value("symptoms"),
                value("phone"),
                value("address"),
                value("emergency_contact"),
                value("emergency_relation"),
                value("family_mobile"),
                value("marital_status", None),
                value("nationality", None),
                value("email", None),
                value("emergency_mobile"),
                value("phone_country_code", None) or "+91",
                value("family_country_code", None),
                value("emergency_country_code", None),
                patient_id,
                scoped_hospital_id,
            ),
        )
        updated = cursor.rowcount > 0

        # Insurance is only touched when the caller sends it. A changed provider or
        # policy needs a fresh eligibility check, so verification is reset.
        if updated and ("insurance_provider" in data or "insurance_policy_no" in data):
            new_provider = (str(data.get("insurance_provider") or "").strip() or None) if "insurance_provider" in data else current.get("insurance_provider")
            new_policy = (str(data.get("insurance_policy_no") or "").strip() or None) if "insurance_policy_no" in data else current.get("insurance_policy_no")
            if (new_provider, new_policy) != (current.get("insurance_provider"), current.get("insurance_policy_no")):
                cursor.execute(
                    """
                    UPDATE patients SET insurance_provider = ?, insurance_policy_no = ?,
                           insurance_verified = FALSE, insurance_verified_by = NULL, insurance_verified_at = NULL, insurance_verification_ref = NULL
                    WHERE patient_id = ? AND hospital_id = ?
                    """,
                    (new_provider, new_policy, patient_id, scoped_hospital_id),
                )
        conn.commit()
        return updated



def list_insurance_providers(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM insurance_providers ORDER BY name ASC")
        return cursor.fetchall()



def create_insurance_provider(db, name, contact_person=None, contact_phone=None, notes=None, username=None,
                              contact_phone_country_code=None):
    name = str(name or "").strip()
    if not name:
        raise ValueError("Provider name is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM insurance_providers WHERE LOWER(name) = LOWER(?)", (name,))
        existing = cursor.fetchone()
        if existing:
            raise ValueError(f"'{existing['name']}' is already in the provider list.")
        cursor.execute(
            """
            INSERT INTO insurance_providers (name, contact_person, contact_phone, notes, created_by, contact_phone_country_code)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (name, contact_person or None, contact_phone or None, notes or None, username,
             (contact_phone_country_code or None) if contact_phone else None),
        )
        provider_id = cursor.lastrowid
        conn.commit()
        cursor.execute("SELECT * FROM insurance_providers WHERE id = ?", (provider_id,))
        return cursor.fetchone()



def get_active_bed_allocation(cursor, patient_id):
    """The patient's current bed allocation on a not-yet-discharged admission, or None."""
    cursor.execute(
        """
        SELECT b.id, b.admission_id, b.ward, b.room_no, b.bed_no FROM bed_allocations b
        JOIN admissions a ON a.id = b.admission_id
        WHERE b.patient_id = ? AND b.status = 'active' AND a.discharge_date IS NULL
        ORDER BY b.allocated_at DESC LIMIT 1
        """,
        (patient_id,),
    )
    return cursor.fetchone()


def ensure_not_currently_admitted(cursor, patient_id):
    """Raise ValueError if the patient already holds a bed on an undischarged admission."""
    cur = get_active_bed_allocation(cursor, patient_id)
    if cur:
        raise ValueError(
            f"Patient {patient_id} is already admitted (admission #{cur['admission_id']}, "
            f"{cur['ward'] or '-'} / bed {cur['bed_no'] or '-'}). Discharge the current admission before admitting or assigning another bed."
        )


def normalize_admission_payer(payload):
    """Validate the payer fields of an admission. Returns a dict with
    payer_type ('self' | 'insurance') and the insurance fields (None for self-pay)."""
    payload = payload or {}
    payer_type = str(payload.get("payer_type") or "self").strip().lower()
    if payer_type in ("self-pay", "self_pay", "cash"):
        payer_type = "self"
    if payer_type not in ("self", "insurance"):
        raise ValueError("Payer must be 'self' or 'insurance'.")
    if payer_type == "self":
        return {"payer_type": "self", "insurance_provider": None, "insurance_policy_no": None, "insurance_preauth_no": None}
    provider = str(payload.get("insurance_provider") or "").strip()
    policy_no = str(payload.get("insurance_policy_no") or "").strip()
    if not provider or not policy_no:
        raise ValueError("Insurance provider and policy number are required when the payer is insurance.")
    return {
        "payer_type": "insurance",
        "insurance_provider": provider,
        "insurance_policy_no": policy_no,
        "insurance_preauth_no": str(payload.get("insurance_preauth_no") or "").strip() or None,
    }


def set_admission_payer(cursor, admission_id, payer, patient_id=None):
    """Store the payer on the admission; for insurance also keep the patient's
    current insurance on record (used by insurance verification)."""
    cursor.execute(
        "UPDATE admissions SET payer_type = ?, insurance_provider = ?, insurance_policy_no = ?, insurance_preauth_no = ? WHERE id = ?",
        (payer["payer_type"], payer["insurance_provider"], payer["insurance_policy_no"], payer["insurance_preauth_no"], admission_id),
    )
    if patient_id and payer["payer_type"] == "insurance":
        cursor.execute(
            """
            UPDATE patients SET insurance_provider = ?, insurance_policy_no = ?,
                   insurance_verified = FALSE, insurance_verified_by = NULL, insurance_verified_at = NULL, insurance_verification_ref = NULL
            WHERE patient_id = ? AND (insurance_provider IS DISTINCT FROM ? OR insurance_policy_no IS DISTINCT FROM ?)
            """,
            (payer["insurance_provider"], payer["insurance_policy_no"], patient_id, payer["insurance_provider"], payer["insurance_policy_no"]),
        )


def add_admission(db, patient_id, notes="", hospital_id=None, payer=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        ensure_not_currently_admitted(cursor, patient_id)
        # One open admission per patient. A bed-less admission still counts: without this a
        # second admission could be opened and the bed and active-admission lookups would
        # then point at different admissions. The placeholder created by "Inpatient
        # registration" is adopted by the real admission instead of duplicated.
        cursor.execute(
            """
            SELECT id, notes FROM admissions
            WHERE patient_id = ? AND discharge_date IS NULL AND COALESCE(notes, '') != 'Initial registration'
            ORDER BY admission_date DESC LIMIT 1
            """,
            (patient_id,),
        )
        open_adm = cursor.fetchone()
        if open_adm:
            if (open_adm["notes"] or "") == "Inpatient registration":
                cursor.execute("UPDATE admissions SET notes = ? WHERE id = ?", (notes, open_adm["id"]))
                if payer:
                    set_admission_payer(cursor, open_adm["id"], payer, patient_id)
                conn.commit()
                return open_adm["id"]
            raise ValueError(
                f"Patient {patient_id} already has an open admission (#{open_adm['id']}). "
                "Discharge it before creating another admission."
            )
        # NOTE: admission_date is a timestamptz (UTC in storage). CURRENT_TIMESTAMP is the
        # instant; the session time zone (IST) only affects how it is read back.
        cursor.execute(
            """
            INSERT INTO admissions (hospital_id, patient_id, admission_date, notes)
            VALUES (?, ?, CURRENT_TIMESTAMP, ?)
            RETURNING id
            """,
            (scoped_hospital_id, patient_id, notes),
        )
        admission_id = cursor.fetchone()[0]
        if payer:
            set_admission_payer(cursor, admission_id, payer, patient_id)
        conn.commit()
        return admission_id



def get_admissions(db, patient_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM admissions WHERE patient_id = ? AND hospital_id = ? AND COALESCE(notes, '') != 'Initial registration' ORDER BY admission_date DESC",
            (patient_id, scoped_hospital_id),
        )
        return cursor.fetchall()



def list_discharged_admissions(db, hospital_id=None, from_date=None, to_date=None, q=None):
    """Every finalised discharge (billing v2's IP Discharge Billing flow, or
    the older bed-based direct discharge) for the 'Discharged Patients'
    history view -- who left, and when.

    admissions.discharge_date is a DATE column so it never carries a time of
    day even though both discharge code paths write CURRENT_TIMESTAMP into
    it; the discharge invoice's own timestamp (INV-IP-<admission_id> for
    billing v2, or the INV-DIS-* invoice created in the same transaction for
    the legacy flow) is the closest real "discharged at" moment on record,
    so it's preferred and the date-only column is only a last-resort
    fallback for a discharge that somehow has neither.
    """
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = [
            "a.hospital_id = ?",
            "a.discharge_date IS NOT NULL",
            "COALESCE(a.notes, '') != 'Initial registration'",
        ]
        params = [scoped_hospital_id]
        if from_date:
            clauses.append("a.discharge_date >= DATE(?)")
            params.append(from_date)
        if to_date:
            clauses.append("a.discharge_date <= DATE(?)")
            params.append(to_date)
        if q:
            clauses.append("(a.patient_id ILIKE ? OR p.name ILIKE ? OR p.last_name ILIKE ?)")
            like = f"%{str(q).strip()}%"
            params.extend([like, like, like])
        where_clause = " AND ".join(clauses)
        cursor.execute(
            f"""
            SELECT
                a.id AS admission_id, a.patient_id, a.admission_date, a.discharge_date, a.notes,
                p.name, p.last_name, p.phone, p.gender, p.age,
                COALESCE(
                    (SELECT i.updated_at FROM invoices i WHERE i.invoice_no = 'INV-IP-' || LPAD(a.id::text, 4, '0')),
                    (SELECT i.created_at FROM invoices i
                     WHERE i.patient_id = a.patient_id AND i.invoice_no LIKE 'INV-DIS-%%' AND DATE(i.created_at) = a.discharge_date
                     ORDER BY i.created_at DESC LIMIT 1),
                    a.discharge_date::timestamp
                ) AS discharged_at,
                (SELECT ba.ward FROM bed_allocations ba WHERE ba.admission_id = a.id ORDER BY ba.allocated_at DESC LIMIT 1) AS ward,
                (SELECT ba.room_no FROM bed_allocations ba WHERE ba.admission_id = a.id ORDER BY ba.allocated_at DESC LIMIT 1) AS room_no,
                (SELECT ba.bed_no FROM bed_allocations ba WHERE ba.admission_id = a.id ORDER BY ba.allocated_at DESC LIMIT 1) AS bed_no
            FROM admissions a
            JOIN patients p ON p.patient_id = a.patient_id
            WHERE {where_clause}
            ORDER BY discharged_at DESC
            LIMIT 300
            """,
            tuple(params),
        )
        return cursor.fetchall()



def add_document(db, 
    patient_id,
    admission_id,
    doc_type,
    file_path,
    ocr_text="",
    ocr_language="en",
    file_name=None,
    mime_type=None,
    file_data=None,
    hospital_id=None,
):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        # NOTE: created_at stored as UTC via CURRENT_TIMESTAMP (matches
        # patients.created_at pattern). Converted to IST only at display
        # time via date_clause(). Do NOT store IST wall-clock time here --
        # see deployment notes re: timezone consistency.
        cursor.execute(
            """
            INSERT INTO documents (
                hospital_id, patient_id, admission_id, doc_type, file_path, file_name, mime_type, file_data, ocr_text, ocr_language, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            RETURNING id
            """,
            (
                scoped_hospital_id,
                patient_id,
                admission_id,
                doc_type,
                file_path,
                file_name,
                mime_type,
                file_data,
                ocr_text,
                ocr_language,
            ),
        )
        document_id = cursor.fetchone()[0]
        conn.commit()
        return document_id



def list_recent_prescription_scans(db, hospital_id=None, limit=30):
    """Photo/scan prescription uploads across all patients, most recent
    first -- these carry no structured line items, so Pharmacy reviews them
    as an image/PDF rather than a dispense-against-lines table."""
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, patient_id, doc_type, file_path, file_name, mime_type, created_at
            FROM documents
            WHERE hospital_id = ? AND doc_type = 'prescriptions'
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (scoped_hospital_id, limit),
        )
        return cursor.fetchall()



def get_documents(db, patient_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                id,
                patient_id,
                admission_id,
                doc_type,
                file_path,
                file_name,
                mime_type,
                ocr_text,
                ocr_language,
                created_at,
                CASE WHEN file_data IS NOT NULL THEN 1 ELSE 0 END AS has_file_data
            FROM documents
            WHERE patient_id = ? AND hospital_id = ?
            ORDER BY created_at DESC
            """,
            (patient_id, scoped_hospital_id),
        )
        return cursor.fetchall()



def get_document(db, document_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM documents WHERE id = ? AND hospital_id = ?",
            (document_id, scoped_hospital_id),
        )
        return cursor.fetchone()



def delete_document(db, document_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM documents WHERE id = ? AND hospital_id = ?",
            (document_id, scoped_hospital_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def update_document_ocr(db, document_id, ocr_text, ocr_language="en", hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE documents SET ocr_text = ?, ocr_language = ? WHERE id = ? AND hospital_id = ?",
            (ocr_text, ocr_language, document_id, scoped_hospital_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def get_patient_stats(db, hospital_id=None, selected_date=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    target_date = str(selected_date).split("T")[0].split(" ")[0] if selected_date else None
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM patients WHERE hospital_id = ?", (scoped_hospital_id,))
        total = cursor.fetchone()[0]
        if target_date:
            cursor.execute(
                "SELECT COUNT(*) FROM patients WHERE hospital_id = ? AND DATE(created_at) = DATE(?)",
                (scoped_hospital_id, target_date),
            )
        else:
            cursor.execute(
                "SELECT COUNT(*) FROM patients WHERE hospital_id = ? AND DATE(created_at) = CURRENT_DATE",
                (scoped_hospital_id,),
            )
        today = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM admissions WHERE hospital_id = ? AND discharge_date IS NULL AND COALESCE(notes, '') != 'Initial registration'",
            (scoped_hospital_id,),
        )
        active = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM documents WHERE hospital_id = ?", (scoped_hospital_id,))
        docs = cursor.fetchone()[0]
        cursor.execute(
            """
            SELECT COUNT(*) FROM (
                SELECT patient_id
                FROM admissions
                WHERE hospital_id = ? AND COALESCE(notes, '') != 'Initial registration'
                GROUP BY patient_id
                HAVING COUNT(*) > 1
            )
            """
            ,
            (scoped_hospital_id,),
        )
        readmitted_patients = cursor.fetchone()[0]

        cursor.execute("SELECT capacity FROM bed_config WHERE hospital_id = ?", (scoped_hospital_id,))
        row_cap = cursor.fetchone()
        bed_capacity = row_cap[0] if row_cap else 50

        cursor.execute(
            "SELECT COUNT(*) FROM bed_allocations WHERE status = 'active' AND admission_id IN (SELECT id FROM admissions WHERE hospital_id = ?)",
            (scoped_hospital_id,)
        )
        active_beds = cursor.fetchone()[0]

        day_filter = target_date or current_ist_datetime().strftime("%Y-%m-%d")
        cursor.execute(
            """
            SELECT COUNT(*) FROM appointments a
            WHERE DATE(a.appointment_date) = DATE(?)
              AND (
                LOWER(COALESCE(a.appointment_kind, '')) = 'follow_up'
                OR LOWER(COALESCE(a.visit_type, '')) LIKE '%follow%'
                OR a.follow_up_for IS NOT NULL
                OR LOWER(COALESCE(a.notes, '')) LIKE '%follow-up%'
                OR LOWER(COALESCE(a.notes, '')) LIKE '%follow up%'
              )
            """,
            (day_filter,)
        )
        follow_ups = cursor.fetchone()[0] or 0

        cursor.execute(
            """
            SELECT COUNT(*) FROM appointments a
            LEFT JOIN patients p ON p.patient_id = a.patient_id
            WHERE DATE(a.appointment_date) = DATE(?)
              AND (
                (p.created_at IS NOT NULL AND DATE(p.created_at) < DATE(a.appointment_date))
                OR a.notes LIKE '%[Re-visit Details]%'
                OR LOWER(COALESCE(a.appointment_kind, '')) IN ('revisit', 'review')
              )
            """,
            (day_filter,)
        )
        rev_appt = cursor.fetchone()[0] or 0

        cursor.execute(
            """
            SELECT COUNT(*) FROM admissions adm
            LEFT JOIN patients p ON p.patient_id = adm.patient_id
            WHERE DATE(adm.admission_date) = DATE(?)
              AND (
                (p.created_at IS NOT NULL AND DATE(p.created_at) < DATE(adm.admission_date))
                OR adm.notes LIKE '%[Re-visit Details]%'
              )
              AND adm.patient_id NOT IN (
                SELECT a2.patient_id FROM appointments a2 WHERE DATE(a2.appointment_date) = DATE(?) AND a2.patient_id IS NOT NULL
              )
            """,
            (day_filter, day_filter)
        )
        rev_adm = cursor.fetchone()[0] or 0
        revisits = rev_appt + rev_adm

    return {
        "total": total,
        "today": today,
        "active_admissions": active,
        "documents": docs,
        "readmitted_patients": readmitted_patients,
        "bed_capacity": bed_capacity,
        "active_beds": active_beds,
        "revisits": revisits,
        "follow_ups": follow_ups,
    }



def get_dashboard_analytics(db, days=14, include_employee=False, hospital_id=None, selected_date=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    try:
        requested_days = int(days)
    except (TypeError, ValueError):
        requested_days = 14

    # Keep the window bounded so the dashboard stays fast and readable.
    window_days = max(7, min(requested_days, 60))
    if selected_date:
        try:
            clean_date = str(selected_date).split('T')[0].split(' ')[0]
            end_date = datetime.strptime(clean_date, "%Y-%m-%d").date()
        except Exception:
            end_date = current_ist_datetime().date()
    else:
        end_date = current_ist_datetime().date()

    start_date = end_date - timedelta(days=window_days - 1)
    day_range = [(start_date + timedelta(days=index)).isoformat() for index in range(window_days)]

    with get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT DATE(created_at) AS day, COUNT(*) AS count
            FROM patients
            WHERE hospital_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            (scoped_hospital_id, start_date.isoformat(), end_date.isoformat()),
        )
        patient_trend_map = {(row["day"].isoformat() if hasattr(row["day"], "isoformat") else str(row["day"])): row["count"] for row in cursor.fetchall()}

        cursor.execute(
            """
            SELECT DATE(created_at) AS day, COUNT(*) AS count
            FROM documents
            WHERE hospital_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            (scoped_hospital_id, start_date.isoformat(), end_date.isoformat()),
        )
        document_trend_map = {(row["day"].isoformat() if hasattr(row["day"], "isoformat") else str(row["day"])): row["count"] for row in cursor.fetchall()}

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(INITCAP(TRIM(gender)), ''), 'Unknown') AS label, COUNT(*) AS count
            FROM patients
            WHERE hospital_id = ?
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
            ,
            (scoped_hospital_id,),
        )
        gender_distribution = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(doc_type), ''), 'Unknown') AS label, COUNT(*) AS count
            FROM documents
            WHERE hospital_id = ?
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
            ,
            (scoped_hospital_id,),
        )
        doc_type_distribution = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT CASE WHEN discharge_date IS NULL THEN 'Active' ELSE 'Discharged' END AS label, COUNT(*) AS count
            FROM admissions
            WHERE hospital_id = ? AND COALESCE(notes, '') != 'Initial registration'
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
            ,
            (scoped_hospital_id,),
        )
        admission_status_distribution = [dict(row) for row in cursor.fetchall()]

        analytics = {
            "window_days": window_days,
            "patients_trend": [{"date": day, "count": patient_trend_map.get(day, 0)} for day in day_range],
            "documents_trend": [{"date": day, "count": document_trend_map.get(day, 0)} for day in day_range],
            "gender_distribution": gender_distribution,
            "doc_type_distribution": doc_type_distribution,
            "admission_status_distribution": admission_status_distribution,
        }

        if include_employee:
            cursor.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS label, COUNT(*) AS count
                FROM users
                WHERE hospital_id = ?
                GROUP BY label
                ORDER BY count DESC, label ASC
                """
                ,
                (scoped_hospital_id,),
            )
            employee_status_distribution = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(department), ''), 'Unassigned') AS label, COUNT(*) AS count
                FROM users
                WHERE hospital_id = ?
                GROUP BY label
                ORDER BY count DESC, label ASC
                """
                ,
                (scoped_hospital_id,),
            )
            department_distribution = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(user_type), ''), 'unknown') AS label, COUNT(*) AS count
                FROM users
                WHERE hospital_id = ?
                GROUP BY label
                ORDER BY count DESC, label ASC
                """
                ,
                (scoped_hospital_id,),
            )
            access_role_distribution = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                "SELECT COUNT(*) AS total FROM users WHERE hospital_id = ?",
                (scoped_hospital_id,),
            )
            employee_total = cursor.fetchone()["total"]

            analytics["employee"] = {
                "total": employee_total,
                "status_distribution": employee_status_distribution,
                "department_distribution": department_distribution,
                "access_role_distribution": access_role_distribution,
            }

    return analytics



def delete_patient(db, patient_id, hospital_id=None):
    """Delete patient and all associated admissions/documents"""
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM documents WHERE patient_id = ? AND hospital_id = ?",
            (patient_id, scoped_hospital_id),
        )
        cursor.execute(
            "DELETE FROM admissions WHERE patient_id = ? AND hospital_id = ?",
            (patient_id, scoped_hospital_id),
        )
        cursor.execute(
            "DELETE FROM patients WHERE patient_id = ? AND hospital_id = ?",
            (patient_id, scoped_hospital_id),
        )
        conn.commit()
        return cursor.rowcount > 0


# ==================== Employee management ====================


def get_all_employees(db, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, username, role, job_role, full_name, email, phone, department,
                   employee_id, date_joined, status, address, emergency_contact, created_at, access_role, user_type, module_access, doctor_name,
                   phone_country_code, emergency_contact_country_code
            FROM users
            WHERE hospital_id = ?
            ORDER BY date_joined DESC
        """
            ,
            (scoped_hospital_id,),
        )
        return cursor.fetchall()



def get_employee(db, employee_id=None, username=None, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if employee_id:
            cursor.execute(
                """
                SELECT id, username, role, job_role, full_name, email, phone, department,
                       employee_id, date_joined, status, address, emergency_contact, created_at, access_role, user_type, module_access, doctor_name,
                   phone_country_code, emergency_contact_country_code
                FROM users WHERE employee_id = ? AND hospital_id = ?
            """,
                (employee_id, scoped_hospital_id),
            )
        elif username:
            cursor.execute(
                """
                SELECT id, username, role, job_role, full_name, email, phone, department,
                       employee_id, date_joined, status, address, emergency_contact, created_at, access_role, user_type, module_access, doctor_name,
                   phone_country_code, emergency_contact_country_code
                FROM users WHERE username = ? AND hospital_id = ?
            """,
                (username, scoped_hospital_id),
            )
        else:
            return None
        return cursor.fetchone()



def update_employee(db, employee_id, data, hospital_id=None):
    """Updates the fields present in `data`; a field the caller did not send keeps its
    stored value (a promote or role change must not blank name, phone or status)."""
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE employee_id=? AND hospital_id=?", (employee_id, scoped_hospital_id))
        current = cursor.fetchone()
        if not current:
            return False

        def value(key):
            return data[key] if key in data else current.get(key)

        cursor.execute(
            """
            UPDATE users SET full_name=?, email=?, phone=?, department=?,
                           status=?, address=?, emergency_contact=?, job_role=?, access_role=COALESCE(?, access_role),
                           user_type=COALESCE(?, user_type), module_access=COALESCE(?, module_access),
                           phone_country_code=?, emergency_contact_country_code=?
            WHERE employee_id=? AND hospital_id=?
        """,
            (
                value("full_name"),
                value("email"),
                value("phone"),
                value("department"),
                value("status") or current.get("status") or "active",
                value("address"),
                value("emergency_contact"),
                value("job_role"),
                data.get("access_role"),
                data.get("user_type"),
                json.dumps(data["module_access"], separators=(",", ":")) if "module_access" in data else None,
                value("phone_country_code"),
                value("emergency_contact_country_code"),
                employee_id,
                scoped_hospital_id,
            ),
        )
        updated = cursor.rowcount > 0
        # Only touch the doctor link when the caller sent job_role/doctor_name, so partial
        # updates (e.g. promote) keep the existing link.
        if updated and ("job_role" in data or "doctor_name" in data):
            cursor.execute(
                "UPDATE users SET doctor_name=? WHERE employee_id=? AND hospital_id=?",
                (linked_doctor_name(data.get("job_role"), data.get("doctor_name")), employee_id, scoped_hospital_id),
            )
        conn.commit()
        return updated



def deactivate_employee(db, employee_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE users SET status='inactive' WHERE employee_id=? AND hospital_id=?",
            (employee_id, scoped_hospital_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def activate_employee(db, employee_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE users SET status='active' WHERE employee_id=? AND hospital_id=?",
            (employee_id, scoped_hospital_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_employee(db, employee_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM users WHERE employee_id=? AND hospital_id=?",
            (employee_id, scoped_hospital_id),
        )
        row = cursor.fetchone()
        if row:
            user_id = row[0]
            # Doctor payout statements are financial records tied to the doctor: they must not be lost.
            cursor.execute("SELECT COUNT(*) FROM doctor_statements WHERE doctor_id=?", (user_id,))
            statements = cursor.fetchone()[0]
            if statements:
                raise ValueError(
                    f"This doctor has {statements} payout statement{'s' if statements != 1 else ''} in Billing (Doctor Payouts), "
                    "so the employee cannot be deleted. Deactivate the employee instead; their login is blocked and the records stay."
                )
            cursor.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            cursor.execute(
                "DELETE FROM users WHERE id=?",
                (user_id,),
            )
            conn.commit()
            return True
        return False



def get_employee_stats(db, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM users WHERE status='active' AND hospital_id = ?",
            (scoped_hospital_id,),
        )
        active = cursor.fetchone()[0]
        cursor.execute(
            "SELECT COUNT(*) FROM users WHERE status='inactive' AND hospital_id = ?",
            (scoped_hospital_id,),
        )
        inactive = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM users WHERE hospital_id = ?", (scoped_hospital_id,))
        total = cursor.fetchone()[0]
    return {"total": total, "active": active, "inactive": inactive}



def search_employees(db, query, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        search = f"%{query}%"
        cursor.execute(
            """
            SELECT id, username, role, job_role, full_name, email, phone, department,
                   employee_id, date_joined, status, address, emergency_contact, created_at, access_role, user_type, module_access, doctor_name,
                   phone_country_code, emergency_contact_country_code
            FROM users WHERE
            hospital_id = ? AND (full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR employee_id LIKE ?)
            ORDER BY date_joined DESC
        """,
            (scoped_hospital_id, search, search, search, search),
        )
        return cursor.fetchall()



def _coerce_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0



def _resolve_doctor_fee(conn, doctor_name, appointment_date, patient_id=None):
    appointment_day = str(appointment_date).split("T")[0].split(" ")[0]
    cursor = conn.cursor()
    
    # 7-day rule for Follow-ups
    is_follow_up = False
    if patient_id:
        cursor.execute(
            """
            SELECT appointment_date FROM appointments 
            WHERE patient_id = ? AND status = 'completed'
            ORDER BY appointment_date DESC LIMIT 1
            """,
            (patient_id,)
        )
        last_visit = cursor.fetchone()
        if last_visit:
            from datetime import datetime
            try:
                last_dt = datetime.strptime(str(last_visit["appointment_date"]).split("T")[0].split(" ")[0], "%Y-%m-%d")
                curr_dt = datetime.strptime(appointment_day, "%Y-%m-%d")
                diff_days = (curr_dt - last_dt).days
                if 0 <= diff_days <= 7:
                    is_follow_up = True
            except Exception:
                pass

    if is_follow_up:
        return 0.0, "follow_up"

    if not doctor_name:
        return 0.0, "new"
        
    cursor.execute(
        """
        SELECT consultation_fee
        FROM doctor_schedules
        WHERE doctor_name = ? AND schedule_date = DATE(?)
        ORDER BY schedule_date DESC, created_at DESC
        LIMIT 1
        """,
        (doctor_name, appointment_day),
    )
    direct_match = cursor.fetchone()
    if direct_match:
        return _coerce_float(direct_match["consultation_fee"]), "new"
        
    cursor.execute(
        """
        SELECT consultation_fee
        FROM doctor_schedules
        WHERE doctor_name = ?
        ORDER BY schedule_date DESC, created_at DESC
        LIMIT 1
        """,
        (doctor_name,),
    )
    fallback = cursor.fetchone()
    if not fallback:
        return 0.0, "new"
    
    return _coerce_float(fallback["consultation_fee"]), "new"



def _normalize_appointment_status(status_str):
    raw = str(status_str or "").strip().lower().replace("-", "_").replace(" ", "_")
    if raw in ("waiting", "wait", "pending", "queue"):
        return "scheduled"
    if raw in ("scheduled", "checked_in", "in_consultation", "completed", "cancelled", "skipped", "no_show"):
        return raw
    return "scheduled"



_SLOT_FREE_STATUSES = ("cancelled", "no_show", "skipped")
_DEFAULT_SLOT_MINUTES = 15


def _parse_hhmm(value):
    match = re.match(r"^\s*(\d{1,2}):(\d{2})", str(value or ""))
    if not match:
        return None
    hours, minutes = int(match.group(1)), int(match.group(2))
    if hours > 23 or minutes > 59:
        return None
    return hours * 60 + minutes


def _format_slot_label(total_minutes):
    hours, minutes = divmod(int(total_minutes), 60)
    suffix = "AM" if hours < 12 else "PM"
    return f"{(hours % 12) or 12}:{minutes:02d} {suffix}"


def _assign_doctor_slot(cursor, doctor_name, visit_type, appointment_date, appointment_day, schedule):
    """Return the appointment_date to store so one doctor never has two patients
    at the same time.

    A date-only booking (walk-in from registration) gets the doctor's next free
    slot instead of piling up at 00:00. A booking with an explicit time is
    rejected if that doctor already has a live appointment at that minute.
    Emergency bookings go to the duty pool, not a timed slot, and are left alone.
    """
    if not doctor_name or str(visit_type or "").strip().lower() == "emergency":
        return appointment_date

    # Serialise bookings for this doctor/day so two desks can't take the same slot.
    cursor.execute(
        "SELECT pg_advisory_xact_lock(hashtext(?))",
        (f"appointment-slot:{doctor_name.lower()}:{appointment_day}",),
    )
    cursor.execute(
        """
        SELECT appointment_date FROM appointments
        WHERE LOWER(TRIM(doctor_name)) = LOWER(?) AND DATE(appointment_date) = DATE(?)
          AND COALESCE(status, '') NOT IN ('cancelled', 'no_show', 'skipped')
        """,
        (doctor_name, appointment_day),
    )
    taken = set()
    for row in cursor.fetchall():
        value = row["appointment_date"]
        minute = (value.hour * 60 + value.minute) if hasattr(value, "hour") else _parse_hhmm(str(value)[11:16])
        if minute is not None:
            taken.add(minute)

    slot_minutes = _DEFAULT_SLOT_MINUTES
    day_start, day_end = 9 * 60, 24 * 60
    if schedule:
        start = _parse_hhmm(schedule["start_time"])
        end = _parse_hhmm(schedule["end_time"])
        capacity = schedule["slot_capacity"] or 0
        if start is not None:
            day_start = start
        if start is not None and end is not None and end > start and capacity > 0:
            slot_minutes = max(5, (end - start) // capacity)

    def next_free(from_minute):
        candidate = from_minute
        while candidate < day_end:
            if not any(candidate <= t < candidate + slot_minutes for t in taken):
                return candidate
            candidate += slot_minutes
        # Grid is full: fall back to the first unused minute.
        for candidate in range(from_minute, day_end):
            if candidate not in taken:
                return candidate
        return None

    earliest = day_start
    now = current_ist_datetime()
    if appointment_day == now.strftime("%Y-%m-%d"):
        now_minute = now.hour * 60 + now.minute
        earliest = max(earliest, now_minute + (-now_minute % 5))

    raw = str(appointment_date).strip()
    time_match = re.search(r"[T ](\d{1,2}:\d{2})", raw)
    if time_match:
        requested = _parse_hhmm(time_match.group(1))
        if requested is not None and requested in taken:
            suggestion = next_free(max(requested, earliest))
            hint = f" Next free slot: {_format_slot_label(suggestion)}." if suggestion is not None else ""
            raise ValueError(
                f"Dr. {doctor_name} already has a patient booked at {_format_slot_label(requested)} on {appointment_day}. "
                f"Please choose another time.{hint}"
            )
        return appointment_date

    slot = next_free(earliest)
    if slot is None:
        raise ValueError(f"Dr. {doctor_name} has no free appointment slot left on {appointment_day}.")
    hours, minutes = divmod(slot, 60)
    return f"{appointment_day} {hours:02d}:{minutes:02d}:00"


def create_appointment(db, data):
    appointment_date = data["appointment_date"]
    appointment_day = str(appointment_date).split("T")[0].split(" ")[0]
    with get_connection(db) as conn:
        cursor = conn.cursor()

        doctor_name = (data.get("doctor_name") or "").strip()
        department = (data.get("department") or "").strip()
        resolved_department = department
        
        patient_id = data.get("patient_id")
        if patient_id:
            cursor.execute(
                "SELECT id, status FROM appointments WHERE patient_id = ? AND status IN ('scheduled', 'checked_in', 'in_consultation') LIMIT 1",
                (patient_id,)
            )
            active_appointment = cursor.fetchone()
            if active_appointment:
                status_display = active_appointment["status"].replace("_", " ").title()
                raise ValueError(f"Patient already has an active consultation token (Status: {status_display}). Please complete or cancel the existing consultation first.")

        if doctor_name:
            cursor.execute(
                "SELECT schedule_date, status, department, slot_capacity, start_time, end_time FROM doctor_schedules WHERE doctor_name = ? AND (schedule_date = ? OR schedule_date IS NULL)",
                (doctor_name, appointment_day)
            )
            schedules = cursor.fetchall()
            
            exact_match = next((s for s in schedules if s["schedule_date"] == appointment_day), None)
            general_match = next((s for s in schedules if not s["schedule_date"]), None)
            best_schedule = exact_match or general_match
            
            if best_schedule:
                status = (best_schedule["status"] or "available").lower()
                if status in ("inactive", "leave"):
                    raise ValueError(f"Doctor '{doctor_name}' is currently marked on leave or inactive.")
                if not department:
                    resolved_department = (best_schedule["department"] or "").strip()

            if not resolved_department:
                resolved_department = department or "General Medicine"
                    
            if schedules:
                cursor.execute(
                    "SELECT COUNT(*) as booked_count FROM appointments WHERE doctor_name = ? AND DATE(appointment_date) = ? AND status NOT IN ('cancelled')",
                    (doctor_name, appointment_day)
                )
                booked_count = cursor.fetchone()["booked_count"]
                valid_capacities = [s["slot_capacity"] for s in schedules if s["slot_capacity"] and s["slot_capacity"] > 0]
                if valid_capacities:
                    max_capacity = max(valid_capacities)
                    if booked_count >= max_capacity:
                        raise ValueError("Selected doctor has reached the maximum appointment capacity for the selected schedule.")
        else:
            resolved_department = department or "General Medicine"

        appointment_date = _assign_doctor_slot(
            cursor, doctor_name, data.get("visit_type", "OP"), appointment_date, appointment_day,
            best_schedule if doctor_name else None,
        )

        cursor.execute(
            "SELECT COALESCE(MAX(token_no), 0) AS value FROM appointments WHERE DATE(appointment_date) = DATE(?)",
            (appointment_day,),
        )
        token_no = int((cursor.fetchone() or {"value": 0})["value"] or 0) + 1
        resolved_fee, appointment_kind = _resolve_doctor_fee(conn, data.get("doctor_name"), appointment_date, data.get("patient_id"))
        cursor.execute(
            """
            INSERT INTO appointments (
                patient_id, patient_name, visit_type, department, doctor_name,
                appointment_date, token_no, status, notes, appointment_kind, follow_up_for,
                reminder_sent_at, no_show_marked, consultation_fee
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("patient_id"),
                data["patient_name"],
                data.get("visit_type", "OP"),
                resolved_department,
                data.get("doctor_name"),
                appointment_date,
                token_no,
                _normalize_appointment_status(data.get("status", "scheduled")),
                data.get("notes"),
                appointment_kind,
                data.get("follow_up_for"),
                data.get("reminder_sent_at"),
                1 if data.get("no_show_marked") else 0,
                resolved_fee,
            ),
        )
        appointment_id = cursor.lastrowid
        conn.commit()
        return appointment_id, token_no


def create_op_appointment_with_invoice(db, payload, consultation_fee, username):
    """Atomically creates appointment, syncs patient data, creates invoice and payment."""
    import re
    from datetime import datetime
    with get_connection(db) as conn:
        # 1. Create Appointment (Inlined logic to avoid nested commits)
        appointment_date = payload["appointment_date"]
        appointment_day = str(appointment_date).split("T")[0].split(" ")[0]
        cursor = conn.cursor()

        doctor_name = (payload.get("doctor_name") or "").strip()
        department = (payload.get("department") or "").strip()
        resolved_department = department
        
        patient_id = payload.get("patient_id")
        if patient_id:
            # Idempotency guard: a double-click or retry submitting the exact
            # same booking (same patient+doctor+slot) within a few seconds
            # returns the appointment that was just created instead of
            # erroring out or creating a duplicate token/invoice.
            cursor.execute(
                """
                SELECT id, token_no FROM appointments
                WHERE patient_id = ? AND doctor_name = ? AND DATE(appointment_date) = DATE(?)
                  AND created_at >= (CURRENT_TIMESTAMP - INTERVAL '10 seconds')
                ORDER BY created_at DESC LIMIT 1
                """,
                (patient_id, doctor_name, appointment_date),
            )
            recent_duplicate = cursor.fetchone()
            if recent_duplicate:
                return recent_duplicate["id"], recent_duplicate["token_no"], None, None

            # The database allows one active queue entry per patient across ALL
            # dates (unique index idx_unique_active_appointment), so look at
            # every date - checking only this date let the INSERT hit that
            # index and fail with a 500.
            cursor.execute(
                "SELECT id, status, DATE(appointment_date) AS appointment_day FROM appointments WHERE patient_id = ? AND status IN ('scheduled', 'checked_in', 'in_consultation')",
                (patient_id,)
            )
            for active_appointment in cursor.fetchall():
                active_day = str(active_appointment["appointment_day"])
                if active_day < appointment_day:
                    # Left open on an earlier day's queue. The OP queue is per day,
                    # so close it out instead of blocking every future visit:
                    # seen by the doctor -> completed, never seen -> no-show.
                    closed_status = "completed" if active_appointment["status"] == "in_consultation" else "no_show"
                    cursor.execute(
                        "UPDATE appointments SET status = ?, no_show_marked = ? WHERE id = ?",
                        (closed_status, 1 if closed_status == "no_show" else 0, active_appointment["id"]),
                    )
                    continue
                status_display = active_appointment["status"].replace("_", " ").title()
                when = "for this date" if active_day == appointment_day else f"on {active_day}"
                raise ValueError(f"Patient already has an active queue entry {when} (Status: {status_display}). Please complete or cancel the existing consultation first.")

        if doctor_name:
            cursor.execute(
                "SELECT schedule_date, status, department, slot_capacity, start_time, end_time FROM doctor_schedules WHERE doctor_name = ? AND (schedule_date = ? OR schedule_date IS NULL)",
                (doctor_name, appointment_day)
            )
            schedules = cursor.fetchall()
            
            exact_match = next((s for s in schedules if s["schedule_date"] == appointment_day), None)
            general_match = next((s for s in schedules if not s["schedule_date"]), None)
            best_schedule = exact_match or general_match
            
            if best_schedule:
                status = (best_schedule["status"] or "available").lower()
                if status in ("inactive", "leave"):
                    raise ValueError(f"Doctor '{doctor_name}' is currently marked on leave or inactive.")
                if not department:
                    resolved_department = (best_schedule["department"] or "").strip()

            if not resolved_department:
                resolved_department = department or "General Medicine"
                    
            if schedules:
                cursor.execute(
                    "SELECT COUNT(*) as booked_count FROM appointments WHERE doctor_name = ? AND DATE(appointment_date) = ? AND status NOT IN ('cancelled')",
                    (doctor_name, appointment_day)
                )
                booked_count = cursor.fetchone()["booked_count"]
                valid_capacities = [s["slot_capacity"] for s in schedules if s["slot_capacity"] and s["slot_capacity"] > 0]
                if valid_capacities:
                    max_capacity = max(valid_capacities)
                    if booked_count >= max_capacity:
                        raise ValueError("Selected doctor has reached the maximum appointment capacity for the selected schedule.")
        else:
            resolved_department = department or "General Medicine"

        appointment_date = _assign_doctor_slot(
            cursor, doctor_name, payload.get("visit_type", "OP"), appointment_date, appointment_day,
            best_schedule if doctor_name else None,
        )

        cursor.execute(
            "SELECT COALESCE(MAX(token_no), 0) AS value FROM appointments WHERE DATE(appointment_date) = DATE(?)",
            (appointment_day,),
        )
        token_no = int((cursor.fetchone() or {"value": 0})["value"] or 0) + 1
        resolved_fee, appointment_kind = _resolve_doctor_fee(conn, payload.get("doctor_name"), appointment_date, patient_id)
        cursor.execute(
            """
            INSERT INTO appointments (
                patient_id, patient_name, visit_type, department, doctor_name,
                appointment_date, token_no, status, notes, appointment_kind, follow_up_for,
                reminder_sent_at, no_show_marked, consultation_fee
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.get("patient_id"),
                payload["patient_name"],
                payload.get("visit_type", "OP"),
                resolved_department,
                payload.get("doctor_name"),
                appointment_date,
                token_no,
                _normalize_appointment_status(payload.get("status", "scheduled")),
                payload.get("notes"),
                appointment_kind,
                payload.get("follow_up_for"),
                payload.get("reminder_sent_at"),
                1 if payload.get("no_show_marked") else 0,
                resolved_fee,
            ),
        )
        appointment_id = cursor.lastrowid
        
        # 2. Sync patient weight/height
        if patient_id:
            weight = payload.get("weight")
            height = payload.get("height")
            notes = payload.get("notes") or ""
            if weight in ("", None, "null"):
                m = re.search(r"Weight:\s*([\d.]+)\s*kg", notes, re.IGNORECASE)
                if m: weight = m.group(1)
            if height in ("", None, "null"):
                m = re.search(r"Height:\s*([\d.]+)\s*cm", notes, re.IGNORECASE)
                if m: height = m.group(1)

            if weight in ("", None, "null"):
                weight = None
            else:
                try:
                    weight = float(weight)
                except ValueError:
                    raise ValueError("Weight must be a valid number.")

            if height in ("", None, "null"):
                height = None
            else:
                try:
                    height = float(height)
                except ValueError:
                    raise ValueError("Height must be a valid number.")

            # Instead of updating patients table, log it to vitals history
            vitals_data = {
                "weight": weight,
                "height": height
            }
            # Extract other vitals from notes
            for v in ["bp", "pulse", "temperature", "spo2"]:
                if v in payload and payload[v]:
                    vitals_data[v] = payload[v]
                else:
                    if v == "bp":
                        m = re.search(r"BP:\s*([\d]+/[\d]+)", notes, re.IGNORECASE)
                        if m: vitals_data["bp"] = m.group(1)
                    elif v == "pulse":
                        m = re.search(r"Pulse:\s*(\d+)", notes, re.IGNORECASE)
                        if m: vitals_data["pulse"] = m.group(1)
                    elif v == "temperature":
                        m = re.search(r"(?:Temp|Temperature):\s*([\d.]+)", notes, re.IGNORECASE)
                        if m: vitals_data["temperature"] = m.group(1)
                    elif v == "spo2":
                        m = re.search(r"SpO2:\s*([\d.]+)", notes, re.IGNORECASE)
                        if m: vitals_data["spo2"] = m.group(1)
            
            add_patient_vitals(db, patient_id, vitals_data)

        # 3. Create Invoice & Payment if fee > 0
        invoice_id = None
        payment_id = None
        if consultation_fee > 0:
            invoice_no = f"INV-OP-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
            
            # Use Operator Name as single source of truth, fallback to username
            op_name = payload.get("operator_name")
            if not op_name or str(op_name).strip() == "":
                op_name = username
                
            cursor.execute(
                """
                INSERT INTO invoices (
                    invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                    subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                    advance_amount, refunded_amount, appointment_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    invoice_no, patient_id, "OP", payload.get("doctor_name"), None, None,
                    0, 0, 0, consultation_fee, 0, consultation_fee, "due", op_name, 0, 0, appointment_id
                )
            )
            invoice_id = cursor.lastrowid

            cursor.execute(
                """
                INSERT INTO invoice_payments (
                    invoice_id, amount, payment_mode, gateway_ref
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    invoice_id, consultation_fee, 
                    str(payload.get("payment_mode") or "cash").strip().lower().replace(" ", "_"), 
                    payload.get("gateway_ref")
                )
            )
            payment_id = cursor.lastrowid

            cursor.execute(
                """
                UPDATE invoices 
                SET paid_amount = paid_amount + ?,
                    due_amount = GREATEST(total_amount - (paid_amount + advance_amount - refunded_amount + ?), CAST(0.0 AS double precision)),
                    payment_status = CASE 
                        WHEN GREATEST(total_amount - (paid_amount + advance_amount - refunded_amount + ?), CAST(0.0 AS double precision)) <= 0.0 THEN 'paid' 
                        ELSE 'due' 
                    END
                WHERE id = ?
                """,
                (consultation_fee, consultation_fee, consultation_fee, invoice_id)
            )

        conn.commit()
        return appointment_id, token_no, invoice_id, payment_id



def list_appointments(db, appointment_date=None, status=None, visit_type=None, doctor_name=None, patient_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if appointment_date:
            clauses.append("(DATE(a.appointment_date) = DATE(?) OR (a.status = 'completed' AND DATE(a.created_at) = DATE(?)))")
            params.extend([appointment_date, appointment_date])
        if status:
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if len(statuses) == 1:
                clauses.append("a.status = ?")
                params.append(statuses[0])
            elif statuses:
                placeholders = ", ".join(["?"] * len(statuses))
                clauses.append(f"a.status IN ({placeholders})")
                params.extend(statuses)
        if visit_type:
            visit_types = [v.strip() for v in visit_type.split(",") if v.strip()]
            if len(visit_types) == 1:
                clauses.append("visit_type = ?")
                params.append(visit_types[0])
            elif visit_types:
                placeholders = ", ".join(["?"] * len(visit_types))
                clauses.append(f"visit_type IN ({placeholders})")
                params.extend(visit_types)
        if doctor_name:
            clauses.append("LOWER(TRIM(doctor_name)) = LOWER(TRIM(?))")
            params.append(doctor_name)
        if patient_id:
            clauses.append("a.patient_id = ?")
            params.append(patient_id)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT
                a.*,
                p.age AS age,
                p.gender AS gender,
                p.weight AS weight,
                p.height AS height,
                p.phone AS mobile,
                p.phone AS phone,
                p.created_at AS registration_date,
                p.created_at AS patient_created_at,
                TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.middle_name, '') || ' ' || COALESCE(p.last_name, '')) AS registered_patient_name,
                (SELECT i.created_by FROM invoices i WHERE i.patient_id = a.patient_id AND i.module = 'OP' AND COALESCE(i.doctor_name, '') = COALESCE(a.doctor_name, '') AND DATE(i.created_at) = DATE(a.created_at) LIMIT 1) AS operator_name,
                (SELECT ip.payment_mode FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.patient_id = a.patient_id AND i.module = 'OP' AND COALESCE(i.doctor_name, '') = COALESCE(a.doctor_name, '') AND DATE(i.created_at) = DATE(a.created_at) ORDER BY ip.created_at DESC LIMIT 1) AS payment_mode
            FROM appointments a
            LEFT JOIN patients p ON p.patient_id = a.patient_id
            {where_clause}
            ORDER BY a.appointment_date ASC, a.token_no ASC
            """,
            tuple(params),
        )
        return cursor.fetchall()



def list_doctors_history(db, hospital_id, doctor_name=None, from_date=None, to_date=None, department=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = ["p.hospital_id = ?"]
        params = [scoped_hospital_id]
        if doctor_name and doctor_name != "All":
            clauses.append("LOWER(TRIM(a.doctor_name)) = LOWER(TRIM(?))")
            params.append(doctor_name)
        if from_date:
            clauses.append("DATE(a.appointment_date) >= DATE(?)")
            params.append(from_date)
        if to_date:
            clauses.append("DATE(a.appointment_date) <= DATE(?)")
            params.append(to_date)
        if department and department != "All":
            clauses.append("a.department = ?")
            params.append(department)
        
        where_clause = f" WHERE {' AND '.join(clauses)}"
        
        cursor.execute(
            f"""
            SELECT
                a.*,
                p.age AS age,
                p.gender AS gender,
                p.weight AS weight,
                p.height AS height,
                p.phone AS mobile,
                p.phone AS phone,
                TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.middle_name, '') || ' ' || COALESCE(p.last_name, '')) AS registered_patient_name
            FROM appointments a
            LEFT JOIN patients p ON p.patient_id = a.patient_id
            {where_clause}
            ORDER BY a.appointment_date DESC, a.token_no DESC
            """,
            tuple(params),
        )
        return cursor.fetchall()


WAITING_STATUSES = ("scheduled", "checked_in")
TERMINAL_STATUSES = ("completed", "no_show")

APPOINTMENT_STATUS_TRANSITIONS = {
    "scheduled": {"scheduled", "checked_in", "in_consultation", "completed", "skipped", "no_show", "cancelled", "waiting", "pending"},
    "waiting": {"scheduled", "checked_in", "in_consultation", "completed", "skipped", "no_show", "cancelled", "waiting", "pending"},
    "pending": {"scheduled", "checked_in", "in_consultation", "completed", "skipped", "no_show", "cancelled", "waiting", "pending"},
    "checked_in": {"scheduled", "checked_in", "in_consultation", "completed", "skipped", "no_show", "cancelled", "waiting", "pending"},
    "in_consultation": {"in_consultation", "completed", "waiting", "pending", "scheduled"},
    "skipped": {"skipped", "scheduled", "checked_in", "waiting", "pending"},
    "cancelled": {"cancelled", "scheduled", "checked_in", "waiting", "pending"},
    # Completed is terminal: once a consultation is done its queue status is locked.
    "completed": {"completed"},
    "no_show": {"no_show", "scheduled", "checked_in", "waiting", "pending"},
}



def validate_appointment_transition(current_status, next_status):
    """Raise ValueError if next_status isn't a legal move from current_status.

    Waiting-equivalent (scheduled/checked_in) can move to in_consultation,
    completed, skipped, no_show, or cancelled. In_consultation can complete.
    Skipped/cancelled/no_show can be Recalled back to waiting. Completed is
    terminal. A same-status "transition" (no real change) is always allowed.
    """
    current = (current_status or "scheduled").strip().lower()
    nxt = (next_status or current).strip().lower()
    if current == nxt:
        return
    if nxt == "completed":
        return
    allowed = APPOINTMENT_STATUS_TRANSITIONS.get(current, set())
    if nxt not in allowed:
        raise ValueError(f"Cannot move an appointment from '{current}' to '{nxt}'.")



def update_appointment(db, appointment_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM appointments WHERE id = ?", (appointment_id,))
        existing = cursor.fetchone()
        if not existing:
            return False

        if "status" in data:
            validate_appointment_transition(existing["status"], data.get("status"))
            new_status = str(data.get("status") or "").strip().lower()
            if new_status in ("in_consultation", "in consultation", "consulting") and (existing["status"] or "").strip().lower() not in ("in_consultation", "in consultation", "consulting"):
                target_doctor = (data.get("doctor_name") or existing.get("doctor_name") or "").strip()
                if target_doctor:
                    cursor.execute(
                        """
                        SELECT id, patient_name, token_no FROM appointments
                        WHERE LOWER(TRIM(doctor_name)) = LOWER(TRIM(?))
                          AND status IN ('in_consultation', 'in consultation', 'consulting')
                          AND appointment_date::date = (SELECT appointment_date::date FROM appointments WHERE id = ?)
                          AND id != ?
                        LIMIT 1
                        """,
                        (target_doctor, appointment_id, appointment_id),
                    )
                    already_active = cursor.fetchone()
                    if already_active:
                        raise ValueError("Already a patient is present in consultation.")

        # Real consultation times: stamped once, the first time the status reaches each stage.
        started_at = existing.get("consultation_started_at")
        completed_at = existing.get("consultation_completed_at")
        if "status" in data:
            new_status = str(data.get("status") or "").strip().lower()
            now_ist = current_ist_datetime().replace(tzinfo=None)
            if new_status in ("in_consultation", "in consultation", "consulting") and not started_at:
                started_at = now_ist
            if new_status == "completed" and not completed_at:
                completed_at = now_ist

        doctor_name = (data.get("doctor_name", existing["doctor_name"]) or "").strip()
        department = (data.get("department", existing["department"]) or "").strip()
        resolved_department = department

        if doctor_name:
            appointment_date_str = data.get("appointment_date", existing["appointment_date"])
            appointment_day = str(appointment_date_str).split("T")[0].split(" ")[0] if appointment_date_str else None
            
            if appointment_day:
                cursor.execute(
                    "SELECT schedule_date, status, department FROM doctor_schedules WHERE doctor_name = ? AND (schedule_date = ? OR schedule_date IS NULL)",
                    (doctor_name, appointment_day)
                )
            else:
                cursor.execute(
                    "SELECT schedule_date, status, department FROM doctor_schedules WHERE doctor_name = ?",
                    (doctor_name,)
                )
            schedules = cursor.fetchall()
            
            if appointment_day:
                exact_match = next((s for s in schedules if s["schedule_date"] == appointment_day), None)
                general_match = next((s for s in schedules if not s["schedule_date"]), None)
                best_schedule = exact_match or general_match
            else:
                best_schedule = next((s for s in schedules if (s["status"] or "available").lower() not in ("inactive", "leave")), schedules[0] if schedules else None)

            if best_schedule:
                status = (best_schedule["status"] or "available").lower()
                if status in ("inactive", "leave"):
                    raise ValueError(f"Doctor '{doctor_name}' is currently marked on leave or inactive.")
                if not department:
                    resolved_department = (best_schedule["department"] or "").strip()

            if not resolved_department:
                resolved_department = department or "General Medicine"
        else:
            resolved_department = department or "General Medicine"

        cursor.execute(
            """
            UPDATE appointments
            SET patient_id = ?,
                patient_name = ?,
                visit_type = ?,
                department = ?,
                doctor_name = ?,
                appointment_date = ?,
                status = ?,
                notes = ?,
                appointment_kind = ?,
                follow_up_for = ?,
                reminder_sent_at = ?,
                no_show_marked = ?,
                consultation_fee = ?,
                consultation_started_at = ?,
                consultation_completed_at = ?
            WHERE id = ?
            """,
            (
                data.get("patient_id", existing["patient_id"]),
                data.get("patient_name", existing["patient_name"]),
                data.get("visit_type", existing["visit_type"]),
                resolved_department,
                data.get("doctor_name", existing["doctor_name"]),
                data.get("appointment_date", existing["appointment_date"]),
                data.get("status", existing["status"]),
                data.get("notes", existing["notes"]),
                data.get("appointment_kind", existing["appointment_kind"]),
                data.get("follow_up_for", existing["follow_up_for"]),
                data.get("reminder_sent_at", existing["reminder_sent_at"]),
                1 if data.get("no_show_marked", existing["no_show_marked"]) else 0,
                _coerce_float(data.get("consultation_fee", existing["consultation_fee"])),
                started_at,
                completed_at,
                appointment_id,
            ),
        )

        if "operator_name" in data and str(data["operator_name"]).strip() != "":
            cursor.execute(
                """
                UPDATE invoices 
                SET created_by = ? 
                WHERE patient_id = ? 
                  AND module = 'OP' 
                  AND COALESCE(doctor_name, '') = COALESCE(?, '') 
                  AND DATE(created_at) = DATE(?)
                """,
                (
                    str(data["operator_name"]).strip(),
                    existing["patient_id"],
                    existing["doctor_name"],
                    existing["appointment_date"]
                )
            )

        conn.commit()
        return cursor.rowcount > 0



def _expand_schedule_dates(raw_schedule_date):
    if raw_schedule_date is None:
        raise ValueError("schedule_date is required")
    if isinstance(raw_schedule_date, (list, tuple)):
        raw_values = [str(item).strip() for item in raw_schedule_date if str(item).strip()]
    else:
        raw_text = str(raw_schedule_date).strip()
        if not raw_text:
            raise ValueError("schedule_date is required")
        raw_values = [item.strip() for item in re.split(r"[\s,]+", raw_text) if item.strip()]
    if not raw_values:
        raise ValueError("schedule_date is required")
    anchor_date = current_ist_datetime().date()
    parsed_dates = []
    day_map = {
        "mon": 0, "monday": 0,
        "tue": 1, "tuesday": 1,
        "wed": 2, "wednesday": 2,
        "thu": 3, "thursday": 3,
        "fri": 4, "friday": 4,
        "sat": 5, "saturday": 5,
        "sun": 6, "sunday": 6,
    }
    for token in raw_values:
        lowered = token.lower()
        if lowered in {"daily", "everyday", "every_day"}:
            parsed_dates.extend(anchor_date + timedelta(days=offset) for offset in range(7))
            continue
        if lowered in day_map:
            weekday = day_map[lowered]
            next_date = anchor_date
            while next_date.weekday() != weekday:
                next_date += timedelta(days=1)
            parsed_dates.append(next_date)
            continue
        try:
            if len(token) == 10 and token[4] == "-" and token[7] == "-":
                parsed_date = datetime.strptime(token, "%Y-%m-%d").date()
            else:
                parsed_date = datetime.strptime(token, "%d-%m-%Y").date()
            parsed_dates.append(parsed_date)
        except ValueError as error:
            raise ValueError(f"Invalid schedule date: {token}") from error
    unique_dates = []
    seen = set()
    for parsed_date in parsed_dates:
        key = parsed_date.isoformat()
        if key in seen:
            continue
        seen.add(key)
        unique_dates.append(parsed_date)
    if not unique_dates:
        raise ValueError("schedule_date is required")
    return unique_dates



def create_doctor_schedule(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        slot_capacity = int(data.get("slot_capacity") or 12)
        consultation_fee = _coerce_float(data.get("consultation_fee"))
        review_fee = _coerce_float(data.get("review_fee"))
        status = data.get("status", "available")
        notes = data.get("notes")
        doctor_name = data["doctor_name"]
        new_start = data.get("start_time") or "09:00"
        new_end = data.get("end_time") or "13:00"
        raw_date = data.get("schedule_date")

        # --- Permanent roster entry (no date) ---
        if not raw_date:
            cursor.execute(
                """
                INSERT INTO doctor_schedules (
                    doctor_name, department, schedule_date, start_time, end_time,
                    slot_capacity, consultation_fee, review_fee, status, notes
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doctor_name,
                    data.get("department"),
                    new_start,
                    new_end,
                    slot_capacity,
                    consultation_fee,
                    review_fee,
                    status,
                    notes,
                ),
            )
            conn.commit()
            return cursor.lastrowid

        # --- Date-specific schedule (original path) ---
        schedule_dates = _expand_schedule_dates(raw_date)
        created_ids = []
        for schedule_date in schedule_dates:
            date_str = schedule_date.isoformat()
            # Block overlapping schedules for the SAME doctor on the same date.
            # Two ranges [s1, e1) and [s2, e2) overlap when s1 < e2 AND s2 < e1.
            # Different doctors on the same date/time are explicitly allowed.
            cursor.execute(
                """
                SELECT id, start_time, end_time FROM doctor_schedules
                WHERE doctor_name = ? AND schedule_date = ?
                  AND start_time < ? AND end_time > ?
                LIMIT 1
                """,
                (doctor_name, date_str, new_end, new_start),
            )
            conflict = cursor.fetchone()
            if conflict:
                raise ValueError(
                    f"Doctor '{doctor_name}' already has a schedule on {date_str} "
                    f"from {conflict['start_time']} to {conflict['end_time']} "
                    f"that overlaps with {new_start}\u2013{new_end}."
                )
            cursor.execute(
                """
                INSERT INTO doctor_schedules (
                    doctor_name, department, schedule_date, start_time, end_time,
                    slot_capacity, consultation_fee, review_fee, status, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doctor_name,
                    data.get("department"),
                    date_str,
                    new_start,
                    new_end,
                    slot_capacity,
                    consultation_fee,
                    review_fee,
                    status,
                    notes,
                ),
            )
            created_ids.append(cursor.lastrowid)
        conn.commit()
        return created_ids[0] if created_ids else None



def list_doctor_schedules(db, schedule_date=None, doctor_name=None, status=None, department=None):
    """Return doctor schedules filtered by date, doctor, status, and/or department."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        booked_date_expr = "ds.schedule_date"
        
        if schedule_date:
            booked_date_expr = "?"
            params.append(schedule_date)
            
        if schedule_date:
            clauses.append("(schedule_date = ? OR schedule_date IS NULL)")
            params.append(schedule_date)
        if doctor_name:
            clauses.append("doctor_name = ?")
            params.append(doctor_name)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if department:
            clauses.append("department = ?")
            params.append(department)
            
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        query = f"""
            SELECT ds.*, 
                   (SELECT COUNT(*) FROM appointments a 
                    WHERE a.doctor_name = ds.doctor_name 
                      AND DATE(a.appointment_date) = {booked_date_expr} 
                      AND a.status NOT IN ('cancelled', 'completed')) AS booked_count
            FROM doctor_schedules ds
            {where_clause} 
            ORDER BY ds.schedule_date ASC, ds.start_time ASC
        """
        cursor.execute(query, tuple(params))
        return cursor.fetchall()



def update_doctor_schedule(db, schedule_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM doctor_schedules WHERE id = ?", (schedule_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        # Resolve the final values that will be written so we can check for conflicts.
        new_doctor = data.get("doctor_name", existing["doctor_name"])
        new_date = data.get("schedule_date", existing["schedule_date"])
        new_start = data.get("start_time", existing["start_time"])
        new_end = data.get("end_time", existing["end_time"])
        # Block overlapping schedules for the SAME doctor on the same date,
        # but exclude the row being updated from the conflict check.
        cursor.execute(
            """
            SELECT id, start_time, end_time FROM doctor_schedules
            WHERE doctor_name = ? AND schedule_date = ?
              AND id != ?
              AND start_time < ? AND end_time > ?
            LIMIT 1
            """,
            (new_doctor, new_date, schedule_id, new_end, new_start),
        )
        conflict = cursor.fetchone()
        if conflict:
            raise ValueError(
                f"Doctor '{new_doctor}' already has a schedule on {new_date} "
                f"from {conflict['start_time']} to {conflict['end_time']} "
                f"that overlaps with {new_start}\u2013{new_end}."
            )
        cursor.execute(
            """
            UPDATE doctor_schedules
            SET doctor_name = ?, department = ?, schedule_date = ?, start_time = ?,
                end_time = ?, slot_capacity = ?, consultation_fee = ?, review_fee = ?, status = ?, notes = ?
            WHERE id = ?
            """,
            (
                new_doctor,
                data.get("department", existing["department"]),
                new_date,
                new_start,
                new_end,
                int(data.get("slot_capacity", existing["slot_capacity"] or 12)),
                _coerce_float(data.get("consultation_fee", existing["consultation_fee"])),
                _coerce_float(data.get("review_fee", existing["review_fee"])),
                data.get("status", existing["status"]),
                data.get("notes", existing["notes"]),
                schedule_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_doctor_schedule(db, schedule_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM doctor_schedules WHERE id = ?", (schedule_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def get_op_summary(db, target_date=None):
    day = target_date or current_ist_datetime().strftime("%Y-%m-%d")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        total_appointments = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND appointment_kind = 'follow_up' AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        follow_ups = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND status IN ('checked_in', 'in_consultation') AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        active_queue = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND LOWER(COALESCE(status, '')) IN ('completed', 'finished', 'consulted', 'done') AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        completed_count = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND no_show_marked = 1 AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        no_shows = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM appointments WHERE visit_type = 'OP' AND reminder_sent_at IS NOT NULL AND DATE(appointment_date) = DATE(?)",
            (day,),
        )
        reminders_sent = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COUNT(*) AS value FROM doctor_schedules WHERE schedule_date = ? AND status = 'available'",
            (day,),
        )
        available_doctors = cursor.fetchone()["value"]
    return {
        "date": day,
        "total_appointments": total_appointments,
        "follow_ups": follow_ups,
        "active_queue": active_queue,
        "completed_count": completed_count,
        "no_shows": no_shows,
        "reminders_sent": reminders_sent,
        "available_doctors": available_doctors,
    }



def create_patient_consent(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO patient_consents (
                patient_id, patient_name, consent_type, signed_by, relation_to_patient, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("patient_id"),
                data["patient_name"],
                data.get("consent_type", "general"),
                data["signed_by"],
                data.get("relation_to_patient"),
                data.get("status", "signed"),
                data.get("notes"),
            ),
        )
        consent_id = cursor.lastrowid
        conn.commit()
        return consent_id



def list_patient_consents(db, patient_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if patient_id:
            cursor.execute(
                "SELECT * FROM patient_consents WHERE patient_id = ? ORDER BY signed_at DESC, id DESC",
                (patient_id,),
            )
        else:
            cursor.execute("SELECT * FROM patient_consents ORDER BY signed_at DESC, id DESC")
        return cursor.fetchall()



def update_patient_consent(db, consent_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM patient_consents WHERE id = ?", (consent_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE patient_consents
            SET patient_id = ?, patient_name = ?, consent_type = ?, signed_by = ?,
                relation_to_patient = ?, status = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("patient_id", existing["patient_id"]),
                data.get("patient_name", existing["patient_name"]),
                data.get("consent_type", existing["consent_type"]),
                data.get("signed_by", existing["signed_by"]),
                data.get("relation_to_patient", existing["relation_to_patient"]),
                data.get("status", existing["status"]),
                data.get("notes", existing["notes"]),
                consent_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def create_insurance_verification(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO insurance_verifications (
                patient_id, patient_name, insurer_name, policy_number, member_id,
                verification_status, coverage_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("patient_id"),
                data["patient_name"],
                data["insurer_name"],
                data.get("policy_number"),
                data.get("member_id"),
                data.get("verification_status", "pending"),
                data.get("coverage_notes"),
            ),
        )
        verification_id = cursor.lastrowid
        conn.commit()
        return verification_id



def list_insurance_verifications(db, patient_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if patient_id:
            cursor.execute(
                "SELECT * FROM insurance_verifications WHERE patient_id = ? ORDER BY checked_at DESC, id DESC",
                (patient_id,),
            )
        else:
            cursor.execute(
                "SELECT * FROM insurance_verifications ORDER BY checked_at DESC, id DESC"
            )
        return cursor.fetchall()



def update_insurance_verification(db, verification_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM insurance_verifications WHERE id = ?",
            (verification_id,),
        )
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE insurance_verifications
            SET patient_id = ?, patient_name = ?, insurer_name = ?, policy_number = ?,
                member_id = ?, verification_status = ?, coverage_notes = ?
            WHERE id = ?
            """,
            (
                data.get("patient_id", existing["patient_id"]),
                data.get("patient_name", existing["patient_name"]),
                data.get("insurer_name", existing["insurer_name"]),
                data.get("policy_number", existing["policy_number"]),
                data.get("member_id", existing["member_id"]),
                data.get("verification_status", existing["verification_status"]),
                data.get("coverage_notes", existing["coverage_notes"]),
                verification_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def create_certificate(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO certificates (
                patient_id, admission_id, certificate_type, title, body, issued_by
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data["patient_id"],
                data.get("admission_id"),
                data["certificate_type"],
                data["title"],
                data["body"],
                data.get("issued_by"),
            ),
        )
        certificate_id = cursor.lastrowid
        conn.commit()
        return certificate_id



def list_certificates(db, patient_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM certificates WHERE patient_id = ? ORDER BY created_at DESC",
            (patient_id,),
        )
        return cursor.fetchall()



def delete_certificate(db, certificate_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM certificates WHERE id = ?", (certificate_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_ot_theatre(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO ot_theatres (
                theatre_code, theatre_name, equipment_notes, status
            ) VALUES (?, ?, ?, ?)
            """,
            (
                data["theatre_code"],
                data["theatre_name"],
                data.get("equipment_notes"),
                data.get("status", "available"),
            ),
        )
        theatre_id = cursor.lastrowid
        conn.commit()
        return theatre_id



def list_ot_theatres(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ot_theatres ORDER BY theatre_code ASC")
        return cursor.fetchall()



def update_ot_theatre(db, theatre_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ot_theatres WHERE id = ?", (theatre_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE ot_theatres
            SET theatre_code = ?, theatre_name = ?, equipment_notes = ?, status = ?
            WHERE id = ?
            """,
            (
                data.get("theatre_code", existing["theatre_code"]),
                data.get("theatre_name", existing["theatre_name"]),
                data.get("equipment_notes", existing["equipment_notes"]),
                data.get("status", existing["status"]),
                theatre_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_ot_theatre(db, theatre_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM ot_surgeries WHERE theatre_id = ?", (theatre_id,))
        cursor.execute("DELETE FROM ot_theatres WHERE id = ?", (theatre_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_ot_surgery(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO ot_surgeries (
                theatre_id, patient_id, procedure_name, surgeon_name, scheduled_start,
                estimated_duration_hours, status, equipment_required, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["theatre_id"],
                data.get("patient_id"),
                data["procedure_name"],
                data["surgeon_name"],
                data["scheduled_start"],
                data.get("estimated_duration_hours", 1),
                data.get("status", "scheduled"),
                data.get("equipment_required"),
                data.get("notes"),
            ),
        )
        surgery_id = cursor.lastrowid
        cursor.execute(
            "UPDATE ot_theatres SET status = CASE WHEN ? IN ('scheduled', 'in_progress') THEN 'occupied' ELSE status END WHERE id = ?",
            (data.get("status", "scheduled"), data["theatre_id"]),
        )
        conn.commit()
        return surgery_id



def list_ot_surgeries(db, theatre_id=None, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if theatre_id:
            clauses.append("theatre_id = ?")
            params.append(theatre_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"SELECT * FROM ot_surgeries{where_clause} ORDER BY scheduled_start ASC",
            tuple(params),
        )
        return cursor.fetchall()



def update_ot_surgery(db, surgery_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ot_surgeries WHERE id = ?", (surgery_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        theatre_id = data.get("theatre_id", existing["theatre_id"])
        status = data.get("status", existing["status"])
        cursor.execute(
            """
            UPDATE ot_surgeries
            SET theatre_id = ?, patient_id = ?, procedure_name = ?, surgeon_name = ?,
                scheduled_start = ?, estimated_duration_hours = ?, status = ?,
                equipment_required = ?, notes = ?
            WHERE id = ?
            """,
            (
                theatre_id,
                data.get("patient_id", existing["patient_id"]),
                data.get("procedure_name", existing["procedure_name"]),
                data.get("surgeon_name", existing["surgeon_name"]),
                data.get("scheduled_start", existing["scheduled_start"]),
                data.get("estimated_duration_hours", existing["estimated_duration_hours"]),
                status,
                data.get("equipment_required", existing["equipment_required"]),
                data.get("notes", existing["notes"]),
                surgery_id,
            ),
        )
        cursor.execute(
            "UPDATE ot_theatres SET status = CASE WHEN ? IN ('scheduled', 'in_progress') THEN 'occupied' ELSE 'available' END WHERE id = ?",
            (status, theatre_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_ot_surgery(db, surgery_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT theatre_id FROM ot_surgeries WHERE id = ?", (surgery_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute("DELETE FROM ot_surgeries WHERE id = ?", (surgery_id,))
        cursor.execute(
            """
            UPDATE ot_theatres
            SET status = CASE
                WHEN EXISTS (
                    SELECT 1 FROM ot_surgeries
                    WHERE theatre_id = ? AND status IN ('scheduled', 'in_progress')
                ) THEN 'occupied'
                ELSE 'available'
            END
            WHERE id = ?
            """,
            (existing["theatre_id"], existing["theatre_id"]),
        )
        deleted = cursor.rowcount >= 0
        conn.commit()
        return deleted



def get_ot_summary(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS value FROM ot_theatres")
        theatre_count = cursor.fetchone()["value"]
        cursor.execute("SELECT COUNT(*) AS value FROM ot_theatres WHERE status = 'available'")
        available_count = cursor.fetchone()["value"]
        cursor.execute("SELECT COUNT(*) AS value FROM ot_surgeries WHERE status = 'scheduled'")
        scheduled_count = cursor.fetchone()["value"]
        cursor.execute("SELECT COUNT(*) AS value FROM ot_surgeries WHERE status = 'completed'")
        completed_count = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(estimated_duration_hours), 0) AS value FROM ot_surgeries WHERE status IN ('scheduled', 'in_progress')"
        )
        scheduled_hours = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(estimated_duration_hours), 0) AS value FROM ot_surgeries WHERE status = 'completed'"
        )
        completed_hours = cursor.fetchone()["value"]
        cursor.execute(
            """
            SELECT
                ot_theatres.theatre_code AS label,
                COALESCE(SUM(
                    CASE
                        WHEN ot_surgeries.status IN ('scheduled', 'in_progress', 'completed')
                        THEN ot_surgeries.estimated_duration_hours
                        ELSE 0
                    END
                ), 0) AS count
            FROM ot_theatres
            LEFT JOIN ot_surgeries ON ot_surgeries.theatre_id = ot_theatres.id
            GROUP BY ot_theatres.id, ot_theatres.theatre_code
            ORDER BY count DESC, ot_theatres.theatre_code ASC
            """
        )
        utilization = [dict(row) for row in cursor.fetchall()]
    return {
        "theatre_count": theatre_count,
        "available_theatres": available_count,
        "scheduled_surgeries": scheduled_count,
        "completed_surgeries": completed_count,
        "scheduled_hours": scheduled_hours,
        "completed_hours": completed_hours,
        "theatre_utilization": utilization,
    }


# ==================== Accounts operations ====================


def create_account_ledger_entry(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO accounts_ledger (
                entry_date, entry_type, category, reference_no, counterparty_name, amount, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["entry_date"],
                data.get("entry_type", "expense"),
                data["category"],
                data.get("reference_no"),
                data.get("counterparty_name"),
                float(data["amount"]),
                data.get("notes"),
            ),
        )
        entry_id = cursor.lastrowid
        conn.commit()
        return entry_id



def list_account_ledger_entries(db, entry_type=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if entry_type:
            cursor.execute(
                "SELECT * FROM accounts_ledger WHERE entry_type = ? ORDER BY entry_date DESC, id DESC",
                (entry_type,),
            )
        else:
            cursor.execute(
                "SELECT * FROM accounts_ledger ORDER BY entry_date DESC, id DESC"
            )
        return cursor.fetchall()



def update_account_ledger_entry(db, entry_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM accounts_ledger WHERE id = ?", (entry_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE accounts_ledger
            SET entry_date = ?, entry_type = ?, category = ?, reference_no = ?,
                counterparty_name = ?, amount = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("entry_date", existing["entry_date"]),
                data.get("entry_type", existing["entry_type"]),
                data.get("category", existing["category"]),
                data.get("reference_no", existing["reference_no"]),
                data.get("counterparty_name", existing["counterparty_name"]),
                float(data.get("amount", existing["amount"] or 0)),
                data.get("notes", existing["notes"]),
                entry_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_account_ledger_entry(db, entry_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM accounts_ledger WHERE id = ?", (entry_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_vendor_payment(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO vendor_payments (
                vendor_name, invoice_ref, amount, payment_date, payment_mode, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["vendor_name"],
                data.get("invoice_ref"),
                float(data["amount"]),
                data["payment_date"],
                data.get("payment_mode", "bank"),
                data.get("status", "paid"),
                data.get("notes"),
            ),
        )
        payment_id = cursor.lastrowid
        conn.commit()
        return payment_id



def list_vendor_payments(db, vendor_name=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if vendor_name:
            cursor.execute(
                "SELECT * FROM vendor_payments WHERE vendor_name = ? ORDER BY payment_date DESC, id DESC",
                (vendor_name,),
            )
        else:
            cursor.execute(
                "SELECT * FROM vendor_payments ORDER BY payment_date DESC, id DESC"
            )
        return cursor.fetchall()



def update_vendor_payment(db, payment_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM vendor_payments WHERE id = ?", (payment_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE vendor_payments
            SET vendor_name = ?, invoice_ref = ?, amount = ?, payment_date = ?,
                payment_mode = ?, status = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("vendor_name", existing["vendor_name"]),
                data.get("invoice_ref", existing["invoice_ref"]),
                float(data.get("amount", existing["amount"] or 0)),
                data.get("payment_date", existing["payment_date"]),
                data.get("payment_mode", existing["payment_mode"]),
                data.get("status", existing["status"]),
                data.get("notes", existing["notes"]),
                payment_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_vendor_payment(db, payment_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM vendor_payments WHERE id = ?", (payment_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_doctor_payout(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        total_amount = float(data["amount"])
        paid_amount = float(data.get("paid_amount", 0))
        if paid_amount > total_amount:
            raise ValueError("Paid Amount cannot be greater than Total Payout Amount.")
        due_amount = max(total_amount - paid_amount, 0.0)
        status = "paid" if due_amount == 0 else ("partial" if paid_amount > 0 else "pending")
        cursor.execute(
            """
            INSERT INTO doctor_payouts (
                doctor_name, payout_month, amount, paid_amount, due_amount, status, paid_date, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
            """,
            (
                data["doctor_name"],
                data["payout_month"],
                total_amount,
                paid_amount,
                due_amount,
                status,
                data.get("paid_date"),
                data.get("notes"),
            ),
        )
        row = cursor.fetchone()
        payout_id = row[0] if row else 0
        
        # Insert initial payment if paid_amount > 0
        if paid_amount > 0:
            cursor.execute(
                """
                INSERT INTO doctor_payout_payments (payout_id, amount, paid_date, notes)
                VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
                """,
                (payout_id, paid_amount, data.get("paid_date"), data.get("notes"))
            )
            # Create General Ledger Entry
            cursor.execute(
                """
                INSERT INTO accounts_ledger (
                    entry_date, entry_type, category, reference_no, counterparty_name, amount, notes
                ) VALUES (COALESCE(?, CURRENT_DATE), 'expense', 'Doctor Payout', ?, ?, ?, ?)
                """,
                (
                    data.get("paid_date"),
                    f"PAYOUT-{payout_id}",
                    data["doctor_name"],
                    paid_amount,
                    f"Initial payout for {data['payout_month']}. {data.get('notes') or ''}"
                )
            )
            
        conn.commit()
        return payout_id



def list_doctor_payouts(db, doctor_name=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if doctor_name:
            cursor.execute(
                "SELECT * FROM doctor_payouts WHERE doctor_name = ? ORDER BY payout_month DESC, id DESC",
                (doctor_name,),
            )
        else:
            cursor.execute(
                "SELECT * FROM doctor_payouts ORDER BY payout_month DESC, id DESC"
            )
        rows = cursor.fetchall()
        
        # Fetch payment history for each payout
        payouts = []
        for row in rows:
            payout_dict = dict(row)
            cursor.execute(
                "SELECT id, amount, paid_date, notes FROM doctor_payout_payments WHERE payout_id = ? ORDER BY paid_date DESC, id DESC",
                (payout_dict["id"],)
            )
            p_rows = cursor.fetchall()
            payout_dict["payments"] = [dict(r) for r in p_rows]
            payouts.append(payout_dict)
        return payouts



def update_doctor_payout(db, payout_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM doctor_payouts WHERE id = ?", (payout_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        total_amount = float(data.get("amount", existing["amount"] or 0))
        
        # Handle custom payment parameter or compute delta automatically
        if "amount_to_pay" in data:
            payment_delta = float(data["amount_to_pay"])
            paid_amount = float(existing["paid_amount"] or 0) + payment_delta
        elif "paid_amount" in data:
            new_paid_total = float(data["paid_amount"])
            payment_delta = new_paid_total - float(existing["paid_amount"] or 0)
            paid_amount = new_paid_total
        else:
            payment_delta = 0.0
            paid_amount = float(existing["paid_amount"] or 0)
            
        if paid_amount > total_amount:
            raise ValueError("Paid Amount cannot be greater than Total Payout Amount.")
            
        due_amount = max(total_amount - paid_amount, 0.0)
        status = "paid" if due_amount == 0 else ("partial" if paid_amount > 0 else "pending")
            
        cursor.execute(
            """
            UPDATE doctor_payouts
            SET doctor_name = ?, payout_month = ?, amount = ?, paid_amount = ?,
                due_amount = ?, status = ?, paid_date = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("doctor_name", existing["doctor_name"]),
                data.get("payout_month", existing["payout_month"]),
                total_amount,
                paid_amount,
                due_amount,
                status,
                data.get("paid_date", existing["paid_date"]),
                data.get("notes", existing["notes"]),
                payout_id,
            ),
        )
        
        # If there is a new payment delta, insert history record and General Ledger entry
        if payment_delta > 0:
            payment_date = data.get("paid_date")
            cursor.execute(
                """
                INSERT INTO doctor_payout_payments (payout_id, amount, paid_date, notes)
                VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
                """,
                (payout_id, payment_delta, payment_date, data.get("notes"))
            )
            # Create General Ledger Entry
            cursor.execute(
                """
                INSERT INTO accounts_ledger (
                    entry_date, entry_type, category, reference_no, counterparty_name, amount, notes
                ) VALUES (COALESCE(?, CURRENT_DATE), 'expense', 'Doctor Payout', ?, ?, ?, ?)
                """,
                (
                    payment_date,
                    f"PAYOUT-{payout_id}",
                    data.get("doctor_name", existing["doctor_name"]),
                    payment_delta,
                    f"Incremental payout payment for {data.get('payout_month', existing['payout_month'])}. {data.get('notes') or ''}"
                )
            )
            
        conn.commit()
        return True



def delete_doctor_payout(db, payout_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM doctor_payouts WHERE id = ?", (payout_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def get_accounts_summary(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS value FROM accounts_ledger WHERE entry_type = 'income'"
        )
        ledger_income = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS value FROM accounts_ledger WHERE entry_type = 'expense'"
        )
        ledger_expense = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS value FROM vendor_payments WHERE status IN ('partial', 'paid')"
        )
        vendor_paid = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(paid_amount), 0) AS value FROM doctor_payouts"
        )
        doctor_paid = cursor.fetchone()["value"]
        cursor.execute(
            "SELECT COALESCE(SUM(due_amount), 0) AS value FROM doctor_payouts"
        )
        doctor_due = cursor.fetchone()["value"]
    return {
        "ledger_income": ledger_income,
        "ledger_expense": ledger_expense,
        "net_position": ledger_income - ledger_expense,
        "vendor_paid_total": vendor_paid,
        "doctor_paid_total": doctor_paid,
        "doctor_due_total": doctor_due,
    }


# ==================== HospAI module operations ====================


EMERGENCY_TRIAGE_LEVELS = ("Red (Critical)", "Yellow (Urgent)", "Green (Non-urgent)")


def set_encounter_triage(db, encounter_id, triage_priority, username=None):
    if triage_priority not in EMERGENCY_TRIAGE_LEVELS:
        raise ValueError(f"Triage must be one of: {', '.join(EMERGENCY_TRIAGE_LEVELS)}.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT encounter_type, disposition FROM encounters WHERE id = ?", (encounter_id,))
        encounter = cursor.fetchone()
        if not encounter:
            raise ValueError("Encounter not found.")
        if encounter["encounter_type"] != "EMERGENCY":
            raise ValueError("Triage applies only to Emergency encounters.")
        if encounter["disposition"]:
            raise ValueError(f"This encounter is already closed ({encounter['disposition']}).")
        cursor.execute("UPDATE encounters SET triage_priority = ? WHERE id = ?", (triage_priority, encounter_id))
        conn.commit()
        return True


def create_encounter(db, data):
    encounter_type = data.get("encounter_type", "OP")
    encounter_no = None
    if encounter_type == "EMERGENCY":
        encounter_no = f"ER-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO encounters (
                patient_id, encounter_type, insurance_provider, insurance_policy_no,
                is_accident, referral_source, referral_name, status, created_by,
                encounter_no, appointment_id, chief_complaint, triage_priority, attendant_name, attending_doctor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["patient_id"],
                encounter_type,
                data.get("insurance_provider"),
                data.get("insurance_policy_no"),
                1 if data.get("is_accident") else 0,
                data.get("referral_source"),
                data.get("referral_name"),
                data.get("status", "active"),
                data.get("created_by"),
                encounter_no,
                data.get("appointment_id"),
                data.get("chief_complaint"),
                data.get("triage_priority") if data.get("triage_priority") in EMERGENCY_TRIAGE_LEVELS else None,
                data.get("attendant_name"),
                data.get("attending_doctor"),
            ),
        )
        encounter_id = cursor.lastrowid
        conn.commit()
        return encounter_id, encounter_no



def list_encounters(db, patient_id=None, encounter_type=None, active_only=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            clauses.append("e.patient_id = ?")
            params.append(patient_id)
        if encounter_type:
            clauses.append("e.encounter_type = ?")
            params.append(encounter_type)
        if active_only:
            clauses.append("e.disposition IS NULL")
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT e.*, p.name AS patient_first_name, p.last_name AS patient_last_name
            FROM encounters e
            LEFT JOIN patients p ON p.patient_id = e.patient_id
            {where_clause}
            ORDER BY e.arrival_at DESC
            """,
            tuple(params),
        )
        return cursor.fetchall()



def admit_from_encounter(db, encounter_id, username, hospital_id=None, notes=None):
    """Emergency -> IPD conversion: reuses add_admission unchanged (same
    patient, no duplicate identity), links both directions, and requires the
    encounter to still be undisposed so this can't run twice for one visit."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,))
        encounter = cursor.fetchone()
        if not encounter:
            raise ValueError("Encounter not found.")
        if encounter["disposition"]:
            raise ValueError(f"This encounter already has a disposition recorded ({encounter['disposition']}).")
        patient_id = encounter["patient_id"]

    admission_id = add_admission(db, patient_id, notes or f"Admitted from Emergency encounter #{encounter_id}", hospital_id=hospital_id)

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE encounters SET disposition = 'admitted', disposition_notes = ?, disposition_at = CURRENT_TIMESTAMP WHERE id = ?",
            (notes, encounter_id),
        )
        conn.commit()
    return admission_id



def set_encounter_disposition(db, encounter_id, disposition, notes, username):
    if disposition not in ("discharged", "admitted", "referred", "transferred"):
        raise ValueError(f"Unsupported disposition '{disposition}'.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,))
        encounter = cursor.fetchone()
        if not encounter:
            raise ValueError("Encounter not found.")
        if encounter["disposition"]:
            raise ValueError(f"This encounter already has a disposition recorded ({encounter['disposition']}).")
        cursor.execute(
            "UPDATE encounters SET disposition = ?, disposition_notes = ?, disposition_at = CURRENT_TIMESTAMP WHERE id = ?",
            (disposition, notes, encounter_id),
        )
        conn.commit()
        return True



def assign_bed(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if str(data.get("status", "active")) == "active":
            ensure_not_currently_admitted(cursor, data["patient_id"])
        cursor.execute(
            """
            INSERT INTO bed_allocations (
                admission_id, patient_id, ward, room_no, bed_no, status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data["admission_id"],
                data["patient_id"],
                data.get("ward"),
                data.get("room_no"),
                data.get("bed_no"),
                data.get("status", "active"),
            ),
        )
        bed_id = cursor.lastrowid
        conn.commit()
        return bed_id



def list_bed_allocations(db, patient_id=None, active_only=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            lookup = str(patient_id).strip()
            clauses.append("(patient_id = ? OR patient_id LIKE ?)")
            params.extend([lookup, f"%{lookup}"])
        if active_only:
            clauses.append("status = 'active'")
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(f"SELECT * FROM bed_allocations{where_clause} ORDER BY allocated_at DESC", tuple(params))
        return cursor.fetchall()



def add_medication_schedule(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO medication_schedules (
                patient_id, medicine_name, dosage, schedule_time, administered, alert_enabled, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["patient_id"],
                data["medicine_name"],
                data.get("dosage"),
                data["schedule_time"],
                1 if data.get("administered") else 0,
                1 if data.get("alert_enabled", True) else 0,
                data.get("notes"),
            ),
        )
        schedule_id = cursor.lastrowid
        conn.commit()
        return schedule_id



def list_medication_schedules(db, patient_id, pending_only=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if pending_only:
            cursor.execute(
                """
                SELECT * FROM medication_schedules
                WHERE patient_id = ? AND administered = 0
                ORDER BY schedule_time ASC
                """,
                (patient_id,),
            )
        else:
            cursor.execute(
                """
                SELECT * FROM medication_schedules
                WHERE patient_id = ?
                ORDER BY schedule_time ASC
                """,
                (patient_id,),
            )
        return cursor.fetchall()



def add_observation_note(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO observation_notes (
                patient_id, admission_id, doctor_name, note, treatment_plan
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                data["patient_id"],
                data.get("admission_id"),
                data.get("doctor_name"),
                data["note"],
                data.get("treatment_plan"),
            ),
        )
        note_id = cursor.lastrowid
        conn.commit()
        return note_id



def list_observation_notes(db, patient_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM observation_notes WHERE patient_id = ? ORDER BY created_at DESC",
            (patient_id,),
        )
        return cursor.fetchall()



def add_patient_movement(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO patient_movements (
                patient_id, admission_id, from_department, to_department, moved_by
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                data["patient_id"],
                data.get("admission_id"),
                data.get("from_department"),
                data["to_department"],
                data.get("moved_by"),
            ),
        )
        movement_id = cursor.lastrowid
        conn.commit()
        return movement_id



def list_patient_movements(db, patient_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM patient_movements WHERE patient_id = ? ORDER BY moved_at DESC",
            (patient_id,),
        )
        return cursor.fetchall()



def create_invoice(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        paid_amount = float(data.get("paid_amount", 0) or 0)
        advance_amount = float(data.get("advance_amount", 0) or 0)
        refunded_amount = float(data.get("refunded_amount", 0) or 0)
        collected_amount = max(paid_amount + advance_amount - refunded_amount, 0.0)
        total_amount = float(data["total_amount"])
        due_amount = max(total_amount - collected_amount, 0.0)
        cursor.execute(
            """
            INSERT INTO invoices (
                invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                advance_amount, refunded_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["invoice_no"],
                data.get("patient_id"),
                data["module"],
                data.get("doctor_name"),
                data.get("clinic_name"),
                data.get("referral_source"),
                data.get("subtotal", 0),
                data.get("tax", 0),
                data.get("discount", 0),
                total_amount,
                paid_amount,
                data.get("due_amount", due_amount),
                data.get("payment_status", "due"),
                data.get("created_by"),
                advance_amount,
                refunded_amount,
            ),
        )
        invoice_id = cursor.lastrowid

        # If module is Lab/Diagnostics, create diagnostic record
        module_upper = str(data.get("module") or "").upper()
        if module_upper in ["LAB", "DIAGNOSTICS", "DIAGNOSTIC"]:
            cursor.execute("SELECT id FROM diagnostics WHERE invoice_no = ?", (data["invoice_no"],))
            existing_diag = cursor.fetchone()
            if not existing_diag:
                # Fetch patient details
                patient_name = None
                age = None
                gender = None
                if data.get("patient_id"):
                    cursor.execute("SELECT name, middle_name, last_name, age, gender FROM patients WHERE patient_id = ?", (data["patient_id"],))
                    pat = cursor.fetchone()
                    if pat:
                        patient_name = " ".join(filter(None, [pat["name"], pat["middle_name"], pat["last_name"]]))
                        age = pat["age"]
                        gender = pat["gender"]
                
                # Compute discount and tax percentages
                disc_pct = float(data.get("discount", 0)) / max(total_amount, 1.0) * 100.0 if total_amount > 0 else 0.0
                tax_pct = float(data.get("tax", 0)) / max(total_amount - float(data.get("discount", 0)), 1.0) * 100.0 if (total_amount - float(data.get("discount", 0))) > 0 else 0.0

                from datetime import datetime
                cursor.execute(
                    """
                    INSERT INTO diagnostics (
                        invoice_no, patient_id, test_name, amount, paid_amount, due_amount, status,
                        patient_name, age, gender, department, visit_type,
                        bill_date, payment_mode, transaction_id,
                        discount_percentage, discount_amount, tax_percentage, tax_amount, remarks
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        data["invoice_no"],
                        data.get("patient_id"),
                        f"{data.get('module')} services",
                        total_amount,
                        paid_amount,
                        due_amount,
                        data.get("payment_status", "due"),
                        patient_name,
                        age,
                        gender,
                        data.get("module"),
                        "OPD",
                        datetime.now().strftime("%Y-%m-%d"),
                        "Cash",
                        None,
                        disc_pct,
                        data.get("discount", 0),
                        tax_pct,
                        data.get("tax", 0),
                        data.get("referral_source") or "Created from Billing module"
                    )
                )

        conn.commit()
        return invoice_id



def list_invoices(db, patient_id=None, module=None, payment_status=None, search=None, limit=None, external_sale=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            clauses.append("i.patient_id = ?")
            params.append(patient_id)
        if module:
            clauses.append("i.module = ?")
            params.append(module)
        if external_sale is True:
            clauses.append("i.invoice_type = 'EXTERNAL_SALE'")
        elif external_sale is False:
            clauses.append("COALESCE(i.invoice_type, '') <> 'EXTERNAL_SALE'")
        if payment_status:
            if payment_status in ("pending_due", "due_pending", "due_or_partial"):
                clauses.append("(COALESCE(i.due_amount, 0) > 0 OR i.payment_status IN ('due', 'partial'))")
            else:
                clauses.append("i.payment_status = ?")
                params.append(payment_status)
        if search:
            term = f"%{search.strip().lower()}%"
            clauses.append("(LOWER(i.invoice_no) LIKE ? OR LOWER(COALESCE(i.patient_id, '')) LIKE ? OR LOWER(COALESCE(p.name, i.referral_source, i.notes, '')) LIKE ? OR LOWER(COALESCE(p.last_name, '')) LIKE ? OR LOWER(COALESCE(p.phone, i.patient_mobile, '')) LIKE ?)")
            params.extend([term, term, term, term, term])
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        limit_clause = f" LIMIT {int(limit)}" if limit else ""
        cursor.execute(
            f"""
            SELECT i.*, 
                   COALESCE(p.name, CASE WHEN i.invoice_type = 'EXTERNAL_SALE' THEN i.patient_name END, i.referral_source, i.notes) AS name,
                   p.middle_name,
                   p.last_name,
                   COALESCE(p.age::text, i.patient_age) AS age,
                   p.gender, 
                   p.weight AS weight, p.height AS height,
                   COALESCE(p.phone, i.patient_mobile) AS phone,
                   COALESCE(p.address, i.patient_address) AS address
            FROM invoices i
            LEFT JOIN patients p ON p.patient_id = i.patient_id
            {where_clause} 
            ORDER BY i.created_at DESC
            {limit_clause}
            """, 
            tuple(params)
        )
        return cursor.fetchall()



def get_invoice_payments(db, invoice_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, invoice_id, amount, payment_mode, gateway_ref, created_at
            FROM invoice_payments
            WHERE invoice_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (invoice_id,)
        )
        return cursor.fetchall()




def get_invoice_by_id(db, invoice_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT i.*, 
                   COALESCE(p.name, CASE WHEN i.invoice_type = 'EXTERNAL_SALE' THEN i.patient_name END, i.referral_source, i.notes) AS name,
                   p.middle_name,
                   p.last_name,
                   COALESCE(p.age::text, i.patient_age) AS age,
                   p.gender, 
                   p.weight AS weight, p.height AS height,
                   COALESCE(p.phone, i.patient_mobile) AS phone,
                   COALESCE(p.address, i.patient_address) AS address
            FROM invoices i
            LEFT JOIN patients p ON p.patient_id = i.patient_id
            WHERE i.id = ?
            """, 
            (invoice_id,)
        )
        return cursor.fetchone()



def update_invoice(db, invoice_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,))
        existing = cursor.fetchone()
        if not existing:
            return False

        total_amount = float(data.get("total_amount", existing["total_amount"] or 0))
        paid_amount = float(data.get("paid_amount", existing["paid_amount"] or 0))
        advance_amount = float(data.get("advance_amount", existing["advance_amount"] or 0))
        refunded_amount = float(data.get("refunded_amount", existing["refunded_amount"] or 0))
        collected_amount = max(paid_amount + advance_amount - refunded_amount, 0.0)
        due_amount = max(total_amount - collected_amount, 0.0)
        payment_status = data.get("payment_status")
        if not payment_status:
            if due_amount == 0:
                payment_status = "paid"
            elif paid_amount > 0:
                payment_status = "partial"
            else:
                payment_status = "due"

        module_name = str(data.get("module", existing["module"])).upper()

        cursor.execute(
            """
            UPDATE invoices
            SET patient_id = ?,
                module = ?,
                doctor_name = ?,
                clinic_name = ?,
                referral_source = ?,
                subtotal = ?,
                tax = ?,
                discount = ?,
                total_amount = ?,
                paid_amount = ?,
                due_amount = ?,
                payment_status = ?,
                advance_amount = ?,
                refunded_amount = ?
            WHERE id = ?
            """,
            (
                data.get("patient_id", existing["patient_id"]),
                module_name,
                data.get("doctor_name", existing["doctor_name"]),
                data.get("clinic_name", existing["clinic_name"]),
                data.get("referral_source", existing["referral_source"]),
                data.get("subtotal", existing["subtotal"]),
                data.get("tax", existing["tax"]),
                data.get("discount", existing["discount"]),
                total_amount,
                paid_amount,
                due_amount,
                payment_status,
                advance_amount,
                refunded_amount,
                invoice_id,
            ),
        )
        updated = cursor.rowcount > 0
        if module_name in ["LAB", "DIAGNOSTICS", "DIAGNOSTIC"]:
            cursor.execute(
                """
                UPDATE diagnostics
                SET paid_amount = ?, due_amount = ?, status = ?, amount = ?
                WHERE invoice_no = ?
                """,
                (paid_amount, due_amount, payment_status, total_amount, existing["invoice_no"]),
            )
        conn.commit()
        return updated



def delete_invoice(db, invoice_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT invoice_no FROM invoices WHERE id = ?", (invoice_id,))
        inv = cursor.fetchone()
        if inv and inv["invoice_no"]:
            cursor.execute("DELETE FROM diagnostics WHERE invoice_no = ?", (inv["invoice_no"],))
        cursor.execute("DELETE FROM invoice_payments WHERE invoice_id = ?", (invoice_id,))
        cursor.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def record_invoice_payment(db, invoice_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT total_amount, paid_amount, advance_amount, refunded_amount FROM invoices WHERE id = ?",
            (invoice_id,),
        )
        invoice = cursor.fetchone()
        if not invoice:
            return None

        amount = float(data["amount"])
        total_amount = float(invoice["total_amount"] or 0)
        advance_amount = float(invoice["advance_amount"] or 0)
        refunded_amount = float(invoice["refunded_amount"] or 0)
        paid_before = float(invoice["paid_amount"] or 0)
        due_before = max(total_amount - max(paid_before + advance_amount - refunded_amount, 0.0), 0.0)
        if due_before <= 0:
            raise ValueError("This invoice is already fully paid. Recording another payment would create a duplicate/overpayment.")

        paid_total = paid_before + amount
        due_total = max(total_amount - max(paid_total + advance_amount - refunded_amount, 0.0), 0.0)
        if due_total == 0:
            status = "paid"
        elif paid_total > 0:
            status = "partial"
        else:
            status = "due"

        cursor.execute(
            """
            INSERT INTO invoice_payments (
                invoice_id, amount, payment_mode, gateway_ref, converted_from_mode, converted_to_mode
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                invoice_id,
                amount,
                data["payment_mode"],
                data.get("gateway_ref"),
                data.get("converted_from_mode"),
                data.get("converted_to_mode"),
            ),
        )
        payment_id = cursor.lastrowid
        cursor.execute(
            """
            UPDATE invoices
            SET paid_amount = ?, due_amount = ?, payment_status = ?
            WHERE id = ?
            """,
            (paid_total, due_total, status, invoice_id),
        )
        
        # Get invoice_no and module to update corresponding diagnostics record if needed
        cursor.execute("SELECT invoice_no, module FROM invoices WHERE id = ?", (invoice_id,))
        inv = cursor.fetchone()
        if inv:
            module_upper = str(inv["module"] or "").upper()
            if module_upper in ["LAB", "DIAGNOSTICS", "DIAGNOSTIC"]:
                cursor.execute(
                    """
                    UPDATE diagnostics
                    SET paid_amount = ?, due_amount = ?, status = ?, payment_mode = ?
                    WHERE invoice_no = ?
                    """,
                    (paid_total, due_total, status, data["payment_mode"], inv["invoice_no"]),
                )
                
        conn.commit()
        return payment_id



def create_insurance_claim(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO insurance_claims (
                invoice_id, patient_id, insurer_name, claim_amount, approved_amount,
                claim_status, external_ref, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["invoice_id"],
                data.get("patient_id"),
                data["insurer_name"],
                float(data["claim_amount"]),
                float(data.get("approved_amount", 0)),
                data.get("claim_status", "submitted"),
                data.get("external_ref"),
                data.get("notes"),
            ),
        )
        claim_id = cursor.lastrowid
        conn.commit()
        return claim_id



def get_insurance_claim(db, claim_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM insurance_claims WHERE id = ?", (claim_id,))
        return cursor.fetchone()



def list_pharmacy_insurance_claims(db, status=None):
    """Pharmacy insurance claims with their invoice position and whether the
    stock for the issued medicines has been deducted yet."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        where = ["i.module IN ('PHARMACY', 'IP')"]
        params = []
        if status == "open":
            where.append("c.claim_status NOT IN ('rejected', 'closed', 'settled') AND COALESCE(c.settlement_status, 'unpaid') <> 'paid'")
        elif status == "closed":
            where.append("(c.claim_status IN ('rejected', 'closed', 'settled') OR c.settlement_status = 'paid')")
        cursor.execute(
            f"""
            SELECT c.id, c.invoice_id, c.patient_id, c.insurer_name, c.claim_amount, c.approved_amount, c.claim_status,
                   c.settlement_status, c.patient_responsibility, c.membership_ref, c.authorization_ref, c.notes, c.submitted_at,
                   i.invoice_no, i.total_amount, i.paid_amount, i.due_amount, i.payment_status, i.module AS bill_module,
                   TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')) AS patient_name,
                   COALESCE(i.admission_id, (SELECT MAX(ps.admission_id) FROM pharmacy_sales ps WHERE ps.invoice_id = c.invoice_id)) AS admission_id,
                   (SELECT COUNT(*) FROM pharmacy_sales ps WHERE ps.invoice_id = c.invoice_id AND COALESCE(ps.quantity, 0) > 0
                      AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.ref_table = 'pharmacy_sales'
                                      AND sm.ref_id = ps.id AND sm.movement_type = 'dispense')) AS lines_awaiting_stock
            FROM insurance_claims c
            JOIN invoices i ON i.id = c.invoice_id
            LEFT JOIN patients p ON p.patient_id = c.patient_id
            WHERE {' AND '.join(where)}
            ORDER BY c.submitted_at DESC, c.id DESC
            LIMIT 500
            """,
            tuple(params),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            r["stock_deducted"] = int(r.pop("lines_awaiting_stock") or 0) == 0
        return rows


def close_pharmacy_insurance_claim(db, claim_id, outcome, reason, username):
    """Final decision on a pharmacy insurance claim that will not be (fully) paid.

    outcome 'rejected': the insurer pays nothing more.
    outcome 'closed':   final settlement -- whatever the insurer has paid so far is all it pays.

    Either way the claim is finished, so the medicines' stock is deducted now
    and the unpaid balance becomes the patient's responsibility on the same
    pharmacy invoice (collected via the normal invoice payment)."""
    if outcome not in ("rejected", "closed"):
        raise ValueError("Outcome must be 'rejected' or 'closed'.")
    if not str(reason or "").strip():
        raise ValueError("A reason is required to reject or close a claim.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM insurance_claims WHERE id = ? FOR UPDATE", (claim_id,))
        claim = cursor.fetchone()
        if not claim:
            raise LookupError("Insurance case not found")
        if claim["claim_status"] in ("rejected", "closed", "settled") or claim["settlement_status"] == "paid":
            raise ValueError("This claim is already finished.")
        cursor.execute("SELECT total_amount, paid_amount FROM invoices WHERE id = ?", (claim["invoice_id"],))
        inv = cursor.fetchone()
        outstanding = round(max(0.0, float(inv["total_amount"] or 0) - float(inv["paid_amount"] or 0)), 2) if inv else 0.0
        note = f"{outcome.title()} by {username or 'system'}: {str(reason).strip()}"
        cursor.execute(
            """
            UPDATE insurance_claims
            SET claim_status = ?, settlement_status = CASE WHEN COALESCE(settlement_status, 'unpaid') = 'part_paid' THEN 'adjusted' ELSE settlement_status END,
                patient_responsibility = ?, notes = COALESCE(notes || ' | ', '') || ?
            WHERE id = ?
            """,
            (outcome, outstanding, note, claim_id),
        )
        cursor.execute(
            "UPDATE invoices SET payment_status = CASE WHEN ? > 0 THEN (CASE WHEN COALESCE(paid_amount, 0) > 0 THEN 'partial' ELSE 'due' END) ELSE 'paid' END, "
            "notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?",
            (outstanding, f"Insurance {outcome}: Rs {outstanding:.2f} payable by patient", claim["invoice_id"]),
        )
        deduct_deferred_insurance_stock(cursor, claim["invoice_id"], username)
        conn.commit()
        return {"claim_id": claim_id, "claim_status": outcome, "patient_payable": outstanding}


def list_insurance_claims(db, invoice_id=None, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if invoice_id:
            clauses.append("invoice_id = ?")
            params.append(invoice_id)
        if status:
            clauses.append("claim_status = ?")
            params.append(status)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"SELECT * FROM insurance_claims{where_clause} ORDER BY submitted_at DESC, id DESC",
            tuple(params),
        )
        return cursor.fetchall()



def update_insurance_claim(db, claim_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM insurance_claims WHERE id = ?", (claim_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE insurance_claims
            SET invoice_id = ?, patient_id = ?, insurer_name = ?, claim_amount = ?,
                approved_amount = ?, claim_status = ?, external_ref = ?, notes = ?,
                settlement_status = ?, patient_responsibility = ?, adjustments = ?,
                membership_ref = ?, authorization_ref = ?
            WHERE id = ?
            """,
            (
                data.get("invoice_id", existing["invoice_id"]),
                data.get("patient_id", existing["patient_id"]),
                data.get("insurer_name", existing["insurer_name"]),
                float(data.get("claim_amount", existing["claim_amount"] or 0)),
                float(data.get("approved_amount", existing["approved_amount"] or 0)),
                data.get("claim_status", existing["claim_status"]),
                data.get("external_ref", existing["external_ref"]),
                data.get("notes", existing["notes"]),
                data.get("settlement_status", existing["settlement_status"]),
                float(data.get("patient_responsibility", existing["patient_responsibility"] or 0)),
                float(data.get("adjustments", existing["adjustments"] or 0)),
                data.get("membership_ref", existing["membership_ref"]),
                data.get("authorization_ref", existing["authorization_ref"]),
                claim_id,
            ),
        )
        updated = cursor.rowcount > 0
        new_status = data.get("settlement_status", existing["settlement_status"])
        inv_id = data.get("invoice_id", existing["invoice_id"])
        if updated and inv_id and str(new_status or "").lower() == "paid":
            deduct_deferred_insurance_stock(cursor, inv_id, data.get("_actor"))
        conn.commit()
        return updated



def delete_insurance_claim(db, claim_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM insurance_claims WHERE id = ?", (claim_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted


PAYMENT_MODE_LABELS = {
    "cash": "Cash",
    "card": "Card",
    "upi": "UPI",
    "bank": "Bank Transfer",
}
PAYMENT_MODE_ORDER = ["Cash", "Card", "UPI"]



def normalize_payment_mode_breakdown(rows):
    totals = {label: 0 for label in PAYMENT_MODE_ORDER}
    for row in rows or []:
        raw_label = str(row.get("label") or "cash").strip().lower()
        if raw_label in ("bank", "bank transfer"):
            continue
        label = PAYMENT_MODE_LABELS.get(raw_label, raw_label.title() if raw_label else "Cash")
        totals[label] = totals.get(label, 0) + float(row.get("count") or 0)
    ordered = [{"label": label, "count": totals.get(label, 0)} for label in PAYMENT_MODE_ORDER]
    extras = [
        {"label": label, "count": amount}
        for label, amount in totals.items()
        if label not in PAYMENT_MODE_ORDER
    ]
    extras.sort(key=lambda item: item["label"])
    return ordered + extras



def get_revenue_summary(db, collection_date=None, collection_month=None):
    if not collection_date and not collection_month:
        from datetime import datetime, timedelta, timezone
        IST_TIMEZONE = timezone(timedelta(hours=5, minutes=30))
        collection_date = datetime.now(IST_TIMEZONE).date().isoformat()

    with get_connection(db) as conn:
        cursor = conn.cursor()
        if collection_month:
            try:
                month_start = datetime.strptime(str(collection_month)[:7] + "-01", "%Y-%m-%d").date()
                if month_start.month == 12:
                    next_month = month_start.replace(year=month_start.year + 1, month=1)
                else:
                    next_month = month_start.replace(month=month_start.month + 1)
                month_end = next_month.isoformat()
                month_start = month_start.isoformat()
            except ValueError:
                month_start = None
                month_end = None
        else:
            month_start = None
            month_end = None

        date_col_ip = date_clause("created_at")
        date_col_d = date_clause("created_at")
        date_col_ps = date_clause("sold_at")
        date_col_i = date_clause("created_at")

        diag_base_cond = "(invoice_no IS NULL OR TRIM(invoice_no) = '')"
        pharm_base_cond = "invoice_id IS NULL"

        if collection_month and month_start and month_end:
            invoice_date_clause = f" WHERE {date_col_i} >= DATE(?) AND {date_col_i} < DATE(?)"
            payment_date_clause = f" WHERE {date_col_ip} >= DATE(?) AND {date_col_ip} < DATE(?)"
            diagnostic_date_clause = f" WHERE {date_col_d} >= DATE(?) AND {date_col_d} < DATE(?) AND {diag_base_cond}"
            pharmacy_date_clause = f" WHERE {date_col_ps} >= DATE(?) AND {date_col_ps} < DATE(?) AND {pharm_base_cond}"
            invoice_params = (month_start, month_end)
            payment_params = (month_start, month_end)
            diagnostic_params = (month_start, month_end)
            pharmacy_params = (month_start, month_end)
        else:
            invoice_date_clause = f" WHERE {date_col_i} = DATE(?)" if collection_date else ""
            payment_date_clause = f" WHERE {date_col_ip} = DATE(?)" if collection_date else ""
            diagnostic_date_clause = f" WHERE {date_col_d} = DATE(?) AND {diag_base_cond}" if collection_date else f" WHERE {diag_base_cond}"
            pharmacy_date_clause = f" WHERE {date_col_ps} = DATE(?) AND {pharm_base_cond}" if collection_date else f" WHERE {pharm_base_cond}"
            invoice_params = (collection_date,) if collection_date else ()
            payment_params = (collection_date,) if collection_date else ()
            diagnostic_params = (collection_date,) if collection_date else ()
            pharmacy_params = (collection_date,) if collection_date else ()

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(value), 0) AS value
            FROM (
                SELECT COALESCE(SUM(total_amount), 0) AS value FROM invoices{invoice_date_clause}
                UNION ALL
                SELECT COALESCE(SUM(amount), 0) AS value FROM diagnostics{diagnostic_date_clause}
                UNION ALL
                SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales{pharmacy_date_clause}
            ) AS total_billed_sub
            """,
            invoice_params + diagnostic_params + pharmacy_params,
        )
        total_billed = cursor.fetchone()["value"]

        if collection_date:
            total_collected = RevenueService.get_today_collections(db, collection_date)
        elif collection_month and month_start and month_end:
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(value), 0) AS value
                FROM (
                    SELECT COALESCE(SUM(amount), 0) AS value FROM invoice_payments{payment_date_clause}
                    UNION ALL
                    SELECT COALESCE(SUM(paid_amount), 0) AS value FROM diagnostics{diagnostic_date_clause}
                    UNION ALL
                    SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales{pharmacy_date_clause}
                ) AS total_collected_sub
                """,
                payment_params + diagnostic_params + pharmacy_params,
            )
            total_collected = cursor.fetchone()["value"]
        else:
            cursor.execute(
                """
            SELECT COALESCE(SUM(value), 0) AS value
            FROM (
                SELECT COALESCE(SUM(paid_amount + advance_amount - refunded_amount), 0) AS value FROM invoices
                UNION ALL
                SELECT COALESCE(SUM(paid_amount), 0) AS value FROM diagnostics WHERE (invoice_no IS NULL OR TRIM(invoice_no) = '')
                UNION ALL
                SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales WHERE invoice_id IS NULL
            ) AS total_collected_sub_all
                """
            )
            total_collected = cursor.fetchone()["value"]

        if collection_date:
            total_due = RevenueService.get_today_outstanding(db, collection_date)
        else:
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(value), 0) AS value
                FROM (
                    SELECT COALESCE(SUM(due_amount), 0) AS value FROM invoices{invoice_date_clause}
                    UNION ALL
                    SELECT COALESCE(SUM(due_amount), 0) AS value FROM diagnostics{diagnostic_date_clause}
                ) AS total_due_sub
                """,
                invoice_params + diagnostic_params,
            )
            total_due = cursor.fetchone()["value"]

        cursor.execute(f"SELECT COALESCE(SUM(advance_amount), 0) AS value FROM invoices{invoice_date_clause}", invoice_params)
        total_advance = cursor.fetchone()["value"]
        cursor.execute(f"SELECT COALESCE(SUM(refunded_amount), 0) AS value FROM invoices{invoice_date_clause}", invoice_params)
        total_refunded = cursor.fetchone()["value"]
        cursor.execute(
            f"""
            SELECT label, COALESCE(SUM(count), 0) AS count
            FROM (
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(amount), 0) AS count
                FROM invoice_payments{payment_date_clause}
                GROUP BY label
                UNION ALL
                SELECT 'cash' AS label,
                       COALESCE(SUM(
                           CASE
                               WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                               THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                               ELSE 0
                           END
                       ), 0) AS count
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                {invoice_date_clause.replace('created_at', 'i.created_at') if invoice_date_clause else ''}
                GROUP BY label
                UNION ALL
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(paid_amount), 0) AS count
                FROM diagnostics{diagnostic_date_clause}
                GROUP BY label
                UNION ALL
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(amount), 0) AS count
                FROM pharmacy_sales{pharmacy_date_clause}
                GROUP BY label
            ) AS by_mode_sub
            GROUP BY label
            ORDER BY count DESC
            """,
            payment_params + invoice_params + diagnostic_params + pharmacy_params,
        )
        by_mode = normalize_payment_mode_breakdown([dict(row) for row in cursor.fetchall()])

        if collection_date or (collection_month and month_start and month_end):
            date_col_ip_ambig = date_clause("ip.created_at")
            if collection_month and month_start and month_end:
                module_where = f"{date_col_ip_ambig} >= DATE(?) AND {date_col_ip_ambig} < DATE(?)"
                diag_where = f"{date_col_d} >= DATE(?) AND {date_col_d} < DATE(?) AND (invoice_no IS NULL OR TRIM(invoice_no) = '')"
                pharm_where = f"{date_col_ps} >= DATE(?) AND {date_col_ps} < DATE(?) AND invoice_id IS NULL"
                module_params = (month_start, month_end, month_start, month_end, month_start, month_end, month_start, month_end)
            else:
                module_where = f"{date_col_ip_ambig} = DATE(?)"
                diag_where = f"{date_col_d} = DATE(?) AND (invoice_no IS NULL OR TRIM(invoice_no) = '')"
                pharm_where = f"{date_col_ps} = DATE(?) AND invoice_id IS NULL"
                module_params = (collection_date, collection_date, collection_date, collection_date)
            cursor.execute(
                f"""
                SELECT label, COALESCE(SUM(count), 0) AS count
                FROM (
                    SELECT CASE
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%op%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%consult%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%billing%'
                               THEN 'OP / Billing'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%pharm%'
                               THEN 'Pharmacy'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%lab%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%diag%'
                               THEN 'Lab / Diagnostics'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%ip%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%inpatient%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%bed%'
                               THEN 'IP / Inpatient'
                               ELSE INITCAP(COALESCE(NULLIF(TRIM(i.module), ''), 'Billing'))
                           END AS label,
                           COALESCE(SUM(ip.amount), 0) AS count
                    FROM invoice_payments ip
                    JOIN invoices i ON i.id = ip.invoice_id
                    WHERE {module_where}
                    GROUP BY label
                    UNION ALL
                    SELECT CASE
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%op%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%consult%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%billing%'
                               THEN 'OP / Billing'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%pharm%'
                               THEN 'Pharmacy'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%lab%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%diag%'
                               THEN 'Lab / Diagnostics'
                               WHEN LOWER(COALESCE(i.module, '')) LIKE '%ip%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%inpatient%'
                                    OR LOWER(COALESCE(i.module, '')) LIKE '%bed%'
                               THEN 'IP / Inpatient'
                               ELSE INITCAP(COALESCE(NULLIF(TRIM(i.module), ''), 'Billing'))
                           END AS label,
                           COALESCE(SUM(
                               CASE
                                   WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                                   THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                                   ELSE 0
                               END
                           ), 0) AS count
                    FROM invoices i
                    LEFT JOIN (
                        SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                        FROM invoice_payments
                        GROUP BY invoice_id
                    ) p ON p.invoice_id = i.id
                    {invoice_date_clause.replace('created_at', 'i.created_at') if invoice_date_clause else ''}
                    GROUP BY label
                    UNION ALL
                    SELECT 'Lab / Diagnostics' AS label,
                           COALESCE(SUM(paid_amount), 0) AS count
                    FROM diagnostics
                    WHERE {diag_where}
                    UNION ALL
                    SELECT 'Pharmacy' AS label,
                           COALESCE(SUM(amount), 0) AS count
                    FROM pharmacy_sales
                    WHERE {pharm_where}
                ) AS by_module_sub
                GROUP BY label
                HAVING COALESCE(SUM(count), 0) > 0
                ORDER BY count DESC
                """,
                module_params,
            )
        else:
            cursor.execute(
                """
            SELECT label, COALESCE(SUM(count), 0) AS count
            FROM (
                SELECT CASE
                           WHEN LOWER(COALESCE(module, '')) LIKE '%op%'
                                OR LOWER(COALESCE(module, '')) LIKE '%consult%'
                                OR LOWER(COALESCE(module, '')) LIKE '%billing%'
                           THEN 'OP / Billing'
                           WHEN LOWER(COALESCE(module, '')) LIKE '%pharm%'
                           THEN 'Pharmacy'
                           WHEN LOWER(COALESCE(module, '')) LIKE '%lab%'
                                OR LOWER(COALESCE(module, '')) LIKE '%diag%'
                           THEN 'Lab / Diagnostics'
                           WHEN LOWER(COALESCE(module, '')) LIKE '%ip%'
                                OR LOWER(COALESCE(module, '')) LIKE '%inpatient%'
                                OR LOWER(COALESCE(module, '')) LIKE '%bed%'
                           THEN 'IP / Inpatient'
                           ELSE INITCAP(COALESCE(NULLIF(TRIM(module), ''), 'Billing'))
                       END AS label,
                       COALESCE(SUM(paid_amount + advance_amount - refunded_amount), 0) AS count
                FROM invoices
                GROUP BY label
                UNION ALL
                SELECT 'Lab / Diagnostics' AS label,
                       COALESCE(SUM(paid_amount), 0) AS count
                FROM diagnostics
                UNION ALL
                SELECT 'Pharmacy' AS label,
                       COALESCE(SUM(amount), 0) AS count
                FROM pharmacy_sales
            ) AS by_module_sub_all
            GROUP BY label
            HAVING COALESCE(SUM(count), 0) > 0
            ORDER BY count DESC
                """
            )
        by_module = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN due_amount > 0 AND CURRENT_TIMESTAMP - created_at < INTERVAL '31 days' THEN due_amount ELSE 0 END), 0) AS bucket_0_30,
                COALESCE(SUM(CASE WHEN due_amount > 0 AND CURRENT_TIMESTAMP - created_at >= INTERVAL '31 days' AND CURRENT_TIMESTAMP - created_at < INTERVAL '61 days' THEN due_amount ELSE 0 END), 0) AS bucket_31_60,
                COALESCE(SUM(CASE WHEN due_amount > 0 AND CURRENT_TIMESTAMP - created_at >= INTERVAL '61 days' AND CURRENT_TIMESTAMP - created_at < INTERVAL '91 days' THEN due_amount ELSE 0 END), 0) AS bucket_61_90,
                COALESCE(SUM(CASE WHEN due_amount > 0 AND CURRENT_TIMESTAMP - created_at >= INTERVAL '91 days' THEN due_amount ELSE 0 END), 0) AS bucket_91_plus
            FROM invoices
            """
        )
        aging = dict(cursor.fetchone() or {})

        cursor.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN gateway_ref IS NOT NULL AND TRIM(gateway_ref) <> '' THEN amount ELSE 0 END), 0) AS gateway_collected,
                COALESCE(SUM(CASE WHEN converted_from_mode IS NOT NULL AND TRIM(converted_from_mode) <> '' THEN amount ELSE 0 END), 0) AS converted_total
            FROM invoice_payments
            """
        )
        reconciliation = dict(cursor.fetchone() or {})

        cursor.execute(
            """
            SELECT
                COALESCE(NULLIF(TRIM(converted_from_mode), ''), payment_mode) || ' -> ' ||
                COALESCE(NULLIF(TRIM(converted_to_mode), ''), payment_mode) AS label,
                COALESCE(SUM(amount), 0) AS count
            FROM invoice_payments
            WHERE converted_from_mode IS NOT NULL AND TRIM(converted_from_mode) <> ''
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        conversion_breakdown = [dict(row) for row in cursor.fetchall()]

        if collection_month and month_start and month_end:
            doctor_payout_clause = " WHERE DATE(COALESCE(paid_date, created_at)) >= DATE(?) AND DATE(COALESCE(paid_date, created_at)) < DATE(?)"
            doctor_payout_params = (month_start, month_end)
        elif collection_date:
            doctor_payout_clause = " WHERE DATE(COALESCE(paid_date, created_at)) = DATE(?)"
            doctor_payout_params = (collection_date,)
        else:
            doctor_payout_clause = ""
            doctor_payout_params = ()

        if collection_date:
            doctor_payout_ready = RevenueService.get_today_doctor_payout(db, collection_date)
        else:
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(
                    CASE
                        WHEN COALESCE(due_amount, 0) > 0 THEN due_amount
                        WHEN LOWER(COALESCE(status, '')) IN ('pending', 'partial') THEN GREATEST(COALESCE(amount, 0) - COALESCE(paid_amount, 0), 0)
                        ELSE 0
                    END
                ), 0) AS value
                FROM doctor_payouts{doctor_payout_clause}
                """,
                doctor_payout_params,
            )
            doctor_payout_ready = cursor.fetchone()["value"]

        # Find lab revenue
        lab_revenue = 0.0
        for m in by_module:
            if m.get("label") == "Lab / Diagnostics":
                lab_revenue = float(m.get("count") or 0.0)
                break

        # Determine monthly revenue
        if collection_month:
            monthly_revenue = float(total_collected)
        else:
            from datetime import datetime
            if collection_date:
                try:
                    curr_date = datetime.strptime(collection_date, "%Y-%m-%d").date()
                except Exception:
                    curr_date = datetime.now().date()
            else:
                curr_date = datetime.now().date()
                
            m_start = curr_date.replace(day=1).isoformat()
            if curr_date.month == 12:
                m_end = curr_date.replace(year=curr_date.year + 1, month=1, day=1).isoformat()
            else:
                m_end = curr_date.replace(month=curr_date.month + 1, day=1).isoformat()
                
            # Get monthly collections
            with get_connection(db) as conn_m:
                c_m = conn_m.cursor()
                date_col_ip_m = date_clause("created_at")
                date_col_d_m = date_clause("created_at")
                date_col_ps_m = date_clause("sold_at")
                
                c_m.execute(
                    f"""
                    SELECT COALESCE(SUM(value), 0) AS value
                    FROM (
                        SELECT COALESCE(SUM(amount), 0) AS value FROM invoice_payments WHERE {date_col_ip_m} >= DATE(?) AND {date_col_ip_m} < DATE(?)
                        UNION ALL
                        SELECT COALESCE(SUM(paid_amount), 0) AS value FROM diagnostics WHERE {date_col_d_m} >= DATE(?) AND {date_col_d_m} < DATE(?)
                        UNION ALL
                        SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales WHERE {date_col_ps_m} >= DATE(?) AND {date_col_ps_m} < DATE(?)
                    )
                    """,
                    (m_start, m_end, m_start, m_end, m_start, m_end)
                )
                monthly_revenue = float(c_m.fetchone()["value"] or 0.0)

    return {
        "total_billed": total_billed,
        "total_collected": total_collected,
        "total_due": total_due,
        "total_advance": total_advance,
        "total_refunded": total_refunded,
        "doctor_payout_ready": doctor_payout_ready,
        "payment_mode_breakdown": by_mode,
        "collections_by_module": by_module,
        "aging_buckets": {
            "bucket_0_30": aging.get("bucket_0_30", 0),
            "bucket_31_60": aging.get("bucket_31_60", 0),
            "bucket_61_90": aging.get("bucket_61_90", 0),
            "bucket_91_plus": aging.get("bucket_91_plus", 0),
        },
        "reconciliation_summary": {
            "gateway_collected": reconciliation.get("gateway_collected", 0),
            "converted_total": reconciliation.get("converted_total", 0),
        },
        "conversion_breakdown": conversion_breakdown,
        "todayRevenue": float(total_collected) if collection_date else 0.0,
        "labRevenue": float(lab_revenue),
        "monthlyRevenue": float(monthly_revenue),
        "pendingPayments": float(total_due),
        "doctorPayoutReady": float(doctor_payout_ready),
        "outstandingAmount": float(total_due),
    }



def get_report_patient_history(db, collection_date=None, filter_type=None, filter_value=None):
    if not filter_type or not filter_value:
        return []

    filter_value_lower = filter_value.strip().lower()
    
    with get_connection(db) as conn:
        cursor = conn.cursor()
        
        date_params = ()
        if collection_date:
            invoice_date_clause = "AND DATE(ip.created_at) = DATE(?)"
            diagnostic_date_clause = "AND DATE(d.created_at) = DATE(?)"
            pharmacy_date_clause = "AND DATE(ps.sold_at) = DATE(?)"
            date_params = (collection_date,)
        else:
            invoice_date_clause = ""
            diagnostic_date_clause = ""
            pharmacy_date_clause = ""
            
        results = []
        
        if filter_type == 'module':
            if filter_value_lower in ('op / billing', 'billing', 'op', 'ip'):
                query = f"""
                    SELECT i.patient_id, p.name, p.last_name, NULL AS fallback_name,
                           ip.created_at, i.module AS source, i.invoice_no AS reference,
                           ip.amount, ip.payment_mode
                    FROM invoice_payments ip
                    JOIN invoices i ON i.id = ip.invoice_id
                    LEFT JOIN patients p ON p.patient_id = i.patient_id
                    WHERE 1=1 {invoice_date_clause}
                """
                if filter_value_lower == 'op / billing':
                    query += """
                        AND (LOWER(COALESCE(i.module, '')) LIKE '%op%'
                          OR LOWER(COALESCE(i.module, '')) LIKE '%consult%'
                          OR LOWER(COALESCE(i.module, '')) LIKE '%billing%')
                    """
                else:
                    query += " AND LOWER(i.module) = ?"
                    date_params = date_params + (filter_value_lower,)
                    
                cursor.execute(query, date_params)
                results = [dict(row) for row in cursor.fetchall()]
                
            elif filter_value_lower in ('lab / diagnostics', 'lab', 'diagnostics'):
                query = f"""
                    SELECT d.patient_id, p.name, p.last_name, d.patient_name AS fallback_name,
                           d.created_at, 'Lab / Diagnostics' AS source, d.test_name AS reference,
                           d.paid_amount AS amount, d.payment_mode
                    FROM diagnostics d
                    LEFT JOIN patients p ON p.patient_id = d.patient_id
                    WHERE 1=1 {diagnostic_date_clause}
                """
                cursor.execute(query, date_params)
                results = [dict(row) for row in cursor.fetchall()]
                
            elif filter_value_lower == 'pharmacy':
                query = f"""
                    SELECT ps.patient_id, p.name, p.last_name, NULL AS fallback_name,
                           ps.sold_at AS created_at, 'Pharmacy' AS source, ps.medicine_name AS reference,
                           ps.amount, ps.payment_mode
                    FROM pharmacy_sales ps
                    LEFT JOIN patients p ON p.patient_id = ps.patient_id
                    WHERE 1=1 {pharmacy_date_clause}
                """
                cursor.execute(query, date_params)
                results = [dict(row) for row in cursor.fetchall()]
                
            else:
                query = f"""
                    SELECT i.patient_id, p.name, p.last_name, NULL AS fallback_name,
                           ip.created_at, i.module AS source, i.invoice_no AS reference,
                           ip.amount, ip.payment_mode
                    FROM invoice_payments ip
                    JOIN invoices i ON i.id = ip.invoice_id
                    LEFT JOIN patients p ON p.patient_id = i.patient_id
                    WHERE LOWER(i.module) = ? {invoice_date_clause}
                """
                params = (filter_value_lower,) + date_params
                cursor.execute(query, params)
                results = [dict(row) for row in cursor.fetchall()]
                
        elif filter_type == 'payment_mode':
            query1 = f"""
                SELECT i.patient_id, p.name, p.last_name, NULL AS fallback_name,
                       ip.created_at,
                       CASE
                           WHEN LOWER(COALESCE(i.module, '')) LIKE '%op%'
                                OR LOWER(COALESCE(i.module, '')) LIKE '%consult%'
                                OR LOWER(COALESCE(i.module, '')) LIKE '%billing%'
                           THEN 'OP / Billing'
                           ELSE COALESCE(NULLIF(TRIM(i.module), ''), 'Billing')
                       END AS source,
                       i.invoice_no AS reference, ip.amount, ip.payment_mode
                FROM invoice_payments ip
                JOIN invoices i ON i.id = ip.invoice_id
                LEFT JOIN patients p ON p.patient_id = i.patient_id
                WHERE COALESCE(NULLIF(TRIM(ip.payment_mode), ''), 'cash') = ? {invoice_date_clause}
            """
            query2 = f"""
                SELECT d.patient_id, p.name, p.last_name, d.patient_name AS fallback_name,
                       d.created_at, 'Lab / Diagnostics' AS source, d.test_name AS reference,
                       d.paid_amount AS amount, d.payment_mode
                FROM diagnostics d
                LEFT JOIN patients p ON p.patient_id = d.patient_id
                WHERE COALESCE(NULLIF(TRIM(d.payment_mode), ''), 'cash') = ? {diagnostic_date_clause}
            """
            query3 = f"""
                SELECT ps.patient_id, p.name, p.last_name, NULL AS fallback_name,
                       ps.sold_at AS created_at, 'Pharmacy' AS source, ps.medicine_name AS reference,
                       ps.amount, ps.payment_mode
                FROM pharmacy_sales ps
                LEFT JOIN patients p ON p.patient_id = ps.patient_id
                WHERE COALESCE(NULLIF(TRIM(ps.payment_mode), ''), 'cash') = ? {pharmacy_date_clause}
            """
            
            mode_map = {
                'cash': 'cash',
                'card': 'card',
                'upi': 'upi',
                'bank': 'bank',
                'net banking': 'bank',
                'wire transfer': 'bank'
            }
            db_mode = mode_map.get(filter_value_lower, filter_value_lower)
            
            p1 = (db_mode,) + date_params
            p2 = (db_mode,) + date_params
            p3 = (db_mode,) + date_params
            
            cursor.execute(query1, p1)
            r1 = [dict(row) for row in cursor.fetchall()]
            
            cursor.execute(query2, p2)
            r2 = [dict(row) for row in cursor.fetchall()]
            
            cursor.execute(query3, p3)
            r3 = [dict(row) for row in cursor.fetchall()]
            
            results = r1 + r2 + r3

        formatted_history = []
        for r in results:
            first_name = r.get("name")
            last_name = r.get("last_name")
            if first_name:
                pat_name = f"{first_name} {last_name or ''}".strip()
            else:
                pat_name = r.get("fallback_name") or "Walk-in Patient"
                
            formatted_history.append({
                "patient_id": r.get("patient_id") or "Walk-in",
                "patient_name": pat_name,
                "date": r.get("created_at").isoformat() if hasattr(r.get("created_at"), 'isoformat') else str(r.get("created_at") or ""),
                "source": r.get("source") or "Other",
                "reference": r.get("reference") or "-",
                "amount": float(r.get("amount") or 0.0),
                "payment_mode": str(r.get("payment_mode") or "cash").title()
            })
            
        formatted_history.sort(key=lambda x: x["date"], reverse=True)
        return formatted_history



def get_reports_overview(db):
    hospital_summary = get_hospital_dashboard_summary(db)
    billing_summary = get_revenue_summary(db)
    pharmacy_summary = get_pharmacy_summary(db)
    lab_summary = get_diagnostic_summary(db)
    employee_summary = get_employee_stats(db)
    accounts_summary = get_accounts_summary(db)

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(doctor_name), ''), 'Unassigned') AS label,
                   COALESCE(SUM(paid_amount + advance_amount - refunded_amount), 0) AS count
            FROM invoices
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        doctor_income = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(patient_id), ''), 'Unknown') AS label,
                   COALESCE(SUM(total_amount), 0) AS total_billed,
                   COALESCE(SUM(due_amount), 0) AS total_due
            FROM invoices
            GROUP BY label
            ORDER BY total_due DESC, total_billed DESC, label ASC
            """
        )
        patient_financials = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(doctor_name), ''), 'Unassigned') AS label,
                   COALESCE(SUM(amount), 0) AS count
            FROM diagnostics
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        diagnostics_by_doctor = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(clinic_name), ''), 'General') AS label,
                   COALESCE(SUM(total_amount), 0) AS count
            FROM invoices
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        clinic_income = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(module), ''), 'UNKNOWN') AS label,
                   COALESCE(SUM(discount), 0) AS count
            FROM invoices
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        discount_by_module = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(payment_status), ''), 'due') AS label,
                   COUNT(*) AS count
            FROM invoices
            GROUP BY label
            ORDER BY count DESC, label ASC
            """
        )
        payment_status_breakdown = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT AVG(
                GREATEST(
                    EXTRACT(EPOCH FROM (COALESCE(discharge_date::timestamp, CURRENT_TIMESTAMP) - admission_date)) / 86400.0,
                    0
                )
            ) AS avg_los,
            COUNT(*) AS admission_count
            FROM admissions
            """
        )
        alos_row = cursor.fetchone()
        average_los_days = round(float((alos_row or {"avg_los": 0})["avg_los"] or 0), 2)
        admission_count = int((alos_row or {"admission_count": 0})["admission_count"] or 0)

    return {
        "hospital_summary": hospital_summary,
        "billing_summary": billing_summary,
        "pharmacy_summary": pharmacy_summary,
        "lab_summary": lab_summary,
        "employee_summary": employee_summary,
        "accounts_summary": accounts_summary,
        "doctor_income": doctor_income,
        "patient_financials": patient_financials,
        "diagnostics_by_doctor": diagnostics_by_doctor,
        "clinic_income": clinic_income,
        "discount_by_module": discount_by_module,
        "payment_status_breakdown": payment_status_breakdown,
        "alos_summary": {
            "average_los_days": average_los_days,
            "admission_count": admission_count,
        },
    }



def _payload_hash(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()



class DuplicateIdempotentRequest(Exception):
    """Raised to signal 'this exact request was already processed -- here is
    the original result', so the caller can return it as a success rather
    than re-running the side effects."""

    def __init__(self, result):
        super().__init__("Duplicate idempotent request")
        self.result = result



def record_stock_movement(cursor, pharmacy_inventory_id, stock_source, movement_type, delta_qty, ref_table=None, ref_id=None, actor=None):
    cursor.execute(
        """
        INSERT INTO stock_movements (pharmacy_inventory_id, stock_source, movement_type, delta_qty, ref_table, ref_id, actor)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (pharmacy_inventory_id, stock_source, movement_type, delta_qty, ref_table, ref_id, actor),
    )



def create_medicine(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO medicines (name, generic_name, category, dosage_form, strength, unit, hsn_code, gst_rate, manufacturer, reorder_level, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"],
                data.get("generic_name"),
                data.get("category"),
                data.get("dosage_form"),
                data.get("strength"),
                data.get("unit"),
                data.get("hsn_code"),
                data.get("gst_rate", 0),
                data.get("manufacturer"),
                data.get("reorder_level", 10),
                1 if data.get("active", True) else 0,
            ),
        )
        medicine_id = cursor.lastrowid
        conn.commit()
        return medicine_id



def list_medicines(db, active_only=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if active_only:
            cursor.execute("SELECT * FROM medicines WHERE active = 1 ORDER BY name ASC")
        else:
            cursor.execute("SELECT * FROM medicines ORDER BY name ASC")
        return cursor.fetchall()



def update_medicine(db, medicine_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM medicines WHERE id = ?", (medicine_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE medicines
            SET name=?, generic_name=?, category=?, dosage_form=?, strength=?, unit=?, hsn_code=?, gst_rate=?, manufacturer=?, reorder_level=?, active=?
            WHERE id=?
            """,
            (
                data.get("name", existing["name"]),
                data.get("generic_name", existing["generic_name"]),
                data.get("category", existing["category"]),
                data.get("dosage_form", existing["dosage_form"]),
                data.get("strength", existing["strength"]),
                data.get("unit", existing["unit"]),
                data.get("hsn_code", existing["hsn_code"]),
                data.get("gst_rate", existing["gst_rate"]),
                data.get("manufacturer", existing["manufacturer"]),
                data.get("reorder_level", existing["reorder_level"]),
                1 if data.get("active", existing["active"]) else 0,
                medicine_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def upsert_inventory_item(db, data):
    """Create/update one stock batch. qty_available/qty_damaged are the
    source of truth; `quantity` is mirrored for any legacy readers.

    stock_source is required on a brand-new batch (a manual entry, e.g.
    opening stock, is not "legacy" -- it must declare a real pool) and is
    immutable on ordinary edits once set (use classify_legacy_batch(db) for
    the one-time legacy-review path instead).
    """
    with get_connection(db) as conn:
        cursor = conn.cursor()
        item_id = data.get("id")
        qty_available = int(data.get("qty_available", data.get("quantity", 0)) or 0)
        qty_damaged = int(data.get("qty_damaged", 0) or 0)
        if item_id:
            cursor.execute(
                """
                UPDATE pharmacy_inventory
                SET medicine_id=?, medicine_name=?, batch_no=?, mfg_date=?, expiry_date=?,
                    qty_available=?, qty_damaged=?, quantity=?, reorder_level=?, unit_price=?,
                    stock_condition=?
                WHERE id=?
                """,
                (
                    data.get("medicine_id"),
                    data["medicine_name"],
                    data.get("batch_no"),
                    data.get("mfg_date"),
                    data.get("expiry_date"),
                    qty_available,
                    qty_damaged,
                    qty_available,
                    data.get("reorder_level", 10),
                    data.get("unit_price", 0),
                    data.get("stock_condition", "proper"),
                    item_id,
                ),
            )
            conn.commit()
            return item_id
        stock_source = data.get("stock_source")
        if stock_source not in ("CASH", "INSURANCE"):
            raise ValueError("stock_source must be CASH or INSURANCE for a new batch.")
        cursor.execute(
            """
            INSERT INTO pharmacy_inventory (
                medicine_id, medicine_name, batch_no, mfg_date, expiry_date,
                qty_available, qty_damaged, quantity, reorder_level, unit_price, stock_condition, stock_source, unit_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("medicine_id"),
                data["medicine_name"],
                data.get("batch_no"),
                data.get("mfg_date"),
                data.get("expiry_date"),
                qty_available,
                qty_damaged,
                qty_available,
                data.get("reorder_level", 10),
                data.get("unit_price", 0),
                data.get("stock_condition", "proper"),
                stock_source,
                data.get("unit_type"),
            ),
        )
        item_id = cursor.lastrowid
        if qty_available:
            record_stock_movement(cursor, item_id, stock_source, "receipt", qty_available, ref_table="pharmacy_inventory", ref_id=item_id)
        conn.commit()
        return item_id



def list_inventory_items(db, stock_source=None):
    """Each batch also carries master_reorder_level -- the medicine master's
    configured reorder threshold (falling back to the batch's own
    reorder_level when there's no linked master record) -- so the frontend
    can compute "low stock" against the real, medicine-specific threshold
    instead of a hardcoded number, and get the same answer everywhere."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        base = """
            SELECT pi.*, 
                   COALESCE(m.reorder_level, pi.reorder_level, 10) AS master_reorder_level,
                   COALESCE(ps_batch.supplier_name, ps_po.supplier_name, ps_pr.supplier_name, ps_def.supplier_name) AS supplier_name,
                   COALESCE(ps_batch.phone, ps_po.phone, ps_pr.phone, ps_def.phone) AS supplier_phone,
                   CASE WHEN ps_batch.phone IS NOT NULL THEN ps_batch.phone_country_code
                        WHEN ps_po.phone IS NOT NULL THEN ps_po.phone_country_code
                        WHEN ps_pr.phone IS NOT NULL THEN ps_pr.phone_country_code
                        ELSE ps_def.phone_country_code END AS supplier_phone_country_code,
                   COALESCE(ps_batch.contact_person, ps_po.contact_person, ps_pr.contact_person, ps_def.contact_person) AS supplier_contact_person
            FROM pharmacy_inventory pi
            LEFT JOIN medicines m ON m.id = pi.medicine_id
            LEFT JOIN pharmacy_suppliers ps_batch ON ps_batch.id = pi.supplier_id
            LEFT JOIN (
                SELECT pp.medicine_name, pp.supplier_id,
                       ROW_NUMBER() OVER (PARTITION BY LOWER(pp.medicine_name) ORDER BY pp.id DESC) as rn
                FROM pharmacy_purchases pp WHERE pp.supplier_id IS NOT NULL
            ) last_po ON LOWER(last_po.medicine_name) = LOWER(pi.medicine_name) AND last_po.rn = 1
            LEFT JOIN pharmacy_suppliers ps_po ON ps_po.id = last_po.supplier_id
            LEFT JOIN (
                SELECT pri.medicine_name, COALESCE(pr.preferred_supplier_id, pr.supplier_id) AS supplier_id,
                       ROW_NUMBER() OVER (PARTITION BY LOWER(pri.medicine_name) ORDER BY pr.id DESC) as rn
                FROM purchase_request_items pri
                JOIN purchase_requests pr ON pr.id = pri.pr_id
                WHERE COALESCE(pr.preferred_supplier_id, pr.supplier_id) IS NOT NULL
            ) last_pr ON LOWER(last_pr.medicine_name) = LOWER(pi.medicine_name) AND last_pr.rn = 1
            LEFT JOIN pharmacy_suppliers ps_pr ON ps_pr.id = last_pr.supplier_id
            LEFT JOIN (
                SELECT id, supplier_name, phone, phone_country_code, contact_person
                FROM pharmacy_suppliers
                WHERE status = 'active'
                ORDER BY id ASC
                LIMIT 1
            ) ps_def ON true
        """
        if stock_source and stock_source != "ALL":
            cursor.execute(base + " WHERE pi.stock_source = ? ORDER BY pi.medicine_name ASC, pi.expiry_date ASC NULLS LAST", (stock_source,))
        else:
            cursor.execute(base + " ORDER BY pi.medicine_name ASC, pi.expiry_date ASC NULLS LAST")
        return cursor.fetchall()



def delete_inventory_item(db, item_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM pharmacy_inventory WHERE id = ?", (item_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_pharmacy_supplier(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO pharmacy_suppliers (supplier_name, contact_person, phone, status, phone_country_code)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                data["supplier_name"],
                data.get("contact_person"),
                data.get("phone"),
                data.get("status", "active"),
                data.get("phone_country_code"),
            ),
        )
        supplier_id = cursor.lastrowid
        conn.commit()
        return supplier_id



def list_pharmacy_suppliers(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_suppliers ORDER BY supplier_name ASC")
        return cursor.fetchall()



def update_pharmacy_supplier(db, supplier_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_suppliers WHERE id = ?", (supplier_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE pharmacy_suppliers
            SET supplier_name = ?, contact_person = ?, phone = ?, status = ?, phone_country_code = ?
            WHERE id = ?
            """,
            (
                data.get("supplier_name", existing["supplier_name"]),
                data.get("contact_person", existing["contact_person"]),
                data.get("phone", existing["phone"]),
                data.get("status", existing["status"]),
                data.get("phone_country_code", existing.get("phone_country_code")),
                supplier_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_pharmacy_supplier(db, supplier_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE pharmacy_purchases SET supplier_id = NULL WHERE supplier_id = ?", (supplier_id,))
        cursor.execute("DELETE FROM pharmacy_suppliers WHERE id = ?", (supplier_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_pharmacy_purchase(db, data):
    """Creating a purchase order NEVER touches stock -- receiving physical
    goods is tracked separately via a GRN (see create_goods_receipt /
    verify_goods_receipt), which is the only place stock actually increases.
    """
    with get_connection(db) as conn:
        cursor = conn.cursor()
        quantity = int(data["quantity"])
        unit_cost = float(data["unit_cost"])
        status = data.get("status", "ordered")
        cursor.execute(
            """
            INSERT INTO pharmacy_purchases (
                supplier_id, medicine_name, quantity, unit_cost, total_cost, status,
                expected_date, received_date, stock_applied
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                data.get("supplier_id"),
                data["medicine_name"],
                quantity,
                unit_cost,
                quantity * unit_cost,
                status,
                data.get("expected_date"),
                data.get("received_date"),
            ),
        )
        purchase_id = cursor.lastrowid
        conn.commit()
        return purchase_id



def list_pharmacy_purchases(db, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if status:
            cursor.execute(
                """
                SELECT pp.*, s.supplier_name
                FROM pharmacy_purchases pp
                LEFT JOIN pharmacy_suppliers s ON pp.supplier_id = s.id
                WHERE pp.status = ?
                ORDER BY pp.created_at DESC, pp.id DESC
                """,
                (status,),
            )
        else:
            cursor.execute(
                """
                SELECT pp.*, s.supplier_name
                FROM pharmacy_purchases pp
                LEFT JOIN pharmacy_suppliers s ON pp.supplier_id = s.id
                ORDER BY pp.created_at DESC, pp.id DESC
                """
            )
        return cursor.fetchall()



def update_pharmacy_purchase(db, purchase_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_purchases WHERE id = ?", (purchase_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        quantity = int(data.get("quantity", existing["quantity"] or 0))
        unit_cost = float(data.get("unit_cost", existing["unit_cost"] or 0))
        status = data.get("status", existing["status"])
        stock_applied = int(existing["stock_applied"] or 0)
        cursor.execute(
            """
            UPDATE pharmacy_purchases
            SET supplier_id = ?, medicine_name = ?, quantity = ?, unit_cost = ?, total_cost = ?,
                status = ?, expected_date = ?, received_date = ?, stock_applied = ?
            WHERE id = ?
            """,
            (
                data.get("supplier_id", existing["supplier_id"]),
                data.get("medicine_name", existing["medicine_name"]),
                quantity,
                unit_cost,
                quantity * unit_cost,
                status,
                data.get("expected_date", existing["expected_date"]),
                data.get("received_date", existing["received_date"]),
                stock_applied,
                purchase_id,
            ),
        )
        # status = 'received' here only means "physically arrived" -- it is
        # informational and never touches stock. Stock only increases via a
        # verified GRN (see verify_goods_receipt).
        conn.commit()
        return cursor.rowcount > 0



def delete_pharmacy_purchase(db, purchase_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM pharmacy_purchases WHERE id = ?", (purchase_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_goods_receipt(db, data):
    """Record what actually arrived. Stock is NOT touched yet -- only once
    this GRN is verified (see verify_goods_receipt). Supports partial
    receipt: multiple GRNs can be created against the same purchase order.
    Requires an explicit stock_source: Cash and Insurance are separate
    physical supplies, one receipt belongs to exactly one of them.
    """
    stock_source = data.get("stock_source")
    if stock_source not in ("CASH", "INSURANCE"):
        raise ValueError("stock_source must be CASH or INSURANCE.")

    idempotency_key = data.get("idempotency_key")
    payload_hash = _payload_hash(data)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if idempotency_key:
            cursor.execute(
                "SELECT id, grn_no, idempotency_payload_hash FROM goods_receipts WHERE idempotency_key = ?",
                (idempotency_key,),
            )
            existing = cursor.fetchone()
            if existing:
                if existing["idempotency_payload_hash"] == payload_hash:
                    return existing["id"], existing["grn_no"]
                raise ValueError("This idempotency key was already used with different request content.")

        grn_no = f"GRN-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        cursor.execute(
            """
            INSERT INTO goods_receipts (grn_no, purchase_order_id, received_date, supplier_invoice_no, status, stock_source, idempotency_key, idempotency_payload_hash, supplier_id)
            VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
            """,
            (grn_no, data.get("purchase_order_id"), data.get("received_date"), data.get("supplier_invoice_no"), stock_source, idempotency_key, payload_hash, data.get("supplier_id")),
        )
        grn_id = cursor.lastrowid
        for item in data.get("items", []):
            item_source = item.get("stock_source") or stock_source
            if item_source not in ("CASH", "INSURANCE"):
                raise ValueError("Each goods-receipt line must have a stock_source of CASH or INSURANCE.")
            qty_received = int(item.get("qty_received", item.get("received_qty", 0)) or 0)
            qty_accepted = int(item.get("qty_accepted", qty_received) or 0)
            purchase_price = float(item.get("purchase_price", item.get("unit_cost", 0)) or 0)
            cursor.execute(
                """
                INSERT INTO goods_receipt_items (
                    grn_id, medicine_id, medicine_name, batch_no, mfg_date, expiry_date, qty_received, qty_accepted, qty_damaged, stock_source,
                    purchase_price, mrp, gst_rate, unit_type, free_qty, selling_price, discount_pct, hsn_code, manufacturer, pack_size
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    grn_id,
                    item.get("medicine_id"),
                    item["medicine_name"],
                    item.get("batch_no"),
                    item.get("mfg_date"),
                    item.get("expiry_date"),
                    qty_received,
                    qty_accepted,
                    int(item.get("qty_damaged", 0) or 0),
                    item_source,
                    purchase_price,
                    float(item.get("mrp", 0) or 0),
                    float(item.get("gst_rate", 0) or 0),
                    item.get("unit_type"),
                    int(item.get("free_qty", 0) or 0),
                    float(item["selling_price"]) if item.get("selling_price") not in (None, "") else None,
                    float(item.get("discount_pct", 0) or 0),
                    item.get("hsn_code") or None,
                    item.get("manufacturer") or None,
                    item.get("pack_size") or None,
                ),
            )
        conn.commit()
        return grn_id, grn_no



def list_goods_receipts(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM goods_receipts ORDER BY created_at DESC")
        receipts = cursor.fetchall()
        result = []
        for grn in receipts:
            cursor.execute("SELECT * FROM goods_receipt_items WHERE grn_id = ?", (grn["id"],))
            grn_dict = dict(grn)
            grn_dict["items"] = [dict(row) for row in cursor.fetchall()]
            result.append(grn_dict)
        return result



def verify_goods_receipt(db, grn_id, actor=None):
    """The one place pharmacy stock actually increases. Accepted quantities
    add to qty_available, damaged quantities add to qty_damaged -- never
    both counted as available. Each line's own stock_source decides which
    pool it lands in; a batch match requires the SAME source too, so the
    same manufacturer batch number can exist independently in both pools
    without colliding."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM goods_receipts WHERE id = ?", (grn_id,))
        grn = cursor.fetchone()
        if not grn:
            raise ValueError("GRN not found.")
        if grn["status"] == "verified":
            raise ValueError("This GRN has already been verified.")

        supplier_id = grn["supplier_id"]
        if grn["purchase_order_id"]:
            cursor.execute("SELECT supplier_id FROM pharmacy_purchases WHERE id = ?", (grn["purchase_order_id"],))
            po_row = cursor.fetchone()
            if po_row and po_row["supplier_id"]:
                supplier_id = po_row["supplier_id"]

        cursor.execute("SELECT * FROM goods_receipt_items WHERE grn_id = ?", (grn_id,))
        items = cursor.fetchall()
        for item in items:
            accepted = int(item["qty_accepted"] or 0)
            damaged = int(item["qty_damaged"] or 0)
            item_source = item["stock_source"] or grn["stock_source"]
            purchase_price = float(item["purchase_price"] or 0)
            mrp = float(item["mrp"] or 0)
            unit_price = mrp if mrp > 0 else purchase_price

            if item_source not in ("CASH", "INSURANCE"):
                raise ValueError(f"Goods-receipt line for {item['medicine_name']} has no valid stock_source.")
            item_unit_type = item["unit_type"]
            item_mfg_date = item["mfg_date"]
            cursor.execute(
                """
                SELECT id, qty_available, qty_damaged, unit_price FROM pharmacy_inventory
                WHERE medicine_name = ? AND batch_no IS NOT DISTINCT FROM ? AND expiry_date IS NOT DISTINCT FROM ?
                  AND stock_source = ?
                """,
                (item["medicine_name"], item["batch_no"], item["expiry_date"], item_source),
            )
            existing_batch = cursor.fetchone()
            if existing_batch:
                new_available = (existing_batch["qty_available"] or 0) + accepted
                new_damaged = (existing_batch["qty_damaged"] or 0) + damaged
                up = unit_price if unit_price > 0 else (existing_batch["unit_price"] or 0)
                cursor.execute(
                    """
                    UPDATE pharmacy_inventory
                    SET qty_available=?, qty_damaged=?, quantity=?, unit_price=?, purchase_price=?,
                        mfg_date=COALESCE(?, mfg_date)
                    WHERE id=?
                    """,
                    (new_available, new_damaged, new_available, up, purchase_price, item_mfg_date, existing_batch["id"]),
                )
                batch_id = existing_batch["id"]
            else:
                # A new batch's reorder threshold should reflect what the
                # medicine master has configured, not a fixed placeholder --
                # otherwise every medicine looks identically "low" regardless
                # of its real consumption rate.
                batch_reorder_level = 10
                if item["medicine_id"]:
                    cursor.execute("SELECT reorder_level FROM medicines WHERE id = ?", (item["medicine_id"],))
                    med_row = cursor.fetchone()
                    if med_row and med_row["reorder_level"] is not None:
                        batch_reorder_level = int(med_row["reorder_level"])
                else:
                    cursor.execute("SELECT reorder_level FROM medicines WHERE LOWER(name) = LOWER(?) LIMIT 1", (item["medicine_name"],))
                    med_row = cursor.fetchone()
                    if med_row and med_row["reorder_level"] is not None:
                        batch_reorder_level = int(med_row["reorder_level"])
                cursor.execute(
                    """
                    INSERT INTO pharmacy_inventory (
                        medicine_id, medicine_name, batch_no, mfg_date, expiry_date, qty_available, qty_damaged, quantity,
                        reorder_level, unit_price, stock_condition, stock_source, batch_status, purchase_price, mrp, unit_type, supplier_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proper', ?, 'available', ?, ?, ?, ?)
                    """,
                    (item["medicine_id"], item["medicine_name"], item["batch_no"], item_mfg_date, item["expiry_date"], accepted, damaged, accepted, batch_reorder_level, unit_price, item_source, purchase_price, mrp, item_unit_type, supplier_id),
                )
                batch_id = cursor.lastrowid
            if accepted:
                record_stock_movement(cursor, batch_id, item_source, "receipt", accepted, ref_table="goods_receipts", ref_id=grn_id, actor=actor)
        cursor.execute("UPDATE goods_receipts SET status = 'verified' WHERE id = ?", (grn_id,))
        if grn["purchase_order_id"]:
            cursor.execute("UPDATE pharmacy_purchases SET status = 'received' WHERE id = ?", (grn["purchase_order_id"],))
        conn.commit()
        return True



def create_stock_adjustment(db, data, username):
    """Reasoned, audited change to a batch's available quantity. Never
    silently deletes a stock row -- every change leaves an audit trail."""
    reason = str(data.get("reason") or "").strip()
    if not reason:
        raise ValueError("A reason is required for stock adjustments.")
    delta = int(data["delta_qty"])
    batch_id = int(data["pharmacy_inventory_id"])
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_inventory WHERE id = ?", (batch_id,))
        batch = cursor.fetchone()
        if not batch:
            raise ValueError("Stock batch not found.")
        new_qty = (batch["qty_available"] or 0) + delta
        if new_qty < 0:
            raise ValueError("Adjustment would make available quantity negative.")
        cursor.execute(
            "UPDATE pharmacy_inventory SET qty_available = ?, quantity = ? WHERE id = ?",
            (new_qty, new_qty, batch_id),
        )
        cursor.execute(
            "INSERT INTO stock_adjustments (pharmacy_inventory_id, delta_qty, reason, adjusted_by) VALUES (?, ?, ?, ?)",
            (batch_id, delta, reason, username),
        )
        adjustment_id = cursor.lastrowid
        conn.commit()
        return adjustment_id



def list_stock_adjustments(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT sa.*, pi.medicine_name, pi.batch_no
            FROM stock_adjustments sa
            JOIN pharmacy_inventory pi ON pi.id = sa.pharmacy_inventory_id
            ORDER BY sa.created_at DESC
            """
        )
        return cursor.fetchall()



EMAR_MAX_DOSES_PER_ISSUE = 60
EMAR_EARLY_WINDOW = timedelta(hours=1)


def _emar_now():
    # eMAR times are naive IST wall-clock times (what the ward sees), never server-local/UTC.
    return current_ist_datetime().replace(tzinfo=None)


def emar_frequency_plan(frequency, is_prn=False):
    """Map a prescribed frequency to administration times. Returns
    ("prn", None) for as-needed orders (no fixed schedule), ("stat", None) for a
    single immediate dose, ("hours", [h, ...]) for fixed clock times, or
    ("interval", n) for every-n-hours orders."""
    f = re.sub(r"\s+", " ", str(frequency or "").strip().upper())
    compact = f.replace(" ", "").replace(".", "")
    if is_prn or re.search(r"\b(PRN|SOS|AS NEEDED|WHEN REQUIRED)\b", f):
        return "prn", None
    if re.search(r"\bSTAT\b|\bIMMEDIATE", f) or compact == "ONCE":
        return "stat", None
    m = re.fullmatch(r"([01])-([01])-([01])(?:-([01]))?", compact)
    if m:
        slots = [8, 14, 20, 22]
        hours = [slots[i] for i, v in enumerate(m.groups()) if v == "1"]
        return ("hours", hours) if hours else ("hours", [9])
    m = re.search(r"\bQ(\d{1,2})H\b|EVERY (\d{1,2}) ?(?:HOURS?|HRS?)", f)
    if m:
        n = int(m.group(1) or m.group(2))
        if 1 <= n <= 24:
            return "interval", n
    if re.search(r"\bQID\b|FOUR TIMES|4 TIMES", f):
        return "hours", [6, 12, 18, 22]
    if re.search(r"\bTDS\b|\bTID\b|THRICE|THREE TIMES|3 TIMES", f):
        return "hours", [8, 14, 20]
    if re.search(r"\bBD\b|\bBID\b|TWICE|TWO TIMES|2 TIMES|\bQ12H\b", f):
        return "hours", [9, 21]
    if re.search(r"\bHS\b|BED ?TIME|NIGHT", f):
        return "hours", [21]
    return "hours", [9]  # OD / once daily / unrecognised -> once daily


def emar_schedule_times(frequency, count, start_at=None, end_at=None, after=None, is_prn=False, now=None):
    """Upcoming administration times for `count` doses. The first dose is the
    next slot at/after max(now, order start, `after`) -- never a slot that had
    already passed when pharmacy issued the stock -- and no dose is scheduled
    after the order's end time."""
    now = now or _emar_now()
    kind, value = emar_frequency_plan(frequency, is_prn)
    if count <= 0 or kind == "prn":
        return []
    begin = now
    for candidate in (start_at, after):
        if isinstance(candidate, str):
            try:
                candidate = datetime.fromisoformat(candidate)
            except ValueError:
                candidate = None
        if isinstance(candidate, datetime):
            candidate = candidate.replace(tzinfo=None)
            if candidate > begin:
                begin = candidate
    after = after.replace(tzinfo=None) if isinstance(after, datetime) else None
    if isinstance(end_at, str):
        try:
            end_at = datetime.fromisoformat(end_at)
        except ValueError:
            end_at = None
    end_at = end_at.replace(tzinfo=None) if isinstance(end_at, datetime) else None
    # A slot is still "current" for up to 30 minutes after its clock time.
    grace = timedelta(minutes=30)
    times = []
    if kind == "stat":
        times = [begin.replace(second=0, microsecond=0)]
    elif kind == "interval":
        step = timedelta(hours=value)
        if isinstance(after, datetime):
            t = after.replace(tzinfo=None) + step
            if t + grace < now:
                t = now.replace(minute=0, second=0, microsecond=0)
        else:
            t = begin.replace(minute=0, second=0, microsecond=0)
            if t + grace < begin:
                t += timedelta(hours=1)
        while len(times) < count:
            times.append(t)
            t += step
    else:
        day = begin.date()
        while len(times) < count:
            for h in value:
                slot = datetime.combine(day, datetime.min.time()).replace(hour=h)
                if slot + grace < begin or (isinstance(after, datetime) and slot <= after):
                    continue
                times.append(slot)
                if len(times) >= count:
                    break
            day += timedelta(days=1)
    if end_at:
        times = [t for t in times if t <= end_at]
    return times


def _create_emar_doses(cursor, line, indent_id, admission_id, patient_id, medicine_name, dispensed_qty, sale_id):
    """Turn an issued IP medication into scheduled eMAR doses. Dose, route and
    frequency come from the doctor's order line (ward_indent_items) when there
    is one -- the order is the source of truth, not the dispense payload."""
    indent_item_id = line.get("indent_item_id")
    order = None
    if indent_item_id:
        cursor.execute(
            "SELECT dose, route, frequency, start_at, end_at, is_prn FROM ward_indent_items WHERE id = ?",
            (indent_item_id,),
        )
        order = cursor.fetchone()
    dose = (order["dose"] if order and order["dose"] else None) or line.get("dose") or "1 dose"
    route = (order["route"] if order and order["route"] else None) or line.get("route") or "Oral"
    freq = (order["frequency"] if order and order["frequency"] else None) or line.get("frequency") or "OD"
    is_prn = bool(order["is_prn"]) if order else bool(line.get("is_prn"))
    count = min(int(dispensed_qty or 0), EMAR_MAX_DOSES_PER_ISSUE)

    if emar_frequency_plan(freq, is_prn)[0] == "prn":
        # As-needed: each issued unit is one dose the nurse may give when indicated.
        now = _emar_now().replace(second=0, microsecond=0)
        for _ in range(count):
            cursor.execute(
                """
                INSERT INTO emar_records (indent_id, indent_item_id, admission_id, patient_id, medicine_name, dose, route, scheduled_time, status, sale_id, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (indent_id, indent_item_id, admission_id, patient_id, medicine_name, dose, route, now, sale_id, "PRN - give only when indicated"),
            )
        return

    # A second (partial) issue of the same order continues after the doses already scheduled.
    last_scheduled = None
    if indent_item_id:
        cursor.execute(
            "SELECT MAX(scheduled_time) AS last_time FROM emar_records WHERE indent_item_id = ? AND status <> 'discontinued'",
            (indent_item_id,),
        )
        row = cursor.fetchone()
        last_scheduled = row["last_time"] if row else None
    times = emar_schedule_times(
        freq, count,
        start_at=order["start_at"] if order else None,
        end_at=order["end_at"] if order else None,
        after=last_scheduled,
    )
    for sched_time in times:
        cursor.execute(
            """
            INSERT INTO emar_records (indent_id, indent_item_id, admission_id, patient_id, medicine_name, dose, route, scheduled_time, status, sale_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (indent_id, indent_item_id, admission_id, patient_id, medicine_name, dose, route, sched_time, sale_id),
        )


def _pending_insurance_qty(cursor, medicine_name):
    """Units dispensed against insurance whose stock has not been deducted yet."""
    cursor.execute(
        """
        SELECT COALESCE(SUM(ps.quantity), 0) AS qty FROM pharmacy_sales ps
        WHERE ps.medicine_name = ? AND LOWER(COALESCE(ps.payment_mode, '')) = 'insurance'
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.ref_table = 'pharmacy_sales' AND sm.ref_id = ps.id AND sm.movement_type = 'dispense')
        """,
        (medicine_name,),
    )
    row = cursor.fetchone()
    return int(row["qty"] or 0) if row else 0


def deduct_deferred_insurance_stock(cursor, invoice_id, username):
    """Deduct inventory (FEFO) for insurance sales on an invoice whose claim is
    now settled. Idempotent: sales that already have a stock movement are skipped."""
    cursor.execute(
        """
        SELECT ps.id, ps.medicine_name, ps.quantity, ps.stock_source FROM pharmacy_sales ps
        WHERE ps.invoice_id = ? AND LOWER(COALESCE(ps.payment_mode, '')) = 'insurance'
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.ref_table = 'pharmacy_sales' AND sm.ref_id = ps.id AND sm.movement_type = 'dispense')
          AND COALESCE(ps.quantity, 0) > 0
        ORDER BY ps.id
        """,
        (invoice_id,),
    )
    for sale in cursor.fetchall():
        remaining = int(sale["quantity"] or 0)
        cursor.execute(
            """
            SELECT id, qty_available, stock_source FROM pharmacy_inventory
            WHERE medicine_name = ? AND batch_status = 'available' AND qty_available > 0
            ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, id ASC
            FOR UPDATE
            """,
            (sale["medicine_name"],),
        )
        for batch in cursor.fetchall():
            if remaining <= 0:
                break
            take = min(int(batch["qty_available"] or 0), remaining)
            if take <= 0:
                continue
            new_avail = int(batch["qty_available"]) - take
            cursor.execute("UPDATE pharmacy_inventory SET qty_available = ?, quantity = ? WHERE id = ?", (new_avail, new_avail, batch["id"]))
            record_stock_movement(cursor, batch["id"], batch["stock_source"] or sale["stock_source"] or "CASH", "dispense", -take,
                                  ref_table="pharmacy_sales", ref_id=sale["id"], actor=username)
            remaining -= take


def create_pharmacy_dispense(db, data, username):
    """Atomic: FEFO batch selection + stock decrement + sale record(s) +
    linked invoice (+ draft insurance claim when billed via insurance), all
    in one transaction. Never one without the other.

    The hospital buys all stock with its own money -- there is one physical
    inventory, not separate cash/insurance stock pools. `stock_source` here
    is a BILLING classification on the sale (how this dispense will be
    recovered: from the patient directly, or claimed back from their
    insurer), not a constraint on which batch gets consumed. FEFO always
    draws from the single shared inventory.

    An insurance-billed dispense requires the patient's insurance to have
    already been verified (a real front-desk/pharmacy step -- checking the
    policy is active and covers this treatment, same as any real pharmacy
    does before billing an insurer) -- enforced here, not just in the UI.
    """
    items = data.get("items") or []
    if not items:
        raise ValueError("At least one medicine line is required to dispense.")
    stock_source = data.get("stock_source") or ("INSURANCE" if data.get("billing_type") == "IPD_INSURANCE" else "CASH")
    if stock_source not in ("CASH", "INSURANCE"):
        stock_source = "CASH"
    patient_id = data.get("patient_id")
    is_external = bool(data.get("is_external") or (not patient_id and (data.get("customer_name") or data.get("customer_phone"))))
    customer_name = str(data.get("customer_name") or "").strip()
    customer_phone = str(data.get("customer_phone") or data.get("patient_mobile") or "").strip()
    customer_age = str(data.get("customer_age") or data.get("patient_age") or "").strip()
    customer_dob = str(data.get("customer_dob") or "").strip()
    remarks = str(data.get("remarks") or data.get("notes") or "").strip()

    if is_external and not patient_id:
        patient_id = f"EXT-{customer_phone}" if customer_phone else f"EXT-{int(datetime.now().timestamp())}"
    if not patient_id and data.get("billing_type") == "CASH_OPD":
        # OP internal sale must be tied to a registered patient (external sales get EXT- ids above).
        raise ValueError("Select a registered patient (UHID) before dispensing an internal OP sale.")

    prescription_id = data.get("prescription_id")
    admission_id = data.get("admission_id")
    indent_id = data.get("indent_id")
    billing_type = data.get("billing_type", "OPD_IMMEDIATE")
    payment_mode = data.get("payment_mode", "cash")
    # Insurance-billed dispenses are recorded as Due and do NOT touch inventory
    # (stock / stock value) until the insurance claim is settled.
    defer_stock = (
        str(payment_mode or "").strip().lower() == "insurance"
        or billing_type in ("OPD_INSURANCE", "INSURANCE", "IPD_INSURANCE")
    )
    if defer_stock:
        payment_mode = "insurance"
    deferred_in_request = {}
    idempotency_key = data.get("idempotency_key")
    payload_hash = _payload_hash(data)

    with get_connection(db) as conn:
        cursor = conn.cursor()

        if idempotency_key:
            cursor.execute(
                "SELECT payload_hash, result_json FROM pharmacy_dispense_transactions WHERE idempotency_key = ?",
                (idempotency_key,),
            )
            prior = cursor.fetchone()
            if prior:
                if prior["payload_hash"] == payload_hash:
                    return json.loads(prior["result_json"])
                raise ValueError("This idempotency key was already used with different request content.")

        if billing_type == "IPD_RUNNING" and not admission_id and patient_id:
            cursor.execute(
                "SELECT id FROM admissions WHERE patient_id = ? AND discharge_date IS NULL AND COALESCE(notes, '') != 'Initial registration' ORDER BY admission_date DESC LIMIT 1",
                (patient_id,)
            )
            adm_row = cursor.fetchone()
            if adm_row:
                admission_id = adm_row["id"]

        # Inpatient insurance: the payer recorded on the admission (provider,
        # policy, pre-auth) is what the pharmacy bills and claims against.
        admission_payer = None
        if admission_id:
            cursor.execute(
                "SELECT payer_type, insurance_provider, insurance_policy_no, insurance_preauth_no FROM admissions WHERE id = ?",
                (admission_id,),
            )
            admission_payer = cursor.fetchone()
        insured_admission = bool(
            admission_payer and admission_payer["payer_type"] == "insurance"
            and admission_payer["insurance_provider"] and admission_payer["insurance_policy_no"]
        )
        if defer_stock and admission_id:
            if not insured_admission:
                raise ValueError(
                    "This admission is marked Self-pay. Set the payer to Insurance (with provider and policy number) "
                    "at IP Admission or IP Discharge Billing before dispensing against insurance."
                )
            stock_source = "INSURANCE"

        if stock_source == "INSURANCE" and patient_id and not insured_admission:
            cursor.execute("SELECT insurance_verified FROM patients WHERE patient_id = ?", (patient_id,))
            prow = cursor.fetchone()
            if not prow or not prow["insurance_verified"]:
                raise ValueError("This patient's insurance has not been verified yet. Verify eligibility before dispensing against insurance.")

        sale_ids = []
        total_amount = 0.0
        invoice_id = None
        invoice_no = None
        shortfalls = []

        for line in items:
            medicine_name = line["medicine_name"]
            qty_needed = int(line["quantity"])

            if indent_id:
                indent_item_id = line.get("indent_item_id")
                if indent_item_id:
                    cursor.execute(
                        "SELECT status FROM ward_indent_items WHERE id = ?",
                        (indent_item_id,),
                    )
                else:
                    cursor.execute(
                        "SELECT status FROM ward_indent_items WHERE indent_id = ? AND medicine_name = ?",
                        (indent_id, medicine_name),
                    )
                indent_item_row = cursor.fetchone()
                if indent_item_row and indent_item_row["status"] == "cancelled":
                    shortfalls.append({"medicine_name": medicine_name, "requested": qty_needed, "dispensed": 0, "pending": qty_needed,
                                        "reason": "This medication order was cancelled and cannot be dispensed."})
                    continue

            unit_price = float(line.get("unit_price") or line.get("price") or 0)
            requested_batch_id = line.get("pharmacy_inventory_id") or line.get("batch_id")

            if requested_batch_id:
                cursor.execute(
                    """
                    SELECT id, qty_available, unit_price, stock_source, batch_status, expiry_date
                    FROM pharmacy_inventory WHERE id = ? FOR UPDATE
                    """,
                    (requested_batch_id,),
                )
                batch = cursor.fetchone()
                eligible = (
                    batch
                    and batch["batch_status"] == "available"
                    and batch["qty_available"] > 0
                    and (not batch["expiry_date"] or str(batch["expiry_date"]) > str(datetime.now().date()))
                )
                candidate_batches = [batch] if eligible else []
            else:
                # FEFO (earliest expiry first) across the single shared
                # inventory -- the hospital owns all stock outright, so there
                # is no source pool to scope this to.
                cursor.execute(
                    """
                    SELECT id, qty_available, unit_price, stock_source, batch_status, expiry_date
                    FROM pharmacy_inventory
                    WHERE medicine_name = ? AND batch_status = 'available'
                      AND qty_available > 0
                      AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
                    ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, id ASC
                    FOR UPDATE
                    """,
                    (medicine_name,),
                )
                candidate_batches = cursor.fetchall()

            line_movements = []
            remaining = qty_needed
            # Stock already promised to earlier undeducted insurance sales is not available again.
            reserved_left = 0
            if defer_stock:
                reserved_left = _pending_insurance_qty(cursor, medicine_name) + deferred_in_request.get(medicine_name, 0)
            for batch in candidate_batches:
                if remaining <= 0:
                    break
                available = int(batch["qty_available"] or 0)
                if defer_stock:
                    held = min(reserved_left, available)
                    reserved_left -= held
                    available -= held
                take = min(available, remaining)
                if take <= 0:
                    continue
                if defer_stock:
                    # Availability check only; inventory is deducted on claim settlement.
                    deferred_in_request[medicine_name] = deferred_in_request.get(medicine_name, 0) + take
                else:
                    new_avail = available - take
                    cursor.execute(
                        "UPDATE pharmacy_inventory SET qty_available = ?, quantity = ? WHERE id = ?",
                        (new_avail, new_avail, batch["id"]),
                    )
                    line_movements.append((batch["id"], take, batch["stock_source"] or stock_source))
                remaining -= take
                if unit_price == 0:
                    unit_price = float(batch["unit_price"] or 0)

            dispensed_qty = qty_needed - remaining
            line["_dispensed_qty"] = dispensed_qty
            if remaining > 0:
                shortfalls.append({
                    "medicine_name": medicine_name,
                    "requested": qty_needed,
                    "dispensed": dispensed_qty,
                    "pending": remaining,
                })
            if dispensed_qty <= 0:
                continue

            amount = dispensed_qty * unit_price
            total_amount += amount
            item_stock_source = stock_source
            cursor.execute(
                """
                INSERT INTO pharmacy_sales (patient_id, prescription_ref, medicine_name, quantity, unit_price, amount, payment_mode, stock_source, admission_id, indent_id, billing_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (patient_id, str(prescription_id) if prescription_id else None, medicine_name, dispensed_qty, unit_price, amount, payment_mode, item_stock_source, admission_id, indent_id, billing_type),
            )
            sale_id = cursor.lastrowid
            sale_ids.append(sale_id)
            for batch_id, take, b_source in line_movements:
                record_stock_movement(cursor, batch_id, b_source, "dispense", -take, ref_table="pharmacy_sales", ref_id=sale_id, actor=username)

            # If IPD dispensing with admission_id, auto-populate eMAR dosage entries for nursing
            if admission_id and patient_id:
                _create_emar_doses(cursor, line, indent_id, admission_id, patient_id, medicine_name, dispensed_qty, sale_id)

        if not sale_ids:
            cancelled_lines = [s["medicine_name"] for s in shortfalls if s.get("reason", "").startswith("This medication order was cancelled")]
            if cancelled_lines and len(cancelled_lines) == len(shortfalls):
                names = ", ".join(cancelled_lines)
                raise ValueError(f"This medication order has been cancelled and cannot be dispensed ({names}).")
            raise ValueError("Insufficient stock available in hospital inventory for the requested items.")

        claim_id = None
        is_insurance = False
        final_bill_total = total_amount
        dispense_paid_amount = total_amount
        dispense_due_amount = 0.0
        dispense_payment_status = "paid"
        # Only generate an immediate invoice for OPD; IPD and Emergency Account run on patient account settled at discharge / encounter close
        if total_amount > 0 and (patient_id or is_external) and (billing_type not in ("IPD_RUNNING", "EMERGENCY_ACCOUNT") or (defer_stock and billing_type == "IPD_RUNNING")):
            invoice_no = f"INV-PHM-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
            is_insurance = (
                payment_mode.lower() == "insurance"
                or billing_type in ("OPD_INSURANCE", "INSURANCE", "IPD_INSURANCE")
                or bool(data.get("insurer_name") or data.get("authorization_ref") or data.get("membership_ref") or data.get("policy_no") or data.get("preauth_no") or data.get("pre_auth_no"))
            )
            if is_insurance:
                patient_responsibility = float(data.get("patient_responsibility") or 0)
                adm_ins = admission_payer if insured_admission else {}
                insurer_name = str(data.get("insurer_name") or (adm_ins or {}).get("insurance_provider") or "Insurance / TPA").strip()
                membership_ref = str(data.get("membership_ref") or data.get("policy_no") or (adm_ins or {}).get("insurance_policy_no") or "").strip()
                authorization_ref = str(data.get("authorization_ref") or data.get("pre_auth_no") or data.get("preauth_no") or (adm_ins or {}).get("insurance_preauth_no") or "").strip()
                claim_label = f"IP Pharmacy Claim - Admission #{admission_id}" if admission_id else "OP Pharmacy Claim"
                dispense_paid_amount = 0.0
                dispense_due_amount = total_amount
                dispense_payment_status = "due"
                cursor.execute(
                    """
                    INSERT INTO invoices (
                        invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                        subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                        advance_amount, refunded_amount, payment_mode, patient_mobile, patient_age, notes
                    ) VALUES (?, ?, 'PHARMACY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (invoice_no, patient_id, None, "HospAI", insurer_name, total_amount, 0, 0, total_amount, 0, total_amount, "due", username, 0, 0, payment_mode, customer_phone or None, customer_age or None, remarks or None),
                )
                invoice_id = cursor.lastrowid
                for sale_id in sale_ids:
                    cursor.execute("UPDATE pharmacy_sales SET invoice_id = ? WHERE id = ?", (invoice_id, sale_id))
                cursor.execute(
                    """
                    INSERT INTO insurance_claims (
                        invoice_id, patient_id, insurer_name, claim_amount, approved_amount, claim_status,
                        external_ref, notes, patient_responsibility, settlement_status, membership_ref,
                        authorization_ref, pharmacy_sale_id
                    ) VALUES (?, ?, ?, ?, 0, 'submitted', ?, ?, ?, 'unpaid', ?, ?, ?)
                    """,
                    (
                        invoice_id, patient_id, insurer_name, total_amount,
                        authorization_ref, data.get("notes") or f"{claim_label} - Policy: {membership_ref or '-'}",
                        patient_responsibility, membership_ref, authorization_ref, sale_ids[0],
                    ),
                )
                claim_id = cursor.lastrowid
            else:
                if is_external:
                    ref_src = customer_name
                else:
                    ref_src = "Emergency" if "EMERGENCY" in billing_type.upper() else None

                notes_val = remarks
                if is_external:
                    ext_parts = ["External Sale", f"Customer: {customer_name}"]
                    if customer_phone:
                        ext_parts.append(f"Mobile: {customer_phone}")
                    if customer_age:
                        ext_parts.append(f"Age: {customer_age}")
                    if customer_dob:
                        ext_parts.append(f"DOB: {customer_dob}")
                    if remarks:
                        ext_parts.append(f"Remarks: {remarks}")
                    notes_val = " | ".join(ext_parts)

                subtotal_val = float(data.get("subtotal") if data.get("subtotal") is not None else total_amount)
                discount_val = float(data.get("discount") or 0.0)
                tax_val = float(data.get("tax") or 0.0)
                if data.get("grand_total") is not None:
                    final_bill_total = round(float(data["grand_total"]), 2)
                elif data.get("total_amount") is not None:
                    final_bill_total = round(float(data["total_amount"]), 2)
                else:
                    final_bill_total = round(max(0.0, subtotal_val - discount_val + tax_val), 2)
                if final_bill_total <= 0:
                    final_bill_total = round(total_amount, 2)

                req_paid = data.get("paid_amount")
                if req_paid is not None:
                    dispense_paid_amount = round(max(0.0, float(req_paid)), 2)
                    if dispense_paid_amount > final_bill_total:
                        dispense_paid_amount = final_bill_total
                else:
                    dispense_paid_amount = final_bill_total

                dispense_due_amount = round(max(0.0, final_bill_total - dispense_paid_amount), 2)
                dispense_payment_status = "paid" if dispense_due_amount <= 0 else ("partial" if dispense_paid_amount > 0 else "due")

                cursor.execute(
                    """
                    INSERT INTO invoices (
                        invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                        subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                        advance_amount, refunded_amount, payment_mode, patient_mobile, patient_age, notes
                    ) VALUES (?, ?, 'PHARMACY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (invoice_no, patient_id, None, "HospAI", ref_src, subtotal_val, tax_val, discount_val, final_bill_total, dispense_paid_amount, dispense_due_amount, dispense_payment_status, username, 0, 0, payment_mode, customer_phone or None, customer_age or None, notes_val or None),
                )
                invoice_id = cursor.lastrowid
                if dispense_paid_amount > 0:
                    cursor.execute(
                        "INSERT INTO invoice_payments (invoice_id, amount, payment_mode) VALUES (?, ?, ?)",
                        (invoice_id, dispense_paid_amount, payment_mode),
                    )
                for sale_id in sale_ids:
                    cursor.execute("UPDATE pharmacy_sales SET invoice_id = ? WHERE id = ?", (invoice_id, sale_id))

        if prescription_id:
            # Partial: some prescribed medicines were out of stock / not supplied this time,
            # so the e-Rx stays in the pharmacy's incoming list until the rest is dispensed.
            partial = bool(shortfalls) or bool(data.get("prescription_partial"))
            cursor.execute(
                "UPDATE prescriptions SET dispense_status = ? WHERE id = ?",
                ("partially_dispensed" if partial else "dispensed", prescription_id),
            )
            _supersede_older_rx_copies(cursor, prescription_id)

        if indent_id:
            for line in items:
                m_name = line["medicine_name"]
                d_qty = line.get("_dispensed_qty", 0)
                indent_item_id = line.get("indent_item_id")
                if d_qty > 0:
                    if indent_item_id:
                        cursor.execute(
                            """
                            UPDATE ward_indent_items
                            SET quantity_dispensed = COALESCE(quantity_dispensed, 0) + ?,
                                status = CASE
                                    WHEN COALESCE(quantity_dispensed, 0) + ? >= quantity_ordered THEN 'dispensed'
                                    ELSE 'partially_issued'
                                END
                            WHERE id = ?
                            """,
                            (d_qty, d_qty, indent_item_id),
                        )
                    else:
                        cursor.execute(
                            """
                            UPDATE ward_indent_items
                            SET quantity_dispensed = COALESCE(quantity_dispensed, 0) + ?,
                                status = CASE
                                    WHEN COALESCE(quantity_dispensed, 0) + ? >= quantity_ordered THEN 'dispensed'
                                    ELSE 'partially_issued'
                                END
                            WHERE indent_id = ? AND medicine_name = ?
                            """,
                            (d_qty, d_qty, indent_id, m_name),
                        )
            cursor.execute(
                """
                SELECT COUNT(*) AS total_items,
                       COUNT(CASE WHEN status = 'dispensed' THEN 1 END) AS fully_dispensed,
                       COUNT(CASE WHEN COALESCE(quantity_dispensed, 0) > 0 THEN 1 END) AS any_dispensed
                FROM ward_indent_items
                WHERE indent_id = ?
                """,
                (indent_id,),
            )
            ind_stat = cursor.fetchone()
            total_items = ind_stat["total_items"] if ind_stat else 0
            fully_dispensed = ind_stat["fully_dispensed"] if ind_stat else 0
            any_dispensed = ind_stat["any_dispensed"] if ind_stat else 0

            if total_items > 0 and fully_dispensed == total_items:
                new_indent_status = "dispensed"
            elif any_dispensed > 0:
                new_indent_status = "partially_issued"
            else:
                new_indent_status = "pending"

            cursor.execute(
                "UPDATE ward_indents SET status = ?, dispensed_by = ?, dispensed_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_indent_status, username, indent_id),
            )

        patient_name = ""
        if is_external and customer_name:
            patient_name = customer_name
        elif patient_id:
            cursor.execute("SELECT name, last_name, phone, age FROM patients WHERE patient_id = ?", (patient_id,))
            p_row = cursor.fetchone()
            if p_row:
                patient_name = f"{p_row['name']} {p_row['last_name'] or ''}".strip()
                if not customer_phone and p_row.get("phone"):
                    customer_phone = p_row["phone"]
                if not customer_age and p_row.get("age"):
                    customer_age = str(p_row["age"])

        ward_info = None
        bed_info = None
        if admission_id:
            cursor.execute(
                "SELECT ward, bed_no FROM bed_allocations WHERE admission_id = ? AND status = 'active' LIMIT 1",
                (admission_id,)
            )
            b_row = cursor.fetchone()
            if b_row:
                ward_info = b_row["ward"]
                bed_info = b_row["bed_no"]

        result = {
            "sale_ids": sale_ids,
            "invoice_id": invoice_id,
            "invoice_no": invoice_no if invoice_id else None,
            "total_amount": final_bill_total if invoice_id and not is_insurance else total_amount,
            "paid_amount": dispense_paid_amount,
            "due_amount": dispense_due_amount,
            "payment_status": dispense_payment_status,
            "stock_source": stock_source,
            "claim_id": claim_id,
            "is_insurance": is_insurance,
            "insurer_name": data.get("insurer_name"),
            "policy_no": data.get("policy_no") or data.get("membership_ref"),
            "preauth_no": data.get("preauth_no") or data.get("authorization_ref"),
            "shortfalls": shortfalls,
            "patient_id": patient_id,
            "patient_name": patient_name,
            "customer_name": customer_name if is_external else None,
            "customer_phone": customer_phone if is_external else None,
            "is_external": is_external,
            "billing_type": billing_type,
            "admission_id": admission_id,
            "payment_mode": payment_mode,
            "items": items,
            "attendant_name": data.get("attendant_name"),
            "ward": ward_info,
            "bed_no": bed_info,
            "dispensed_at": current_ist_datetime().strftime("%d-%b-%Y %I:%M %p"),
        }

        if idempotency_key:
            cursor.execute(
                "INSERT INTO pharmacy_dispense_transactions (idempotency_key, payload_hash, result_json) VALUES (?, ?, ?)",
                (idempotency_key, payload_hash, json.dumps(result)),
            )

        conn.commit()
        return result



def classify_legacy_batch(db, batch_id, stock_source, username):
    """One-time, logged reclassification of a pre-migration batch whose
    source was never recorded. Only valid while still UNVERIFIED -- once a
    batch has a real source it is immutable through ordinary editing."""
    if stock_source not in ("CASH", "INSURANCE"):
        raise ValueError("stock_source must be CASH or INSURANCE.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_inventory WHERE id = ?", (batch_id,))
        batch = cursor.fetchone()
        if not batch:
            raise ValueError("Batch not found.")
        if batch["stock_source"] != "UNVERIFIED":
            raise ValueError("This batch already has a verified source and cannot be reclassified here.")
        cursor.execute("UPDATE pharmacy_inventory SET stock_source = ? WHERE id = ?", (stock_source, batch_id))
        cursor.execute(
            "INSERT INTO stock_adjustments (pharmacy_inventory_id, delta_qty, reason, adjusted_by) VALUES (?, 0, ?, ?)",
            (batch_id, f"Legacy stock source classified as {stock_source}", username),
        )
        conn.commit()
        return True



def _reduce_undeducted_insurance_sale(cursor, sale, quantity):
    unit_price = float(sale["unit_price"] or 0)
    if unit_price <= 0 and int(sale["quantity"] or 0) > 0:
        unit_price = float(sale["amount"] or 0) / float(sale["quantity"])
    reduce_amount = round(unit_price * quantity, 2)
    new_qty = int(sale["quantity"]) - quantity
    cursor.execute(
        "UPDATE pharmacy_sales SET quantity = ?, amount = ? WHERE id = ?",
        (new_qty, round(max(0.0, float(sale["amount"] or 0) - reduce_amount), 2), sale["id"]),
    )
    if sale.get("invoice_id") and reduce_amount > 0:
        cursor.execute(
            """
            UPDATE invoices
            SET subtotal = GREATEST(0, COALESCE(subtotal, 0) - ?), total_amount = GREATEST(0, COALESCE(total_amount, 0) - ?),
                due_amount = GREATEST(0, COALESCE(due_amount, 0) - ?),
                payment_status = CASE WHEN GREATEST(0, COALESCE(total_amount, 0) - ?) <= COALESCE(paid_amount, 0) THEN 'paid' ELSE payment_status END
            WHERE id = ?
            """,
            (reduce_amount, reduce_amount, reduce_amount, reduce_amount, sale["invoice_id"]),
        )
        cursor.execute(
            "UPDATE insurance_claims SET claim_amount = GREATEST(0, COALESCE(claim_amount, 0) - ?) WHERE invoice_id = ?",
            (reduce_amount, sale["invoice_id"]),
        )


def create_pharmacy_return(db, data, username):
    """A return always lands back in the SAME source's quarantine, capped at
    issued-minus-already-returned. It never directly increases saleable
    stock -- release_pharmacy_return(db) is the only path for that, matching
    the same 'never silently trust a return' principle as goods receipts."""
    original_sale_id = data.get("original_sale_id")
    quantity = int(data.get("quantity") or 0)
    reason = str(data.get("reason") or "").strip()
    if not original_sale_id or quantity <= 0:
        raise ValueError("original_sale_id and a positive quantity are required.")
    if not reason:
        raise ValueError("A reason is required for a return.")

    idempotency_key = data.get("idempotency_key")
    payload_hash = _payload_hash(data)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if idempotency_key:
            cursor.execute(
                "SELECT id FROM pharmacy_returns WHERE idempotency_key = ?",
                (idempotency_key,),
            )
            existing = cursor.fetchone()
            if existing:
                return existing["id"]

        cursor.execute("SELECT * FROM pharmacy_sales WHERE id = ?", (original_sale_id,))
        sale = cursor.fetchone()
        if not sale:
            raise ValueError("Original sale not found.")
        cursor.execute(
            "SELECT COALESCE(SUM(quantity), 0) AS returned FROM pharmacy_returns WHERE original_sale_id = ? AND status != 'rejected'",
            (original_sale_id,),
        )
        already_returned = cursor.fetchone()["returned"] or 0
        remaining_returnable = int(sale["quantity"]) - int(already_returned)
        if quantity > remaining_returnable:
            raise ValueError(f"Cannot return more than {remaining_returnable} unit(s) for this issue.")

        if str(sale.get("payment_mode") or "").lower() == "insurance":
            cursor.execute(
                "SELECT 1 FROM stock_movements WHERE ref_table = 'pharmacy_sales' AND ref_id = ? AND movement_type = 'dispense' LIMIT 1",
                (original_sale_id,),
            )
            if not cursor.fetchone():
                # Insurance sale whose stock was never deducted (claim not settled yet):
                # the units are still counted in inventory, so the return only reduces
                # the bill and the claim -- it must not add stock a second time.
                _reduce_undeducted_insurance_sale(cursor, sale, quantity)
                conn.commit()
                return None

        # Find (or, if the original batch was fully consumed since, create) a
        # batch row for this medicine/source/batch to hold the quarantine.
        cursor.execute(
            "SELECT id FROM pharmacy_inventory WHERE medicine_name = ? AND stock_source = ? ORDER BY id ASC LIMIT 1",
            (sale["medicine_name"], sale["stock_source"]),
        )
        batch = cursor.fetchone()
        if not batch:
            cursor.execute(
                """
                INSERT INTO pharmacy_inventory (medicine_name, qty_available, qty_damaged, quantity, reorder_level, unit_price, stock_condition, stock_source)
                VALUES (?, 0, 0, 0, 10, 0, 'proper', ?)
                """,
                (sale["medicine_name"], sale["stock_source"]),
            )
            batch_id = cursor.lastrowid
        else:
            batch_id = batch["id"]

        cursor.execute(
            "UPDATE pharmacy_inventory SET qty_quarantine = qty_quarantine + ? WHERE id = ?",
            (quantity, batch_id),
        )
        record_stock_movement(cursor, batch_id, sale["stock_source"], "return_in", quantity, ref_table="pharmacy_sales", ref_id=original_sale_id, actor=username)
        cursor.execute(
            """
            INSERT INTO pharmacy_returns (
                original_sale_id, pharmacy_inventory_id, quantity, stock_source, reason, status, created_by, idempotency_key
            ) VALUES (?, ?, ?, ?, ?, 'quarantined', ?, ?)
            """,
            (original_sale_id, batch_id, quantity, sale["stock_source"], reason, username, idempotency_key),
        )
        return_id = cursor.lastrowid

        # Calculate refund amount based on returned units
        refund_unit_price = float(sale["unit_price"] or 0)
        if refund_unit_price <= 0 and int(sale["quantity"] or 0) > 0:
            refund_unit_price = float(sale["amount"] or 0) / float(sale["quantity"])
        refund_amount = round(refund_unit_price * quantity, 2)

        # Reflect refund on the linked invoice and payments
        if sale.get("invoice_id") and refund_amount > 0:
            inv_id = sale["invoice_id"]
            cursor.execute("SELECT * FROM invoices WHERE id = ?", (inv_id,))
            inv = cursor.fetchone()
            if inv:
                current_refunded = float(inv["refunded_amount"] or 0)
                current_paid = float(inv["paid_amount"] or 0)
                total_amt = float(inv["total_amount"] or 0)
                new_refunded = current_refunded + refund_amount
                new_paid = max(0.0, current_paid - refund_amount)
                new_status = "refunded" if (new_paid == 0 or new_refunded >= total_amt) else inv["payment_status"]

                cursor.execute(
                    """
                    UPDATE invoices
                    SET refunded_amount = ?, paid_amount = ?, payment_status = ?
                    WHERE id = ?
                    """,
                    (new_refunded, new_paid, new_status, inv_id),
                )

                pay_mode = str(sale.get("payment_mode") or "cash").lower()
                valid_modes = ('cash', 'card', 'upi', 'bank', 'razorpay', 'bank_transfer', 'net_banking', 'mixed_payment', 'cheque')
                if pay_mode not in valid_modes:
                    pay_mode = 'cash'
                cursor.execute(
                    """
                    INSERT INTO invoice_payments (invoice_id, amount, payment_mode, gateway_ref)
                    VALUES (?, ?, ?, ?)
                    """,
                    (inv_id, -refund_amount, pay_mode, f"REFUND: Return #{return_id}"),
                )

        conn.commit()
        return return_id



def release_pharmacy_return(db, return_id, username):
    """Authorized decision that quarantined returned stock is fit to resell
    -- moves quarantine to available, same batch/source only."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_returns WHERE id = ?", (return_id,))
        ret = cursor.fetchone()
        if not ret:
            raise ValueError("Return not found.")
        if ret["status"] != "quarantined":
            raise ValueError("This return has already been reviewed.")
        cursor.execute(
            "UPDATE pharmacy_inventory SET qty_quarantine = qty_quarantine - ?, qty_available = qty_available + ?, quantity = quantity + ? WHERE id = ?",
            (ret["quantity"], ret["quantity"], ret["quantity"], ret["pharmacy_inventory_id"]),
        )
        record_stock_movement(cursor, ret["pharmacy_inventory_id"], ret["stock_source"], "return_release", ret["quantity"], ref_table="pharmacy_returns", ref_id=return_id, actor=username)
        cursor.execute(
            "UPDATE pharmacy_returns SET status = 'released', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, return_id),
        )
        conn.commit()
        return True



def reject_pharmacy_return(db, return_id, username, reason=None):
    """Not fit to resell -- permanently written off (never silently
    deleted), same source, via the same audited stock_adjustments trail used
    for damage/expiry write-offs."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_returns WHERE id = ?", (return_id,))
        ret = cursor.fetchone()
        if not ret:
            raise ValueError("Return not found.")
        if ret["status"] != "quarantined":
            raise ValueError("This return has already been reviewed.")
        cursor.execute(
            "UPDATE pharmacy_inventory SET qty_quarantine = qty_quarantine - ? WHERE id = ?",
            (ret["quantity"], ret["pharmacy_inventory_id"]),
        )
        record_stock_movement(cursor, ret["pharmacy_inventory_id"], ret["stock_source"], "return_reject", -ret["quantity"], ref_table="pharmacy_returns", ref_id=return_id, actor=username)
        cursor.execute(
            "INSERT INTO stock_adjustments (pharmacy_inventory_id, delta_qty, reason, adjusted_by) VALUES (?, 0, ?, ?)",
            (ret["pharmacy_inventory_id"], reason or "Return rejected -- not fit for resale", username),
        )
        cursor.execute(
            "UPDATE pharmacy_returns SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, return_id),
        )
        conn.commit()
        return True



def list_pharmacy_returns(db, status=None, admission_id=None, patient_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT r.*, pi.medicine_name, pi.batch_no, ps.patient_id, ps.admission_id
            FROM pharmacy_returns r
            JOIN pharmacy_inventory pi ON pi.id = r.pharmacy_inventory_id
            JOIN pharmacy_sales ps ON ps.id = r.original_sale_id
            WHERE 1=1
        """
        params = []
        if status:
            query += " AND r.status = ?"
            params.append(status)
        if admission_id:
            query += " AND ps.admission_id = ?"
            params.append(admission_id)
        if patient_id:
            query += " AND ps.patient_id = ?"
            params.append(patient_id)
        query += " ORDER BY r.created_at DESC"
        cursor.execute(query, tuple(params))
        return cursor.fetchall()



def list_stock_movements(db, stock_source=None, medicine_name=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if stock_source:
            clauses.append("sm.stock_source = ?")
            params.append(stock_source)
        if medicine_name:
            clauses.append("pi.medicine_name = ?")
            params.append(medicine_name)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT sm.*, pi.medicine_name, pi.batch_no FROM stock_movements sm
            JOIN pharmacy_inventory pi ON pi.id = sm.pharmacy_inventory_id
            {where_clause}
            ORDER BY sm.created_at DESC
            LIMIT 500
            """,
            tuple(params),
        )
        return cursor.fetchall()



def create_pharmacy_sale(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        amount = float(data["quantity"]) * float(data["unit_price"])
        cursor.execute(
            """
            INSERT INTO pharmacy_sales (
                invoice_id, patient_id, prescription_ref, medicine_name, quantity, unit_price, amount, payment_mode
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("invoice_id"),
                data.get("patient_id"),
                data.get("prescription_ref"),
                data["medicine_name"],
                data["quantity"],
                data["unit_price"],
                amount,
                data.get("payment_mode", "cash"),
            ),
        )
        sale_id = cursor.lastrowid
        cursor.execute(
            """
            UPDATE pharmacy_inventory
            SET quantity = CASE WHEN quantity >= ? THEN quantity - ? ELSE 0 END
            WHERE medicine_name = ?
            """,
            (data["quantity"], data["quantity"], data["medicine_name"]),
        )
        conn.commit()
        return sale_id



def list_pharmacy_sales(db, medicine_name=None, invoice_id=None, patient_id=None, admission_id=None, billing_type=None,
                         from_date=None, to_date=None, q=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if medicine_name:
            clauses.append("ps.medicine_name = ?")
            params.append(medicine_name)
        if invoice_id:
            raw = str(invoice_id).strip()
            resolved_ids = []
            cursor.execute("SELECT id FROM invoices WHERE invoice_no = ? OR invoice_no ILIKE ?", (raw, f"%{raw}%"))
            for inv_row in cursor.fetchall():
                resolved_ids.append(inv_row["id"])
            if raw.isdigit() and len(raw) < 10:
                resolved_ids.append(int(raw))
            if not resolved_ids:
                resolved_ids = [-1]
            placeholders = ", ".join("?" for _ in resolved_ids)
            clauses.append(f"ps.invoice_id IN ({placeholders})")
            params.extend(resolved_ids)
        if patient_id:
            # Staff often key in just the trailing digits printed on a
            # receipt/wristband rather than the full "PAT-YYYYMMDD-NNNN"
            # UHID, so match on the full id or as a suffix.
            lookup = str(patient_id).strip()
            clauses.append("(ps.patient_id = ? OR ps.patient_id LIKE ?)")
            params.extend([lookup, f"%{lookup}"])
        if admission_id:
            # Scoped to one admission so a readmitted patient's earlier stay
            # never shows up mixed into the current one's issued list.
            clauses.append("ps.admission_id = ?")
            params.append(admission_id)
        if billing_type:
            clauses.append("ps.billing_type = ?")
            params.append(billing_type)
        if from_date:
            clauses.append("ps.sold_at >= DATE(?)")
            params.append(from_date)
        if to_date:
            clauses.append("ps.sold_at < DATE(?) + INTERVAL '1 day'")
            params.append(to_date)
        if q:
            clauses.append("(ps.patient_id ILIKE ? OR ps.medicine_name ILIKE ? OR inv.invoice_no ILIKE ? OR inv.referral_source ILIKE ? OR inv.patient_mobile ILIKE ?)")
            like = f"%{str(q).strip()}%"
            params.extend([like, like, like, like, like])
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT ps.*,
                   COALESCE(p.name, inv.referral_source) AS customer_name,
                   COALESCE(p.phone, inv.patient_mobile) AS customer_mobile,
                   inv.invoice_no,
                   inv.payment_status,
                   inv.due_amount,
                   COALESCE((
                       SELECT SUM(pr.quantity) FROM pharmacy_returns pr
                       WHERE pr.original_sale_id = ps.id AND pr.status != 'rejected'
                   ), 0) AS returned_qty
            FROM pharmacy_sales ps
            LEFT JOIN invoices inv ON inv.id = ps.invoice_id
            LEFT JOIN patients p ON p.patient_id = ps.patient_id
            {where_clause} ORDER BY ps.sold_at DESC
            """,
            tuple(params),
        )
        return cursor.fetchall()



def _supersede_older_rx_copies(cursor, prescription_id):
    """Earlier pending e-Rx saved for the same consultation are replaced by this one."""
    cursor.execute(
        """
        UPDATE prescriptions SET dispense_status = 'superseded'
        WHERE appointment_id = (SELECT appointment_id FROM prescriptions WHERE id = ?)
          AND appointment_id IS NOT NULL AND id < ? AND dispense_status = 'sent_to_pharmacy'
        """,
        (prescription_id, prescription_id),
    )


def dismiss_pharmacy_prescription(db, prescription_id):
    """Pharmacy removes an e-Rx it cannot (or will not) supply from its incoming list."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE prescriptions SET dispense_status = 'dismissed' WHERE id = ? AND dispense_status IN ('sent_to_pharmacy', 'partially_dispensed')",
            (prescription_id,),
        )
        if cursor.rowcount == 0:
            raise ValueError("This e-prescription is no longer pending at the pharmacy.")
        _supersede_older_rx_copies(cursor, prescription_id)
        conn.commit()


def list_pharmacy_incoming_prescriptions(db, status=None):
    """Structured (typed) prescriptions explicitly sent to pharmacy.
    status: 'sent_to_pharmacy' (pending), 'partially_dispensed', 'dispensed'
    (done), a comma-separated combination, or None (all non-'not_sent'
    prescriptions, i.e. everything pharmacy has ever seen).
    """
    statuses = [s.strip() for s in str(status).split(",") if s.strip()] if status else \
        ["sent_to_pharmacy", "partially_dispensed", "dispensed"]
    placeholders = ",".join(["?"] * len(statuses))
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT p.id, p.appointment_id, p.patient_id, p.doctor_name, p.department, p.diagnosis, p.advice,
                   p.dispense_status, p.created_at,
                   pt.name AS patient_name, pt.last_name AS patient_last_name, pt.age AS patient_age,
                   pt.gender AS patient_gender, pt.phone AS patient_phone
            FROM prescriptions p
            LEFT JOIN patients pt ON pt.patient_id = p.patient_id
            WHERE p.dispense_status IN ({placeholders})
            ORDER BY p.created_at DESC
            """,
            statuses,
        )
        prescriptions = [dict(row) for row in cursor.fetchall()]
        if prescriptions:
            presc_ids = [p["id"] for p in prescriptions]
            placeholders = ",".join(["?"] * len(presc_ids))
            cursor.execute(
                f"""
                SELECT id, prescription_id, medicine_name, dosage, frequency, duration, instructions
                FROM prescription_medicines
                WHERE prescription_id IN ({placeholders})
                ORDER BY id ASC
                """,
                presc_ids,
            )
            from collections import defaultdict
            meds_by_presc = defaultdict(list)
            for row in cursor.fetchall():
                meds_by_presc[row["prescription_id"]].append(dict(row))
            for p in prescriptions:
                p["medicines"] = meds_by_presc.get(p["id"], [])
        return prescriptions



def get_pharmacy_summary(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        # Low/out-of-stock are medicine-level facts (total across every batch
        # vs. the medicine's real configured reorder level), not per-batch --
        # a medicine split across several batches, or a batch stuck with a
        # placeholder reorder_level, must not be mis-flagged either way.
        cursor.execute("""
            SELECT COUNT(*) AS value FROM (
                SELECT TRIM(pi.medicine_name) AS med_name, SUM(pi.qty_available) AS total_qty,
                       COALESCE(MAX(m.reorder_level), MAX(pi.reorder_level), 10) AS effective_reorder_level
                FROM pharmacy_inventory pi
                LEFT JOIN medicines m ON m.id = pi.medicine_id
                GROUP BY TRIM(pi.medicine_name)
                HAVING SUM(pi.qty_available) <= COALESCE(MAX(m.reorder_level), MAX(pi.reorder_level), 10)
            ) t
        """)
        low_stock = cursor.fetchone()["value"]
        cursor.execute("""
            SELECT COUNT(*) AS value FROM (
                SELECT medicine_name FROM pharmacy_inventory GROUP BY medicine_name HAVING SUM(qty_available) = 0
            ) t
        """)
        out_of_stock = cursor.fetchone()["value"]
        cursor.execute("SELECT COUNT(*) AS value FROM pharmacy_inventory WHERE qty_damaged > 0")
        damaged = cursor.fetchone()["value"]
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales WHERE DATE(sold_at) = CURRENT_DATE")
        sales_today = float(cursor.fetchone()["value"] or 0)
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales WHERE DATE(sold_at) = CURRENT_DATE - INTERVAL '1 day'")
        sales_yesterday = float(cursor.fetchone()["value"] or 0)
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS value FROM pharmacy_sales")
        sales_total = float(cursor.fetchone()["value"] or 0)

        # OPD Sales today & count
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS val, COUNT(*) AS cnt FROM pharmacy_sales WHERE DATE(sold_at) = CURRENT_DATE AND (billing_type IN ('OPD_IMMEDIATE', 'CASH_OPD') OR billing_type IS NULL)")
        opd_row = cursor.fetchone()
        opd_sales_today = float(opd_row["val"] or 0)
        opd_prescriptions_count = int(opd_row["cnt"] or 0)

        # IPD Consumption today & count
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS val, COUNT(*) AS cnt FROM pharmacy_sales WHERE DATE(sold_at) = CURRENT_DATE AND billing_type = 'IPD_RUNNING'")
        ipd_row = cursor.fetchone()
        ipd_consumption_today = float(ipd_row["val"] or 0)
        ipd_indents_count = int(ipd_row["cnt"] or 0)

        # Emergency Sales today & count
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS val, COUNT(*) AS cnt FROM pharmacy_sales WHERE DATE(sold_at) = CURRENT_DATE AND (billing_type IN ('EMERGENCY', 'EMERGENCY_IMMEDIATE', 'EMERGENCY_ACCOUNT') OR UPPER(COALESCE(payment_mode, '')) = 'EMERGENCY')")
        em_row = cursor.fetchone()
        emergency_sales_today = float(em_row["val"] or 0)
        emergency_count = int(em_row["cnt"] or 0)

        # Net every revenue figure above against returns -- a return refunds
        # the invoice the moment it's created (see create_pharmacy_return),
        # regardless of whether it's later released or rejected, so it is
        # real money out and must reduce revenue here too, not just the
        # discharge-billing net calc. Scoped by the RETURN's own date (cash
        # basis), not the original sale's date, and split into the same
        # buckets the gross figures above use.
        def _returns_refunded(extra_where=""):
            cursor.execute(f"""
                SELECT COALESCE(SUM(pr.quantity * ps.unit_price), 0) AS val
                FROM pharmacy_returns pr JOIN pharmacy_sales ps ON ps.id = pr.original_sale_id
                WHERE 1=1 {extra_where}
            """)
            return float(cursor.fetchone()["val"] or 0)

        sales_today = max(0.0, sales_today - _returns_refunded("AND DATE(pr.created_at) = CURRENT_DATE"))
        sales_yesterday = max(0.0, sales_yesterday - _returns_refunded("AND DATE(pr.created_at) = CURRENT_DATE - INTERVAL '1 day'"))
        sales_total = max(0.0, sales_total - _returns_refunded())
        opd_sales_today = max(0.0, opd_sales_today - _returns_refunded(
            "AND DATE(pr.created_at) = CURRENT_DATE AND (ps.billing_type IN ('OPD_IMMEDIATE', 'CASH_OPD') OR ps.billing_type IS NULL)"))
        ipd_consumption_today = max(0.0, ipd_consumption_today - _returns_refunded(
            "AND DATE(pr.created_at) = CURRENT_DATE AND ps.billing_type = 'IPD_RUNNING'"))
        emergency_sales_today = max(0.0, emergency_sales_today - _returns_refunded(
            "AND DATE(pr.created_at) = CURRENT_DATE AND (ps.billing_type IN ('EMERGENCY', 'EMERGENCY_IMMEDIATE', 'EMERGENCY_ACCOUNT') OR UPPER(COALESCE(ps.payment_mode, '')) = 'EMERGENCY')"))

        # Cash Stock Value & item count
        cursor.execute("SELECT COALESCE(SUM(qty_available * unit_price), 0) AS val, COALESCE(SUM(qty_available), 0) AS items FROM pharmacy_inventory WHERE stock_source = 'CASH'")
        cash_row = cursor.fetchone()
        cash_stock_value = float(cash_row["val"] or 0)
        cash_stock_items = int(cash_row["items"] or 0)

        # Insurance Stock Value & item count
        cursor.execute("SELECT COALESCE(SUM(qty_available * unit_price), 0) AS val, COALESCE(SUM(qty_available), 0) AS items FROM pharmacy_inventory WHERE stock_source = 'INSURANCE'")
        ins_row = cursor.fetchone()
        insurance_stock_value = float(ins_row["val"] or 0)
        insurance_stock_items = int(ins_row["items"] or 0)

        total_stock_value = cash_stock_value + insurance_stock_value
        total_stock_items = cash_stock_items + insurance_stock_items

        # Pending Ward Indents (IPD)
        cursor.execute("SELECT COUNT(*) AS value FROM ward_indents WHERE status = 'pending'")
        pending_ward_indents = int(cursor.fetchone()["value"] or 0)

        # Partially Issued Ward Indents
        cursor.execute("SELECT COUNT(*) AS value FROM ward_indents WHERE status = 'partially_issued'")
        partially_issued_indents = int(cursor.fetchone()["value"] or 0)

        # Supplier Outstanding Balance
        cursor.execute("""
            SELECT COALESCE(SUM(pp.total_cost), 0) AS total_purchased
            FROM pharmacy_purchases pp
            WHERE pp.status != 'cancelled'
        """)
        total_purchased = float(cursor.fetchone()["total_purchased"] or 0)
        supplier_outstanding = total_purchased

        # Returns today
        cursor.execute("SELECT COUNT(*) AS val FROM pharmacy_returns WHERE DATE(created_at) = CURRENT_DATE")
        returns_today = int(cursor.fetchone()["val"] or 0)

        # GRNs today
        cursor.execute("SELECT COUNT(*) AS val FROM goods_receipts WHERE received_date = CURRENT_DATE OR DATE(created_at) = CURRENT_DATE")
        grns_today = int(cursor.fetchone()["val"] or 0)

        # Adjustments today
        cursor.execute("SELECT COUNT(*) AS val FROM stock_adjustments WHERE DATE(created_at) = CURRENT_DATE")
        adjustments_today = int(cursor.fetchone()["val"] or 0)

        # Pending purchase requests
        cursor.execute("SELECT COUNT(*) AS val FROM purchase_requests WHERE status = 'pending'")
        pending_pr_count = int(cursor.fetchone()["val"] or 0)

        # Unverified GRNs
        cursor.execute("SELECT COUNT(*) AS val FROM goods_receipts WHERE status = 'draft'")
        unverified_grn_count = int(cursor.fetchone()["val"] or 0)

        # Supplier payments due
        cursor.execute("SELECT COUNT(*) AS val FROM pharmacy_purchases WHERE status = 'pending'")
        supplier_payments_due = int(cursor.fetchone()["val"] or 0)

        # Expiry counts & details
        cursor.execute("SELECT COUNT(*) AS val, COALESCE(SUM(qty_available), 0) AS qty, MIN(expiry_date) AS min_date FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE AND qty_available > 0")
        exp_row = cursor.fetchone()
        expired_count = int(exp_row["val"] or 0)
        expired_qty = int(exp_row["qty"] or 0)
        expired_date = str(exp_row["min_date"] or "")

        cursor.execute("SELECT COUNT(*) AS val, COALESCE(SUM(qty_available), 0) AS qty, MIN(expiry_date) AS min_date FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE AND expiry_date < CURRENT_DATE + INTERVAL '30 days' AND qty_available > 0")
        exp1_row = cursor.fetchone()
        expiring_1m = int(exp1_row["val"] or 0)
        expiring_1m_qty = int(exp1_row["qty"] or 0)
        expiring_1m_date = str(exp1_row["min_date"] or "")

        cursor.execute("SELECT COUNT(*) AS val, COALESCE(SUM(qty_available), 0) AS qty, MIN(expiry_date) AS min_date FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE + INTERVAL '30 days' AND expiry_date < CURRENT_DATE + INTERVAL '90 days' AND qty_available > 0")
        exp13_row = cursor.fetchone()
        expiring_1_3m = int(exp13_row["val"] or 0)
        expiring_1_3m_qty = int(exp13_row["qty"] or 0)
        expiring_1_3m_date = str(exp13_row["min_date"] or "")

        cursor.execute("SELECT COUNT(*) AS val, COALESCE(SUM(qty_available), 0) AS qty, MIN(expiry_date) AS min_date FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE + INTERVAL '90 days' AND expiry_date < CURRENT_DATE + INTERVAL '180 days' AND qty_available > 0")
        exp36_row = cursor.fetchone()
        expiring_3_6m = int(exp36_row["val"] or 0)
        expiring_3_6m_qty = int(exp36_row["qty"] or 0)
        expiring_3_6m_date = str(exp36_row["min_date"] or "")

        cursor.execute("SELECT medicine_name FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE AND qty_available > 0 LIMIT 3")
        expired_items = [r["medicine_name"] for r in cursor.fetchall()]

        cursor.execute("SELECT medicine_name FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE AND expiry_date < CURRENT_DATE + INTERVAL '30 days' AND qty_available > 0 LIMIT 3")
        exp1m_items = [r["medicine_name"] for r in cursor.fetchall()]

        cursor.execute("SELECT medicine_name FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE + INTERVAL '30 days' AND expiry_date < CURRENT_DATE + INTERVAL '90 days' AND qty_available > 0 LIMIT 3")
        exp13m_items = [r["medicine_name"] for r in cursor.fetchall()]

        cursor.execute("SELECT medicine_name FROM pharmacy_inventory WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE + INTERVAL '90 days' AND expiry_date < CURRENT_DATE + INTERVAL '180 days' AND qty_available > 0 LIMIT 3")
        exp36m_items = [r["medicine_name"] for r in cursor.fetchall()]

        expiry_breakdown = {
            "expired": {"count": expired_count, "qty": expired_qty, "nearest_date": expired_date, "items": expired_items},
            "under_1m": {"count": expiring_1m, "qty": expiring_1m_qty, "nearest_date": expiring_1m_date, "items": exp1m_items},
            "from_1_to_3m": {"count": expiring_1_3m, "qty": expiring_1_3m_qty, "nearest_date": expiring_1_3m_date, "items": exp13m_items},
            "from_3_to_6m": {"count": expiring_3_6m, "qty": expiring_3_6m_qty, "nearest_date": expiring_3_6m_date, "items": exp36m_items},
        }

        # Low stock items table (up to 10 items) -- aggregated per medicine
        # against the real medicine-master reorder level, same rule as the
        # low_stock_count above.
        cursor.execute("""
            SELECT pi.medicine_name, COALESCE(MAX(m.generic_name), MAX(pi.item_category), '-') AS generic_name,
                   SUM(pi.qty_available) AS qty_available,
                   COALESCE(MAX(m.reorder_level), MAX(pi.reorder_level), 10) AS reorder_level
            FROM pharmacy_inventory pi
            LEFT JOIN medicines m ON m.id = pi.medicine_id
            GROUP BY pi.medicine_name
            HAVING SUM(pi.qty_available) <= COALESCE(MAX(m.reorder_level), MAX(pi.reorder_level), 10)
            ORDER BY SUM(pi.qty_available) ASC
            LIMIT 10
        """)
        low_stock_rows = cursor.fetchall()
        low_stock_items = []
        for r in low_stock_rows:
            q_avail = int(r["qty_available"] or 0)
            r_lvl = int(r["reorder_level"] or 10)
            low_stock_items.append({
                "medicine_name": r["medicine_name"],
                "generic_name": r["generic_name"] or "-",
                "current_stock": q_avail,
                "reorder_level": r_lvl,
                "suggested_reorder": max(r_lvl * 2 - q_avail, 10),
                "status": "Out of Stock" if q_avail == 0 else "Low Stock",
            })

        # Top 10 Medicines This Month with OP/IP/Emergency split
        cursor.execute("""
            SELECT medicine_name,
                   COALESCE(SUM(quantity), 0) AS total_qty,
                   COALESCE(SUM(amount), 0) AS total_amount,
                   COALESCE(SUM(CASE WHEN billing_type = 'IPD_RUNNING' THEN quantity ELSE 0 END), 0) AS ip_qty,
                   COALESCE(SUM(CASE WHEN billing_type IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') THEN quantity ELSE 0 END), 0) AS emergency_qty,
                   COALESCE(SUM(CASE WHEN billing_type NOT IN ('IPD_RUNNING', 'EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') OR billing_type IS NULL THEN quantity ELSE 0 END), 0) AS op_qty
            FROM pharmacy_sales
            WHERE sold_at >= DATE_TRUNC('month', CURRENT_DATE)
            GROUP BY medicine_name
            ORDER BY total_qty DESC
            LIMIT 10
        """)
        top_medicines = [dict(row) for row in cursor.fetchall()]

        # Recent Pharmacy Transactions (Real operations, NO prescription queue!)
        # Daily sales trend, last 30 days, split by OP/IPD/Emergency -- feeds the
        # Pharmacy Overview trend chart. Real per-day aggregates, never fabricated.
        cursor.execute("""
            SELECT DATE(sold_at) AS day,
                   COALESCE(SUM(CASE WHEN billing_type NOT IN ('IPD_RUNNING', 'EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') OR billing_type IS NULL THEN amount ELSE 0 END), 0) AS op_amount,
                   COALESCE(SUM(CASE WHEN billing_type = 'IPD_RUNNING' THEN amount ELSE 0 END), 0) AS ip_amount,
                   COALESCE(SUM(CASE WHEN billing_type IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') THEN amount ELSE 0 END), 0) AS er_amount
            FROM pharmacy_sales
            WHERE sold_at >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY DATE(sold_at)
            ORDER BY day ASC
        """)
        sales_trend = [
            {
                "date": str(r["day"]),
                "op_amount": float(r["op_amount"] or 0),
                "ip_amount": float(r["ip_amount"] or 0),
                "er_amount": float(r["er_amount"] or 0),
            }
            for r in cursor.fetchall()
        ]

        cursor.execute("""
            SELECT ps.id, ps.patient_id, TRIM(p.name || ' ' || COALESCE(p.last_name, '')) AS patient_name, ps.medicine_name, ps.quantity,
                   ps.unit_price, ps.amount, ps.billing_type,
                   COALESCE(
                       ps.payment_mode,
                       i.payment_mode,
                       (SELECT ip.payment_mode FROM invoice_payments ip WHERE ip.invoice_id = ps.invoice_id AND ip.amount > 0 ORDER BY ip.id DESC LIMIT 1)
                   ) AS payment_mode,
                   ps.sold_at,
                   ps.invoice_id, ps.admission_id,
                   COALESCE(
                       (SELECT pi.purchase_price 
                        FROM pharmacy_inventory pi 
                        WHERE LOWER(TRIM(pi.medicine_name)) = LOWER(TRIM(ps.medicine_name)) 
                          AND pi.purchase_price > 0 
                        ORDER BY pi.id DESC LIMIT 1),
                       (SELECT gri.purchase_price 
                        FROM goods_receipt_items gri 
                        JOIN goods_receipts gr ON gr.id = gri.grn_id 
                        WHERE LOWER(TRIM(gri.medicine_name)) = LOWER(TRIM(ps.medicine_name)) 
                          AND gr.status = 'verified' AND gri.purchase_price > 0 
                        ORDER BY gr.received_date DESC NULLS LAST, gri.id DESC LIMIT 1),
                       0.0
                   ) AS cost_price
            FROM pharmacy_sales ps
            LEFT JOIN patients p ON p.patient_id = ps.patient_id
            LEFT JOIN invoices i ON i.id = ps.invoice_id
            ORDER BY ps.sold_at DESC
            LIMIT 15
        """)
        recent_sales_rows = cursor.fetchall()
        recent_transactions = []
        for r in recent_sales_rows:
            b_type = r["billing_type"] or "OPD_IMMEDIATE"
            if b_type == "IPD_RUNNING":
                tx_type = "IPD Issue"
                pay_status = "Posted to Admission"
            elif b_type in ("EMERGENCY", "EMERGENCY_ACCOUNT", "EMERGENCY_IMMEDIATE"):
                tx_type = "Emergency Dispense"
                pay_status = "Emergency Account" if not r["invoice_id"] else "Paid"
            else:
                tx_type = "OP Dispense"
                pay_status = "Paid"

            ref = f"SALE-{r['id']}" if not r["invoice_id"] else f"INV-{r['invoice_id']}"
            sold_time_str = str(r["sold_at"])[:16] if r["sold_at"] else ""
            qty = float(r["quantity"] or 1)
            unit_sale = float(r["unit_price"] or 0)
            sale_amount = float(r["amount"] if r["amount"] is not None else (qty * unit_sale))
            unit_cost = float(r["cost_price"] or 0)
            total_cost = round(qty * unit_cost, 2)
            profit = round(sale_amount - total_cost, 2)
            margin_pct = round((profit / sale_amount * 100), 1) if sale_amount > 0 else 0.0

            recent_transactions.append({
                "reference": ref,
                "patient_name": r["patient_name"] or (r["patient_id"] or "Walk-in"),
                "uhid": r["patient_id"] or (f"IP-{r['admission_id']}" if r["admission_id"] else "-"),
                "type": tx_type,
                "medicine_name": r["medicine_name"],
                "medicine_count": 1,
                "quantity": qty,
                "cost_price": unit_cost,
                "total_cost": total_cost,
                "sale_price": unit_sale,
                "amount": sale_amount,
                "profit": profit,
                "profit_margin_pct": margin_pct,
                "payment_status": pay_status,
                "payment_mode": r["payment_mode"],
                "user": "Pharmacist",
                "date_time": sold_time_str,
                "status": "Completed",
            })

    return {
        "low_stock_count": low_stock,
        "out_of_stock_count": out_of_stock,
        "damaged_stock_count": damaged,
        "sales_today": sales_today,
        "sales_yesterday": sales_yesterday,
        "sales_total": sales_total,
        "opd_sales_today": opd_sales_today,
        "opd_prescriptions_count": opd_prescriptions_count,
        "ipd_consumption_today": ipd_consumption_today,
        "ipd_indents_count": ipd_indents_count,
        "emergency_sales_today": emergency_sales_today,
        "emergency_count": emergency_count,
        "cash_stock_value": cash_stock_value,
        "cash_stock_items": cash_stock_items,
        "insurance_stock_value": insurance_stock_value,
        "insurance_stock_items": insurance_stock_items,
        "total_stock_value": total_stock_value,
        "total_stock_items": total_stock_items,
        "pending_ward_indents": pending_ward_indents,
        "partially_issued_indents": partially_issued_indents,
        "supplier_outstanding": supplier_outstanding,
        "expired_count": expired_count,
        "expiring_1m": expiring_1m,
        "expiring_1_3m": expiring_1_3m,
        "expiring_3_6m": expiring_3_6m,
        "expiry_breakdown": expiry_breakdown,
        "low_stock_items": low_stock_items,
        "top_medicines": top_medicines,
        "recent_transactions": recent_transactions,
        "sales_trend": sales_trend,
        "today_activity": {
            "op_dispensations": opd_prescriptions_count,
            "ipd_issues": ipd_indents_count,
            "emergency_issues": emergency_count,
            "returns": returns_today,
            "grns_received": grns_today,
            "stock_adjustments": adjustments_today,
        },
        "needs_attention": {
            "low_stock": low_stock,
            "near_expiry": expiring_1m + expiring_1_3m,
            "pending_ward_indents": pending_ward_indents,
            "partially_issued_indents": partially_issued_indents,
            "pending_purchase_requests": pending_pr_count,
            "unverified_grns": unverified_grn_count,
            "supplier_payments_due": supplier_payments_due,
        },
    }


# ==================== Enterprise Procurement (PR -> PO -> Supplier Ledger) ====================


def create_purchase_request(db, data, username):
    pr_no = f"PR-{datetime.now().strftime('%Y%m%d%H%M%S')}-{datetime.now().microsecond:06d}"
    pref_supplier = data.get("preferred_supplier_id") or data.get("supplier_id")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO purchase_requests (pr_no, requested_by, status, priority, notes, preferred_supplier_id, supplier_id)
            VALUES (?, ?, 'pending', ?, ?, ?, ?)
            """,
            (pr_no, username, data.get("priority", "normal"), data.get("notes"), pref_supplier, pref_supplier),
        )
        pr_id = cursor.lastrowid
        for item in data.get("items", []):
            qty = item.get("required_qty") or item.get("quantity") or 1
            cursor.execute(
                """
                INSERT INTO purchase_request_items (
                    pr_id, medicine_id, medicine_name, current_stock, min_level, required_qty, estimated_unit_cost, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pr_id,
                    item.get("medicine_id"),
                    item["medicine_name"],
                    int(item.get("current_stock", 0) or 0),
                    int(item.get("min_level", 10) or 10),
                    int(qty),
                    float(item.get("estimated_unit_cost", 0) or 0),
                    item.get("notes"),
                ),
            )
        conn.commit()
        return pr_id, pr_no



def list_purchase_requests(db, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if status:
            cursor.execute(
                """
                SELECT pr.*, s.supplier_name
                FROM purchase_requests pr
                LEFT JOIN pharmacy_suppliers s ON COALESCE(pr.preferred_supplier_id, pr.supplier_id) = s.id
                WHERE pr.status = ?
                ORDER BY pr.created_at DESC
                """,
                (status,),
            )
        else:
            cursor.execute(
                """
                SELECT pr.*, s.supplier_name
                FROM purchase_requests pr
                LEFT JOIN pharmacy_suppliers s ON COALESCE(pr.preferred_supplier_id, pr.supplier_id) = s.id
                ORDER BY pr.created_at DESC
                """
            )
        requests = cursor.fetchall()
        result = []
        for pr in requests:
            cursor.execute("SELECT * FROM purchase_request_items WHERE pr_id = ?", (pr["id"],))
            pr_dict = dict(pr)
            pr_dict["items"] = [dict(r) for r in cursor.fetchall()]
            result.append(pr_dict)
        return result



def approve_purchase_request(db, pr_id, username, supplier_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM purchase_requests WHERE id = ?", (pr_id,))
        pr = cursor.fetchone()
        if not pr:
            raise ValueError("Purchase Request not found.")
        if pr["status"] == "approved":
            raise ValueError("Purchase Request is already approved.")

        target_supplier_id = supplier_id or pr.get("preferred_supplier_id") or pr.get("supplier_id")

        cursor.execute("SELECT * FROM purchase_request_items WHERE pr_id = ?", (pr_id,))
        items = cursor.fetchall()
        created_po_ids = []
        for item in items:
            unit_cost = float(item["estimated_unit_cost"] or 0)
            qty = int(item["required_qty"] or 1)
            cursor.execute(
                """
                INSERT INTO pharmacy_purchases (
                    supplier_id, medicine_name, quantity, unit_cost, total_cost, status, stock_applied, pr_id
                ) VALUES (?, ?, ?, ?, ?, 'ordered', 0, ?)
                """,
                (target_supplier_id, item["medicine_name"], qty, unit_cost, qty * unit_cost, pr_id),
            )
            created_po_ids.append(cursor.lastrowid)

        cursor.execute(
            "UPDATE purchase_requests SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, pr_id),
        )
        conn.commit()
        return created_po_ids



def reject_purchase_request(db, pr_id, username, reason=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM purchase_requests WHERE id = ?", (pr_id,))
        pr = cursor.fetchone()
        if not pr:
            raise ValueError("Purchase Request not found.")
        notes = pr.get("notes") or ""
        if reason:
            notes = f"{notes} | Rejection reason: {reason}".strip(" |")
        cursor.execute(
            "UPDATE purchase_requests SET status = 'rejected', notes = ? WHERE id = ?",
            (notes, pr_id),
        )
        conn.commit()
        return True



def update_purchase_request_status(db, pr_id, status, username=None, reason=None):
    status_lower = str(status).strip().lower()
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM purchase_requests WHERE id = ?", (pr_id,))
        pr = cursor.fetchone()
        if not pr:
            raise ValueError("Purchase Request not found.")
        notes = pr.get("notes") or ""
        if reason:
            notes = f"{notes} | Status changed to {status_lower} by {username or 'admin'}: {reason}".strip(" |")
        cursor.execute(
            "UPDATE purchase_requests SET status = ?, notes = ? WHERE id = ?",
            (status_lower, notes, pr_id),
        )
        conn.commit()
        return True



# Payments counted against a supplier: money actually paid out. A 'pending' row is a payable that
# has not been paid yet, so it is not counted.
_SUPPLIER_PAID_STATUSES = ("paid", "partial")


def get_supplier_ledger(db, supplier_id):
    """Supplier financial ledger.

    Inward purchases = what the supplier has invoiced for goods received: every verified GRN
    line, valued the way the GRN screen totals a supplier invoice (billed quantity = received
    minus free, at the purchase price, less discount, plus GST). Purchase orders are only
    commitments until goods arrive, so they are listed but not counted as owed.

    Payments = vendor_payments rows linked to this supplier (recorded here), plus older rows
    typed in Accounts under the exact same vendor name.
    """
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pharmacy_suppliers WHERE id = ?", (supplier_id,))
        supplier = cursor.fetchone()
        if not supplier:
            raise ValueError("Supplier not found.")

        cursor.execute(
            """
            SELECT id, medicine_name, quantity, unit_cost, total_cost, status, created_at, expected_date
            FROM pharmacy_purchases
            WHERE supplier_id = ?
            ORDER BY created_at DESC
            """,
            (supplier_id,),
        )
        purchases = [dict(r) for r in cursor.fetchall()]

        cursor.execute(
            """
            SELECT gr.id AS grn_id, gr.grn_no, gr.supplier_invoice_no, gr.received_date, gr.created_at,
                   i.medicine_name, i.qty_received, i.free_qty, i.qty_accepted, i.purchase_price,
                   COALESCE(i.discount_pct, 0) AS discount_pct, COALESCE(i.gst_rate, 0) AS gst_rate
            FROM goods_receipts gr
            JOIN goods_receipt_items i ON i.grn_id = gr.id
            WHERE gr.status = 'verified'
              AND COALESCE(gr.supplier_id, (SELECT pp.supplier_id FROM pharmacy_purchases pp WHERE pp.id = gr.purchase_order_id)) = ?
            ORDER BY COALESCE(gr.received_date, DATE(gr.created_at)) DESC, gr.id DESC, i.id
            """,
            (supplier_id,),
        )
        deliveries = []
        total_purchases = 0.0
        for row in cursor.fetchall():
            r = dict(row)
            billed = max(0, int(r["qty_received"] or 0) - int(r["free_qty"] or 0))
            taxable = billed * float(r["purchase_price"] or 0) * (1 - float(r["discount_pct"] or 0) / 100.0)
            line_total = round(taxable * (1 + float(r["gst_rate"] or 0) / 100.0), 2)
            total_purchases += line_total
            deliveries.append({
                "grn_id": r["grn_id"], "grn_no": r["grn_no"], "invoice_no": r["supplier_invoice_no"],
                "date": str(r["received_date"] or r["created_at"])[:10],
                "medicine_name": r["medicine_name"], "quantity": billed, "free_qty": int(r["free_qty"] or 0),
                "total_cost": line_total, "status": "received",
            })
        total_purchases = round(total_purchases, 2)

        placeholders = ", ".join("?" for _ in _SUPPLIER_PAID_STATUSES)
        cursor.execute(
            f"""
            SELECT id, amount, payment_date, payment_mode, status, invoice_ref, notes, created_by, created_at
            FROM vendor_payments
            WHERE status IN ({placeholders})
              AND (supplier_id = ? OR (supplier_id IS NULL AND LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))))
            ORDER BY payment_date DESC, id DESC
            """,
            (*_SUPPLIER_PAID_STATUSES, supplier_id, supplier["supplier_name"]),
        )
        payments = []
        total_paid = 0.0
        for row in cursor.fetchall():
            r = dict(row)
            r["payment_date"] = str(r["payment_date"])[:10]
            r["created_at"] = str(r["created_at"])[:19] if r.get("created_at") else None
            total_paid += float(r["amount"] or 0)
            payments.append(r)
        total_paid = round(total_paid, 2)

        balance = round(total_purchases - total_paid, 2)
        outstanding = max(0.0, balance)
        advance = max(0.0, -balance)

        cursor.execute(
            """
            SELECT gr.id, gr.grn_no, gr.supplier_invoice_no, gr.received_date, gr.stock_source, gr.status
            FROM goods_receipts gr
            WHERE gr.status = 'verified'
              AND COALESCE(gr.supplier_id, (SELECT pp.supplier_id FROM pharmacy_purchases pp WHERE pp.id = gr.purchase_order_id)) = ?
            ORDER BY gr.received_date DESC
            LIMIT 25
            """,
            (supplier_id,),
        )
        recent_receipts = [dict(grn) for grn in cursor.fetchall()]

        return {
            "supplier": dict(supplier),
            "total_purchases": total_purchases,
            "total_paid": total_paid,
            # `outstanding` is what the screen reads; `outstanding_balance` is kept for older callers.
            "outstanding": outstanding,
            "outstanding_balance": outstanding,
            "advance": advance,
            "purchases": purchases,
            "deliveries": deliveries,
            "payments": payments,
            "recent_receipts": recent_receipts,
        }


SUPPLIER_PAYMENT_MODES = ("bank_transfer", "cheque", "upi", "cash", "card")


def record_supplier_payment(db, supplier_id, data, username):
    """Record money paid to a pharmacy supplier. Stored in vendor_payments (so it also shows
    under Accounts > Vendor Payments) and counted by get_supplier_ledger. A payment larger than
    the outstanding balance is allowed: it is kept as an advance credit on the ledger."""
    try:
        amount = round(float(data.get("amount")), 2)
    except (TypeError, ValueError):
        raise ValueError("Enter the payment amount.")
    if not amount > 0:
        raise ValueError("Payment amount must be greater than zero.")
    mode = str(data.get("payment_mode") or "bank_transfer").strip().lower()
    if mode not in SUPPLIER_PAYMENT_MODES:
        raise ValueError("Choose a valid payment mode.")
    pay_date = str(data.get("payment_date") or "").strip() or current_ist_datetime().date().isoformat()
    try:
        parsed = datetime.strptime(pay_date[:10], "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("Payment date must be a valid date (YYYY-MM-DD).")
    if parsed > current_ist_datetime().date():
        raise ValueError("Payment date cannot be in the future.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT supplier_name FROM pharmacy_suppliers WHERE id = ?", (supplier_id,))
        supplier = cursor.fetchone()
        if not supplier:
            raise LookupError("Supplier not found.")
        cursor.execute(
            """
            INSERT INTO vendor_payments (vendor_name, supplier_id, invoice_ref, amount, payment_date, payment_mode, status, notes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?)
            RETURNING id
            """,
            (supplier["supplier_name"], supplier_id, str(data.get("reference") or "").strip() or None, amount,
             parsed.isoformat(), mode, str(data.get("notes") or "").strip() or None, username),
        )
        payment_id = cursor.fetchone()["id"]
        conn.commit()
        return payment_id


# ==================== Enterprise IPD Ward Indenting & eMAR ====================


def create_ward_indent(db, data, username):
    """An indent belongs to one specific admission, never just a UHID --
    ward/bed are read from that admission's real active bed allocation, not
    accepted as free-text, so a readmitted patient's indent can never be
    mis-attributed to a stale ward. Clinical fields (dose/frequency/route)
    must come from the real order; a missing one is surfaced as a validation
    error rather than silently defaulted to "tablet"/"oral"/"OD"."""
    indent_no = f"IND-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    patient_id = data["patient_id"]
    admission_id = data.get("admission_id")
    doctor_name = data.get("doctor_name")
    priority = data.get("priority", "normal")
    if priority not in ("normal", "urgent", "stat"):
        raise ValueError(f"Invalid priority '{priority}'. Must be one of: normal, urgent, stat.")
    items = data.get("items") or []
    if not items:
        raise ValueError("At least one medicine line is required.")
    for item in items:
        if not item.get("medicine_name"):
            raise ValueError("Each line requires a medicine name.")
        if not item.get("dose") or not item.get("frequency") or not item.get("route"):
            raise ValueError(f"Dose, frequency, and route are required for {item.get('medicine_name', 'a medicine')} -- these must come from the real order, not a default.")
        if not int(item.get("quantity_ordered") or 0) > 0:
            raise ValueError(f"A positive quantity is required for {item['medicine_name']}.")

    with get_connection(db) as conn:
        cursor = conn.cursor()
        indent_id = _insert_ward_indent(cursor, indent_no, patient_id, admission_id, doctor_name, priority, items, username)
        conn.commit()
        return indent_id, indent_no



def _insert_ward_indent(cursor, indent_no, patient_id, admission_id, doctor_name, priority, items, username, prescription_id=None):
    ward = ""
    bed_no = ""
    if admission_id:
        cursor.execute(
            "SELECT ward, room_no, bed_no FROM bed_allocations WHERE admission_id = ? AND status = 'active' ORDER BY allocated_at DESC LIMIT 1",
            (admission_id,),
        )
        bed_row = cursor.fetchone()
        if not bed_row:
            raise ValueError("This admission has no active bed allocation. Allocate a bed before raising a ward indent.")
        ward = bed_row["ward"]
        bed_no = bed_row["bed_no"]
    else:
        raise ValueError("An admission_id is required to raise a ward indent.")

    cursor.execute(
        """
        INSERT INTO ward_indents (indent_no, patient_id, admission_id, ward, bed_no, doctor_name, priority, status, created_by, prescription_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        """,
        (indent_no, patient_id, admission_id, ward, bed_no, doctor_name, priority, username, prescription_id),
    )
    indent_id = cursor.lastrowid
    for item in items:
        cursor.execute(
            """
            INSERT INTO ward_indent_items (
                indent_id, medicine_id, medicine_name, dose, frequency, route, quantity_ordered, status,
                start_at, end_at, is_prn, instructions, ordered_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            """,
            (
                indent_id,
                item.get("medicine_id"),
                item["medicine_name"],
                item["dose"],
                item["frequency"],
                item["route"],
                int(item["quantity_ordered"]),
                item.get("start_at") or datetime.now(),
                item.get("end_at"),
                bool(item.get("is_prn", False)),
                item.get("instructions"),
                username,
            ),
        )
    return indent_id



_ROUTE_HINTS = [
    (r"\b(INJ|INJECTION|IV|I\.V\.|INFUSION|VIAL|AMPOULE|AMP)\b", "IV"),
    (r"\b(IM)\b", "IM"),
    (r"\b(SC|SUBCUT|INSULIN)\b", "Subcutaneous"),
    (r"\b(INHALER|NEB|NEBUL|ROTACAP|RESPULE|PUFF)", "Inhalation"),
    (r"\b(EYE|EAR) ?DROPS?\b", "Topical (drops)"),
    (r"\b(CREAM|OINTMENT|GEL|LOTION|PATCH)\b", "Topical"),
    (r"\b(SUPPOSITORY|SUPP)\b", "Rectal"),
    (r"\b(SL|SUBLINGUAL)\b", "Sublingual"),
]


def _infer_route(*texts):
    blob = " ".join(str(t or "") for t in texts).upper()
    for pattern, route in _ROUTE_HINTS:
        if re.search(pattern, blob):
            return route
    return "Oral"


def _duration_days(duration):
    m = re.search(r"(\d+)\s*(D|DAY|DAYS|W|WK|WEEK|WEEKS|M|MONTH|MONTHS)?\b", str(duration or "").upper())
    if not m:
        return None
    n = int(m.group(1))
    unit = (m.group(2) or "D")[0]
    return n * (7 if unit == "W" else 30 if unit == "M" else 1)


def ip_order_items_from_prescription(medicines, now=None):
    """Convert Doctor Prescription medicine rows into IP medication order
    lines. The prescription form has no route field, so the route is inferred
    from the medicine name / instructions (default Oral) and flagged for
    pharmacy to verify; quantity = doses per day x duration."""
    now = now or current_ist_datetime().replace(tzinfo=None)
    items = []
    for med in medicines or []:
        name = str(med.get("medicine_name") or med.get("medicine") or "").strip()
        if not name:
            continue
        frequency = str(med.get("frequency") or med.get("freq_custom") or "").strip() or "OD"
        kind, value = emar_frequency_plan(frequency)
        per_day = len(value) if kind == "hours" else max(1, 24 // value) if kind == "interval" else 1
        days = _duration_days(med.get("duration"))
        quantity = min(per_day * (days or 1), 500)
        route = str(med.get("route") or "").strip()
        notes = [str(med.get("instructions") or "").strip()]
        if med.get("duration"):
            notes.append(f"Duration: {str(med.get('duration')).strip()}")
        if not route:
            route = _infer_route(name, med.get("dosage"), med.get("instructions"))
            notes.append("Route taken from prescription text - verify")
        items.append({
            "medicine_name": name,
            "dose": str(med.get("dosage") or "").strip() or "As directed",
            "frequency": frequency,
            "route": route,
            "quantity_ordered": quantity,
            "start_at": now,
            "end_at": now + timedelta(days=days) if days else None,
            "is_prn": kind == "prn",
            "instructions": " · ".join(n for n in notes if n) or None,
        })
    return items



def active_ip_admission(cursor, patient_id):
    """The patient's current inpatient admission (an active bed allocation on an
    admission that is not discharged), or None for an outpatient."""
    cursor.execute(
        """
        SELECT b.admission_id FROM bed_allocations b
        JOIN admissions a ON a.id = b.admission_id
        WHERE b.patient_id = ? AND b.status = 'active' AND a.discharge_date IS NULL
        ORDER BY b.allocated_at DESC LIMIT 1
        """,
        (patient_id,),
    )
    row = cursor.fetchone()
    return row["admission_id"] if row else None



def create_ip_order_from_prescription(cursor, prescription_id, patient_id, admission_id, doctor_name, medicines, username):
    """Doctor Prescription for an admitted patient -> IP medication order
    (ward indent) that appears in Pharmacy > IP Dispense. Re-saving the same
    prescription cancels its not-yet-issued lines and raises them again;
    anything already issued stays as recorded."""
    cursor.execute(
        """
        UPDATE ward_indent_items SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
               cancel_reason = 'Prescription revised (by ' || ? || ')'
        WHERE indent_id IN (SELECT id FROM ward_indents WHERE prescription_id = ?)
          AND COALESCE(quantity_dispensed, 0) = 0 AND COALESCE(status, 'pending') <> 'cancelled'
        """,
        (username or "system", prescription_id),
    )
    cursor.execute(
        """
        UPDATE ward_indents SET status = 'cancelled'
        WHERE prescription_id = ? AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM ward_indent_items i WHERE i.indent_id = ward_indents.id AND COALESCE(i.status, 'pending') <> 'cancelled')
        """,
        (prescription_id,),
    )
    items = ip_order_items_from_prescription(medicines)
    if not items:
        return None
    indent_no = f"IND-RX{prescription_id}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    indent_id = _insert_ward_indent(cursor, indent_no, patient_id, admission_id, doctor_name, "normal", items, username,
                                    prescription_id=prescription_id)
    return {"indent_id": indent_id, "indent_no": indent_no, "items": len(items)}



def update_ward_indent_item(db, item_id, data):
    """Only a still-pending, not-yet-issued line can be edited -- once
    pharmacy has issued any quantity against it, the issued record is
    historical fact and must not change underneath it."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ward_indent_items WHERE id = ?", (item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Medication order line not found.")
        if str(item["status"] or "").lower() == "cancelled" or int(item["quantity_dispensed"] or 0) > 0:
            raise ValueError("This order has already been issued (fully or partially) or cancelled and can no longer be edited.")
        cursor.execute(
            """
            UPDATE ward_indent_items
            SET dose = ?, frequency = ?, route = ?, quantity_ordered = ?, start_at = ?, end_at = ?, is_prn = ?, instructions = ?
            WHERE id = ?
            """,
            (
                data.get("dose", item["dose"]), data.get("frequency", item["frequency"]), data.get("route", item["route"]),
                int(data.get("quantity_ordered", item["quantity_ordered"])), data.get("start_at", item["start_at"]),
                data.get("end_at", item["end_at"]), bool(data.get("is_prn", item["is_prn"])),
                data.get("instructions", item["instructions"]), item_id,
            ),
        )
        conn.commit()
        return True



def cancel_ward_indent_item(db, item_id, reason, username):
    if not (reason or "").strip():
        raise ValueError("A cancellation reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ward_indent_items WHERE id = ?", (item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Medication order line not found.")
        if int(item["quantity_dispensed"] or 0) > 0:
            raise ValueError("This order has already been partially or fully issued and cannot be cancelled -- discontinue the remaining eMAR doses instead.")
        if item["status"] == "cancelled":
            raise ValueError("This order is already cancelled.")
        cursor.execute(
            "UPDATE ward_indent_items SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ?",
            (f"{reason} (by {username})", item_id),
        )
        conn.commit()
        return True



def list_ward_indents(db, status=None, ward=None, patient_id=None, admission_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT wi.*, TRIM(p.name || ' ' || COALESCE(p.last_name, '')) AS patient_name,
                   COALESCE(a.payer_type, 'self') AS payer_type, a.insurance_provider, a.insurance_policy_no, a.insurance_preauth_no
            FROM ward_indents wi
            LEFT JOIN patients p ON p.patient_id = wi.patient_id
            LEFT JOIN admissions a ON a.id = wi.admission_id
            WHERE 1=1
        """
        params = []
        if status:
            query += " AND wi.status = ?"
            params.append(status)
        if ward:
            query += " AND wi.ward = ?"
            params.append(ward)
        if patient_id:
            query += " AND wi.patient_id = ?"
            params.append(patient_id)
        if admission_id:
            # Scoped to one specific admission -- a patient readmitted later
            # must never see a previous stay's indents mixed into this one.
            query += " AND wi.admission_id = ?"
            params.append(admission_id)
        query += " ORDER BY wi.created_at DESC"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        result = []
        for r in rows:
            r_dict = dict(r)
            cursor.execute("SELECT * FROM ward_indent_items WHERE indent_id = ?", (r_dict["id"],))
            r_dict["items"] = [dict(it) for it in cursor.fetchall()]
            result.append(r_dict)
        return result



def list_emar_records(db, patient_id=None, admission_id=None, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT e.*, TRIM(p.name || ' ' || COALESCE(p.last_name, '')) AS patient_name, wi.ward, wi.bed_no,
                   wii.frequency, wii.is_prn, wii.instructions, wii.ordered_by, wi.doctor_name
            FROM emar_records e
            LEFT JOIN patients p ON p.patient_id = e.patient_id
            LEFT JOIN ward_indents wi ON wi.id = e.indent_id
            LEFT JOIN ward_indent_items wii ON wii.id = e.indent_item_id
            WHERE 1=1
        """
        params = []
        if patient_id:
            query += " AND e.patient_id = ?"
            params.append(patient_id)
        if admission_id:
            query += " AND e.admission_id = ?"
            params.append(admission_id)
        if status:
            query += " AND e.status = ?"
            params.append(status)
        query += " ORDER BY e.scheduled_time ASC, e.id ASC"
        cursor.execute(query, tuple(params))
        return [dict(r) for r in cursor.fetchall()]



def count_emar_by_status(db, patient_id, admission_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = "SELECT status, COUNT(*) AS n FROM emar_records WHERE patient_id = ?"
        params = [patient_id]
        if admission_id:
            query += " AND admission_id = ?"
            params.append(admission_id)
        cursor.execute(query + " GROUP BY status", tuple(params))
        return {r["status"]: r["n"] for r in cursor.fetchall()}



def list_unissued_medication_orders(db, patient_id, admission_id=None):
    """Doctor's medication orders for this admission that pharmacy has not
    (fully) issued yet. They have no eMAR doses until stock is issued, so the
    Nursing Station lists them separately instead of showing an empty chart."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT wii.id, wii.indent_id, wi.indent_no, wi.priority, wi.doctor_name, wii.medicine_name, wii.dose, wii.frequency,
                   wii.route, wii.quantity_ordered, COALESCE(wii.quantity_dispensed, 0) AS quantity_dispensed, wii.status,
                   wii.start_at, wii.end_at, wii.is_prn, wii.instructions, wii.ordered_by, wi.created_at
            FROM ward_indent_items wii
            JOIN ward_indents wi ON wi.id = wii.indent_id
            WHERE wi.patient_id = ?
              AND COALESCE(wii.status, 'pending') NOT IN ('cancelled', 'dispensed')
              AND COALESCE(wii.quantity_dispensed, 0) < wii.quantity_ordered
        """
        params = [patient_id]
        if admission_id:
            query += " AND wi.admission_id = ?"
            params.append(admission_id)
        cursor.execute(query + " ORDER BY wi.created_at ASC, wii.id ASC", tuple(params))
        return [dict(r) for r in cursor.fetchall()]



def record_emar_status(db, emar_id, status, username, notes=None):
    """Nurse-recorded outcome for a single scheduled dose. Only a still-pending
    dose can be recorded against -- this is what prevents double-administration
    and what stops a typo'd/stale emar_id from silently 'succeeding'. The
    update itself is conditional on status = 'pending', so two simultaneous
    submissions for the same dose can never both succeed."""
    if status not in ("given", "held", "refused", "missed"):
        raise ValueError(f"Unsupported eMAR status '{status}'.")
    notes = (str(notes).strip() if notes is not None else "") or None
    if status in ("held", "refused", "missed") and not notes:
        raise ValueError(f"A reason is required to mark a dose as {status}.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT e.*, wii.frequency, wii.is_prn FROM emar_records e
            LEFT JOIN ward_indent_items wii ON wii.id = e.indent_item_id
            WHERE e.id = ?
            """,
            (emar_id,),
        )
        record = cursor.fetchone()
        if not record:
            raise ValueError("eMAR record not found.")
        if record["status"] != "pending":
            raise ValueError(f"This dose is already {record['status']}; it cannot be changed.")
        now = _emar_now()
        scheduled = record["scheduled_time"]
        is_prn = emar_frequency_plan(record["frequency"], record["is_prn"])[0] == "prn" or str(record["notes"] or "").startswith("PRN")
        if status == "given" and not is_prn and isinstance(scheduled, datetime) and scheduled - now > EMAR_EARLY_WINDOW and not notes:
            raise ValueError(
                f"This dose is scheduled for {scheduled.strftime('%d %b %Y %H:%M')}. "
                "Giving it more than 1 hour early needs a reason (e.g. a doctor's instruction)."
            )
        cursor.execute(
            """
            UPDATE emar_records
            SET status = ?, administered_by = ?, administered_at = ?, notes = CASE WHEN ? IS NULL THEN notes ELSE ? END
            WHERE id = ? AND status = 'pending'
            """,
            (status, username, now, notes, notes, emar_id),
        )
        if cursor.rowcount != 1:
            raise ValueError("This dose was just recorded by someone else; refresh to see its status.")
        conn.commit()
        return True



def administer_emar_record(db, emar_id, username, notes=None):
    return record_emar_status(db, emar_id, "given", username, notes)



def discontinue_emar_schedule(db, indent_item_id, reason, username):
    """Doctor/nurse stops a medication: every still-pending future dose for
    this order line is discontinued, but doses already given/held/refused/
    missed/returned are historical fact and stay exactly as recorded."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE emar_records
            SET status = 'discontinued', notes = COALESCE(notes || ' | ', '') || ?
            WHERE indent_item_id = ? AND status = 'pending'
            """,
            (f"Discontinued: {reason} by {username}", indent_item_id),
        )
        affected = cursor.rowcount
        conn.commit()
        return {"discontinued_count": affected}



def return_emar_record(db, emar_id, quantity, reason, username):
    """Ward Return: an unadministered dose sent back to pharmacy. Links back to
    the real pharmacy sale/batch that dispensed it -- if that link doesn't
    exist (e.g. a legacy row predating this), the return is refused rather
    than recorded against a fabricated sale/batch id."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM emar_records WHERE id = ?", (emar_id,))
        record = cursor.fetchone()
        if not record:
            raise ValueError("eMAR record not found.")
        if record["status"] != "pending":
            raise ValueError(f"This dose is already {record['status']}; only a pending dose can be returned.")

        sale_id = record["sale_id"]
        if not sale_id:
            raise ValueError("Cannot return this dose: no linked pharmacy sale found.")
        # A dispense split across multiple FEFO batches only links here to the
        # first batch drawn from -- pharmacy_returns has a single
        # pharmacy_inventory_id column, a pre-existing limitation this fix
        # doesn't redesign.
        cursor.execute(
            "SELECT pharmacy_inventory_id FROM stock_movements WHERE ref_table = 'pharmacy_sales' AND ref_id = ? ORDER BY id ASC LIMIT 1",
            (sale_id,),
        )
        movement = cursor.fetchone()
        if not movement:
            raise ValueError("Cannot return this dose: no linked pharmacy sale found.")

        cursor.execute(
            "UPDATE emar_records SET status = 'returned', notes = ? WHERE id = ?",
            (f"Returned: {reason} by {username}", emar_id),
        )

        # Place into pharmacy quarantine return table
        cursor.execute(
            """
            INSERT INTO pharmacy_returns (
                original_sale_id, pharmacy_inventory_id, quantity, stock_source, reason, status, created_by
            ) VALUES (?, ?, ?, 'CASH', ?, 'quarantined', ?)
            """,
            (sale_id, movement["pharmacy_inventory_id"], quantity or 1, f"Ward Return from eMAR #{emar_id}: {reason}", username),
        )
        conn.commit()
        return True



def get_running_ipd_pharmacy_charges(db, admission_id):
    """Pulls all unbilled pharmacy items for an admitted inpatient to be consolidated at discharge."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ps.id, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount, ps.stock_source, ps.sold_at,
                   wi.indent_no, wi.ward, wi.bed_no
            FROM pharmacy_sales ps
            LEFT JOIN ward_indents wi ON wi.id = ps.indent_id
            WHERE ps.admission_id = ? AND ps.invoice_id IS NULL
            ORDER BY ps.sold_at ASC
            """,
            (admission_id,),
        )
        items = [dict(r) for r in cursor.fetchall()]
        total = sum(float(i["amount"] or 0) for i in items)
        return {"items": items, "total_charges": total}



def get_discharge_bill_preview(db, admission_id=None, allocation_id=None):
    """Calculates stay duration, bed charges, and consolidated unbilled
    pharmacy charges for an admitted inpatient preparing for discharge."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if allocation_id and not admission_id:
            cursor.execute("SELECT admission_id, patient_id FROM bed_allocations WHERE id = ?", (allocation_id,))
            row = cursor.fetchone()
            if row and row["admission_id"]:
                admission_id = row["admission_id"]
            elif row:
                cursor.execute(
                    "SELECT id FROM admissions WHERE patient_id = ? AND discharge_date IS NULL ORDER BY admission_date DESC LIMIT 1",
                    (row["patient_id"],)
                )
                adm = cursor.fetchone()
                if adm:
                    admission_id = adm["id"]

        bed = None
        if allocation_id:
            cursor.execute(
                """
                SELECT b.id, b.admission_id, b.patient_id, b.ward, b.room_no, b.bed_no,
                       COALESCE(b.amount_per_day, 0) as amount_per_day,
                       b.allocated_at, b.status
                FROM bed_allocations b WHERE b.id = ?
                """,
                (allocation_id,)
            )
            bed = cursor.fetchone()
        elif admission_id:
            cursor.execute(
                """
                SELECT b.id, b.admission_id, b.patient_id, b.ward, b.room_no, b.bed_no,
                       COALESCE(b.amount_per_day, 0) as amount_per_day,
                       b.allocated_at, b.status
                FROM bed_allocations b
                WHERE (b.admission_id = ? OR b.patient_id = (SELECT patient_id FROM admissions WHERE id = ?))
                ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.allocated_at DESC LIMIT 1
                """,
                (admission_id, admission_id)
            )
            bed = cursor.fetchone()

        adm_record = None
        if admission_id:
            cursor.execute("SELECT * FROM admissions WHERE id = ?", (admission_id,))
            adm_record = cursor.fetchone()
        elif bed:
            cursor.execute(
                "SELECT * FROM admissions WHERE patient_id = ? AND discharge_date IS NULL ORDER BY admission_date DESC LIMIT 1",
                (bed["patient_id"],)
            )
            adm_record = cursor.fetchone()
            if adm_record:
                admission_id = adm_record["id"]

        patient_id = bed["patient_id"] if bed else (adm_record["patient_id"] if adm_record else None)
        if not patient_id:
            raise ValueError("Inpatient record not found.")

        cursor.execute("SELECT patient_id, name, age, gender, phone FROM patients WHERE patient_id = ?", (patient_id,))
        patient = cursor.fetchone()

        now_dt = current_ist_datetime()
        allocated_dt = None
        if bed and bed["allocated_at"]:
            try:
                allocated_dt = datetime.fromisoformat(str(bed["allocated_at"]))
            except Exception:
                allocated_dt = None
        if not allocated_dt and adm_record and adm_record["admission_date"]:
            try:
                allocated_dt = datetime.fromisoformat(str(adm_record["admission_date"]))
            except Exception:
                allocated_dt = None
        if not allocated_dt:
            allocated_dt = now_dt - timedelta(days=1)

        seconds_stayed = max(0, (now_dt.replace(tzinfo=None) - allocated_dt.replace(tzinfo=None)).total_seconds())
        hours_stayed = round(seconds_stayed / 3600.0, 1)
        days_stayed = max(1, int(math.ceil(seconds_stayed / 86400.0))) if seconds_stayed > 0 else 1

        rate_per_day = float(bed["amount_per_day"] or 0) if bed else 0.0
        bed_total = round(days_stayed * rate_per_day, 2)

        pharmacy_items = []
        pharmacy_total = 0.0
        if admission_id:
            cursor.execute(
                """
                SELECT ps.id, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount, ps.stock_source, ps.sold_at,
                       wi.indent_no, wi.ward, wi.bed_no, ps.invoice_id
                FROM pharmacy_sales ps
                LEFT JOIN ward_indents wi ON wi.id = ps.indent_id
                WHERE (ps.admission_id = ? OR (ps.patient_id = ? AND ps.billing_type IN ('IPD_RUNNING', 'EMERGENCY_ACCOUNT', 'EMERGENCY')))
                ORDER BY ps.sold_at ASC
                """,
                (admission_id, patient_id)
            )
            all_sales = [dict(r) for r in cursor.fetchall()]
            unbilled = [s for s in all_sales if s.get("invoice_id") is None]
            pharmacy_items = unbilled if unbilled or not adm_record or not adm_record.get("discharge_date") else all_sales
            pharmacy_total = round(sum(float(i["amount"] or 0) for i in pharmacy_items), 2)
        elif patient_id:
            cursor.execute(
                """
                SELECT ps.id, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount, ps.stock_source, ps.sold_at,
                       wi.indent_no, wi.ward, wi.bed_no, ps.invoice_id
                FROM pharmacy_sales ps
                LEFT JOIN ward_indents wi ON wi.id = ps.indent_id
                WHERE ps.patient_id = ? AND ps.billing_type IN ('IPD_RUNNING', 'EMERGENCY_ACCOUNT', 'EMERGENCY')
                ORDER BY ps.sold_at ASC
                """,
                (patient_id,)
            )
            all_sales = [dict(r) for r in cursor.fetchall()]
            unbilled = [s for s in all_sales if s.get("invoice_id") is None]
            pharmacy_items = unbilled if unbilled or not adm_record or not adm_record.get("discharge_date") else all_sales
            pharmacy_total = round(sum(float(i["amount"] or 0) for i in pharmacy_items), 2)

        formatted_pharmacy_items = []
        for it in pharmacy_items:
            item_dict = dict(it)
            if item_dict.get("sold_at"):
                try:
                    dt = datetime.fromisoformat(str(item_dict["sold_at"]))
                    item_dict["sold_at_formatted"] = dt.strftime("%d-%b %I:%M %p")
                except Exception:
                    item_dict["sold_at_formatted"] = str(item_dict["sold_at"])[:16]
            else:
                item_dict["sold_at_formatted"] = "-"
            formatted_pharmacy_items.append(item_dict)

        cursor.execute(
            """
            SELECT insurer_name, claim_amount, approved_amount, claim_status,
                   external_ref as authorization_ref
            FROM insurance_claims
            WHERE patient_id = ?
            ORDER BY id DESC LIMIT 1
            """,
            (patient_id,)
        )
        ins_row = cursor.fetchone()
        insurance_claim = dict(ins_row) if ins_row else None

        diag_items = []
        diag_total = 0.0
        if admission_id:
            cursor.execute(
                """
                SELECT oi.id, oi.service_name, oi.department_type, oi.quantity, oi.amount, o.order_no, o.created_at AS ordered_at
                FROM diag_order_items oi
                JOIN diag_orders o ON o.id = oi.order_id
                WHERE o.admission_id = ? AND o.status = 'confirmed' AND oi.cancelled_at IS NULL AND oi.discharge_invoice_id IS NULL
                ORDER BY o.created_at ASC
                """,
                (admission_id,),
            )
            diag_items = [dict(r) for r in cursor.fetchall()]
            diag_total = round(sum(float(i["amount"] or 0) for i in diag_items), 2)

        grand_total = round(bed_total + pharmacy_total + diag_total, 2)

        # Advance deposits the patient still has available (same rows the IP Discharge Billing screen applies).
        cursor.execute(
            """
            SELECT id, advance_no, amount, allocated_amount, refunded_amount, reserved_refund_amount, payment_mode, created_at
            FROM patient_advances
            WHERE (admission_id = ? OR patient_id = ?) AND status = 'active'
            ORDER BY id ASC
            """,
            (admission_id, patient_id),
        )
        advances = []
        for a in cursor.fetchall():
            avail = round(float(a["amount"] or 0) - float(a["allocated_amount"] or 0) - float(a["refunded_amount"] or 0) - float(a["reserved_refund_amount"] or 0), 2)
            if avail > 0:
                advances.append({"id": a["id"], "advance_no": a["advance_no"], "payment_mode": a["payment_mode"],
                                 "amount": float(a["amount"] or 0), "available": avail})
        advance_available = round(sum(a["available"] for a in advances), 2)

        return {
            "advances": advances,
            "advance_available": advance_available,
            "patient": dict(patient) if patient else {"patient_id": patient_id},
            "admission": dict(adm_record) if adm_record else {"id": admission_id},
            "bed": dict(bed) if bed else None,
            "admission_date": allocated_dt.isoformat(),
            "discharge_date": now_dt.isoformat(),
            "admission_date_formatted": allocated_dt.strftime("%d-%b-%Y %I:%M %p"),
            "discharge_date_formatted": now_dt.strftime("%d-%b-%Y %I:%M %p"),
            "hours_stayed": hours_stayed,
            "days_stayed": days_stayed,
            "rate_per_day": rate_per_day,
            "bed_total": bed_total,
            "pharmacy_items": formatted_pharmacy_items,
            "pharmacy_total": pharmacy_total,
            "diag_items": diag_items,
            "diag_total": diag_total,
            "insurance_claim": insurance_claim,
            "grand_total": grand_total,
        }



def get_admission_insurer(cursor, admission_id):
    """The insurer an admission is billed to: {provider, policy_no, preauth_no}, or None when the
    stay is Self-pay or its insurance details are incomplete."""
    cursor.execute(
        "SELECT payer_type, insurance_provider, insurance_policy_no, insurance_preauth_no FROM admissions WHERE id = ?",
        (admission_id,),
    )
    row = cursor.fetchone()
    if not row or row["payer_type"] != "insurance" or not row["insurance_provider"] or not row["insurance_policy_no"]:
        return None
    return {"provider": row["insurance_provider"], "policy_no": row["insurance_policy_no"],
            "preauth_no": row["insurance_preauth_no"] or ""}


NOT_INSURED_MESSAGE = (
    "This admission is marked Self-pay. Set the payer to Insurance (with provider and policy number) at "
    "IP Admission or IP Discharge Billing before billing the insurer."
)


def create_ip_insurance_claim(cursor, invoice_id, patient_id, admission_id, insurer, claim_amount):
    """Claim for an inpatient bill that is due from the insurer (nothing is recorded as paid)."""
    cursor.execute("SELECT id FROM insurance_claims WHERE invoice_id = ?", (invoice_id,))
    existing = cursor.fetchone()
    if existing:
        cursor.execute("UPDATE insurance_claims SET claim_amount = ? WHERE id = ?", (float(claim_amount), existing["id"]))
        return existing["id"]
    cursor.execute(
        """
        INSERT INTO insurance_claims (
            invoice_id, patient_id, insurer_name, claim_amount, approved_amount, claim_status, external_ref, notes,
            patient_responsibility, settlement_status, membership_ref, authorization_ref
        ) VALUES (?, ?, ?, ?, 0, 'submitted', ?, ?, 0, 'unpaid', ?, ?)
        RETURNING id
        """,
        (invoice_id, patient_id, insurer["provider"], float(claim_amount), insurer["preauth_no"] or None,
         f"IP discharge claim - Admission #{admission_id} - Policy: {insurer['policy_no']}",
         insurer["policy_no"], insurer["preauth_no"] or None),
    )
    return cursor.fetchone()["id"]


def settle_inpatient_discharge(db, data, username):
    """Atomically settles bed release, records discharge timestamp, generates
    consolidated final invoice (bed + pharmacy), and links all running pharmacy
    sales to the master invoice."""
    admission_id = data.get("admission_id")
    allocation_id = data.get("allocation_id")
    raw_mode = str(data.get("payment_mode") or "cash").strip().lower()
    valid_modes = {"cash", "card", "upi", "bank", "razorpay", "bank_transfer", "net_banking", "mixed_payment", "cheque"}
    # "insurance" is not a payment received: the bill goes to the insurer as a claim.
    bill_to_insurer = raw_mode == "insurance"
    payment_mode = "insurance" if bill_to_insurer else (raw_mode if raw_mode in valid_modes else "cash")
    notes = data.get("notes", "Discharged in stable condition")
    discount = float(data.get("discount") or 0)
    return_excess = bool(data.get("return_excess"))
    refund_method = str(data.get("refund_method") or "Cash").strip()

    preview = get_discharge_bill_preview(db, admission_id=admission_id, allocation_id=allocation_id)
    if preview.get("admission") and preview["admission"].get("discharge_date"):
        raise ValueError("This admission is already discharged and billed.")
    patient_id = preview["patient"]["patient_id"]
    bed_id = preview["bed"]["id"] if preview.get("bed") else allocation_id
    adm_id = preview["admission"]["id"] if preview.get("admission") else admission_id
    
    bed_total = preview["bed_total"]
    pharmacy_total = preview["pharmacy_total"]
    diag_total = preview.get("diag_total", 0.0)
    days_stayed = preview["days_stayed"]
    subtotal = round(bed_total + pharmacy_total + diag_total, 2)
    total_amount = max(0.0, round(subtotal - discount, 2))
    # The advance applied is whatever the patient actually has on deposit (never a typed number), up to the bill.
    advance_available = float(preview.get("advance_available") or 0)
    advance_paid = round(min(advance_available, total_amount), 2)
    paid_amount = max(0.0, round(total_amount - advance_paid, 2))
    due_amount = 0.0
    insurer_due = 0.0
    invoice_status = "paid"
    if bill_to_insurer:
        # The patient's advance covers its part; the insurer is billed the rest and nothing is collected now.
        insurer_due = max(0.0, round(total_amount - advance_paid, 2))
        paid_amount = 0.0
        due_amount = insurer_due
        invoice_status = "due" if insurer_due > 0 else "paid"

    now_str = datetime.now().strftime("%Y%m%d%H%M%S")
    invoice_no = f"INV-DIS-{now_str}"

    with get_connection(db) as conn:
        cursor = conn.cursor()

        insurer = None
        if bill_to_insurer:
            insurer = get_admission_insurer(cursor, adm_id)
            if not insurer:
                raise ValueError(NOT_INSURED_MESSAGE)

        # Two discharges in the same second would otherwise share an invoice number.
        base_no, copy_no = invoice_no, 1
        while True:
            cursor.execute("SELECT 1 FROM invoices WHERE invoice_no = ?", (invoice_no,))
            if not cursor.fetchone():
                break
            copy_no += 1
            invoice_no = f"{base_no}-{copy_no}"

        if bed_id:
            cursor.execute(
                """
                UPDATE bed_allocations 
                SET status = 'released', released_at = CURRENT_TIMESTAMP, total_days = ?, total_amount = ?
                WHERE id = ?
                """,
                (days_stayed, bed_total, bed_id)
            )
            if preview.get("bed"):
                b_ward = preview["bed"].get("ward")
                b_no = preview["bed"].get("bed_no")
                if b_ward and b_no:
                    cursor.execute(
                        "UPDATE hospital_beds SET status = 'available' WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
                        (str(b_ward).strip(), str(b_no).strip())
                    )

        if adm_id:
            cursor.execute(
                """
                UPDATE admissions 
                SET discharge_date = CURRENT_DATE, notes = COALESCE(notes, '') || ' | Discharged: ' || ?
                WHERE id = ?
                """,
                (notes, adm_id)
            )

        cursor.execute(
            """
            INSERT INTO invoices (
                invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                advance_amount, refunded_amount, admission_id, payment_mode
            ) VALUES (?, ?, 'IP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                invoice_no, patient_id, preview["bed"].get("assigned_doctor") if preview.get("bed") else None,
                "HospAI", None, subtotal, 0, discount, total_amount, paid_amount, due_amount,
                invoice_status, username, advance_paid, 0, adm_id, payment_mode
            )
        )
        invoice_id = cursor.lastrowid

        # Apply the advance: lock the deposits, re-check what is available, mark it allocated to this invoice.
        advance_left = {}
        if advance_available > 0:
            cursor.execute(
                "SELECT * FROM patient_advances WHERE (admission_id = ? OR patient_id = ?) AND status = 'active' ORDER BY id ASC FOR UPDATE",
                (adm_id, patient_id),
            )
            need = advance_paid
            locked_total = 0.0
            for adv in cursor.fetchall():
                avail = round(float(adv["amount"] or 0) - float(adv["allocated_amount"] or 0) - float(adv["refunded_amount"] or 0) - float(adv["reserved_refund_amount"] or 0), 2)
                if avail <= 0:
                    continue
                locked_total += avail
                chunk = round(min(avail, need), 2)
                if chunk > 0:
                    cursor.execute("UPDATE patient_advances SET allocated_amount = allocated_amount + ? WHERE id = ?", (chunk, adv["id"]))
                    cursor.execute("INSERT INTO advance_allocations (advance_id, invoice_id, amount, allocated_by) VALUES (?, ?, ?, ?)",
                                   (adv["id"], invoice_id, chunk, username))
                    need = round(need - chunk, 2)
                if round(avail - chunk, 2) > 0:
                    advance_left[adv["id"]] = round(avail - chunk, 2)
            if need > 0.009 or locked_total + 0.009 < advance_paid:
                conn.rollback()
                raise ValueError("The patient's advance balance changed while settling. Please reopen the bill and try again.")

        claim_id = None
        if insurer and insurer_due > 0:
            claim_id = create_ip_insurance_claim(cursor, invoice_id, patient_id, adm_id, insurer, insurer_due)

        if paid_amount > 0:
            cursor.execute(
                "INSERT INTO invoice_payments (invoice_id, amount, payment_mode) VALUES (?, ?, ?)",
                (invoice_id, paid_amount, payment_mode)
            )

        if adm_id:
            cursor.execute(
                "UPDATE pharmacy_sales SET invoice_id = ? WHERE admission_id = ? AND invoice_id IS NULL",
                (invoice_id, adm_id)
            )
        cursor.execute(
            "UPDATE pharmacy_sales SET invoice_id = ? WHERE patient_id = ? AND billing_type = 'IPD_RUNNING' AND invoice_id IS NULL",
            (invoice_id, patient_id)
        )

        if adm_id:
            cursor.execute(
                """
                UPDATE diag_order_items SET discharge_invoice_id = ?
                WHERE discharge_invoice_id IS NULL AND id IN (
                    SELECT oi.id FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
                    WHERE o.admission_id = ? AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
                )
                """,
                (invoice_id, adm_id),
            )

        conn.commit()

    # Money left on deposit after the bill: optionally send it for refund (the normal approve-and-pay flow).
    refund_requests = []
    if return_excess and advance_left:
        import billing_service as bs
        for adv_id, left in advance_left.items():
            res = bs.request_advance_refund(db, {
                "advance_id": adv_id, "amount": left, "refund_method": refund_method,
                "reason": "Excess advance returned at discharge", "notes": f"Discharge invoice {invoice_no}",
            }, {"username": username})
            refund_requests.append({"refund_no": res.get("refund_no"), "amount": res.get("amount")})

    return {
        "advance_balance_left": round(sum(advance_left.values()), 2) if advance_left else 0.0,
        "refund_requests": refund_requests,
        "status": "success",
        "invoice_id": invoice_id,
        "invoice_no": invoice_no,
        "payment_mode": payment_mode,
        "billed_to_insurer": bill_to_insurer,
        "insurer_name": insurer["provider"] if insurer else None,
        "insurer_due": insurer_due,
        "claim_id": claim_id,
        "preview": preview,
        "total_amount": total_amount,
        "paid_amount": paid_amount,
        "discount": discount,
        "advance_paid": advance_paid,
        "discharge_timestamp": preview["discharge_date_formatted"],
        "patient": preview["patient"],
        "bed": preview["bed"],
        "pharmacy_items": preview["pharmacy_items"],
        "diag_items": preview.get("diag_items", []),
    }



def create_lab_vendor(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO lab_vendors (vendor_name, contact_person, phone, status)
            VALUES (?, ?, ?, ?)
            """,
            (
                data["vendor_name"],
                data.get("contact_person"),
                data.get("phone"),
                data.get("status", "active"),
            ),
        )
        vendor_id = cursor.lastrowid
        conn.commit()
        return vendor_id



def list_lab_vendors(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM lab_vendors ORDER BY vendor_name ASC")
        return cursor.fetchall()



def update_lab_vendor(db, vendor_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM lab_vendors WHERE id = ?", (vendor_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE lab_vendors
            SET vendor_name = ?, contact_person = ?, phone = ?, status = ?
            WHERE id = ?
            """,
            (
                data.get("vendor_name", existing["vendor_name"]),
                data.get("contact_person", existing["contact_person"]),
                data.get("phone", existing["phone"]),
                data.get("status", existing["status"]),
                vendor_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def save_partner_lab(db, data, vendor_id=None):
    """Create or edit a partner (outsourcing) laboratory. Names are unique
    (case-insensitive). Labs are deactivated rather than deleted, so past
    referrals and orders keep showing which lab they went to."""
    name = str(data.get("vendor_name") or "").strip()
    if vendor_id is None and not name:
        raise ValueError("Enter the partner lab name.")
    status = data.get("status")
    if status is not None and status not in ("active", "inactive"):
        raise ValueError("Status must be active or inactive.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        existing = None
        if vendor_id is not None:
            cursor.execute("SELECT * FROM lab_vendors WHERE id = ?", (vendor_id,))
            existing = cursor.fetchone()
            if not existing:
                raise LookupError("Partner lab not found.")
            if "vendor_name" in data and not name:
                raise ValueError("The partner lab name cannot be empty.")
        if name:
            cursor.execute(
                "SELECT id FROM lab_vendors WHERE LOWER(TRIM(vendor_name)) = LOWER(?) AND id <> ?",
                (name, vendor_id or 0),
            )
            if cursor.fetchone():
                raise ValueError(f"A partner lab named '{name}' already exists.")
        clean = lambda key: (str(data.get(key) or "").strip() or None)
        if existing is None:
            cursor.execute(
                "INSERT INTO lab_vendors (vendor_name, contact_person, phone, status) VALUES (?, ?, ?, ?) RETURNING id",
                (name, clean("contact_person"), clean("phone"), status or "active"),
            )
            vendor_id = cursor.fetchone()["id"]
        else:
            cursor.execute(
                "UPDATE lab_vendors SET vendor_name = ?, contact_person = ?, phone = ?, status = ? WHERE id = ?",
                (
                    name or existing["vendor_name"],
                    clean("contact_person") if "contact_person" in data else existing["contact_person"],
                    clean("phone") if "phone" in data else existing["phone"],
                    status or existing["status"] or "active",
                    vendor_id,
                ),
            )
        conn.commit()
        cursor.execute("SELECT * FROM lab_vendors WHERE id = ?", (vendor_id,))
        return cursor.fetchone()


def delete_lab_vendor(db, vendor_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE diagnostics SET vendor_id = NULL WHERE vendor_id = ?", (vendor_id,))
        cursor.execute("DELETE FROM lab_vendors WHERE id = ?", (vendor_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def _diagnostic_amounts(data, existing=None):
    def _number(value, fallback=0):
        try:
            if value is None or value == "":
                return float(fallback or 0)
            return float(value)
        except (TypeError, ValueError):
            return float(fallback or 0)

    existing = existing or {}
    gross_amount = _number(data.get("amount"), (existing["amount"] if existing and "amount" in existing.keys() else 0))
    discount_percentage = _number(data.get("discount_percentage"), (existing["discount_percentage"] if existing and "discount_percentage" in existing.keys() else 0))
    discount_amount = _number(data.get("discount_amount"), (existing["discount_amount"] if existing and "discount_amount" in existing.keys() else 0))
    if discount_percentage and not discount_amount:
        discount_amount = round(gross_amount * discount_percentage / 100, 2)
    discount_amount = min(max(discount_amount, 0), gross_amount)

    taxable_amount = max(gross_amount - discount_amount, 0)
    tax_percentage = _number(data.get("tax_percentage"), (existing["tax_percentage"] if existing and "tax_percentage" in existing.keys() else 0))
    tax_amount = _number(data.get("tax_amount"), (existing["tax_amount"] if existing and "tax_amount" in existing.keys() else 0))
    if tax_percentage and not tax_amount:
        tax_amount = round(taxable_amount * tax_percentage / 100, 2)

    net_amount = round(max(taxable_amount + tax_amount, 0), 2)
    paid_amount = _number(data.get("paid_amount"), (existing["paid_amount"] if existing and "paid_amount" in existing.keys() else 0))
    paid_amount = min(max(paid_amount, 0), net_amount)
    due_amount = round(max(net_amount - paid_amount, 0), 2)
    status = "paid" if due_amount == 0 else ("partial" if paid_amount > 0 else "due")
    return gross_amount, net_amount, paid_amount, due_amount, status, discount_percentage, discount_amount, tax_percentage, tax_amount



def _blank_to_none(value):
    """Convert empty strings to None so PostgreSQL DATE/TIMESTAMP columns don't fail."""
    if value == "" or value is None:
        return None
    return value



def create_diagnostic_record(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        gross_amount, net_amount, paid_amount, due_amount, status, discount_percentage, discount_amount, tax_percentage, tax_amount = _diagnostic_amounts(data)
        cursor.execute(
            """
            INSERT INTO diagnostics (
                invoice_no, patient_id, vendor_id, doctor_name, test_name, amount, paid_amount, due_amount, status,
                sample_barcode, order_status, collected_at, reported_at,
                patient_name, age, gender, department, visit_type, visit_id,
                bill_date, due_date, payment_mode, transaction_id,
                discount_percentage, discount_amount, tax_percentage, tax_amount,
                report_delivery_mode, report_delivery_date, remarks,
                quantity, unit_rate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?,
                     ?, ?, ?, ?,
                     ?, ?, ?,
                     ?, ?)
            """,
            (
                data.get("invoice_no"),
                data.get("patient_id"),
                data.get("vendor_id"),
                data.get("doctor_name"),
                data["test_name"],
                gross_amount,
                paid_amount,
                due_amount,
                status,
                data.get("sample_barcode"),
                data.get("order_status", "ordered"),
                data.get("collected_at"),
                data.get("reported_at"),
                data.get("patient_name"),
                data.get("age"),
                data.get("gender"),
                _blank_to_none(data.get("department")),
                _blank_to_none(data.get("visit_type")),
                _blank_to_none(data.get("visit_id")),
                _blank_to_none(data.get("bill_date")),
                _blank_to_none(data.get("due_date")),
                _blank_to_none(data.get("payment_mode")),
                _blank_to_none(data.get("transaction_id")),
                discount_percentage,
                discount_amount,
                tax_percentage,
                tax_amount,
                _blank_to_none(data.get("report_delivery_mode")),
                _blank_to_none(data.get("report_delivery_date")),
                _blank_to_none(data.get("remarks")),
                data.get("quantity", 1),
                data.get("unit_rate", 0),
            ),
        )
        diagnostic_id = cursor.lastrowid

        # Automatically insert corresponding global billing invoice if it doesn't exist
        invoice_no = data.get("invoice_no")
        if invoice_no:
            cursor.execute("SELECT id FROM invoices WHERE invoice_no = ?", (invoice_no,))
            existing_inv = cursor.fetchone()
            if not existing_inv:
                cursor.execute(
                    """
                    INSERT INTO invoices (
                        invoice_no, patient_id, module, doctor_name, clinic_name, referral_source,
                        subtotal, tax, discount, total_amount, paid_amount, due_amount, payment_status, created_by,
                        advance_amount, refunded_amount
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        invoice_no,
                        data.get("patient_id"),
                        "LAB",
                        data.get("doctor_name"),
                        None,
                        data.get("remarks") or "Lab Billing",
                        data.get("amount", 0),
                        tax_amount,
                        discount_amount,
                        net_amount,
                        paid_amount,
                        due_amount,
                        status,
                        "System",
                        0.0,
                        0.0
                    )
                )
                if paid_amount > 0:
                    invoice_id = cursor.lastrowid
                    cursor.execute(
                        """
                        INSERT INTO invoice_payments (
                            invoice_id, amount, payment_mode, gateway_ref
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (
                            invoice_id,
                            paid_amount,
                            str(data.get("payment_mode") or "cash").strip().lower().replace(" ", "_"),
                            _blank_to_none(data.get("transaction_id"))
                        )
                    )

        conn.commit()
        return diagnostic_id



def get_lab_categories(db, category_type=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if category_type:
            cursor.execute("SELECT category_name FROM lab_categories WHERE category_type = ? ORDER BY category_name", (category_type,))
        else:
            cursor.execute("SELECT category_name FROM lab_categories ORDER BY category_name")
        return [row["category_name"] for row in cursor.fetchall()]



def add_lab_category(db, category_type, category_name):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        try:
            cursor.execute(
                "INSERT INTO lab_categories (category_type, category_name) VALUES (?, ?)",
                (category_type, category_name)
            )
            conn.commit()
            return cursor.lastrowid
        except Exception:
            return None



def delete_lab_category(db, category_type, category_name):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM lab_categories WHERE category_type = ? AND category_name = ?",
            (category_type, category_name)
        )
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def list_diagnostics(db, patient_id=None, doctor_name=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            clauses.append("patient_id = ?")
            params.append(patient_id)
        if doctor_name:
            clauses.append("doctor_name = ?")
            params.append(doctor_name)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(f"SELECT * FROM diagnostics{where_clause} ORDER BY created_at DESC", tuple(params))
        return cursor.fetchall()



def update_diagnostic_record(db, diagnostic_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diagnostics WHERE id = ?", (diagnostic_id,))
        existing = cursor.fetchone()
        if not existing:
            return False

        def ex(column, default=None):
            try:
                return existing[column] if column in existing.keys() else default
            except Exception:
                return default

        gross_amount, net_amount, paid_amount, due_amount, computed_status, discount_percentage, discount_amount, tax_percentage, tax_amount = _diagnostic_amounts(data, existing)
        status = data.get("status") or computed_status

        cursor.execute(
            """
            UPDATE diagnostics
            SET invoice_no = ?,
                patient_id = ?,
                vendor_id = ?,
                doctor_name = ?,
                test_name = ?,
                amount = ?,
                paid_amount = ?,
                due_amount = ?,
                status = ?,
                sample_barcode = ?,
                order_status = ?,
                collected_at = ?,
                reported_at = ?,
                patient_name = ?,
                age = ?,
                gender = ?,
                department = ?,
                visit_type = ?,
                visit_id = ?,
                bill_date = ?,
                due_date = ?,
                payment_mode = ?,
                transaction_id = ?,
                discount_percentage = ?,
                discount_amount = ?,
                tax_percentage = ?,
                tax_amount = ?,
                report_delivery_mode = ?,
                report_delivery_date = ?,
                remarks = ?,
                quantity = ?,
                unit_rate = ?
            WHERE id = ?
            """,
            (
                data.get("invoice_no", existing["invoice_no"]),
                data.get("patient_id", existing["patient_id"]),
                data.get("vendor_id", existing["vendor_id"]),
                data.get("doctor_name", existing["doctor_name"]),
                data.get("test_name", existing["test_name"]),
                gross_amount,
                paid_amount,
                due_amount,
                status,
                data.get("sample_barcode", existing["sample_barcode"]),
                data.get("order_status", existing["order_status"]),
                data.get("collected_at", existing["collected_at"]),
                data.get("reported_at", existing["reported_at"]),
                data.get("patient_name", ex("patient_name")),
                data.get("age", ex("age")),
                data.get("gender", ex("gender")),
                _blank_to_none(data.get("department", ex("department"))),
                _blank_to_none(data.get("visit_type", ex("visit_type"))),
                _blank_to_none(data.get("visit_id", ex("visit_id"))),
                _blank_to_none(data.get("bill_date", ex("bill_date"))),
                _blank_to_none(data.get("due_date", ex("due_date"))),
                _blank_to_none(data.get("payment_mode", ex("payment_mode"))),
                _blank_to_none(data.get("transaction_id", ex("transaction_id"))),
                discount_percentage,
                discount_amount,
                tax_percentage,
                tax_amount,
                _blank_to_none(data.get("report_delivery_mode", ex("report_delivery_mode"))),
                _blank_to_none(data.get("report_delivery_date", ex("report_delivery_date"))),
                _blank_to_none(data.get("remarks", ex("remarks"))),
                data.get("quantity", ex("quantity", 1)),
                data.get("unit_rate", ex("unit_rate", 0)),
                diagnostic_id,
            ),
        )
        # Update corresponding global billing invoice if it exists
        inv_no = data.get("invoice_no", existing["invoice_no"])
        if inv_no:
            cursor.execute(
                """
                UPDATE invoices
                SET paid_amount = ?, due_amount = ?, payment_status = ?, total_amount = ?, subtotal = ?, tax = ?, discount = ?
                WHERE invoice_no = ?
                """,
                (
                    paid_amount,
                    due_amount,
                    status,
                    net_amount,
                    data.get("amount", existing["amount"]),
                    tax_amount,
                    discount_amount,
                    inv_no
                )
            )
        conn.commit()
        return cursor.rowcount > 0



def delete_diagnostic_record(db, diagnostic_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT invoice_no FROM diagnostics WHERE id = ?", (diagnostic_id,))
        diag = cursor.fetchone()
        if diag and diag["invoice_no"]:
            cursor.execute("DELETE FROM invoices WHERE invoice_no = ?", (diag["invoice_no"],))
        cursor.execute("DELETE FROM diagnostics WHERE id = ?", (diagnostic_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def get_diagnostic_summary(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COALESCE(SUM(amount), 0) AS value FROM diagnostics")
        total_amount = cursor.fetchone()["value"]
        cursor.execute("SELECT COALESCE(SUM(paid_amount), 0) AS value FROM diagnostics")
        total_paid = cursor.fetchone()["value"]
        cursor.execute("SELECT COALESCE(SUM(due_amount), 0) AS value FROM diagnostics")
        total_due = cursor.fetchone()["value"]
    return {"total_amount": total_amount, "total_paid": total_paid, "total_due": total_due}



def list_diagnostic_payments(db, diagnostic_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM diagnostic_payments WHERE diagnostic_id = ? ORDER BY created_at DESC",
            (diagnostic_id,)
        )
        return cursor.fetchall()



def collect_diagnostic_payment(db, diagnostic_id, amount, payment_mode, transaction_ref, operator_name, remarks=None):
    amount = float(amount)
    payment_mode_lower = payment_mode.strip().lower()
    
    with get_connection(db) as conn:
        cursor = conn.cursor()
        
        # 1. Fetch and Lock the diagnostic record for safety
        cursor.execute("SELECT * FROM diagnostics WHERE id = ? FOR UPDATE", (diagnostic_id,))
        record = cursor.fetchone()
        if not record:
            raise ValueError("Diagnostic record not found")
        
        # 2. Extract and compute amounts
        net_amount = round(
            max(
                float(record["amount"])
                - float(record["discount_amount"] or 0)
                + float(record["tax_amount"] or 0),
                0
            ),
            2
        )
        current_paid = float(record["paid_amount"] or 0)
        current_due = round(max(net_amount - current_paid, 0), 2)
        
        # 3. Validate amounts
        if amount <= 0:
            raise ValueError("Payment amount must be greater than zero.")
        if amount > current_due:
            raise ValueError(f"Payment amount ({amount}) cannot exceed remaining due amount ({current_due}).")
        
        # 4. Prevent duplicate payment submissions
        if transaction_ref and transaction_ref.strip():
            cursor.execute(
                "SELECT id FROM diagnostic_payments WHERE transaction_ref = ?",
                (transaction_ref.strip(),)
            )
            if cursor.fetchone():
                raise ValueError(f"Duplicate payment submission: Transaction Reference '{transaction_ref}' has already been processed.")
                
        # Prevent rapid double-clicks on submit with identical fields
        # Look for a payment within the last 5 seconds with same amount and diagnostic_id
        cursor.execute(
            """
            SELECT id FROM diagnostic_payments 
            WHERE diagnostic_id = ? AND payment_amount = ? AND created_at >= NOW() - INTERVAL '5 seconds'
            """,
            (diagnostic_id, amount)
        )
        if cursor.fetchone():
            raise ValueError("Duplicate payment submission: An identical payment was recorded just a few seconds ago.")
        
        # 5. Calculate new amounts
        new_paid = round(current_paid + amount, 2)
        new_due = round(max(net_amount - new_paid, 0), 2)
        new_status = "paid" if new_due == 0 else "partial"
        
        # 6. Insert payment record
        from datetime import date
        payment_date = date.today().isoformat()
        
        cursor.execute(
            """
            INSERT INTO diagnostic_payments (
                diagnostic_id, payment_date, payment_amount, payment_mode, transaction_ref, operator_name, remarks
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                diagnostic_id,
                payment_date,
                amount,
                payment_mode_lower,
                transaction_ref.strip() if transaction_ref else None,
                operator_name.strip() if operator_name else None,
                remarks.strip() if remarks else None
            )
        )
        
        # 7. Update diagnostics record
        cursor.execute(
            """
            UPDATE diagnostics
            SET paid_amount = ?, due_amount = ?, status = ?, payment_mode = ?, transaction_id = ?
            WHERE id = ?
            """,
            (new_paid, new_due, new_status, payment_mode_lower, transaction_ref, diagnostic_id)
        )
        
        # 8. Update corresponding invoices record if exists
        invoice_no = record["invoice_no"]
        if invoice_no:
            cursor.execute(
                """
                UPDATE invoices
                SET paid_amount = ?, due_amount = ?, payment_status = ?
                WHERE invoice_no = ?
                """,
                (new_paid, new_due, new_status, invoice_no)
            )
            
            cursor.execute("SELECT id FROM invoices WHERE invoice_no = ?", (invoice_no,))
            inv_row = cursor.fetchone()
            if inv_row:
                cursor.execute(
                    """
                    INSERT INTO invoice_payments (
                        invoice_id, amount, payment_mode, gateway_ref
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (
                        inv_row["id"],
                        amount,
                        payment_mode_lower,
                        transaction_ref.strip() if transaction_ref else None
                    )
                )
            
        conn.commit()
        return {
            "id": diagnostic_id,
            "paid_amount": new_paid,
            "due_amount": new_due,
            "status": new_status,
            "payment_mode": payment_mode_lower,
            "transaction_id": transaction_ref,
            "operator_name": operator_name
        }



def create_department(db, data, hospital_id=None):
    scoped_hospital_id = hospital_id or data.get("hospital_id") or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO department_master (hospital_id, department_name, mapped_head_employee_id)
            VALUES (?, ?, ?)
            """,
            (scoped_hospital_id, data["department_name"], data.get("mapped_head_employee_id")),
        )
        department_id = cursor.lastrowid
        conn.commit()
        return department_id



def list_departments(db, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM department_master WHERE hospital_id = ? ORDER BY department_name ASC",
            (scoped_hospital_id,),
        )
        rows = cursor.fetchall()
        if not rows:
            cursor.execute("SELECT * FROM department_master ORDER BY department_name ASC")
            rows = cursor.fetchall()
        return rows



def update_department(db, department_id, data, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM department_master WHERE id = ? AND hospital_id = ?",
            (department_id, scoped_hospital_id),
        )
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE department_master
            SET department_name = ?, mapped_head_employee_id = ?
            WHERE id = ? AND hospital_id = ?
            """,
            (
                data.get("department_name", existing["department_name"]),
                data.get("mapped_head_employee_id", existing["mapped_head_employee_id"]),
                department_id,
                scoped_hospital_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_department(db, department_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM department_master WHERE id = ? AND hospital_id = ?",
            (department_id, scoped_hospital_id),
        )
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def delete_department_safe(db, department_id, hospital_id=None):
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        
        try:
            # Get department name to verify it exists
            cursor.execute("SELECT department_name FROM department_master WHERE id = ? AND hospital_id = ?", (department_id, scoped_hospital_id))
            dept = cursor.fetchone()
            if not dept:
                return False, "Department not found."
            
            department_name = dept["department_name"]
            
            # Check for active doctor schedules tied to this department
            cursor.execute("SELECT COUNT(*) as cnt FROM doctor_schedules WHERE department = ?", (department_name,))
            schedule_count = cursor.fetchone()["cnt"]
            if schedule_count > 0:
                return False, f"Cannot delete department '{department_name}' because it has {schedule_count} active doctor schedules."
            
            # If safe, delete the department
            cursor.execute("DELETE FROM department_master WHERE id = ?", (department_id,))
            deleted = cursor.rowcount > 0
                
            conn.commit()
            return deleted, "Department deleted successfully."
        except Exception as e:
            conn.rollback()
            return False, f"Database error: {str(e)}"



def create_attendance(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO attendance (employee_id, attendance_date, status, in_time, out_time, notes)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data["employee_id"],
                data["attendance_date"],
                data["status"],
                data.get("in_time"),
                data.get("out_time"),
                data.get("notes"),
            ),
        )
        attendance_id = cursor.lastrowid
        conn.commit()
        return attendance_id



def list_attendance(db, employee_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if employee_id:
            cursor.execute(
                "SELECT * FROM attendance WHERE employee_id = ? ORDER BY attendance_date DESC",
                (employee_id,),
            )
        else:
            cursor.execute("SELECT * FROM attendance ORDER BY attendance_date DESC")
        return cursor.fetchall()



def update_attendance_record(db, attendance_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM attendance WHERE id = ?", (attendance_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE attendance
            SET employee_id = ?, attendance_date = ?, status = ?, in_time = ?, out_time = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("employee_id", existing["employee_id"]),
                data.get("attendance_date", existing["attendance_date"]),
                data.get("status", existing["status"]),
                data.get("in_time", existing["in_time"]),
                data.get("out_time", existing["out_time"]),
                data.get("notes", existing["notes"]),
                attendance_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_attendance_record(db, attendance_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM attendance WHERE id = ?", (attendance_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_payroll_record(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        net_salary = float(data["basic_salary"]) + float(data.get("allowances", 0)) - float(data.get("deductions", 0))
        cursor.execute(
            """
            INSERT INTO payroll (
                employee_id, payroll_month, basic_salary, allowances, deductions, net_salary, paid_status, paid_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["employee_id"],
                data["payroll_month"],
                data["basic_salary"],
                data.get("allowances", 0),
                data.get("deductions", 0),
                net_salary,
                data.get("paid_status", "pending"),
                data.get("paid_date"),
            ),
        )
        payroll_id = cursor.lastrowid
        conn.commit()
        return payroll_id



def list_payroll(db, employee_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if employee_id:
            cursor.execute(
                "SELECT * FROM payroll WHERE employee_id = ? ORDER BY payroll_month DESC",
                (employee_id,),
            )
        else:
            cursor.execute("SELECT * FROM payroll ORDER BY payroll_month DESC")
        return cursor.fetchall()



def update_payroll_record(db, payroll_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM payroll WHERE id = ?", (payroll_id,))
        existing = cursor.fetchone()
        if not existing:
            return False

        basic_salary = float(data.get("basic_salary", existing["basic_salary"] or 0))
        allowances = float(data.get("allowances", existing["allowances"] or 0))
        deductions = float(data.get("deductions", existing["deductions"] or 0))
        net_salary = basic_salary + allowances - deductions

        cursor.execute(
            """
            UPDATE payroll
            SET employee_id = ?, payroll_month = ?, basic_salary = ?, allowances = ?, deductions = ?, net_salary = ?, paid_status = ?, paid_date = ?
            WHERE id = ?
            """,
            (
                data.get("employee_id", existing["employee_id"]),
                data.get("payroll_month", existing["payroll_month"]),
                basic_salary,
                allowances,
                deductions,
                net_salary,
                data.get("paid_status", existing["paid_status"]),
                data.get("paid_date", existing["paid_date"]),
                payroll_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0



def delete_payroll_record(db, payroll_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM payroll WHERE id = ?", (payroll_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def create_leave_request(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO leave_requests (
                employee_id, leave_type, start_date, end_date, reason, status, decided_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["employee_id"],
                data["leave_type"],
                data["start_date"],
                data["end_date"],
                data.get("reason"),
                data.get("status", "pending"),
                data.get("decided_by"),
            ),
        )
        leave_id = cursor.lastrowid
        conn.commit()
        return leave_id



def update_leave_status(db, leave_id, status, decided_by=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE leave_requests SET status=?, decided_by=? WHERE id=?",
            (status, decided_by, leave_id),
        )
        conn.commit()
        return cursor.rowcount > 0



def list_leave_requests(db, employee_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if employee_id:
            cursor.execute(
                "SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC",
                (employee_id,),
            )
        else:
            cursor.execute("SELECT * FROM leave_requests ORDER BY created_at DESC")
        return cursor.fetchall()



def delete_leave_request(db, leave_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM leave_requests WHERE id = ?", (leave_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted



def add_audit_log(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO audit_logs (
                actor_username, action, module_name, entity_key, payload, ip_address
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("actor_username"),
                data["action"],
                data["module_name"],
                data.get("entity_key"),
                data.get("payload"),
                data.get("ip_address"),
            ),
        )
        log_id = cursor.lastrowid
        conn.commit()
        return log_id



def get_audit_logs(db, module_name=None, limit=100):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        safe_limit = max(1, min(int(limit), 1000))
        if module_name:
            cursor.execute(
                f"""
                SELECT * FROM audit_logs
                WHERE module_name = ?
                ORDER BY created_at DESC
                LIMIT {safe_limit}
                """,
                (module_name,),
            )
        else:
            cursor.execute(
                f"""
                SELECT * FROM audit_logs
                ORDER BY created_at DESC
                LIMIT {safe_limit}
                """
            )
        return cursor.fetchall()



def _to_json_friendly(val):
    if isinstance(val, dict):
        return {k: _to_json_friendly(v) for k, v in val.items()}
    elif isinstance(val, (list, tuple)):
        return [_to_json_friendly(v) for v in val]
    elif isinstance(val, Decimal):
        return float(val) if val % 1 else int(val)
    elif isinstance(val, (datetime, date)):
        return val.isoformat()
    return val



def get_hospital_dashboard_summary(db, selected_date=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        
        # Default behavior (current date semantics)
        selected_date_clause = "DATE(arrival_at) = CURRENT_DATE"
        encounter_date_clause = "to_char(arrival_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        selected_date_params = ()
        target_month_val = None
        date_str = None
        
        # If a date is provided, validate it in Python to prevent executing a failing query
        # that would abort the PostgreSQL transaction state.
        if selected_date:
            try:
                # Handle potential timezone strings like "Z" or custom formats
                clean_date = selected_date.split('T')[0] if 'T' in selected_date else selected_date.split(' ')[0]
                parsed_dt = None
                for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%d-%m-%Y", "%m/%d/%Y"):
                    try:
                        parsed_dt = datetime.strptime(clean_date, fmt)
                        break
                    except ValueError:
                        continue
                if parsed_dt:
                    date_str = parsed_dt.date().isoformat()
                    target_month_val = parsed_dt.strftime("%Y-%m")
                    selected_date_clause = "DATE(arrival_at) = DATE(?)"
                    selected_date_params = (date_str,)
                    encounter_date_clause = "to_char(arrival_at, 'YYYY-MM') = ?"
            except Exception:
                pass

        # 1. Encounters Daily & Monthly counts from actual admissions and appointments tables
        # Daily IP
        cursor.execute(
            f"SELECT COUNT(*) FROM admissions WHERE {selected_date_clause.replace('arrival_at', 'admission_date')}",
            selected_date_params,
        )
        daily_ip = cursor.fetchone()[0]

        # Daily OP
        cursor.execute(
            f"SELECT COUNT(*) FROM appointments WHERE UPPER(visit_type)='OP' AND {selected_date_clause.replace('arrival_at', 'appointment_date')}",
            selected_date_params,
        )
        daily_op = cursor.fetchone()[0]

        # Monthly IP
        if target_month_val:
            cursor.execute(
                "SELECT COUNT(*) FROM admissions WHERE to_char(admission_date, 'YYYY-MM') = ?",
                (target_month_val,),
            )
        else:
            cursor.execute(
                "SELECT COUNT(*) FROM admissions WHERE to_char(admission_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')",
            )
        monthly_ip = cursor.fetchone()[0]

        # Monthly OP
        if target_month_val:
            cursor.execute(
                "SELECT COUNT(*) FROM appointments WHERE UPPER(visit_type)='OP' AND to_char(appointment_date, 'YYYY-MM') = ?",
                (target_month_val,),
            )
        else:
            cursor.execute(
                "SELECT COUNT(*) FROM appointments WHERE UPPER(visit_type)='OP' AND to_char(appointment_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')",
            )
        monthly_op = cursor.fetchone()[0]

        encounter_summary = {
            "daily_ip": daily_ip,
            "daily_op": daily_op,
            "monthly_ip": monthly_ip,
            "monthly_op": monthly_op,
            "daily_accident": 0,
            "monthly_accident": 0,
        }

        # 2. Revenue Summary
        if not date_str:
            IST_TZ = timezone(timedelta(hours=5, minutes=30))
            date_str = datetime.now(IST_TZ).date().isoformat()
            target_month_val = date_str[:7]
            selected_date_clause = f"{date_clause('arrival_at')} = DATE(?)"
            selected_date_params = (date_str,)
            encounter_date_clause = "to_char(arrival_at, 'YYYY-MM') = ?"

        selected_payment_date_clause = f"{date_clause('created_at')}=DATE(?)"
        selected_invoice_date_clause = f"{date_clause('i.created_at')}=DATE(?)"
        selected_diagnostic_date_clause = f"{date_clause('created_at')}=DATE(?)"
        selected_pharmacy_date_clause = f"{date_clause('sold_at')}=DATE(?)"
        
        payment_month_clause = "to_char(created_at, 'YYYY-MM') = ?"
        invoice_month_clause = "to_char(i.created_at, 'YYYY-MM') = ?"
        diagnostic_month_clause = "to_char(created_at, 'YYYY-MM') = ?"
        pharmacy_month_clause = "to_char(sold_at, 'YYYY-MM') = ?"
        
        revenue_query_params = (
            date_str, target_month_val,
            date_str, date_str, target_month_val,
            date_str, date_str, target_month_val,
            date_str, target_month_val
        )

        cursor.execute(
            f"""
            SELECT
                COALESCE(SUM(today_value), 0) AS today_revenue,
                COALESCE(SUM(month_value), 0) AS monthly_revenue,
                COALESCE(SUM(due_value), 0) AS due_collection
            FROM (
                SELECT
                    CASE WHEN {selected_payment_date_clause} THEN amount ELSE 0 END AS today_value,
                    amount AS month_value,
                    0 AS due_value
                FROM invoice_payments
                WHERE {payment_month_clause}
                UNION ALL
                SELECT
                    CASE WHEN {selected_invoice_date_clause}
                         THEN CASE
                             WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                             THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                             ELSE 0
                         END
                         ELSE 0
                    END AS today_value,
                    CASE
                        WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                        THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                        ELSE 0
                    END AS month_value,
                    CASE WHEN {selected_invoice_date_clause} THEN i.due_amount ELSE 0 END AS due_value
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                WHERE {invoice_month_clause}
                UNION ALL
                SELECT
                    CASE WHEN {selected_diagnostic_date_clause} THEN paid_amount ELSE 0 END AS today_value,
                    paid_amount AS month_value,
                    CASE WHEN {selected_diagnostic_date_clause} THEN due_amount ELSE 0 END AS due_value
                FROM diagnostics
                WHERE {diagnostic_month_clause} AND (invoice_no IS NULL OR TRIM(invoice_no) = '')
                UNION ALL
                SELECT
                    CASE WHEN {selected_pharmacy_date_clause} THEN amount ELSE 0 END AS today_value,
                    amount AS month_value,
                    0 AS due_value
                FROM pharmacy_sales
                WHERE {pharmacy_month_clause} AND invoice_id IS NULL
            ) q
            """,
            revenue_query_params,
        )
        revenue_summary = dict(cursor.fetchone() or {})
        
        # Override today/due metrics via central RevenueService
        revenue_summary["today_revenue"] = RevenueService.get_today_collections(db, date_str)
        revenue_summary["due_collection"] = RevenueService.get_today_outstanding(db, date_str)

        # 3. Period Revenue Summary
        date_clause_expr = date_clause("created_at")
        period_revenue_query = f"""
            SELECT
                COALESCE(SUM(CASE WHEN {date_clause_expr}=DATE(?) THEN amount ELSE 0 END), 0) AS today_revenue,
                COALESCE(SUM(CASE WHEN {date_clause_expr}>=DATE(?) - INTERVAL '6 days' AND {date_clause_expr}<=DATE(?) THEN amount ELSE 0 END), 0) AS weekly_revenue,
                COALESCE(SUM(CASE WHEN {date_clause_expr}>=DATE_TRUNC('month', DATE(?)) AND {date_clause_expr}<=DATE(?) THEN amount ELSE 0 END), 0) AS monthly_revenue,
                COALESCE(SUM(CASE WHEN {date_clause_expr}>=DATE_TRUNC('year', DATE(?)) AND {date_clause_expr}<=DATE(?) THEN amount ELSE 0 END), 0) AS yearly_revenue
            FROM (
                SELECT created_at, amount
                FROM invoice_payments
                UNION ALL
                SELECT created_at, paid_amount AS amount
                FROM diagnostics
                WHERE (invoice_no IS NULL OR TRIM(invoice_no) = '')
                UNION ALL
                SELECT sold_at AS created_at, amount
                FROM pharmacy_sales
                WHERE invoice_id IS NULL
            ) q
        """
        period_revenue_params = (date_str, date_str, date_str, date_str, date_str, date_str, date_str)
        cursor.execute(period_revenue_query, period_revenue_params)
        period_revenue_summary = dict(cursor.fetchone() or {})

        # 4. Payment Mode Breakdown
        selected_payment_mode_clause = "DATE(created_at)=CURRENT_DATE"
        selected_diagnostic_mode_clause = "DATE(created_at)=CURRENT_DATE"
        selected_pharmacy_mode_clause = "DATE(sold_at)=CURRENT_DATE"
        selected_invoice_mode_clause = "DATE(i.created_at)=CURRENT_DATE"
        
        mode_breakdown_params = ()
        if date_str:
            selected_payment_mode_clause = "DATE(created_at)=DATE(?)"
            selected_diagnostic_mode_clause = "DATE(created_at)=DATE(?)"
            selected_pharmacy_mode_clause = "DATE(sold_at)=DATE(?)"
            selected_invoice_mode_clause = "DATE(i.created_at)=DATE(?)"
            mode_breakdown_params = (date_str,) * 4

        cursor.execute(
            f"""
            SELECT label, COALESCE(SUM(count), 0) AS count
            FROM (
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(amount), 0) AS count
                FROM invoice_payments
                WHERE {selected_payment_mode_clause}
                GROUP BY label
                UNION ALL
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(paid_amount), 0) AS count
                FROM diagnostics
                WHERE {selected_diagnostic_mode_clause} AND (invoice_no IS NULL OR TRIM(invoice_no) = '')
                GROUP BY label
                UNION ALL
                SELECT NULLIF(TRIM(payment_mode), '') AS label,
                       COALESCE(SUM(amount), 0) AS count
                FROM pharmacy_sales
                WHERE {selected_pharmacy_mode_clause} AND invoice_id IS NULL
                GROUP BY label
                UNION ALL
                SELECT 'cash' AS label,
                       COALESCE(SUM(
                           CASE
                               WHEN i.paid_amount - COALESCE(p.paid_total, 0) > 0
                               THEN i.paid_amount - COALESCE(p.paid_total, 0)
                               ELSE 0
                           END
                       ), 0) AS count
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                WHERE {selected_invoice_mode_clause}
            ) q
            GROUP BY label
            ORDER BY count DESC
            """,
            mode_breakdown_params,
        )
        payment_mode_breakdown = normalize_payment_mode_breakdown([dict(row) for row in cursor.fetchall()])

        # 5. Income by Module and Referrals
        diagnostics_income_month_clause = "to_char(created_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        pharmacy_sales_month_clause = "to_char(sold_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        revenue_module_month_clause_ip = "to_char(ip.created_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        revenue_module_month_clause_i = "to_char(i.created_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        revenue_module_month_clause_diag = "to_char(created_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        revenue_module_month_clause_pharm = "to_char(sold_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        referral_month_clause = "to_char(arrival_at, 'YYYY-MM')=to_char(CURRENT_DATE, 'YYYY-MM')"
        
        diag_income_params = ()
        pharm_sales_params = ()
        module_breakdown_params = ()
        referrals_params = ()
        
        if target_month_val:
            diagnostics_income_month_clause = "to_char(created_at, 'YYYY-MM') = ?"
            diag_income_params = (target_month_val,)
            
            pharmacy_sales_month_clause = "to_char(sold_at, 'YYYY-MM') = ?"
            pharm_sales_params = (target_month_val,)
            
            revenue_module_month_clause_ip = "to_char(ip.created_at, 'YYYY-MM') = ?"
            revenue_module_month_clause_i = "to_char(i.created_at, 'YYYY-MM') = ?"
            revenue_module_month_clause_diag = "to_char(created_at, 'YYYY-MM') = ?"
            revenue_module_month_clause_pharm = "to_char(sold_at, 'YYYY-MM') = ?"
            
            op_billing_today_clause_ip = f"{date_clause('ip.created_at')}=DATE(?)"
            op_billing_today_clause_i = f"{date_clause('i.created_at')}=DATE(?)"
            lab_today_clause = f"{date_clause('created_at')}=DATE(?)"
            pharmacy_today_clause = f"{date_clause('sold_at')}=DATE(?)"
            
            # Setup module breakdown query parameters
            # Subquery 1: today_clause (date_str), month_clause (target_month_val)
            # Subquery 2: today_clause (date_str), month_clause (target_month_val)
            # Subquery 3: today_clause (date_str), month_clause (target_month_val)
            # Subquery 4: today_clause (date_str), month_clause (target_month_val)
            module_breakdown_params = (
                (date_str, target_month_val) +
                (date_str, target_month_val) +
                (date_str, target_month_val) +
                (date_str, target_month_val)
            )
            
            referral_month_clause = "to_char(arrival_at, 'YYYY-MM') = ?"
            referrals_params = (target_month_val,)
        else:
            op_billing_today_clause_ip = "DATE(ip.created_at)=CURRENT_DATE"
            op_billing_today_clause_i = "DATE(i.created_at)=CURRENT_DATE"
            lab_today_clause = "DATE(created_at)=CURRENT_DATE"
            pharmacy_today_clause = "DATE(sold_at)=CURRENT_DATE"

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(total_amount), 0) AS diagnostics_income
            FROM invoices i
            WHERE module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND {invoice_month_clause}
            """,
            diag_income_params
        )
        inv_diag_income_row = cursor.fetchone()
        inv_diag_income = inv_diag_income_row["diagnostics_income"] if inv_diag_income_row else 0

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(amount), 0) AS diagnostics_income
            FROM diagnostics
            WHERE {diagnostics_income_month_clause}
            """,
            diag_income_params
        )
        legacy_diagnostics_row = cursor.fetchone()
        legacy_diag_income = legacy_diagnostics_row["diagnostics_income"] if legacy_diagnostics_row else 0
        diagnostics_income = inv_diag_income + legacy_diag_income

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(amount), 0) AS pharmacy_sales
            FROM pharmacy_sales
            WHERE {pharmacy_sales_month_clause}
            """,
            pharm_sales_params
        )
        pharmacy_sales_row = cursor.fetchone()
        pharmacy_sales = pharmacy_sales_row["pharmacy_sales"] if pharmacy_sales_row else 0

        cursor.execute(
            f"""
            SELECT label,
                   COALESCE(SUM(today_value), 0) AS today_amount,
                   COALESCE(SUM(month_amount), 0) AS month_amount
            FROM (
                SELECT
                    'op_billing' AS label,
                    CASE WHEN {op_billing_today_clause_ip} THEN ip.amount ELSE 0 END AS today_value,
                    ip.amount AS month_amount
                FROM invoice_payments ip
                INNER JOIN invoices i ON i.id = ip.invoice_id
                WHERE i.module = 'OP'
                  AND {revenue_module_month_clause_ip}
                UNION ALL
                SELECT
                    'op_billing' AS label,
                    CASE WHEN {op_billing_today_clause_i}
                         THEN CASE
                             WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                             THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                             ELSE 0
                         END
                         ELSE 0
                    END AS today_value,
                    CASE
                        WHEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
                        THEN (i.paid_amount - COALESCE(p.paid_total, 0)) + i.advance_amount - i.refunded_amount
                        ELSE 0
                    END AS month_amount
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_total
                    FROM invoice_payments
                    GROUP BY invoice_id
                ) p ON p.invoice_id = i.id
                WHERE i.module = 'OP'
                  AND {revenue_module_month_clause_i}
                UNION ALL
                SELECT
                    'lab_diagnostics' AS label,
                    CASE WHEN {lab_today_clause} THEN paid_amount ELSE 0 END AS today_value,
                    paid_amount AS month_amount
                FROM diagnostics
                WHERE {revenue_module_month_clause_diag}
                UNION ALL
                SELECT
                    'pharmacy' AS label,
                    CASE WHEN {pharmacy_today_clause} THEN amount ELSE 0 END AS today_value,
                    amount AS month_amount
                FROM pharmacy_sales
                WHERE {revenue_module_month_clause_pharm}
            ) q
            GROUP BY label
            """,
            module_breakdown_params
        )
        revenue_module_rows = [dict(row) for row in cursor.fetchall()]
        revenue_module_breakdown = {
            "today": {"op_billing": 0, "ip_billing": 0, "lab_diagnostics": 0, "pharmacy": 0, "lab_earned": 0, "lab_collected": 0, "lab_due": 0},
            "monthly": {"op_billing": 0, "ip_billing": 0, "lab_diagnostics": 0, "pharmacy": 0, "lab_earned": 0, "lab_collected": 0, "lab_due": 0},
        }
        for module_row in revenue_module_rows:
            label = module_row.get("label")
            if label in revenue_module_breakdown["today"]:
                revenue_module_breakdown["today"][label] = module_row.get("today_amount", 0) or 0
                revenue_module_breakdown["monthly"][label] = module_row.get("month_amount", 0) or 0

        # Enhance with unified revenue_breakdown (includes IP billing and pharmacy invoices)
        try:
            import revenue_details
            rb_today = revenue_details.revenue_breakdown(db, date_str, 'today')
            rb_month = revenue_details.revenue_breakdown(db, date_str, 'month')

            today_by_key = {r["key"]: r["amount"] for r in rb_today.get("rows", [])}
            month_by_key = {r["key"]: r["amount"] for r in rb_month.get("rows", [])}

            revenue_module_breakdown["today"]["op_billing"] = today_by_key.get("op", revenue_module_breakdown["today"]["op_billing"])
            revenue_module_breakdown["today"]["ip_billing"] = today_by_key.get("ip", 0.0)
            revenue_module_breakdown["today"]["pharmacy"] = today_by_key.get("pharmacy", revenue_module_breakdown["today"]["pharmacy"])
            revenue_module_breakdown["today"]["lab_diagnostics"] = today_by_key.get("lab", revenue_module_breakdown["today"]["lab_diagnostics"])

            revenue_module_breakdown["monthly"]["op_billing"] = month_by_key.get("op", revenue_module_breakdown["monthly"]["op_billing"])
            revenue_module_breakdown["monthly"]["ip_billing"] = month_by_key.get("ip", 0.0)
            revenue_module_breakdown["monthly"]["pharmacy"] = month_by_key.get("pharmacy", revenue_module_breakdown["monthly"]["pharmacy"])
            revenue_module_breakdown["monthly"]["lab_diagnostics"] = month_by_key.get("lab", revenue_module_breakdown["monthly"]["lab_diagnostics"])

            if rb_month.get("total", 0) > 0:
                revenue_summary["monthly_revenue"] = rb_month["total"]
            pharmacy_sales = revenue_module_breakdown["monthly"]["pharmacy"]
        except Exception:
            pass

        # Detailed Lab Revenue breakdown for the selected date
        detailed_lab_params = (date_str,) if date_str else ()
        detailed_lab_clause = f"{date_clause('created_at')}=DATE(?)" if date_str else "DATE(created_at)=CURRENT_DATE"
        detailed_lab_clause_ip = f"{date_clause('ip.created_at')}=DATE(?)" if date_str else "DATE(ip.created_at)=CURRENT_DATE"

        cursor.execute(
            f"""
            SELECT
                COALESCE(SUM(total_amount), 0) AS total_earned,
                COALESCE(SUM(due_amount), 0) AS total_due
            FROM invoices
            WHERE module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND {detailed_lab_clause}
            """,
            detailed_lab_params
        )
        inv_lab_row = cursor.fetchone() or {}
        inv_lab_earned = float(inv_lab_row.get("total_earned") or 0)
        inv_lab_due = float(inv_lab_row.get("total_due") or 0)

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(ip.amount), 0) AS total_collected
            FROM invoice_payments ip
            JOIN invoices i ON i.id = ip.invoice_id
            WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND {detailed_lab_clause_ip}
            """,
            detailed_lab_params
        )
        ip_lab_row = cursor.fetchone() or {}
        inv_lab_collected = float(ip_lab_row.get("total_collected") or 0)

        # Fallback to confirmed orders sum if invoice query returned 0
        if inv_lab_earned == 0:
            cursor.execute(
                f"""
                SELECT COALESCE(SUM(oi.amount), 0) AS total
                FROM diag_order_items oi
                JOIN diag_orders o ON o.id = oi.order_id
                WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL
                  AND {detailed_lab_clause.replace('created_at', 'o.created_at')}
                """,
                detailed_lab_params
            )
            order_sum = float((cursor.fetchone() or {}).get("total") or 0)
            if order_sum > 0:
                inv_lab_earned = order_sum

        # Check legacy diagnostics table
        cursor.execute(
            f"""
            SELECT
                COALESCE(SUM(amount), 0) AS total_earned,
                COALESCE(SUM(paid_amount), 0) AS total_collected,
                COALESCE(SUM(due_amount), 0) AS total_due
            FROM diagnostics
            WHERE {detailed_lab_clause} AND (invoice_no IS NULL OR TRIM(invoice_no) = '')
            """,
            detailed_lab_params
        )
        legacy_lab_row = cursor.fetchone() or {}
        legacy_earned = float(legacy_lab_row.get("total_earned") or 0)
        legacy_collected = float(legacy_lab_row.get("total_collected") or 0)
        legacy_due = float(legacy_lab_row.get("total_due") or 0)

        final_lab_earned = inv_lab_earned + legacy_earned
        final_lab_collected = inv_lab_collected + legacy_collected
        final_lab_due = inv_lab_due + legacy_due
        final_lab_revenue = final_lab_earned if final_lab_earned > 0 else final_lab_collected

        revenue_module_breakdown["today"]["lab_earned"] = final_lab_earned
        revenue_module_breakdown["today"]["lab_collected"] = final_lab_collected
        revenue_module_breakdown["today"]["lab_due"] = final_lab_due
        revenue_module_breakdown["today"]["lab_diagnostics"] = final_lab_revenue

        # Monthly lab calculations
        cursor.execute(
            f"""
            SELECT
                COALESCE(SUM(total_amount), 0) AS total_earned,
                COALESCE(SUM(due_amount), 0) AS total_due
            FROM invoices i
            WHERE module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND {invoice_month_clause}
            """,
            diag_income_params
        )
        m_inv_lab_row = cursor.fetchone() or {}
        m_earned = float(m_inv_lab_row.get("total_earned") or 0)
        m_due = float(m_inv_lab_row.get("total_due") or 0)

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(ip.amount), 0) AS total_collected
            FROM invoice_payments ip
            JOIN invoices i ON i.id = ip.invoice_id
            WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND {revenue_module_month_clause_ip}
            """,
            diag_income_params
        )
        m_ip_lab_row = cursor.fetchone() or {}
        m_collected = float(m_ip_lab_row.get("total_collected") or 0)

        revenue_module_breakdown["monthly"]["lab_earned"] = m_earned
        revenue_module_breakdown["monthly"]["lab_collected"] = m_collected
        revenue_module_breakdown["monthly"]["lab_due"] = m_due
        revenue_module_breakdown["monthly"]["lab_diagnostics"] = m_earned if m_earned > 0 else m_collected

        cursor.execute(
            f"""
            SELECT COALESCE(referral_source, 'unknown') AS label, COUNT(*) AS count
            FROM encounters
            WHERE {referral_month_clause}
            GROUP BY referral_source
            ORDER BY count DESC
            """,
            referrals_params
        )
        referral_summary = [dict(row) for row in cursor.fetchall()]

        # Helper to run scalar SQL queries with optional parameters
        def scalar(query, params=()):
            cursor.execute(query, params)
            row = cursor.fetchone()
            if not row:
                return 0
            value = row[0]
            return value or 0

        # Define date placeholders for operations_today queries
        if date_str:
            date_placeholder = "DATE(?)"
            scalar_date_params = (date_str,)
        else:
            date_placeholder = "CURRENT_DATE"
            scalar_date_params = ()

        patient_registration_total = scalar(
            f"SELECT COUNT(*) FROM patients WHERE DATE(created_at)={date_placeholder}",
            scalar_date_params
        )
        queue_total = scalar(
            f"SELECT COUNT(*) FROM appointments WHERE DATE(COALESCE(appointment_date, created_at))={date_placeholder}",
            scalar_date_params
        )
        queue_completed = scalar(
            f"""
            SELECT COUNT(*) FROM appointments
            WHERE DATE(COALESCE(appointment_date, created_at))={date_placeholder}
              AND LOWER(COALESCE(status, '')) IN ('completed', 'finished', 'consulted', 'done')
            """,
            scalar_date_params
        )
        queue_pending = max(queue_total - queue_completed, 0)

        billing_total = scalar(
            f"SELECT COUNT(*) FROM invoices WHERE DATE(created_at)={date_placeholder}",
            scalar_date_params
        )
        billing_completed = scalar(
            f"""
            SELECT COUNT(*) FROM invoices
            WHERE DATE(created_at)={date_placeholder}
              AND (LOWER(COALESCE(payment_status, ''))='paid' OR COALESCE(paid_amount, 0) > 0)
            """,
            scalar_date_params
        )
        billing_pending = scalar(
            f"""
            SELECT COUNT(*) FROM invoices
            WHERE DATE(created_at)={date_placeholder}
              AND (COALESCE(due_amount, 0) > 0 OR LOWER(COALESCE(payment_status, '')) IN ('due', 'partial', 'pending'))
            """,
            scalar_date_params
        )

        payment_collection_completed = scalar(
            f"""
            SELECT COALESCE(SUM(total_count), 0)
            FROM (
                SELECT COUNT(*) AS total_count FROM invoice_payments WHERE DATE(created_at)={date_placeholder}
                UNION ALL
                SELECT COUNT(*) AS total_count FROM diagnostics WHERE DATE(created_at)={date_placeholder} AND COALESCE(paid_amount, 0) > 0
                UNION ALL
                SELECT COUNT(*) AS total_count FROM pharmacy_sales WHERE DATE(sold_at)={date_placeholder}
            ) q
            """,
            scalar_date_params * 3
        )
        payment_collection_pending = scalar(
            f"""
            SELECT COALESCE(SUM(total_count), 0)
            FROM (
                SELECT COUNT(*) AS total_count FROM invoices WHERE DATE(created_at)={date_placeholder} AND COALESCE(due_amount, 0) > 0
                UNION ALL
                SELECT COUNT(*) AS total_count FROM diagnostics WHERE DATE(created_at)={date_placeholder} AND COALESCE(due_amount, 0) > 0
            ) q
            """,
            scalar_date_params * 2
        )
        payment_collection_total = payment_collection_completed + payment_collection_pending

        today_revenue_record_count = scalar(
            f"""
            SELECT COALESCE(SUM(total_count), 0)
            FROM (
                SELECT COUNT(*) AS total_count FROM invoice_payments WHERE DATE(created_at)={date_placeholder}
                UNION ALL
                SELECT COUNT(*) AS total_count FROM invoices WHERE DATE(created_at)={date_placeholder}
                UNION ALL
                SELECT COUNT(*) AS total_count FROM diagnostics WHERE DATE(created_at)={date_placeholder}
                UNION ALL
                SELECT COUNT(*) AS total_count FROM pharmacy_sales WHERE DATE(sold_at)={date_placeholder}
            ) q
            """,
            scalar_date_params * 4
        )
        revenue_reporting_count = 1 if today_revenue_record_count > 0 else 0

        # Payout Summary Dates
        payout_total_query = "SELECT COUNT(*) FROM doctor_payouts WHERE DATE(created_at)=CURRENT_DATE OR payout_month=to_char(CURRENT_DATE, 'YYYY-MM')"
        payout_completed_query = """
            SELECT COUNT(*) FROM doctor_payouts
            WHERE (DATE(created_at)=CURRENT_DATE OR payout_month=to_char(CURRENT_DATE, 'YYYY-MM'))
              AND (LOWER(COALESCE(status, ''))='paid' OR COALESCE(due_amount, 0)=0)
        """
        payout_ready_query = """
            SELECT COALESCE(SUM(
                CASE
                    WHEN COALESCE(due_amount, 0) > 0 THEN due_amount
                    WHEN LOWER(COALESCE(status, '')) IN ('pending', 'partial') THEN GREATEST(COALESCE(amount, 0) - COALESCE(paid_amount, 0), 0)
                    ELSE 0
                END
            ), 0)
            FROM doctor_payouts
            WHERE to_char(CURRENT_DATE, 'YYYY-MM') IN (payout_month, to_char(created_at::date, 'YYYY-MM'))
        """
        payout_total_params = ()
        payout_completed_params = ()
        payout_ready_params = ()

        if date_str and target_month_val:
            payout_total_query = "SELECT COUNT(*) FROM doctor_payouts WHERE DATE(created_at)=DATE(?) OR payout_month=?"
            payout_total_params = (date_str, target_month_val)
            
            payout_completed_query = """
                SELECT COUNT(*) FROM doctor_payouts
                WHERE (DATE(created_at)=DATE(?) OR payout_month=?)
                  AND (LOWER(COALESCE(status, ''))='paid' OR COALESCE(due_amount, 0)=0)
            """
            payout_completed_params = (date_str, target_month_val)
            
            payout_ready_query = """
                SELECT COALESCE(SUM(
                    CASE
                        WHEN COALESCE(due_amount, 0) > 0 THEN due_amount
                        WHEN LOWER(COALESCE(status, '')) IN ('pending', 'partial') THEN GREATEST(COALESCE(amount, 0) - COALESCE(paid_amount, 0), 0)
                        ELSE 0
                    END
                ), 0)
                FROM doctor_payouts
                WHERE ? IN (payout_month, to_char(created_at::date, 'YYYY-MM'))
            """
            payout_ready_params = (target_month_val,)

        doctor_payout_total = scalar(payout_total_query, payout_total_params)
        doctor_payout_completed = scalar(payout_completed_query, payout_completed_params)
        doctor_payout_pending = max(doctor_payout_total - doctor_payout_completed, 0)
        doctor_payout_ready = RevenueService.get_today_doctor_payout(db, date_str)

        # Detailed Pharmacy metrics
        pharm_today_sales = revenue_module_breakdown["today"].get("pharmacy", 0) or 0
        detailed_pharmacy_params = (date_str,) if date_str else ()
        detailed_pharmacy_clause = f"{date_clause('sold_at')}=DATE(?)" if date_str else "DATE(sold_at)=CURRENT_DATE"
        pharm_today_txs = scalar(
            f"SELECT COUNT(*) FROM pharmacy_sales WHERE {detailed_pharmacy_clause}",
            detailed_pharmacy_params
        )
        indent_dispensed_clause = f"{date_clause('dispensed_at')}=DATE(?)" if date_str else "DATE(dispensed_at)=CURRENT_DATE"
        try:
            pharm_today_indents = scalar(
                f"SELECT COUNT(*) FROM ward_indents WHERE {indent_dispensed_clause} AND LOWER(status) = 'dispensed'",
                detailed_pharmacy_params
            )
        except Exception:
            pharm_today_indents = 0

        # Bed Management stats -- sourced from the real per-bed inventory
        # (hospital_beds), not the legacy bed_config.capacity number, which
        # never reflects the actual ICU/General Ward/Single Room bed count.
        try:
            cursor.execute("SELECT COUNT(*) FROM hospital_beds")
            bed_capacity = cursor.fetchone()[0] or 0
        except Exception:
            bed_capacity = 0

        try:
            cursor.execute("SELECT COUNT(*) FROM hospital_beds WHERE LOWER(status) = 'occupied'")
            bed_occupied = cursor.fetchone()[0] or 0
        except Exception:
            bed_occupied = 0

        bed_available = max(bed_capacity - bed_occupied, 0)
        bed_occupancy_rate = round((bed_occupied / bed_capacity) * 100, 1) if bed_capacity > 0 else 0
        bed_stats = {
            "capacity": bed_capacity,
            "occupied": bed_occupied,
            "available": bed_available,
            "occupancy_rate": bed_occupancy_rate,
        }

        try:
            cursor.execute("""
                SELECT ward,
                       COUNT(*) AS capacity,
                       COALESCE(SUM(CASE WHEN LOWER(status) = 'occupied' THEN 1 ELSE 0 END), 0) AS occupied
                FROM hospital_beds
                GROUP BY ward
                ORDER BY ward
            """)
            ward_breakdown = [
                {
                    "ward": row["ward"],
                    "capacity": int(row["capacity"] or 0),
                    "occupied": int(row["occupied"] or 0),
                    "available": max(int(row["capacity"] or 0) - int(row["occupied"] or 0), 0),
                }
                for row in cursor.fetchall()
            ]
        except Exception:
            ward_breakdown = []

        operations_today = {
            "patient_registration": {"count": patient_registration_total, "completed": patient_registration_total, "pending": 0},
            "queue_management": {"count": queue_total, "completed": queue_completed, "pending": queue_pending},
            "doctor_consultation": {"count": queue_total, "completed": queue_completed, "pending": queue_pending},
            "bed_management": {"count": bed_capacity, "completed": bed_occupied, "pending": bed_available},
            "pharmacy": {"count": pharm_today_txs + pharm_today_indents, "completed": pharm_today_txs + pharm_today_indents, "pending": 0},
            "billing": {"count": billing_total, "completed": billing_completed, "pending": billing_pending},
            "payment_collection": {"count": payment_collection_total, "completed": payment_collection_completed, "pending": payment_collection_pending},
            "revenue_reporting": {"count": revenue_reporting_count, "completed": revenue_reporting_count, "pending": 0},
            "doctor_payout": {"count": doctor_payout_total, "completed": doctor_payout_completed, "pending": doctor_payout_pending},
        }

        # 4. Visit and Registration breakdown (New Registrations, Revisits, Follow-ups)
        target_reg_date = date_str or current_ist_datetime().strftime("%Y-%m-%d")
        cursor.execute(
            "SELECT COUNT(*) FROM patients WHERE DATE(created_at) = DATE(?)",
            (target_reg_date,)
        )
        new_reg_count = cursor.fetchone()[0] or 0

        cursor.execute(
            """
            SELECT 
                a.id, a.patient_id, a.patient_name, a.visit_type, a.appointment_kind,
                a.doctor_name, a.department, a.appointment_date, a.notes, a.token_no,
                p.age, p.gender, p.phone, p.created_at AS patient_created_at
            FROM appointments a
            LEFT JOIN patients p ON p.patient_id = a.patient_id
            WHERE DATE(a.appointment_date) = DATE(?)
            ORDER BY a.token_no ASC, a.appointment_date ASC
            """,
            (target_reg_date,)
        )
        appt_rows = cursor.fetchall()

        cursor.execute(
            """
            SELECT 
                adm.id, adm.patient_id, adm.admission_date, adm.notes,
                p.name, p.middle_name, p.last_name, p.age, p.gender, p.phone, p.created_at AS patient_created_at
            FROM admissions adm
            LEFT JOIN patients p ON p.patient_id = adm.patient_id
            WHERE DATE(adm.admission_date) = DATE(?)
            ORDER BY adm.admission_date ASC
            """,
            (target_reg_date,)
        )
        adm_rows = cursor.fetchall()

        follow_up_records = []
        revisit_records = []
        seen_revisit_keys = set()

        for a in appt_rows:
            a_dict = dict(a)
            pid = a_dict.get("patient_id") or f"appt-{a_dict.get('id')}"
            pname = a_dict.get("patient_name") or "Patient"
            notes = a_dict.get("notes") or ""
            kind = (a_dict.get("appointment_kind") or "").lower()
            vtype = (a_dict.get("visit_type") or "").lower()
            app_dt = str(a_dict.get("appointment_date") or "")[:10] or target_reg_date
            p_created = str(a_dict.get("patient_created_at") or "")[:10]

            is_fu = kind == "follow_up" or "follow" in vtype or "follow" in notes.lower()
            is_rev = ("[re-visit details]" in notes.lower()) or (kind in ["review", "revisit"]) or (bool(p_created) and p_created < app_dt)

            rec = {
                "patient_id": a_dict.get("patient_id"),
                "patient_name": pname,
                "age": a_dict.get("age"),
                "gender": a_dict.get("gender"),
                "phone": a_dict.get("phone"),
                "doctor_name": a_dict.get("doctor_name"),
                "department": a_dict.get("department"),
                "visit_type": a_dict.get("visit_type") or "OP",
                "appointment_kind": a_dict.get("appointment_kind") or "new",
                "notes": notes,
                "token_no": a_dict.get("token_no"),
                "source": "appointment",
                "visit_date": app_dt,
            }

            if is_fu:
                follow_up_records.append(rec)
            if is_rev:
                key = f"{pid}-{app_dt}"
                if key not in seen_revisit_keys:
                    seen_revisit_keys.add(key)
                    revisit_records.append(rec)

        for adm in adm_rows:
            adm_dict = dict(adm)
            pid = adm_dict.get("patient_id") or f"adm-{adm_dict.get('id')}"
            parts = [adm_dict.get("name"), adm_dict.get("middle_name"), adm_dict.get("last_name")]
            pname = " ".join([p for p in parts if p]) or pid
            notes = adm_dict.get("notes") or ""
            adm_dt = str(adm_dict.get("admission_date") or "")[:10] or target_reg_date
            p_created = str(adm_dict.get("patient_created_at") or "")[:10]

            is_rev = ("[re-visit details]" in notes.lower()) or (bool(p_created) and p_created < adm_dt)
            if is_rev:
                key = f"{pid}-{adm_dt}"
                if key not in seen_revisit_keys:
                    seen_revisit_keys.add(key)
                    revisit_records.append({
                        "patient_id": adm_dict.get("patient_id"),
                        "patient_name": pname,
                        "age": adm_dict.get("age"),
                        "gender": adm_dict.get("gender"),
                        "phone": adm_dict.get("phone"),
                        "doctor_name": None,
                        "department": "In-Patient",
                        "visit_type": "IP",
                        "appointment_kind": "revisit",
                        "notes": notes,
                        "token_no": None,
                        "source": "admission",
                        "visit_date": adm_dt,
                    })

        registration_summary = {
            "date": target_reg_date,
            "new_registrations": new_reg_count,
            "revisits": len(revisit_records),
            "follow_ups": len(follow_up_records),
            "total_visits": new_reg_count + len(revisit_records),
            "revisit_records": revisit_records,
            "follow_up_records": follow_up_records,
        }

    return _to_json_friendly({
        "ip_op_counts": {
            "daily_ip": encounter_summary.get("daily_ip", 0) or 0,
            "daily_op": encounter_summary.get("daily_op", 0) or 0,
            "monthly_ip": encounter_summary.get("monthly_ip", 0) or 0,
            "monthly_op": encounter_summary.get("monthly_op", 0) or 0,
        },
        "accidents": {
            "daily": encounter_summary.get("daily_accident", 0) or 0,
            "monthly": encounter_summary.get("monthly_accident", 0) or 0,
        },
        "revenue": {
            "total": revenue_summary.get("monthly_revenue", 0) or 0,
            "today_total": revenue_summary.get("today_revenue", 0) or 0,
            "weekly_revenue": period_revenue_summary.get("weekly_revenue", 0) or 0,
            "weekly_total": period_revenue_summary.get("weekly_revenue", 0) or 0,
            "monthly_total": revenue_summary.get("monthly_revenue", 0) or 0,
            "monthly_revenue": revenue_summary.get("monthly_revenue", 0) or 0,
            "yearly_revenue": period_revenue_summary.get("yearly_revenue", 0) or 0,
            "yearly_total": period_revenue_summary.get("yearly_revenue", 0) or 0,
            "due": revenue_summary.get("due_collection", 0) or 0,
            "today_collection": period_revenue_summary.get("today_revenue", 0) or 0,
            "total_collection": period_revenue_summary.get("monthly_revenue", 0) or 0,
            "pending_payments": revenue_summary.get("due_collection", 0) or 0,
            "paid_payments": period_revenue_summary.get("monthly_revenue", 0) or 0,
            "doctor_payout_ready": doctor_payout_ready,
            "payment_mode_breakdown": payment_mode_breakdown,
            "module_breakdown": revenue_module_breakdown,
        },
        "payment_summary": {
            "total_collection": period_revenue_summary.get("monthly_revenue", 0) or 0,
            "pending_payments": revenue_summary.get("due_collection", 0) or 0,
            "paid_payments": period_revenue_summary.get("monthly_revenue", 0) or 0,
            "today_collection": period_revenue_summary.get("today_revenue", 0) or 0,
        },
        "pharmacy_summary": {
            "today_sales": pharm_today_sales,
            "monthly_sales": pharmacy_sales,
            "today_transactions": pharm_today_txs,
            "today_indents_dispensed": pharm_today_indents,
        },
        "bed_stats": bed_stats,
        "bed_ward_breakdown": ward_breakdown,
        "diagnostics_summary": {"monthly_income": diagnostics_income},
        "operations_today": operations_today,
        "referrals": referral_summary,
        "registration_summary": registration_summary,
    })



def create_shared_export(db, share_token, file_path, file_name, mime_type):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO shared_exports (share_token, file_path, file_name, mime_type)
            VALUES (?, ?, ?, ?)
            """,
            (share_token, file_path, file_name, mime_type),
        )
        conn.commit()



def get_shared_export(db, share_token):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM shared_exports
            WHERE share_token = ?
            """,
            (share_token,),
        )
        return cursor.fetchone()


# ==================== Lab & Diagnostics: Test Catalogue ====================


def create_diag_service(db, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_services WHERE code = ?", (data["code"],))
        if cursor.fetchone():
            raise ValueError(f"Service code '{data['code']}' already exists.")
        cursor.execute(
            """
            INSERT INTO diag_services (
                code, name, service_type, department, active, turnaround_time, turnaround_hours,
                preparation_requirements, specimen_type, container_type, modality,
                body_region, laterality, requires_scheduling, report_template, rate, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["code"].strip(),
                data["name"].strip(),
                data["service_type"],
                data.get("department"),
                bool(data.get("active", True)),
                data.get("turnaround_time"),
                float(data["turnaround_hours"]) if data.get("turnaround_hours") not in (None, "") else None,
                data.get("preparation_requirements"),
                data.get("specimen_type"),
                data.get("container_type"),
                data.get("modality"),
                data.get("body_region"),
                data.get("laterality"),
                bool(data.get("requires_scheduling", False)),
                data.get("report_template", "generic"),
                float(data.get("rate", 0) or 0),
                username,
            ),
        )
        service_id = cursor.lastrowid
        cursor.execute(
            "INSERT INTO diag_service_pricing_history (service_id, rate, payer_type, changed_by) VALUES (?, ?, 'standard', ?)",
            (service_id, float(data.get("rate", 0) or 0), username),
        )
        conn.commit()
        return service_id



def list_diag_services(db, service_type=None, department=None, active_only=None, search=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if service_type:
            clauses.append("service_type = ?")
            params.append(service_type)
        if department:
            clauses.append("department = ?")
            params.append(department)
        if active_only is not None:
            clauses.append("active = ?")
            params.append(bool(active_only))
        if search:
            clauses.append("(LOWER(name) LIKE ? OR LOWER(code) LIKE ?)")
            like = f"%{search.strip().lower()}%"
            params.extend([like, like])
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(f"SELECT * FROM diag_services{where_clause} ORDER BY name ASC", tuple(params))
        return cursor.fetchall()



def get_diag_service(db, service_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_services WHERE id = ?", (service_id,))
        return cursor.fetchone()



def update_diag_service(db, service_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_services WHERE id = ?", (service_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        new_rate = float(data.get("rate", existing["rate"]) or 0)
        new_turnaround_hours = data.get("turnaround_hours", existing["turnaround_hours"])
        new_turnaround_hours = float(new_turnaround_hours) if new_turnaround_hours not in (None, "") else None
        cursor.execute(
            """
            UPDATE diag_services
            SET name=?, service_type=?, department=?, active=?, turnaround_time=?, turnaround_hours=?,
                preparation_requirements=?, specimen_type=?, container_type=?, modality=?,
                body_region=?, laterality=?, requires_scheduling=?, report_template=?, rate=?
            WHERE id=?
            """,
            (
                data.get("name", existing["name"]),
                data.get("service_type", existing["service_type"]),
                data.get("department", existing["department"]),
                bool(data.get("active", existing["active"])),
                data.get("turnaround_time", existing["turnaround_time"]),
                new_turnaround_hours,
                data.get("preparation_requirements", existing["preparation_requirements"]),
                data.get("specimen_type", existing["specimen_type"]),
                data.get("container_type", existing["container_type"]),
                data.get("modality", existing["modality"]),
                data.get("body_region", existing["body_region"]),
                data.get("laterality", existing["laterality"]),
                bool(data.get("requires_scheduling", existing["requires_scheduling"])),
                data.get("report_template", existing["report_template"]),
                new_rate,
                service_id,
            ),
        )
        if abs(new_rate - float(existing["rate"] or 0)) > 1e-9:
            cursor.execute(
                "INSERT INTO diag_service_pricing_history (service_id, rate, payer_type, changed_by) VALUES (?, ?, 'standard', ?)",
                (service_id, new_rate, username),
            )
        conn.commit()
        return True



def deactivate_diag_service(db, service_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE diag_services SET active = FALSE WHERE id = ?", (service_id,))
        conn.commit()
        return cursor.rowcount > 0



def get_diag_service_pricing_history(db, service_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM diag_service_pricing_history WHERE service_id = ? ORDER BY changed_at DESC",
            (service_id,),
        )
        return cursor.fetchall()



def list_diag_service_parameters(db, service_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM diag_service_parameters WHERE service_id = ? ORDER BY display_order ASC, id ASC",
            (service_id,),
        )
        return cursor.fetchall()



def replace_diag_service_parameters(db, service_id, parameters):
    """Replaces the full parameter set for a service with the given list.
    Historical results already recorded keep their own copied unit/reference-range
    values (see diag_results), so this never rewrites past reports."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_services WHERE id = ?", (service_id,))
        if not cursor.fetchone():
            raise ValueError("Service not found.")
        cursor.execute("DELETE FROM diag_service_parameters WHERE service_id = ?", (service_id,))
        for idx, p in enumerate(parameters):
            cursor.execute(
                """
                INSERT INTO diag_service_parameters (
                    service_id, name, data_type, unit, method, ref_low, ref_high, ref_text,
                    critical_low, critical_high, sex_specific, age_min, age_max, display_order,
                    calc_formula, comments
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    service_id,
                    p["name"],
                    p.get("data_type", "numeric"),
                    p.get("unit"),
                    p.get("method"),
                    p.get("ref_low"),
                    p.get("ref_high"),
                    p.get("ref_text"),
                    p.get("critical_low"),
                    p.get("critical_high"),
                    p.get("sex_specific") or None,
                    p.get("age_min"),
                    p.get("age_max"),
                    p.get("display_order", idx),
                    p.get("calc_formula"),
                    p.get("comments"),
                ),
            )
        conn.commit()
        return True



def create_diag_package(db, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_packages WHERE code = ?", (data["code"],))
        if cursor.fetchone():
            raise ValueError(f"Package code '{data['code']}' already exists.")
        cursor.execute(
            "INSERT INTO diag_packages (code, name, active, rate, created_by) VALUES (?, ?, ?, ?, ?)",
            (data["code"].strip(), data["name"].strip(), bool(data.get("active", True)), float(data.get("rate", 0) or 0), username),
        )
        package_id = cursor.lastrowid
        service_ids = data.get("service_ids") or []
        seen = set()
        for sid in service_ids:
            if sid in seen:
                continue
            seen.add(sid)
            cursor.execute(
                "INSERT INTO diag_package_items (package_id, service_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                (package_id, sid),
            )
        conn.commit()
        return package_id



def list_diag_packages(db, active_only=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        where_clause = " WHERE active = TRUE" if active_only else ""
        cursor.execute(f"SELECT * FROM diag_packages{where_clause} ORDER BY name ASC")
        packages = cursor.fetchall()
        result = []
        for pkg in packages:
            cursor.execute(
                """
                SELECT s.id, s.code, s.name, s.service_type, s.rate
                FROM diag_package_items pi JOIN diag_services s ON s.id = pi.service_id
                WHERE pi.package_id = ?
                """,
                (pkg["id"],),
            )
            items = cursor.fetchall()
            pkg_dict = dict(pkg)
            pkg_dict["items"] = [dict(i) for i in items]
            result.append(pkg_dict)
        return result



def update_diag_package(db, package_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_packages WHERE id = ?", (package_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            "UPDATE diag_packages SET name=?, active=?, rate=? WHERE id=?",
            (
                data.get("name", existing["name"]),
                bool(data.get("active", existing["active"])),
                float(data.get("rate", existing["rate"]) or 0),
                package_id,
            ),
        )
        if data.get("service_ids") is not None:
            cursor.execute("DELETE FROM diag_package_items WHERE package_id = ?", (package_id,))
            seen = set()
            for sid in data["service_ids"]:
                if sid in seen:
                    continue
                seen.add(sid)
                cursor.execute("INSERT INTO diag_package_items (package_id, service_id) VALUES (?, ?)", (package_id, sid))
        conn.commit()
        return True



def _generate_diag_order_no(cursor=None):
    import random
    return _unused_code(cursor, "diag_orders", "order_no",
                        lambda: f"LABORD-{datetime.now().strftime('%y%m%d%H%M%S')}{random.randint(10, 99)}")



def _generate_specimen_no(cursor=None):
    import random
    return _unused_code(cursor, "diag_specimens", "specimen_no",
                        lambda: f"SPC-{datetime.now().strftime('%y%m%d')}-{random.randint(1000, 9999)}")


def _unused_code(cursor, table, column, make_code, attempts=25):
    """The random suffixes above are short (90 order numbers per second, 9000 specimen
    numbers per day), so collisions with the UNIQUE constraint are routine on a busy
    day -- and also within one order that has several tests. Re-draw until unused."""
    code = make_code()
    if cursor is None:
        return code
    for _ in range(attempts):
        cursor.execute(f"SELECT 1 FROM {table} WHERE {column} = ?", (code,))
        if not cursor.fetchone():
            return code
        code = make_code()
    raise ValueError("Could not allocate a unique number. Please try again.")


def _db_now(cursor):
    """Database clock in the same (naive, session-timezone) basis as the CURRENT_TIMESTAMP
    values stored in diag_* timestamps, so TAT is right even if the app server's timezone
    differs from the database's."""
    cursor.execute("SELECT LOCALTIMESTAMP AS now")
    return cursor.fetchone()["now"]



def create_diag_order(db, data, username=None):
    is_external_sale = str(data.get("sale_type") or "INTERNAL").upper() == "EXTERNAL"
    items = data.get("items") or []
    if not items:
        raise ValueError("At least one service must be selected.")
    if is_external_sale:
        # Walk-in sale: no UHID, identified by name + mobile only.
        patient_id = None
        encounter_type = "EXTERNAL"
        walkin_name = (data.get("walkin_name") or "").strip()
        if not walkin_name:
            raise ValueError("Patient name is required for an external sale.")
        from phone import validate_phone
        walkin_mobile, walkin_country_code, mobile_error = validate_phone(
            data.get("walkin_mobile"), data.get("walkin_country_code"), required=True, label="Mobile number")
        if mobile_error:
            raise ValueError(mobile_error)
        walkin_age = str(data.get("walkin_age") or "").strip() or None
        walkin_gender = (data.get("walkin_gender") or "").strip() or None
        external_source = (data.get("external_source") or "").strip() or "Walk-in"
    else:
        patient_id = data["patient_id"]
        encounter_type = data["encounter_type"]
        walkin_name = walkin_mobile = walkin_age = walkin_gender = walkin_country_code = None
        external_source = data.get("external_source")
        if encounter_type not in ("OP", "IP", "EMERGENCY", "EXTERNAL"):
            raise ValueError("Invalid encounter type.")
        if encounter_type == "IP" and not data.get("admission_id"):
            raise ValueError("An IPD order requires the patient's active admission.")
        if encounter_type in ("OP", "EMERGENCY") and not data.get("appointment_id"):
            raise ValueError(f"A {encounter_type} order requires the selected visit.")
        if encounter_type == "EXTERNAL" and not (data.get("external_source") or "").strip():
            raise ValueError("An external order requires the referring source.")

    with get_connection(db) as conn:
        cursor = conn.cursor()
        if not is_external_sale:
            cursor.execute("SELECT patient_id FROM patients WHERE patient_id = ?", (patient_id,))
            if not cursor.fetchone():
                raise ValueError("Patient not found.")
            if encounter_type == "IP":
                cursor.execute("SELECT id FROM admissions WHERE id = ? AND patient_id = ?", (data["admission_id"], patient_id))
                if not cursor.fetchone():
                    raise ValueError("Admission does not belong to this patient.")
            if encounter_type in ("OP", "EMERGENCY"):
                cursor.execute("SELECT id FROM appointments WHERE id = ? AND patient_id = ?", (data["appointment_id"], patient_id))
                if not cursor.fetchone():
                    raise ValueError("Visit does not belong to this patient.")

        order_no = _generate_diag_order_no(cursor)
        cursor.execute(
            """
            INSERT INTO diag_orders (
                order_no, patient_id, encounter_type, appointment_id, admission_id, external_source,
                referring_clinician, priority, clinical_indication, notes, source_document_id, status, created_by,
                sale_type, walkin_name, walkin_mobile, walkin_age, walkin_gender, service_type, walkin_country_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_no,
                patient_id,
                encounter_type,
                None if is_external_sale else data.get("appointment_id"),
                None if is_external_sale else data.get("admission_id"),
                external_source,
                data.get("referring_clinician"),
                data.get("priority", "Routine"),
                data.get("clinical_indication"),
                data.get("notes"),
                data.get("source_document_id"),
                username,
                "EXTERNAL" if is_external_sale else "INTERNAL",
                walkin_name, walkin_mobile, walkin_age, walkin_gender,
                # Outsourcing / Home Visit orders set their own type (diag_service_types.create_service_order).
                "EXTERNAL" if is_external_sale else "IN_HOUSE",
                walkin_country_code,
            ),
        )
        order_id = cursor.lastrowid

        for item in items:
            cursor.execute("SELECT * FROM diag_services WHERE id = ? AND active = TRUE", (item["service_id"],))
            svc = cursor.fetchone()
            if not svc:
                raise ValueError(f"Service {item.get('service_id')} is not available.")
            quantity = int(item.get("quantity", 1) or 1)
            rate = float(svc["rate"])
            discount = float(item.get("discount", 0) or 0)
            amount = max(rate * quantity - discount, 0.0)
            if item.get("is_duplicate_repeat") and not (item.get("duplicate_reason") or "").strip():
                raise ValueError(f"A reason is required to repeat {svc['name']} for this encounter.")
            cursor.execute(
                """
                INSERT INTO diag_order_items (
                    order_id, service_id, service_name, department_type, quantity, rate, discount, amount,
                    is_duplicate_repeat, duplicate_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    order_id, svc["id"], svc["name"], svc["service_type"], quantity, rate, discount, amount,
                    bool(item.get("is_duplicate_repeat", False)), item.get("duplicate_reason"),
                ),
            )
        conn.commit()
        return order_id



def check_diag_duplicate_active_services(db, patient_id, service_ids, admission_id=None, appointment_id=None):
    """Returns service_ids that already have a non-cancelled active order item for this encounter."""
    if not service_ids:
        return []
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = ["o.patient_id = ?", "oi.service_id = ANY(?)", "oi.cancelled_at IS NULL", "o.status = 'confirmed'"]
        params = [patient_id, service_ids]
        if admission_id:
            clauses.append("o.admission_id = ?")
            params.append(admission_id)
        elif appointment_id:
            clauses.append("o.appointment_id = ?")
            params.append(appointment_id)
        cursor.execute(
            f"SELECT DISTINCT oi.service_id FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id WHERE {' AND '.join(clauses)}",
            tuple(params),
        )
        return [row["service_id"] for row in cursor.fetchall()]



def find_recent_diag_services(db, patient_id, service_ids, days=7, admission_id=None, appointment_id=None):
    """Latest confirmed order of each service for this patient in the last `days` days, from
    other visits. Advisory only ("CBC done 2 days ago"); same-visit repeats are blocked by
    check_diag_duplicate_active_services instead."""
    if not service_ids:
        return []
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = ["o.patient_id = ?", "oi.service_id = ANY(?)", "oi.cancelled_at IS NULL", "o.status = 'confirmed'",
                   "COALESCE(o.confirmed_at, o.created_at) >= CURRENT_TIMESTAMP - (? * INTERVAL '1 day')"]
        params = [patient_id, service_ids, int(days)]
        if admission_id:
            clauses.append("(o.admission_id IS NULL OR o.admission_id <> ?)")
            params.append(admission_id)
        elif appointment_id:
            clauses.append("(o.appointment_id IS NULL OR o.appointment_id <> ?)")
            params.append(appointment_id)
        cursor.execute(
            f"""
            SELECT DISTINCT ON (oi.service_id) oi.service_id, oi.service_name, oi.progress_status, o.order_no,
                   COALESCE(o.confirmed_at, o.created_at) AS ordered_at
            FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
            WHERE {' AND '.join(clauses)}
            ORDER BY oi.service_id, COALESCE(o.confirmed_at, o.created_at) DESC
            """,
            tuple(params),
        )
        return [dict(row) for row in cursor.fetchall()]



def get_diag_order(db, order_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_orders WHERE id = ?", (order_id,))
        order = cursor.fetchone()
        if not order:
            return None
        order_dict = dict(order)
        cursor.execute("SELECT * FROM diag_order_items WHERE order_id = ? ORDER BY id ASC", (order_id,))
        order_dict["items"] = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT name, last_name, phone, dob, gender FROM patients WHERE patient_id = ?", (order_dict["patient_id"],))
        p = cursor.fetchone()
        if p:
            order_dict["patient_name"] = f"{p['name']} {p['last_name'] or ''}".strip()
            order_dict["patient_phone"] = p["phone"]
        elif order_dict.get("walkin_name"):
            order_dict["patient_name"] = order_dict["walkin_name"]
            order_dict["patient_phone"] = order_dict.get("walkin_mobile")
        return order_dict



def list_diag_orders(db, patient_id=None, status=None, department_type=None, priority=None, encounter_type=None, admission_id=None, sale_type=None, search=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if patient_id:
            clauses.append("o.patient_id = ?")
            params.append(patient_id)
        if status:
            clauses.append("o.status = ?")
            params.append(status)
        if priority:
            clauses.append("o.priority = ?")
            params.append(priority)
        if encounter_type:
            clauses.append("o.encounter_type = ?")
            params.append(encounter_type)
        if admission_id:
            clauses.append("o.admission_id = ?")
            params.append(admission_id)
        if sale_type:
            clauses.append("o.sale_type = ?")
            params.append(sale_type.upper())
        if search:
            term = f"%{search.strip().lower()}%"
            clauses.append("(LOWER(o.order_no) LIKE ? OR LOWER(COALESCE(o.walkin_name, '')) LIKE ? OR COALESCE(o.walkin_mobile, '') LIKE ?)")
            params.extend([term, term, term])
        if department_type:
            clauses.append("EXISTS (SELECT 1 FROM diag_order_items oi WHERE oi.order_id = o.id AND oi.department_type = ?)")
            params.append(department_type)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT o.*, COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name
            FROM diag_orders o LEFT JOIN patients p ON p.patient_id = o.patient_id
            {where_clause} ORDER BY o.created_at DESC LIMIT 500
            """,
            tuple(params),
        )
        orders = cursor.fetchall()
        result = []
        for o in orders:
            od = dict(o)
            od["patient_name"] = f"{od.pop('patient_first_name', '') or ''} {od.pop('patient_last_name', '') or ''}".strip() or od.get("walkin_name") or ""
            cursor.execute("SELECT * FROM diag_order_items WHERE order_id = ? ORDER BY id ASC", (od["id"],))
            od["items"] = [dict(r) for r in cursor.fetchall()]
            result.append(od)
        return result



def confirm_diag_order(db, order_id, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_orders WHERE id = ?", (order_id,))
        order = cursor.fetchone()
        if not order:
            raise ValueError("Order not found.")
        if order["status"] != "draft":
            raise ValueError(f"Order is already {order['status']}.")
        cursor.execute("SELECT * FROM diag_order_items WHERE order_id = ? AND cancelled_at IS NULL", (order_id,))
        items = cursor.fetchall()
        if not items:
            raise ValueError("Order has no active services to confirm.")

        # Home-visit convenience fee is billed once per order, on top of the tests.
        subtotal = sum(float(i["amount"]) for i in items) + float(order.get("home_visit_fee") or 0)
        invoice_id = None
        if order["encounter_type"] in ("OP", "EMERGENCY", "EXTERNAL"):
            invoice_no = f"INV-LAB-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
            if order["sale_type"] == "EXTERNAL":
                cursor.execute(
                    """
                    INSERT INTO invoices (invoice_no, patient_id, module, invoice_type, patient_name, patient_mobile, patient_age,
                                          referral_source, doctor_name, subtotal, tax, discount, total_amount, due_amount, payment_status, created_by)
                    VALUES (?, NULL, 'LAB', 'EXTERNAL_SALE', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'due', ?)
                    """,
                    (invoice_no, order["walkin_name"], order["walkin_mobile"], order["walkin_age"],
                     order.get("external_source"), order.get("referring_clinician"), subtotal, subtotal, subtotal, username),
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO invoices (invoice_no, patient_id, module, referral_source, subtotal, tax, discount, total_amount, due_amount, payment_status, created_by)
                    VALUES (?, ?, 'LAB', ?, ?, 0, 0, ?, ?, 'due', ?)
                    """,
                    (invoice_no, order["patient_id"], order.get("external_source"), subtotal, subtotal, subtotal, username),
                )
            invoice_id = cursor.lastrowid

        for item in items:
            cursor.execute("UPDATE diag_order_items SET progress_status = 'ordered' WHERE id = ?", (item["id"],))
            if item["department_type"] == "LAB":
                cursor.execute(
                    "INSERT INTO diag_specimens (order_item_id, specimen_no, status) VALUES (?, ?, 'awaiting_collection')",
                    (item["id"], _generate_specimen_no(cursor)),
                )
            elif item["department_type"] == "IMAGING":
                cursor.execute("SELECT modality, preparation_requirements FROM diag_services WHERE id = ?", (item["service_id"],))
                svc = cursor.fetchone()
                cursor.execute(
                    "INSERT INTO diag_imaging_exams (order_item_id, modality, prep_instructions, status) VALUES (?, ?, ?, 'scheduled')",
                    (item["id"], svc["modality"] if svc else None, svc["preparation_requirements"] if svc else None),
                )

        cursor.execute(
            "UPDATE diag_orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, invoice_id = ? WHERE id = ?",
            (invoice_id, order_id),
        )
        conn.commit()
        return {"order_id": order_id, "invoice_id": invoice_id, "subtotal": subtotal}



def cancel_diag_draft_order(db, order_id, username=None):
    """Discards an unconfirmed order. Confirmed orders are cancelled per service
    (cancel_diag_order_item) so the invoice is adjusted line by line."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM diag_orders WHERE id = ?", (order_id,))
        order = cursor.fetchone()
        if not order:
            raise ValueError("Order not found.")
        if order["status"] != "draft":
            raise ValueError(f"Only a draft order can be discarded (this order is {order['status']}).")
        cursor.execute("UPDATE diag_orders SET status = 'cancelled' WHERE id = ?", (order_id,))
        cursor.execute(
            "UPDATE diag_order_items SET progress_status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = 'Draft discarded' WHERE order_id = ? AND cancelled_at IS NULL",
            (order_id,),
        )
        conn.commit()
        return True



REFUND_PAYMENT_MODES = ('cash', 'card', 'upi', 'bank', 'razorpay', 'bank_transfer', 'net_banking', 'mixed_payment', 'cheque')


def _invoice_balance_after_cancellation(total, paid, advance, refunded):
    """Settles a LAB invoice after a service is cancelled. Whatever the patient has
    paid beyond the new total is refunded (never left as a silent overpayment), and
    due/payment_status are recomputed with the same formula record_invoice_payment uses.
    Returns (refund_amount, refunded_total, due_amount, payment_status)."""
    total = max(float(total or 0), 0.0)
    net_paid = float(paid or 0) + float(advance or 0) - float(refunded or 0)
    refund = round(max(net_paid - total, 0.0), 2)
    refunded_total = round(float(refunded or 0) + refund, 2)
    due = round(max(total - (net_paid - refund), 0.0), 2)
    if refund > 0 and total <= 0:
        status = "refunded"
    elif due <= 0:
        status = "paid"
    elif net_paid - refund > 0:
        status = "partial"
    else:
        status = "due"
    return refund, refunded_total, due, status


def cancel_diag_order_item(db, item_id, reason, username=None, refund_mode=None):
    if not (reason or "").strip():
        raise ValueError("A cancellation reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_order_items WHERE id = ?", (item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Order item not found.")
        if item["cancelled_at"]:
            raise ValueError("This service is already cancelled.")
        if item["progress_status"] not in ("ordered",):
            raise ValueError(f"Cannot cancel a service once it is {item['progress_status']}.")
        cursor.execute(
            "UPDATE diag_order_items SET cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ?, progress_status = 'cancelled' WHERE id = ?",
            (reason, item_id),
        )
        cursor.execute("SELECT invoice_id, service_type, home_visit_fee FROM diag_orders WHERE id = ?", (item["order_id"],))
        order_row = cursor.fetchone()
        # Cancelling the last test of a home visit also drops the visit fee: no tests, no visit.
        visit_fee_refund = 0.0
        if order_row and order_row["service_type"] == "HOME_VISIT":
            cursor.execute("SELECT COUNT(*) AS n FROM diag_order_items WHERE order_id = ? AND cancelled_at IS NULL", (item["order_id"],))
            if cursor.fetchone()["n"] == 0:
                visit_fee_refund = float(order_row["home_visit_fee"] or 0)
                cursor.execute("UPDATE diag_orders SET visit_status = 'cancelled' WHERE id = ?", (item["order_id"],))
        refund = 0.0
        if order_row and order_row["invoice_id"]:
            cursor.execute("SELECT * FROM invoices WHERE id = ?", (order_row["invoice_id"],))
            inv = cursor.fetchone()
            if inv:
                amount = float(item["amount"] or 0) + visit_fee_refund
                new_total = max(float(inv["total_amount"] or 0) - amount, 0.0)
                new_subtotal = max(float(inv["subtotal"] or 0) - amount, 0.0)
                refund, refunded_total, due, status = _invoice_balance_after_cancellation(
                    new_total, inv["paid_amount"], inv["advance_amount"], inv["refunded_amount"])
                cursor.execute(
                    """
                    UPDATE invoices SET subtotal = ?, total_amount = ?, due_amount = ?, refunded_amount = ?,
                        payment_status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (new_subtotal, new_total, due, refunded_total, status, username, inv["id"]),
                )
                if refund > 0:
                    mode = str(refund_mode or "").strip().lower().replace(" ", "_")
                    if mode not in REFUND_PAYMENT_MODES:
                        cursor.execute(
                            "SELECT payment_mode FROM invoice_payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC LIMIT 1",
                            (inv["id"],),
                        )
                        last = cursor.fetchone()
                        mode = last["payment_mode"] if last else "cash"
                    # Negative payment row, same convention as pharmacy returns, so collections reconcile.
                    cursor.execute(
                        "INSERT INTO invoice_payments (invoice_id, amount, payment_mode, gateway_ref) VALUES (?, ?, ?, ?)",
                        (inv["id"], -refund, mode, f"REFUND: cancelled {item['service_name']} (item #{item_id})"),
                    )
        conn.commit()
        return {"refund_amount": refund}



def add_diag_order_items(db, order_id, new_items, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_orders WHERE id = ?", (order_id,))
        order = cursor.fetchone()
        if not order:
            raise ValueError("Order not found.")
        if order["status"] == "cancelled":
            raise ValueError("Cannot add services to a cancelled order.")
        added_amount = 0.0
        added_ids = []
        for item in new_items:
            cursor.execute("SELECT * FROM diag_services WHERE id = ? AND active = TRUE", (item["service_id"],))
            svc = cursor.fetchone()
            if not svc:
                raise ValueError(f"Service {item.get('service_id')} is not available.")
            quantity = int(item.get("quantity", 1) or 1)
            rate = float(svc["rate"])
            discount = float(item.get("discount", 0) or 0)
            amount = max(rate * quantity - discount, 0.0)
            cursor.execute(
                """
                INSERT INTO diag_order_items (order_id, service_id, service_name, department_type, quantity, rate, discount, amount, progress_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (order_id, svc["id"], svc["name"], svc["service_type"], quantity, rate, discount, amount,
                 "ordered" if order["status"] == "confirmed" else "draft"),
            )
            new_item_id = cursor.lastrowid
            added_ids.append(new_item_id)
            added_amount += amount
            if order["status"] == "confirmed":
                if svc["service_type"] == "LAB":
                    cursor.execute(
                        "INSERT INTO diag_specimens (order_item_id, specimen_no, status) VALUES (?, ?, 'awaiting_collection')",
                        (new_item_id, _generate_specimen_no(cursor)),
                    )
                elif svc["service_type"] == "IMAGING":
                    cursor.execute(
                        "INSERT INTO diag_imaging_exams (order_item_id, modality, prep_instructions, status) VALUES (?, ?, ?, 'scheduled')",
                        (new_item_id, svc["modality"], svc["preparation_requirements"]),
                    )
        if order["status"] == "confirmed" and order["invoice_id"] and added_amount > 0:
            cursor.execute(
                "UPDATE invoices SET subtotal = subtotal + ?, total_amount = total_amount + ?, due_amount = due_amount + ? WHERE id = ?",
                (added_amount, added_amount, added_amount, order["invoice_id"]),
            )
        conn.commit()
        return added_ids



def get_diag_patient_running_charges(db, admission_id):
    """IPD lab/imaging charges not yet part of a posted invoice -- for the admission running bill."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COALESCE(SUM(oi.amount), 0) AS total, COUNT(*) AS line_count
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND o.status = 'confirmed' AND oi.cancelled_at IS NULL AND oi.discharge_invoice_id IS NULL
            """,
            (admission_id,),
        )
        row = cursor.fetchone()
        return {"total": float(row["total"] or 0), "line_count": row["line_count"]}


# ==================== Lab & Diagnostics: Laboratory ====================


# An item whose report was already released is only being amended -- its TAT was met (or missed) at first release.
_HAS_RELEASED_REPORT_SQL = "EXISTS (SELECT 1 FROM diag_reports rr WHERE rr.order_item_id = oi.id AND rr.status IN ('released', 'amended'))"


def list_diag_lab_worklist(db, stage=None, search=None, priority=None):
    """stage: awaiting_collection | collected | received | testing | results_entered | for_review | released"""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = ["oi.department_type = 'LAB'", "oi.cancelled_at IS NULL", "o.status = 'confirmed'"]
        params = []
        if priority:
            clauses.append("o.priority = ?")
            params.append(priority)
        if search:
            like = f"%{search.strip().lower()}%"
            clauses.append("(LOWER(p.name) LIKE ? OR LOWER(p.last_name) LIKE ? OR LOWER(p.patient_id) LIKE ? OR LOWER(sp.specimen_no) LIKE ?)")
            params.extend([like, like, like, like])
        where_clause = " AND ".join(clauses)
        cursor.execute(
            f"""
            SELECT oi.*, o.order_no, o.patient_id, o.encounter_type, o.admission_id, o.appointment_id, o.priority,
                   o.created_at AS order_created_at, COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name,
                   sp.id AS specimen_id, sp.specimen_no, sp.status AS specimen_status, sp.collected_at, sp.received_at,
                   sp.rejection_reason, sp.container_type, sp.collection_location, ds.turnaround_hours,
                   {_HAS_RELEASED_REPORT_SQL} AS has_released_report
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            LEFT JOIN diag_specimens sp ON sp.order_item_id = oi.id AND sp.status != 'rejected'
            LEFT JOIN diag_services ds ON ds.id = oi.service_id
            WHERE {where_clause}
            ORDER BY o.priority = 'STAT' DESC, o.priority = 'Urgent' DESC, o.created_at ASC
            """,
            tuple(params),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        now = _db_now(cursor)
        for r in rows:
            if r["progress_status"] == "released" or r["has_released_report"]:
                r.update({"elapsed_hours": None, "tat_target_hours": None, "tat_status": None})
            else:
                tat_start = r.get("received_at") or r.get("collected_at") or r.get("order_created_at")
                r.update(_tat_status(tat_start, r.get("turnaround_hours"), now))
        if stage:
            stage_map = {
                "awaiting_collection": lambda r: r["specimen_status"] == "awaiting_collection",
                "collected": lambda r: r["specimen_status"] == "collected",
                "received": lambda r: r["specimen_status"] == "received" and r["progress_status"] not in ("results_entered", "authorized", "released"),
                "for_review": lambda r: r["progress_status"] in ("results_entered", "authorized"),
                "released": lambda r: r["progress_status"] == "released",
            }
            f = stage_map.get(stage)
            if f:
                rows = [r for r in rows if f(r)]
        return rows



def get_diag_lab_item_detail(db, order_item_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT oi.*, o.order_no, o.patient_id, o.encounter_type, o.admission_id, o.appointment_id,
                   o.priority, o.clinical_indication, o.referring_clinician, o.walkin_name
            FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id WHERE oi.id = ?
            """,
            (order_item_id,),
        )
        item = cursor.fetchone()
        if not item:
            return None
        item_dict = dict(item)
        cursor.execute("SELECT name, last_name, dob, age, gender, phone, phone_country_code FROM patients WHERE patient_id = ?", (item_dict["patient_id"],))
        p = cursor.fetchone()
        item_dict["patient"] = dict(p) if p else None
        cursor.execute("SELECT * FROM diag_specimens WHERE order_item_id = ? ORDER BY id DESC", (order_item_id,))
        item_dict["specimens"] = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT * FROM diag_service_parameters WHERE service_id = ? ORDER BY display_order ASC, id ASC", (item_dict["service_id"],))
        item_dict["parameters"] = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT * FROM diag_results WHERE order_item_id = ? ORDER BY id ASC", (order_item_id,))
        item_dict["results"] = [dict(r) for r in cursor.fetchall()]
        cursor.execute(
            """
            SELECT r.*, v.vendor_name FROM diag_external_referrals r
            LEFT JOIN lab_vendors v ON v.id = r.vendor_id
            WHERE r.order_item_id = ? ORDER BY r.id DESC
            """,
            (order_item_id,),
        )
        item_dict["external_referrals"] = [dict(r) for r in cursor.fetchall()]
        latest_report = _latest_diag_report(cursor, order_item_id)
        item_dict["report_id"] = latest_report["id"] if latest_report else None
        item_dict["report_status"] = latest_report["status"] if latest_report else None
        return item_dict



def collect_diag_specimen(db, specimen_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_specimens WHERE id = ?", (specimen_id,))
        specimen = cursor.fetchone()
        if not specimen:
            raise ValueError("Specimen not found.")
        if specimen["status"] != "awaiting_collection":
            raise ValueError(f"Specimen is already {specimen['status']}.")
        if not data.get("identity_verified"):
            raise ValueError("Patient identity must be verified before collection.")
        cursor.execute(
            """
            UPDATE diag_specimens SET status = 'collected', container_type = ?, collection_location = ?,
                identity_verified = TRUE, collected_by = ?, collected_at = CURRENT_TIMESTAMP, collection_notes = ?
            WHERE id = ?
            """,
            (data.get("container_type"), data.get("collection_location"), username, data.get("collection_notes"), specimen_id),
        )
        cursor.execute("UPDATE diag_order_items SET progress_status = 'collected' WHERE id = ?", (specimen["order_item_id"],))
        conn.commit()
        return True



def receive_diag_specimen(db, specimen_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_specimens WHERE id = ?", (specimen_id,))
        specimen = cursor.fetchone()
        if not specimen:
            raise ValueError("Specimen not found.")
        if specimen["status"] != "collected":
            raise ValueError(f"Specimen must be collected before it can be received (currently {specimen['status']}).")
        accept = bool(data.get("accept", True))
        if accept:
            cursor.execute(
                "UPDATE diag_specimens SET status = 'received', received_by = ?, received_at = CURRENT_TIMESTAMP, condition_on_receipt = ? WHERE id = ?",
                (username, data.get("condition_on_receipt"), specimen_id),
            )
            cursor.execute("UPDATE diag_order_items SET progress_status = 'received' WHERE id = ?", (specimen["order_item_id"],))
            # Outsourcing / Home Visit tests are routed (in-house or partner lab) once the sample is at the lab.
            import diag_service_types
            diag_service_types.route_item(cursor, specimen["order_item_id"], username)
        else:
            reason = (data.get("rejection_reason") or "").strip()
            if not reason:
                raise ValueError("A rejection reason is required.")
            cursor.execute(
                "UPDATE diag_specimens SET status = 'rejected', received_by = ?, received_at = CURRENT_TIMESTAMP, condition_on_receipt = ?, rejection_reason = ? WHERE id = ?",
                (username, data.get("condition_on_receipt"), reason, specimen_id),
            )
            new_specimen_no = _generate_specimen_no(cursor)
            cursor.execute(
                "INSERT INTO diag_specimens (order_item_id, specimen_no, status, replaces_specimen_id) VALUES (?, ?, 'awaiting_collection', ?)",
                (specimen["order_item_id"], new_specimen_no, specimen_id),
            )
            cursor.execute("UPDATE diag_order_items SET progress_status = 'ordered' WHERE id = ?", (specimen["order_item_id"],))
        conn.commit()
        return True



def _tat_status(start_at, target_hours, end_at=None):
    """Computes elapsed hours against a configured TAT target. Returns all-None
    fields when there's no start timestamp or no configured target -- TAT is
    never fabricated for a test that hasn't defined one."""
    if not start_at or target_hours in (None, "", 0):
        return {"elapsed_hours": None, "tat_target_hours": None, "tat_status": None}
    try:
        target = float(target_hours)
    except (TypeError, ValueError):
        return {"elapsed_hours": None, "tat_target_hours": None, "tat_status": None}
    if isinstance(start_at, str):
        try:
            start_at = datetime.fromisoformat(start_at)
        except ValueError:
            return {"elapsed_hours": None, "tat_target_hours": None, "tat_status": None}
    end = end_at or datetime.now()
    if isinstance(end, str):
        try:
            end = datetime.fromisoformat(end)
        except ValueError:
            end = datetime.now()
    elapsed_hours = max((end - start_at).total_seconds() / 3600.0, 0.0)
    if elapsed_hours > target:
        status = "overdue"
    elif elapsed_hours >= target * 0.8:
        status = "near_due"
    else:
        status = "on_time"
    return {"elapsed_hours": round(elapsed_hours, 2), "tat_target_hours": target, "tat_status": status}


def _compute_result_flag(value_numeric, ref_low, ref_high, critical_low, critical_high):
    if value_numeric is None:
        return None
    try:
        v = float(value_numeric)
    except (TypeError, ValueError):
        return None
    if critical_low is not None and v < float(critical_low):
        return "critical_low"
    if critical_high is not None and v > float(critical_high):
        return "critical_high"
    if ref_low is not None and v < float(ref_low):
        return "low"
    if ref_high is not None and v > float(ref_high):
        return "high"
    if ref_low is not None or ref_high is not None:
        return "normal"
    return None



def save_diag_results(db, order_item_id, results, username=None, is_draft=True, and_release=False):
    """results: [{parameter_id, value_text, value_numeric, equipment_id}]. Reference ranges and
    critical thresholds are always read from the hospital-configured catalogue parameter, never
    invented or accepted from the client, and copied onto the result row as a permanent record."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_order_items WHERE id = ?", (order_item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Order item not found.")
        if item["cancelled_at"]:
            raise ValueError("This test has been cancelled.")
        if item["progress_status"] in ("ordered", "collected"):
            raise ValueError("The specimen must be received in the laboratory before results can be entered.")
        latest_report = _latest_diag_report(cursor, order_item_id)
        if latest_report and latest_report["status"] not in REPORT_EDITABLE_STATUSES:
            raise ValueError(
                f"The report for this test is {latest_report['status'].replace('_', ' ')}. "
                "Return it for correction (or create an amendment if released) before changing results."
            )
        critical_hits = []
        checked_equipment = set()
        checked_lots = set()
        for r in results:
            cursor.execute("SELECT * FROM diag_service_parameters WHERE id = ?", (r.get("parameter_id"),))
            param = cursor.fetchone()
            if not param:
                raise ValueError(f"Unknown parameter {r.get('parameter_id')}.")
            if param["service_id"] != item["service_id"]:
                raise ValueError(f"Parameter {param['name']} does not belong to this test.")
            equipment_id = r.get("equipment_id")
            # Final results must name the analyzer, otherwise the QC-hold and
            # equipment-status checks below could be bypassed by leaving it out.
            if not is_draft and not equipment_id:
                raise ValueError(f"Select the equipment/analyzer used for {param['name']} before finalizing results.")
            if equipment_id and equipment_id not in checked_equipment:
                cursor.execute(
                    "SELECT name, operational_status, next_calibration_date, next_calibration_date < CURRENT_DATE AS calibration_overdue "
                    "FROM diag_equipment WHERE id = ?",
                    (equipment_id,),
                )
                equipment = cursor.fetchone()
                if not equipment:
                    raise ValueError("The selected equipment was not found.")
                if equipment["operational_status"] in ("maintenance", "down"):
                    raise ValueError(
                        f"{equipment['name']} is {equipment['operational_status']} and cannot be used for results. "
                        "Return it to service from Quality & Equipment first."
                    )
                if equipment["calibration_overdue"]:
                    raise ValueError(
                        f"{equipment['name']} was due for calibration on {equipment['next_calibration_date']}. "
                        "Record the calibration (update the next calibration date) in Quality & Equipment first."
                    )
                checked_equipment.add(equipment_id)
            reagent_lot_id = r.get("reagent_lot_id") or None
            if reagent_lot_id and reagent_lot_id not in checked_lots:
                cursor.execute(
                    "SELECT item_name, lot_no, status, expiry_date, expiry_date < CURRENT_DATE AS expired FROM diag_reagent_lots WHERE id = ?",
                    (reagent_lot_id,),
                )
                lot = cursor.fetchone()
                if not lot:
                    raise ValueError("The selected reagent lot was not found.")
                if lot["expired"] or lot["status"] == "expired":
                    raise ValueError(f"Reagent lot {lot['item_name']} {lot['lot_no']} expired on {lot['expiry_date']} and cannot be used.")
                if lot["status"] != "available":
                    raise ValueError(f"Reagent lot {lot['item_name']} {lot['lot_no']} is {lot['status']} and cannot be used.")
                checked_lots.add(reagent_lot_id)
            if equipment_id:
                cursor.execute(
                    """
                    SELECT h.* FROM diag_qc_holds h
                    WHERE h.status != 'released' AND (
                        (h.scope = 'equipment' AND h.equipment_id = ?) OR
                        (h.scope = 'assay' AND h.equipment_id = ? AND h.service_id = ?)
                    ) LIMIT 1
                    """,
                    (equipment_id, equipment_id, item["service_id"]),
                )
                if cursor.fetchone():
                    raise ValueError(f"Equipment has an open QC hold for {param['name']}. Results cannot be recorded until the hold is released.")
            value_numeric = r.get("value_numeric")
            if value_numeric in ("", None):
                value_numeric = None
            else:
                try:
                    value_numeric = float(value_numeric)
                except (TypeError, ValueError):
                    raise ValueError(f"Enter a number for {param['name']}.")
                if not math.isfinite(value_numeric):
                    raise ValueError(f"Enter a number for {param['name']}.")
            flag = _compute_result_flag(value_numeric, param["ref_low"], param["ref_high"], param["critical_low"], param["critical_high"])
            if flag in ("critical_low", "critical_high"):
                critical_hits.append((param["name"], flag))
            cursor.execute("SELECT id FROM diag_results WHERE order_item_id = ? AND parameter_id = ?", (order_item_id, r["parameter_id"]))
            existing = cursor.fetchone()
            if existing:
                cursor.execute(
                    """
                    UPDATE diag_results SET value_text = ?, value_numeric = ?, unit = ?, method = ?, ref_range_text = ?,
                        ref_low = ?, ref_high = ?, flag = ?, is_draft = ?, equipment_id = ?, reagent_lot_id = ?, updated_by = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (r.get("value_text"), value_numeric, param["unit"], param["method"], param["ref_text"],
                     param["ref_low"], param["ref_high"], flag, is_draft, equipment_id, reagent_lot_id, username, existing["id"]),
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO diag_results (
                        order_item_id, parameter_id, parameter_name, equipment_id, reagent_lot_id, value_text, value_numeric, unit, method,
                        ref_range_text, ref_low, ref_high, flag, is_draft, entered_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (order_item_id, r["parameter_id"], param["name"], equipment_id, reagent_lot_id, r.get("value_text"), value_numeric,
                     param["unit"], param["method"], param["ref_text"], param["ref_low"], param["ref_high"], flag, is_draft, username),
                )
        raised = 0
        report_id = None
        if not is_draft:
            cursor.execute("UPDATE diag_order_items SET progress_status = 'results_entered' WHERE id = ?", (order_item_id,))
            report_id = latest_report["id"] if latest_report else _insert_diag_report_draft(cursor, order_item_id, "LAB", username)
            # Critical values are only notified once the result is final, and only
            # once per parameter while an earlier alert for it is still open.
            for pname, flag in critical_hits:
                cursor.execute(
                    "SELECT 1 FROM diag_critical_alerts WHERE order_item_id = ? AND resolved_at IS NULL AND notes LIKE ?",
                    (order_item_id, f"{pname}:%"),
                )
                if cursor.fetchone():
                    continue
                cursor.execute(
                    "INSERT INTO diag_critical_alerts (order_item_id, notes) VALUES (?, ?)",
                    (order_item_id, f"{pname}: {flag.replace('_', ' ')}"),
                )
                raised += 1

            if and_release and report_id and not raised:
                cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
                rep = cursor.fetchone()
                if rep and rep["status"] in ("draft", "returned_for_correction"):
                    cursor.execute("UPDATE diag_reports SET status = 'pending_review', content = COALESCE(content, '{}'), submitted_at = CURRENT_TIMESTAMP WHERE id = ?", (report_id,))
                    rep = dict(rep)
                    rep["status"] = "pending_review"
                if rep and rep["status"] == "pending_review":
                    try:
                        _check_four_eyes(cursor, rep, username)
                        cursor.execute(
                            "UPDATE diag_reports SET status = 'authorized', authorized_by = ?, authorized_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (username, report_id),
                        )
                        _snapshot_lab_results(cursor, rep)
                        cursor.execute("UPDATE diag_reports SET status = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?", (_release_status(rep), report_id))
                        cursor.execute("UPDATE diag_order_items SET progress_status = 'released' WHERE id = ?", (order_item_id,))
                    except ValueError:
                        pass
        conn.commit()
        return {"critical_alerts_raised": raised, "critical_values": len(critical_hits), "report_id": report_id}



def create_diag_external_referral(db, order_item_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, cancelled_at FROM diag_order_items WHERE id = ?", (order_item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Order item not found.")
        if item["cancelled_at"]:
            raise ValueError("This test has been cancelled.")
        if not data.get("vendor_id"):
            raise ValueError("Select the referral laboratory.")
        cursor.execute("SELECT id FROM lab_vendors WHERE id = ?", (data["vendor_id"],))
        if not cursor.fetchone():
            raise ValueError("Referral laboratory not found.")
        cursor.execute(
            "SELECT id FROM diag_external_referrals WHERE order_item_id = ? AND received_report_at IS NULL LIMIT 1",
            (order_item_id,),
        )
        if cursor.fetchone():
            raise ValueError("This test is already with an external laboratory. Mark that report received before dispatching again.")
        cursor.execute(
            """
            INSERT INTO diag_external_referrals (order_item_id, vendor_id, dispatched_at, dispatched_by, expected_turnaround, notes)
            VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
            """,
            (order_item_id, data.get("vendor_id"), username, data.get("expected_turnaround"), data.get("notes")),
        )
        referral_id = cursor.lastrowid
        conn.commit()
        return referral_id



def update_diag_external_referral(db, referral_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_external_referrals WHERE id = ?", (referral_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        received_at = data.get("received_report_at", existing["received_report_at"])
        if data.get("report_received") and not existing["received_report_at"]:
            received_at = datetime.now()
        cursor.execute(
            """
            UPDATE diag_external_referrals SET received_report_at = ?, report_document_id = ?, local_review_status = ?, notes = ?
            WHERE id = ?
            """,
            (
                received_at,
                data.get("report_document_id", existing["report_document_id"]),
                data.get("local_review_status", existing["local_review_status"]),
                data.get("notes", existing["notes"]),
                referral_id,
            ),
        )
        conn.commit()
        return True



def list_diag_external_referrals(db, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if status:
            clauses.append("r.local_review_status = ?")
            params.append(status)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT r.*, v.vendor_name, oi.service_name, o.patient_id
            FROM diag_external_referrals r
            JOIN diag_order_items oi ON oi.id = r.order_item_id
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN lab_vendors v ON v.id = r.vendor_id
            {where_clause} ORDER BY r.dispatched_at DESC
            """,
            tuple(params),
        )
        return cursor.fetchall()


# ==================== Lab & Diagnostics: Imaging ====================


def list_diag_imaging_worklist(db, stage=None, modality=None, room=None, search=None, date_from=None, date_to=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = ["oi.department_type = 'IMAGING'", "oi.cancelled_at IS NULL", "o.status = 'confirmed'"]
        params = []
        if modality:
            clauses.append("ex.modality = ?")
            params.append(modality)
        if room:
            clauses.append("ex.room = ?")
            params.append(room)
        if date_from:
            clauses.append("DATE(ex.scheduled_at) >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("DATE(ex.scheduled_at) <= ?")
            params.append(date_to)
        if search:
            like = f"%{search.strip().lower()}%"
            clauses.append("(LOWER(p.name) LIKE ? OR LOWER(p.last_name) LIKE ? OR LOWER(p.patient_id) LIKE ?)")
            params.extend([like, like, like])
        where_clause = " AND ".join(clauses)
        cursor.execute(
            f"""
            SELECT oi.*, o.order_no, o.patient_id, o.encounter_type, o.admission_id, o.priority,
                   o.created_at AS order_created_at, COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name,
                   ex.id AS exam_id, ex.modality, ex.room, ex.scheduled_at, ex.expected_duration_min, ex.status AS exam_status,
                   ex.assigned_staff, ex.prep_instructions, ex.image_available, ds.turnaround_hours,
                   {_HAS_RELEASED_REPORT_SQL} AS has_released_report
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            LEFT JOIN diag_imaging_exams ex ON ex.order_item_id = oi.id
            LEFT JOIN diag_services ds ON ds.id = oi.service_id
            WHERE {where_clause}
            ORDER BY o.priority = 'STAT' DESC, o.priority = 'Urgent' DESC, ex.scheduled_at ASC NULLS FIRST
            """,
            tuple(params),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        now = _db_now(cursor)
        for r in rows:
            if r["progress_status"] in ("released", "cancelled") or r["has_released_report"]:
                r.update({"elapsed_hours": None, "tat_target_hours": None, "tat_status": None})
            else:
                tat_start = r.get("scheduled_at") or r.get("order_created_at")
                r.update(_tat_status(tat_start, r.get("turnaround_hours"), now))
        if stage:
            stage_map = {
                "to_schedule": lambda r: r["exam_status"] == "scheduled" and not r["scheduled_at"],
                "scheduled": lambda r: r["exam_status"] == "scheduled" and r["scheduled_at"],
                "in_progress": lambda r: r["exam_status"] in ("arrived", "prep", "in_progress"),
                "for_reporting": lambda r: r["exam_status"] == "completed" and r["progress_status"] not in ("authorized", "released"),
            }
            f = stage_map.get(stage)
            if f:
                rows = [r for r in rows if f(r)]
        return rows



def get_diag_imaging_detail(db, order_item_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT oi.*, o.order_no, o.patient_id, o.encounter_type, o.admission_id, o.priority,
                   o.clinical_indication, o.referring_clinician
            FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id WHERE oi.id = ?
            """,
            (order_item_id,),
        )
        item = cursor.fetchone()
        if not item:
            return None
        item_dict = dict(item)
        cursor.execute("SELECT name, last_name, dob, age, gender, phone, phone_country_code FROM patients WHERE patient_id = ?", (item_dict["patient_id"],))
        p = cursor.fetchone()
        item_dict["patient"] = dict(p) if p else None
        cursor.execute("SELECT * FROM diag_imaging_exams WHERE order_item_id = ?", (order_item_id,))
        exam = cursor.fetchone()
        item_dict["exam"] = dict(exam) if exam else None
        return item_dict



def schedule_diag_imaging_exam(db, exam_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_imaging_exams WHERE id = ?", (exam_id,))
        exam = cursor.fetchone()
        if not exam:
            raise ValueError("Exam not found.")
        room = data.get("room", exam["room"])
        scheduled_at = data.get("scheduled_at")
        if room and scheduled_at:
            duration = int(data.get("expected_duration_min", exam["expected_duration_min"] or 30))
            cursor.execute(
                """
                SELECT id FROM diag_imaging_exams
                WHERE room = ? AND id != ? AND status NOT IN ('cancelled', 'completed', 'no_show')
                  AND scheduled_at IS NOT NULL
                  AND scheduled_at < (? ::timestamp + (? || ' minutes')::interval)
                  AND (scheduled_at + (expected_duration_min || ' minutes')::interval) > ? ::timestamp
                """,
                (room, exam_id, scheduled_at, duration, scheduled_at),
            )
            conflict = cursor.fetchone()
            if conflict:
                raise ValueError(f"Room {room} is already booked for an overlapping time slot.")
        cursor.execute(
            """
            UPDATE diag_imaging_exams SET modality = ?, room = ?, scheduled_at = ?, expected_duration_min = ?,
                assigned_staff = ?, prep_instructions = ?, status = 'scheduled', reschedule_reason = ?
            WHERE id = ?
            """,
            (
                data.get("modality", exam["modality"]), room, scheduled_at,
                int(data.get("expected_duration_min", exam["expected_duration_min"] or 30)),
                data.get("assigned_staff", exam["assigned_staff"]), data.get("prep_instructions", exam["prep_instructions"]),
                data.get("reschedule_reason"), exam_id,
            ),
        )
        conn.commit()
        return True



def cancel_diag_imaging_exam(db, exam_id, reason, username=None):
    if not (reason or "").strip():
        raise ValueError("A cancellation/no-show reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_imaging_exams WHERE id = ?", (exam_id,))
        exam = cursor.fetchone()
        if not exam:
            raise ValueError("Exam not found.")
        status = "no_show" if exam["status"] in ("scheduled", "arrived") and data_is_no_show(reason) else "cancelled"
        cursor.execute(
            "UPDATE diag_imaging_exams SET status = ?, cancel_reason = ?, no_show_at = CASE WHEN ? = 'no_show' THEN CURRENT_TIMESTAMP ELSE no_show_at END WHERE id = ?",
            (status, reason, status, exam_id),
        )
        conn.commit()
        return True



def data_is_no_show(reason):
    return "no show" in (reason or "").lower() or "no-show" in (reason or "").lower()



def update_diag_imaging_status(db, exam_id, status, data=None, username=None):
    data = data or {}
    valid_transitions = {
        "scheduled": {"arrived", "cancelled", "no_show"},
        "arrived": {"prep", "in_progress", "cancelled"},
        "prep": {"in_progress", "cancelled"},
        "in_progress": {"completed"},
    }
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_imaging_exams WHERE id = ?", (exam_id,))
        exam = cursor.fetchone()
        if not exam:
            raise ValueError("Exam not found.")
        allowed = valid_transitions.get(exam["status"], set())
        if status not in allowed:
            raise ValueError(f"Cannot move exam from {exam['status']} to {status}.")
        updates = ["status = ?"]
        params = [status]
        if status == "arrived":
            updates.append("arrived_at = CURRENT_TIMESTAMP")
        elif status == "prep":
            if data.get("consent_recorded"):
                updates.append("consent_recorded = TRUE")
                updates.append("consent_notes = ?")
                params.append(data.get("consent_notes"))
            updates.append("prep_completed_at = CURRENT_TIMESTAMP")
        elif status == "in_progress":
            updates.append("started_at = CURRENT_TIMESTAMP")
            updates.append("performing_staff = ?")
            params.append((data.get("performing_staff") or "").strip() or username)
        elif status == "completed":
            updates.append("completed_at = CURRENT_TIMESTAMP")
            updates.append("image_available = ?")
            params.append(bool(data.get("image_available", True)))
        params.append(exam_id)
        cursor.execute(f"UPDATE diag_imaging_exams SET {', '.join(updates)} WHERE id = ?", tuple(params))
        if status == "completed":
            cursor.execute("UPDATE diag_order_items SET progress_status = 'exam_completed' WHERE id = ?", (exam["order_item_id"],))
            if not _latest_diag_report(cursor, exam["order_item_id"]):
                _insert_diag_report_draft(cursor, exam["order_item_id"], "IMAGING", username)
        elif status == "arrived":
            cursor.execute("UPDATE diag_order_items SET progress_status = 'in_progress' WHERE id = ?", (exam["order_item_id"],))
        conn.commit()
        return True


# ==================== Lab & Diagnostics: Reports & Approval ====================


REPORT_EDITABLE_STATUSES = ("draft", "returned_for_correction")


def _latest_diag_report(cursor, order_item_id):
    cursor.execute("SELECT * FROM diag_reports WHERE order_item_id = ? ORDER BY version DESC LIMIT 1", (order_item_id,))
    return cursor.fetchone()


def _insert_diag_report_draft(cursor, order_item_id, report_type, username=None, template=None):
    cursor.execute(
        """
        INSERT INTO diag_reports (order_item_id, report_type, version, status, template, drafted_by)
        VALUES (?, ?, 1, 'draft', ?, ?)
        """,
        (order_item_id, report_type, template or "generic", username),
    )
    return cursor.lastrowid


def _release_status(report):
    # A released amendment is recorded as "amended" so history shows it as the corrected final version.
    return "amended" if report["amendment_reason"] else "released"


# LAB result values live in diag_results (one row per parameter) and are edited in place
# when an amendment changes them, so each authorized LAB report version keeps a frozen
# copy of the values it was signed with. Without it, printing/viewing an older released
# version would show the amended values instead of what was actually reported.
RESULTS_SNAPSHOT_KEY = "results_snapshot"
FROZEN_REPORT_STATUSES = ("authorized", "released", "amended")
_SNAPSHOT_RESULT_FIELDS = (
    "id", "parameter_id", "parameter_name", "value_text", "value_numeric", "unit", "method",
    "ref_range_text", "ref_low", "ref_high", "flag", "equipment_id", "reagent_lot_id", "entered_by", "updated_by",
)


def _report_content_dict(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _strip_results_snapshot(content):
    """Snapshots are written only by authorization -- never accepted from a client draft."""
    if isinstance(content, dict) and RESULTS_SNAPSHOT_KEY in content:
        content = {k: v for k, v in content.items() if k != RESULTS_SNAPSHOT_KEY}
    return content


def _snapshot_lab_results(cursor, report):
    cursor.execute("SELECT * FROM diag_results WHERE order_item_id = ? ORDER BY id ASC", (report["order_item_id"],))
    rows = [{k: r[k] for k in _SNAPSHOT_RESULT_FIELDS} for r in cursor.fetchall()]
    content = _report_content_dict(report["content"])
    content[RESULTS_SNAPSHOT_KEY] = rows
    cursor.execute("UPDATE diag_reports SET content = ? WHERE id = ?", (json.dumps(content, default=str), report["id"]))


def get_or_create_diag_report_draft(db, order_item_id, report_type, username=None, template=None):
    """Returns the item's current (latest) report, creating version 1 only when none exists.
    New versions of a released report are created exclusively through create_diag_report_amendment."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        latest = _latest_diag_report(cursor, order_item_id)
        if latest:
            return dict(latest)
        cursor.execute("SELECT department_type, cancelled_at FROM diag_order_items WHERE id = ?", (order_item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Order item not found.")
        if item["cancelled_at"]:
            raise ValueError("This test has been cancelled.")
        report_id = _insert_diag_report_draft(cursor, order_item_id, item["department_type"] or report_type, username, template)
        conn.commit()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        return {**dict(cursor.fetchone()), "created": True}



def save_diag_report_draft(db, report_id, content, username=None, is_preliminary=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report:
            raise ValueError("Report not found.")
        if report["status"] not in ("draft", "returned_for_correction"):
            raise ValueError(f"Report cannot be edited while {report['status']}.")
        cursor.execute(
            "UPDATE diag_reports SET content = ?, is_preliminary = ?, drafted_by = ? WHERE id = ?",
            (json.dumps(_strip_results_snapshot(content)), bool(is_preliminary), username, report_id),
        )
        conn.commit()
        return True



def submit_diag_report_for_review(db, report_id, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report:
            raise ValueError("Report not found.")
        if report["status"] not in ("draft", "returned_for_correction"):
            raise ValueError(f"Cannot submit a report that is {report['status']}.")
        if not report["content"]:
            raise ValueError("Cannot submit an empty report.")
        if report["report_type"] == "LAB":
            cursor.execute(
                "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_draft) AS drafts FROM diag_results WHERE order_item_id = ?",
                (report["order_item_id"],),
            )
            counts = cursor.fetchone()
            if not counts["total"] or counts["drafts"]:
                raise ValueError("Finalize the results in the Laboratory worklist before submitting this report.")
        cursor.execute("UPDATE diag_reports SET status = 'pending_review', submitted_at = CURRENT_TIMESTAMP WHERE id = ?", (report_id,))
        conn.commit()
        return True



def return_diag_report_for_correction(db, report_id, reason, username=None):
    if not (reason or "").strip():
        raise ValueError("A correction reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report or report["status"] != "pending_review":
            raise ValueError("Only a report pending review can be returned for correction.")
        cursor.execute(
            "UPDATE diag_reports SET status = 'returned_for_correction', reviewed_by = ?, return_reason = ?, returned_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, reason, report_id),
        )
        conn.commit()
        return True



def _check_four_eyes(cursor, report, username):
    """LAB sign-off needs a second person: the authorizer cannot be the user who entered
    or last changed this test's results, or who drafted the report. (Imaging is exempt --
    the radiologist who writes the read is the one who signs it.)"""
    if username:
        cursor.execute(
            "SELECT user_type, role, job_role, access_role FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))",
            (username,),
        )
        u = cursor.fetchone()
        if u:
            ut = (u.get("user_type") or "").strip().lower()
            ur = (u.get("role") or "").strip().lower()
            jr = (u.get("job_role") or "").strip().lower()
            ar = (u.get("access_role") or "").strip().lower()
            if (
                ut in ("admin", "super_admin")
                or ur in ("admin", "super_admin")
                or ar in ("admin", "owner")
                or jr in ("owner / admin", "admin", "medical director", "chief pathologist", "pathologist", "doctor")
            ):
                return

    cursor.execute(
        "SELECT entered_by, updated_by FROM diag_results WHERE order_item_id = ?", (report["order_item_id"],)
    )
    involved = {report["drafted_by"]}
    for r in cursor.fetchall():
        involved.update((r["entered_by"], r["updated_by"]))
    involved.discard(None)
    if not username or username in involved:
        raise ValueError(
            "You entered these results or drafted this report, so another authorized user must "
            "review and authorize it (four-eyes rule)."
        )


def diag_four_eyes_blocked(db, report_id, username):
    """True when `username` may not authorize this LAB report (they entered its results or drafted it).
    Lets the UI disable the button instead of letting the server reject every click."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report or report["report_type"] != "LAB" or report["status"] != "pending_review":
            return False
        try:
            _check_four_eyes(cursor, report, username)
        except ValueError:
            return True
        return False


def authorize_diag_report(db, report_id, username, also_release=False):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report or report["status"] != "pending_review":
            raise ValueError("Only a report pending review can be authorized.")
        cursor.execute("SELECT COUNT(*) AS c FROM diag_critical_alerts WHERE order_item_id = ? AND resolved_at IS NULL", (report["order_item_id"],))
        if cursor.fetchone()["c"] > 0:
            raise ValueError("This result has an unresolved critical value alert. Record who was contacted and resolve the alert (Reports > Critical Alerts) before authorizing this report.")
        if report["report_type"] == "LAB":
            _check_four_eyes(cursor, report, username)
        cursor.execute(
            "UPDATE diag_reports SET status = 'authorized', authorized_by = ?, authorized_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, report_id),
        )
        if report["report_type"] == "LAB":
            _snapshot_lab_results(cursor, report)
        if also_release:
            cursor.execute("UPDATE diag_reports SET status = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?", (_release_status(report), report_id))
            cursor.execute("UPDATE diag_order_items SET progress_status = 'released' WHERE id = ?", (report["order_item_id"],))
        else:
            cursor.execute("UPDATE diag_order_items SET progress_status = 'authorized' WHERE id = ?", (report["order_item_id"],))
        conn.commit()
        return True



def release_diag_report(db, report_id, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report or report["status"] != "authorized":
            raise ValueError("Only an authorized report can be released.")
        cursor.execute("SELECT COUNT(*) AS c FROM diag_critical_alerts WHERE order_item_id = ? AND resolved_at IS NULL", (report["order_item_id"],))
        if cursor.fetchone()["c"] > 0:
            raise ValueError("This result has an unresolved critical value alert. Record who was contacted and resolve the alert (Reports > Critical Alerts) before releasing this report.")
        cursor.execute("UPDATE diag_reports SET status = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?", (_release_status(report), report_id))
        cursor.execute("UPDATE diag_order_items SET progress_status = 'released' WHERE id = ?", (report["order_item_id"],))
        conn.commit()
        return True



def create_diag_report_amendment(db, report_id, reason, content, username=None):
    if not (reason or "").strip():
        raise ValueError("An amendment reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report or report["status"] not in ("released", "amended"):
            raise ValueError("Only a released report can be amended.")
        latest = _latest_diag_report(cursor, report["order_item_id"])
        if latest["id"] != report["id"]:
            raise ValueError(f"Version {latest['version']} of this report already exists ({latest['status'].replace('_', ' ')}). Continue with that version instead.")
        cursor.execute(
            """
            INSERT INTO diag_reports (order_item_id, report_type, version, status, content, template, drafted_by, previous_version_id, amendment_reason)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
            """,
            (report["order_item_id"], report["report_type"], report["version"] + 1, json.dumps(_strip_results_snapshot(content)), report["template"], username, report["id"], reason),
        )
        new_id = cursor.lastrowid
        conn.commit()
        return new_id



def list_diag_reports_worklist(db, status=None, report_type=None, search=None, date_from=None, date_to=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if status:
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if len(statuses) == 1:
                clauses.append("r.status = ?")
                params.append(statuses[0])
            elif statuses:
                placeholders = ", ".join(["?"] * len(statuses))
                clauses.append(f"r.status IN ({placeholders})")
                params.extend(statuses)
        if report_type:
            clauses.append("r.report_type = ?")
            params.append(report_type)
        if search:
            like = f"%{search.strip().lower()}%"
            # Match first name, last name, and the full "First Last" name
            # together -- searching a name as typed (with a space) previously
            # never matched, since name/last_name are separate columns.
            clauses.append(
                "(LOWER(p.name) LIKE ? OR LOWER(p.last_name) LIKE ? "
                "OR LOWER(TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, ''))) LIKE ? "
                "OR LOWER(o.order_no) LIKE ? OR LOWER(o.patient_id) LIKE ?)"
            )
            params.extend([like, like, like, like, like])
        # "Report date" for history browsing -- whichever milestone actually
        # happened (released, else authorized, else drafted), never a column
        # that stays NULL for most rows.
        if date_from:
            clauses.append("DATE(COALESCE(r.released_at, r.authorized_at, r.created_at)) >= DATE(?)")
            params.append(date_from)
        if date_to:
            clauses.append("DATE(COALESCE(r.released_at, r.authorized_at, r.created_at)) <= DATE(?)")
            params.append(date_to)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT r.*, oi.service_name, oi.department_type, o.order_no, o.patient_id, o.admission_id, o.priority,
                   o.created_at AS order_created_at, COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name,
                   ds.turnaround_hours,
                   EXISTS(SELECT 1 FROM diag_critical_alerts ca WHERE ca.order_item_id = oi.id AND ca.resolved_at IS NULL) AS has_open_critical
            FROM diag_reports r
            JOIN diag_order_items oi ON oi.id = r.order_item_id
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            LEFT JOIN diag_services ds ON ds.id = oi.service_id
            {where_clause}
            ORDER BY r.created_at DESC LIMIT 500
            """,
            tuple(params),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        now = _db_now(cursor)
        for r in rows:
            # A released amendment ("amended") is a final report too, and an amendment in progress
            # belongs to a test whose original report was already released -- the TAT clock has stopped.
            if r["status"] in ("released", "amended") or r.get("amendment_reason"):
                r.update({"elapsed_hours": None, "tat_target_hours": None, "tat_status": None})
            else:
                r.update(_tat_status(r.get("order_created_at"), r.get("turnaround_hours"), now))
        return rows



def get_diag_report_detail(db, report_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reports WHERE id = ?", (report_id,))
        report = cursor.fetchone()
        if not report:
            return None
        report_dict = dict(report)
        snapshot = None
        if report_dict.get("content"):
            try:
                report_dict["content"] = json.loads(report_dict["content"])
            except (TypeError, json.JSONDecodeError):
                pass
            if isinstance(report_dict["content"], dict):
                snapshot = report_dict["content"].get(RESULTS_SNAPSHOT_KEY)
                report_dict["content"] = _strip_results_snapshot(report_dict["content"])
        item = get_diag_lab_item_detail(db, report_dict["order_item_id"]) if report_dict["report_type"] == "LAB" else get_diag_imaging_detail(db, report_dict["order_item_id"])
        # A signed LAB version shows the values it was authorized with, not later amendments.
        report_dict["results_frozen"] = bool(item and isinstance(snapshot, list) and report_dict["status"] in FROZEN_REPORT_STATUSES)
        if report_dict["results_frozen"]:
            item["results"] = snapshot
        report_dict["order_item"] = item
        if item:
            report_dict["patient_id"] = item.get("patient_id")
            report_dict["order_no"] = item.get("order_no")
            report_dict["service_name"] = item.get("service_name")
            report_dict["priority"] = item.get("priority")
        cursor.execute("SELECT * FROM diag_reports WHERE order_item_id = ? ORDER BY version ASC", (report_dict["order_item_id"],))
        report_dict["all_versions"] = [dict(r) for r in cursor.fetchall()]
        return report_dict



def list_diag_critical_alerts(db, open_only=True):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        where_clause = " WHERE ca.resolved_at IS NULL" if open_only else ""
        cursor.execute(
            f"""
            SELECT ca.*, oi.service_name, o.patient_id, o.order_no, COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name
            FROM diag_critical_alerts ca
            JOIN diag_order_items oi ON oi.id = ca.order_item_id
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            {where_clause}
            ORDER BY ca.raised_at DESC
            """
        )
        return [dict(r) for r in cursor.fetchall()]



def record_diag_critical_contact(db, alert_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_critical_alerts WHERE id = ?", (alert_id,))
        if not cursor.fetchone():
            raise ValueError("Critical alert not found.")
        if not (data.get("contacted_person") or "").strip():
            raise ValueError("The person contacted must be recorded.")
        cursor.execute(
            """
            UPDATE diag_critical_alerts SET contacted_person = ?, contacted_at = CURRENT_TIMESTAMP, contacted_by = ?,
                ack_method = ?, ack_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE ack_at END, notes = COALESCE(notes || ' | ', '') || ?
            WHERE id = ?
            """,
            (data["contacted_person"], username, data.get("ack_method"), data.get("ack_method"), data.get("notes", ""), alert_id),
        )
        conn.commit()
        return True



def escalate_diag_critical_alert(db, alert_id, escalated_to, username=None):
    if not (escalated_to or "").strip():
        raise ValueError("Record who the alert was escalated to.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT resolved_at FROM diag_critical_alerts WHERE id = ?", (alert_id,))
        alert = cursor.fetchone()
        if not alert:
            raise ValueError("Critical alert not found.")
        if alert["resolved_at"]:
            raise ValueError("This critical alert is already resolved.")
        cursor.execute(
            "UPDATE diag_critical_alerts SET escalated = TRUE, escalated_at = CURRENT_TIMESTAMP, escalated_to = ? WHERE id = ?",
            (escalated_to, alert_id),
        )
        conn.commit()
        return True



def resolve_diag_critical_alert(db, alert_id, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT contacted_person, ack_at, resolved_at FROM diag_critical_alerts WHERE id = ?", (alert_id,))
        alert = cursor.fetchone()
        if not alert:
            raise ValueError("Critical alert not found.")
        if alert["resolved_at"]:
            raise ValueError("This critical alert is already resolved.")
        if not alert["contacted_person"]:
            raise ValueError("Record who was contacted before resolving this alert.")
        cursor.execute("UPDATE diag_critical_alerts SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?", (alert_id,))
        conn.commit()
        return True


# ==================== Lab & Diagnostics: Quality & Equipment ====================


def create_diag_equipment(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_equipment WHERE asset_id = ?", (data["asset_id"],))
        if cursor.fetchone():
            raise ValueError(f"Asset ID '{data['asset_id']}' already exists.")
        cursor.execute(
            """
            INSERT INTO diag_equipment (asset_id, name, type, location, model, serial_no, responsible_staff, next_maintenance_date, next_calibration_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data["asset_id"], data["name"], data.get("type"), data.get("location"), data.get("model"),
             data.get("serial_no"), data.get("responsible_staff"), data.get("next_maintenance_date"), data.get("next_calibration_date")),
        )
        equipment_id = cursor.lastrowid
        conn.commit()
        return equipment_id



def list_diag_equipment(db, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if status:
            cursor.execute("SELECT * FROM diag_equipment WHERE operational_status = ? ORDER BY name ASC", (status,))
        else:
            cursor.execute("SELECT * FROM diag_equipment ORDER BY name ASC")
        return cursor.fetchall()



def update_diag_equipment(db, equipment_id, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_equipment WHERE id = ?", (equipment_id,))
        existing = cursor.fetchone()
        if not existing:
            return False
        cursor.execute(
            """
            UPDATE diag_equipment SET name=?, type=?, location=?, model=?, serial_no=?, responsible_staff=?,
                next_maintenance_date=?, next_calibration_date=?
            WHERE id=?
            """,
            (
                data.get("name", existing["name"]), data.get("type", existing["type"]), data.get("location", existing["location"]),
                data.get("model", existing["model"]), data.get("serial_no", existing["serial_no"]),
                data.get("responsible_staff", existing["responsible_staff"]),
                data.get("next_maintenance_date", existing["next_maintenance_date"]),
                data.get("next_calibration_date", existing["next_calibration_date"]),
                equipment_id,
            ),
        )
        conn.commit()
        return True



def record_diag_qc_run(db, data, username=None, create_hold_on_fail=True):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_equipment WHERE id = ?", (data["equipment_id"],))
        equipment = cursor.fetchone()
        if not equipment:
            raise ValueError("Equipment not found.")
        outcome = data.get("outcome", "pending")
        cursor.execute(
            """
            INSERT INTO diag_qc_runs (equipment_id, service_id, control_material, control_lot, operator, measurements, outcome, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["equipment_id"], data.get("service_id"), data.get("control_material"), data.get("control_lot"),
                data.get("operator", username), json.dumps(data.get("measurements") or {}), outcome, data.get("notes"),
            ),
        )
        run_id = cursor.lastrowid
        hold_id = None
        if outcome == "failed" and create_hold_on_fail:
            scope = "assay" if data.get("service_id") else "equipment"
            cursor.execute(
                "INSERT INTO diag_qc_holds (qc_run_id, equipment_id, service_id, scope, status) VALUES (?, ?, ?, ?, 'open')",
                (run_id, data["equipment_id"], data.get("service_id"), scope),
            )
            hold_id = cursor.lastrowid
            if scope == "equipment":
                cursor.execute("UPDATE diag_equipment SET operational_status = 'qc_hold' WHERE id = ?", (data["equipment_id"],))
        conn.commit()
        return {"run_id": run_id, "hold_id": hold_id}



def review_diag_qc_run(db, run_id, username, notes=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE diag_qc_runs SET reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?",
                       (username, notes or "", run_id))
        conn.commit()
        return cursor.rowcount > 0



def record_diag_qc_corrective_action(db, hold_id, corrective_action, assigned_to, username=None):
    if not (corrective_action or "").strip():
        raise ValueError("Corrective action details are required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_qc_holds WHERE id = ?", (hold_id,))
        hold = cursor.fetchone()
        if not hold or hold["status"] == "released":
            raise ValueError("Hold not found or already released.")
        cursor.execute(
            "UPDATE diag_qc_holds SET status = 'corrective_action_recorded', corrective_action = ?, assigned_to = ? WHERE id = ?",
            (corrective_action, assigned_to, hold_id),
        )
        conn.commit()
        return True



def record_diag_repeat_qc(db, hold_id, run_data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_qc_holds WHERE id = ?", (hold_id,))
        hold = cursor.fetchone()
        if not hold or hold["status"] == "released":
            raise ValueError("Hold not found or already released.")
        if hold["status"] != "corrective_action_recorded":
            raise ValueError("Record a corrective action before repeat QC.")
    run_data = dict(run_data)
    run_data["equipment_id"] = hold["equipment_id"]
    run_data["service_id"] = hold["service_id"]
    # The repeat run reuses the existing hold rather than opening a second one
    # via record_diag_qc_run's own auto-hold-on-fail path.
    result = record_diag_qc_run(db, run_data, username, create_hold_on_fail=False)
    result["hold_id"] = hold_id
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE diag_qc_holds SET status = 'repeat_qc_pending', repeat_qc_run_id = ? WHERE id = ?",
            (result["run_id"], hold_id),
        )
        conn.commit()
    return result



def _qc_hold_affected_items(cursor, hold):
    """Tests whose results were finalized on the held analyzer (and assay, for an assay
    hold) after its last passing QC run and before the failing one. The failure does not
    prove those results wrong, but they were produced while the analyzer may already have
    been out of control, so they must be reviewed before the hold is released."""
    cursor.execute(
        """
        SELECT DISTINCT oi.id AS order_item_id, oi.service_name, o.order_no, o.patient_id,
               COALESCE(p.name, o.walkin_name) AS patient_first_name, p.last_name AS patient_last_name,
               (SELECT rr.status FROM diag_reports rr WHERE rr.order_item_id = oi.id ORDER BY rr.version DESC LIMIT 1) AS report_status
        FROM diag_results r
        JOIN diag_order_items oi ON oi.id = r.order_item_id
        JOIN diag_orders o ON o.id = oi.order_id
        LEFT JOIN patients p ON p.patient_id = o.patient_id
        JOIN diag_qc_runs failed ON failed.id = ?
        WHERE r.equipment_id = ? AND r.is_draft = FALSE AND oi.cancelled_at IS NULL
          AND (? = 'equipment' OR oi.service_id = ?)
          AND COALESCE(r.updated_at, r.entered_at) <= failed.run_at
          AND COALESCE(r.updated_at, r.entered_at) > COALESCE((
                SELECT MAX(ok.run_at) FROM diag_qc_runs ok
                WHERE ok.equipment_id = failed.equipment_id AND ok.outcome = 'passed' AND ok.run_at < failed.run_at
                  AND (ok.service_id IS NULL OR ok.service_id = failed.service_id)
          ), '-infinity'::timestamp)
        ORDER BY oi.id
        """,
        (hold["qc_run_id"], hold["equipment_id"], hold["scope"], hold["service_id"]),
    )
    return [dict(r) for r in cursor.fetchall()]


def release_diag_qc_hold(db, hold_id, username, release_notes=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_qc_holds WHERE id = ?", (hold_id,))
        hold = cursor.fetchone()
        if not hold:
            raise ValueError("Hold not found.")
        if hold["status"] != "repeat_qc_pending":
            raise ValueError("A passing repeat QC run is required before this hold can be released.")
        cursor.execute("SELECT outcome FROM diag_qc_runs WHERE id = ?", (hold["repeat_qc_run_id"],))
        repeat_run = cursor.fetchone()
        if not repeat_run or repeat_run["outcome"] != "passed":
            raise ValueError("The repeat QC run must pass before this hold can be released.")
        affected = _qc_hold_affected_items(cursor, hold)
        if affected and not (release_notes or "").strip():
            raise ValueError(
                f"{len(affected)} test(s) were reported on this analyzer since its last passing QC. "
                "Record the outcome of reviewing them in the release notes."
            )
        cursor.execute(
            "UPDATE diag_qc_holds SET status = 'released', released_by = ?, released_at = CURRENT_TIMESTAMP, release_notes = ? WHERE id = ?",
            (username, release_notes, hold_id),
        )
        if hold["scope"] == "equipment":
            cursor.execute(
                "SELECT COUNT(*) AS c FROM diag_qc_holds WHERE equipment_id = ? AND status != 'released' AND id != ?",
                (hold["equipment_id"], hold_id),
            )
            if cursor.fetchone()["c"] == 0:
                cursor.execute("UPDATE diag_equipment SET operational_status = 'ready' WHERE id = ?", (hold["equipment_id"],))
        conn.commit()
        return True



def list_diag_qc_runs(db, equipment_id=None, outcome=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if equipment_id:
            clauses.append("qr.equipment_id = ?")
            params.append(equipment_id)
        if outcome:
            clauses.append("qr.outcome = ?")
            params.append(outcome)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(
            f"""
            SELECT qr.*, eq.name AS equipment_name, s.name AS service_name
            FROM diag_qc_runs qr
            JOIN diag_equipment eq ON eq.id = qr.equipment_id
            LEFT JOIN diag_services s ON s.id = qr.service_id
            {where_clause} ORDER BY qr.run_at DESC LIMIT 200
            """,
            tuple(params),
        )
        return [dict(r) for r in cursor.fetchall()]



def list_diag_qc_holds(db, status=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if status:
            clauses.append("h.status = ?")
            params.append(status)
        else:
            clauses.append("h.status != 'released'")
        cursor.execute(
            f"""
            SELECT h.*, eq.name AS equipment_name, s.name AS service_name, qr.notes AS run_notes, qr.run_at,
                   repeat_qr.outcome AS repeat_qc_outcome
            FROM diag_qc_holds h
            JOIN diag_equipment eq ON eq.id = h.equipment_id
            LEFT JOIN diag_services s ON s.id = h.service_id
            JOIN diag_qc_runs qr ON qr.id = h.qc_run_id
            LEFT JOIN diag_qc_runs repeat_qr ON repeat_qr.id = h.repeat_qc_run_id
            WHERE {' AND '.join(clauses)} ORDER BY h.created_at DESC
            """,
            tuple(params),
        )
        holds = [dict(r) for r in cursor.fetchall()]
        for h in holds:
            h["affected_items"] = _qc_hold_affected_items(cursor, h)
        return holds



def log_diag_equipment_maintenance(db, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_equipment WHERE id = ?", (data["equipment_id"],))
        equipment = cursor.fetchone()
        if not equipment:
            raise ValueError("Equipment not found.")
        cursor.execute(
            """
            INSERT INTO diag_equipment_maintenance (
                equipment_id, service_date, service_type, findings, work_performed, responsible,
                completion_status, next_due_date, downtime_start
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["equipment_id"], data.get("service_date"), data.get("service_type"), data.get("findings"),
                data.get("work_performed"), data.get("responsible", username), data.get("completion_status", "completed"),
                data.get("next_due_date"), datetime.now() if data.get("mark_unavailable") else None,
            ),
        )
        log_id = cursor.lastrowid
        if data.get("next_due_date"):
            # A calibration entry moves the calibration due date (which gates result entry),
            # any other service entry the maintenance due date.
            due_column = "next_calibration_date" if "calibrat" in (data.get("service_type") or "").lower() else "next_maintenance_date"
            cursor.execute(f"UPDATE diag_equipment SET {due_column} = ? WHERE id = ?", (data["next_due_date"], data["equipment_id"]))
        if data.get("mark_unavailable"):
            cursor.execute("UPDATE diag_equipment SET operational_status = 'maintenance' WHERE id = ?", (data["equipment_id"],))
        conn.commit()
        return log_id



def return_diag_equipment_to_service(db, equipment_id, username):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_equipment WHERE id = ?", (equipment_id,))
        equipment = cursor.fetchone()
        if not equipment:
            raise ValueError("Equipment not found.")
        if equipment["operational_status"] != "maintenance":
            raise ValueError("Equipment is not currently under maintenance.")
        cursor.execute(
            "SELECT id FROM diag_equipment_maintenance WHERE equipment_id = ? ORDER BY id DESC LIMIT 1",
            (equipment_id,),
        )
        latest_log = cursor.fetchone()
        if latest_log:
            cursor.execute(
                "UPDATE diag_equipment_maintenance SET downtime_end = CURRENT_TIMESTAMP, return_to_service_by = ?, return_to_service_at = CURRENT_TIMESTAMP, completion_status = 'completed' WHERE id = ?",
                (username, latest_log["id"]),
            )
        cursor.execute("UPDATE diag_equipment SET operational_status = 'ready' WHERE id = ?", (equipment_id,))
        conn.commit()
        return True



def list_diag_equipment_maintenance(db, equipment_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if equipment_id:
            cursor.execute("SELECT * FROM diag_equipment_maintenance WHERE equipment_id = ? ORDER BY id DESC", (equipment_id,))
        else:
            cursor.execute(
                """
                SELECT m.*, eq.name AS equipment_name FROM diag_equipment_maintenance m
                JOIN diag_equipment eq ON eq.id = m.equipment_id ORDER BY m.id DESC LIMIT 200
                """
            )
        return [dict(r) for r in cursor.fetchall()]



REAGENT_LOT_STATUSES = ("available", "quarantined", "expired", "consumed")


def _parse_lot_expiry(value):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ValueError("Enter the expiry date as YYYY-MM-DD.")


def _reagent_lot_is_expired(expiry_date, today=None):
    expiry = _parse_lot_expiry(expiry_date)
    return bool(expiry and expiry < (today or date.today()))


def create_diag_reagent_lot(db, data, username=None):
    if _reagent_lot_is_expired(data.get("expiry_date")):
        raise ValueError("This lot is already past its expiry date and cannot be received into stock.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_reagent_lots WHERE item_name = ? AND lot_no = ?", (data["item_name"], data["lot_no"]))
        if cursor.fetchone():
            raise ValueError("This item/lot combination already exists.")
        cursor.execute(
            """
            INSERT INTO diag_reagent_lots (item_name, lot_no, quantity, unit, expiry_date, storage_location, supplier_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (data["item_name"], data["lot_no"], float(data.get("quantity", 0) or 0), data.get("unit"),
             data.get("expiry_date"), data.get("storage_location"), data.get("supplier_ref")),
        )
        lot_id = cursor.lastrowid
        cursor.execute(
            "INSERT INTO diag_stock_movements (reagent_lot_id, movement_type, delta_qty, actor, notes) VALUES (?, 'receipt', ?, ?, ?)",
            (lot_id, float(data.get("quantity", 0) or 0), username, "Initial receipt"),
        )
        conn.commit()
        return lot_id



def list_diag_reagent_lots(db, status=None, expiring_within_days=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        clauses = []
        params = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if expiring_within_days is not None:
            clauses.append("expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + (? || ' days')::interval")
            params.append(expiring_within_days)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        cursor.execute(f"SELECT * FROM diag_reagent_lots{where_clause} ORDER BY expiry_date ASC NULLS LAST", tuple(params))
        rows = [dict(r) for r in cursor.fetchall()]
        # Lots are not auto-expired in the database; flag the ones still in use past expiry.
        for r in rows:
            r["is_expired"] = r["status"] in ("available", "quarantined") and _reagent_lot_is_expired(r.get("expiry_date"))
        return rows



def update_diag_reagent_lot_status(db, lot_id, status, username=None, notes=None):
    if status not in REAGENT_LOT_STATUSES:
        raise ValueError(f"Invalid reagent lot status '{status}'.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM diag_reagent_lots WHERE id = ?", (lot_id,))
        lot = cursor.fetchone()
        if not lot:
            raise ValueError("Reagent lot not found.")
        if status == "available" and _reagent_lot_is_expired(lot["expiry_date"]):
            raise ValueError("This lot is past its expiry date and cannot be released for use. Mark it expired instead.")
        cursor.execute("UPDATE diag_reagent_lots SET status = ? WHERE id = ?", (status, lot_id))
        movement_type = {"quarantined": "quarantine", "available": "release", "consumed": "consume", "expired": "adjustment"}.get(status, "adjustment")
        cursor.execute(
            "INSERT INTO diag_stock_movements (reagent_lot_id, movement_type, delta_qty, actor, notes) VALUES (?, ?, 0, ?, ?)",
            (lot_id, movement_type, username, notes),
        )
        conn.commit()
        return True



def get_diag_quality_overview(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS c FROM diag_qc_runs WHERE reviewed_at IS NULL")
        open_qc_reviews = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_equipment WHERE operational_status = 'ready'")
        ready = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_equipment")
        total_equipment = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_equipment WHERE next_maintenance_date IS NOT NULL AND next_maintenance_date <= CURRENT_DATE + INTERVAL '14 days'")
        maintenance_due = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_equipment WHERE next_calibration_date IS NOT NULL AND next_calibration_date < CURRENT_DATE")
        calibration_overdue = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_reagent_lots WHERE status = 'available' AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '14 days'")
        expiring_lots = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_reagent_lots WHERE status IN ('available', 'quarantined') AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE")
        expired_lots = cursor.fetchone()["c"]
        cursor.execute("SELECT COUNT(*) AS c FROM diag_qc_holds WHERE status != 'released'")
        open_holds = cursor.fetchone()["c"]
        return {
            "open_qc_reviews": open_qc_reviews,
            "equipment_ready": ready,
            "equipment_total": total_equipment,
            "maintenance_due_soon": maintenance_due,
            "calibration_overdue": calibration_overdue,
            "expiring_lots": expiring_lots,
            "expired_lots": expired_lots,
            "open_release_holds": open_holds,
        }



def get_diag_overview(db):
    """KPI summary for the Lab & Diagnostics Overview dashboard. Every figure is
    a live count/sum against the same tables the worklists and billing already
    use -- nothing here is a separate or fabricated source of truth."""
    with get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) AS c FROM diag_orders WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE")
        today_orders = cursor.fetchone()["c"]

        cursor.execute(
            """
            SELECT COUNT(*) AS c FROM diag_specimens sp
            JOIN diag_order_items oi ON oi.id = sp.order_item_id
            WHERE sp.status = 'awaiting_collection' AND oi.cancelled_at IS NULL
            """
        )
        pending_collection = cursor.fetchone()["c"]

        cursor.execute(
            """
            SELECT COUNT(*) AS c FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL AND (
                (oi.department_type = 'LAB' AND oi.progress_status IN ('collected', 'received'))
                OR (oi.department_type = 'IMAGING' AND EXISTS (
                    SELECT 1 FROM diag_imaging_exams ex WHERE ex.order_item_id = oi.id AND ex.status IN ('arrived', 'prep', 'in_progress')
                ))
            )
            """
        )
        in_processing = cursor.fetchone()["c"]

        cursor.execute("SELECT COUNT(*) AS c FROM diag_reports WHERE status = 'pending_review'")
        pending_validation = cursor.fetchone()["c"]

        cursor.execute("SELECT COUNT(*) AS c FROM diag_reports WHERE status = 'authorized'")
        ready_for_release = cursor.fetchone()["c"]

        cursor.execute(
            """
            SELECT COUNT(*) AS c FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.priority = 'STAT' AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
              AND oi.progress_status NOT IN ('released', 'cancelled')
            """
        )
        stat_cases = cursor.fetchone()["c"]

        cursor.execute("SELECT COUNT(*) AS c FROM diag_critical_alerts WHERE resolved_at IS NULL")
        critical_alerts_open = cursor.fetchone()["c"]

        # Revenue from today's diagnostic orders / invoices:
        cursor.execute(
            """
            SELECT COALESCE(SUM(total_amount), 0) AS billed,
                   COALESCE(SUM(due_amount), 0) AS due
            FROM invoices
            WHERE module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') AND DATE(created_at) = CURRENT_DATE
            """
        )
        inv_row = cursor.fetchone() or {}
        today_billed = float(inv_row.get("billed") or 0)
        today_due = float(inv_row.get("due") or 0)

        cursor.execute(
            """
            SELECT COALESCE(SUM(ip.amount), 0) AS total
            FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
            WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') AND DATE(ip.created_at) = CURRENT_DATE
            """
        )
        today_collected = float(cursor.fetchone()["total"] or 0)

        # Fallback to confirmed orders sum if invoice query returned 0
        if today_billed == 0:
            cursor.execute(
                """
                SELECT COALESCE(SUM(oi.amount), 0) AS total
                FROM diag_order_items oi
                JOIN diag_orders o ON o.id = oi.order_id
                WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL AND DATE(o.created_at) = CURRENT_DATE
                """
            )
            order_sum = float((cursor.fetchone() or {}).get("total") or 0)
            if order_sum > 0:
                today_billed = order_sum

        today_revenue = today_billed if today_billed > 0 else today_collected

        # Overdue: same TAT logic as the worklists, across every still-active lab + imaging item.
        cursor.execute(
            f"""
            SELECT oi.id, oi.department_type, oi.progress_status, o.created_at AS order_created_at,
                   sp.collected_at, sp.received_at, ex.scheduled_at, ds.turnaround_hours
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN diag_specimens sp ON sp.order_item_id = oi.id AND sp.status != 'rejected'
            LEFT JOIN diag_imaging_exams ex ON ex.order_item_id = oi.id
            LEFT JOIN diag_services ds ON ds.id = oi.service_id
            WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL AND oi.progress_status NOT IN ('released', 'cancelled')
              AND NOT {_HAS_RELEASED_REPORT_SQL}
            """
        )
        overdue_count = 0
        pending_rows = cursor.fetchall()
        now = _db_now(cursor)
        for row in pending_rows:
            row = dict(row)
            if row["department_type"] == "IMAGING":
                start = row.get("scheduled_at") or row.get("order_created_at")
            else:
                start = row.get("received_at") or row.get("collected_at") or row.get("order_created_at")
            if _tat_status(start, row.get("turnaround_hours"), now)["tat_status"] == "overdue":
                overdue_count += 1

        return {
            "today_orders": today_orders,
            "pending_collection": pending_collection,
            "in_processing": in_processing,
            "pending_validation": pending_validation,
            "ready_for_release": ready_for_release,
            "stat_cases": stat_cases,
            "critical_alerts_open": critical_alerts_open,
            "today_revenue": float(today_revenue),
            "today_billed": float(today_billed),
            "today_collected": float(today_collected),
            "today_due": float(today_due),
            "overdue_count": overdue_count,
        }



def list_diag_report_templates(db, report_type=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if report_type:
            cursor.execute("SELECT * FROM diag_report_templates WHERE report_type = ? AND active = TRUE ORDER BY name ASC", (report_type,))
        else:
            cursor.execute("SELECT * FROM diag_report_templates WHERE active = TRUE ORDER BY name ASC")
        return cursor.fetchall()



def create_diag_report_template(db, data):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM diag_report_templates WHERE code = ?", (data["code"],))
        if cursor.fetchone():
            raise ValueError(f"Template code '{data['code']}' already exists.")
        cursor.execute(
            "INSERT INTO diag_report_templates (code, name, report_type, layout) VALUES (?, ?, ?, ?)",
            (data["code"].strip(), data["name"].strip(), data["report_type"], data.get("layout", "structured")),
        )
        template_id = cursor.lastrowid
        conn.commit()
        return template_id



def deactivate_diag_report_template(db, template_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE diag_report_templates SET active = FALSE WHERE id = ?", (template_id,))
        conn.commit()
        return cursor.rowcount > 0




# ==================== Bed inventory (ported from utils/beds.py) ====================


def init_beds_table(db):
    """Initializes the hospital_beds table and populates standard initial wards:
    5 ICU beds, 5 General Ward beds, and 5 Single Room beds."""
    id_col = "SERIAL PRIMARY KEY"
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS hospital_beds (
                id {id_col},
                hospital_id INTEGER DEFAULT 1,
                ward TEXT NOT NULL,
                room_no TEXT,
                bed_no TEXT NOT NULL,
                bed_type TEXT DEFAULT 'Standard',
                daily_rate REAL DEFAULT 1000,
                status TEXT DEFAULT 'available',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (ward, bed_no)
            )
            """
        )
        
        # Check if table has any beds; if not, seed the initial 15 beds
        cursor.execute("SELECT COUNT(*) FROM hospital_beds")
        count = cursor.fetchone()[0]
        if count == 0:
            initial_beds = [
                # 5 ICU Beds
                ("ICU", "ICU-Unit 1", "ICU-01", "Critical Care", 3500.0, "available", "Equipped with ventilator & multipara monitor"),
                ("ICU", "ICU-Unit 1", "ICU-02", "Critical Care", 3500.0, "available", "Equipped with ventilator & multipara monitor"),
                ("ICU", "ICU-Unit 1", "ICU-03", "Critical Care", 3500.0, "available", "Equipped with ventilator & multipara monitor"),
                ("ICU", "ICU-Unit 1", "ICU-04", "Critical Care", 3500.0, "available", "Equipped with ventilator & multipara monitor"),
                ("ICU", "ICU-Unit 1", "ICU-05", "Critical Care", 3500.0, "available", "Equipped with ventilator & multipara monitor"),
                
                # 5 General Ward Beds
                ("General Ward", "GW-Wing A", "GW-01", "Standard Ward", 800.0, "available", "General inpatient semi-private care"),
                ("General Ward", "GW-Wing A", "GW-02", "Standard Ward", 800.0, "available", "General inpatient semi-private care"),
                ("General Ward", "GW-Wing A", "GW-03", "Standard Ward", 800.0, "available", "General inpatient semi-private care"),
                ("General Ward", "GW-Wing A", "GW-04", "Standard Ward", 800.0, "available", "General inpatient semi-private care"),
                ("General Ward", "GW-Wing A", "GW-05", "Standard Ward", 800.0, "available", "General inpatient semi-private care"),
                
                # 5 Single Room Beds
                ("Single Room", "SR-Floor 2", "SR-01", "Deluxe Private", 2000.0, "available", "Private room with AC & patient attendant couch"),
                ("Single Room", "SR-Floor 2", "SR-02", "Deluxe Private", 2000.0, "available", "Private room with AC & patient attendant couch"),
                ("Single Room", "SR-Floor 2", "SR-03", "Deluxe Private", 2000.0, "available", "Private room with AC & patient attendant couch"),
                ("Single Room", "SR-Floor 2", "SR-04", "Deluxe Private", 2000.0, "available", "Private room with AC & patient attendant couch"),
                ("Single Room", "SR-Floor 2", "SR-05", "Deluxe Private", 2000.0, "available", "Private room with AC & patient attendant couch"),
            ]
            for b in initial_beds:
                cursor.execute(
                    """
                    INSERT INTO hospital_beds (ward, room_no, bed_no, bed_type, daily_rate, status, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (ward, bed_no) DO NOTHING
                    """,
                    b
                )
        conn.commit()



def list_hospital_beds(db, ward=None, status=None):
    """Returns all beds joined with any active allocation and patient details."""
    init_beds_table(db)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        query = """
            SELECT hb.id, hb.ward, hb.room_no, hb.bed_no, hb.bed_type, hb.daily_rate, hb.status, hb.notes,
                   ba.id as allocation_id, ba.patient_id, ba.allocated_at, ba.amount_per_day as alloc_rate,
                   p.name as patient_name, p.age as patient_age, p.gender as patient_gender, p.phone as patient_phone,
                   adm.discharge_date, adm.notes as admission_notes
            FROM hospital_beds hb
            LEFT JOIN bed_allocations ba ON (ba.ward = hb.ward AND ba.bed_no = hb.bed_no AND ba.status = 'active')
            LEFT JOIN patients p ON p.patient_id = ba.patient_id
            LEFT JOIN admissions adm ON adm.id = ba.admission_id
        """
        clauses = []
        params = []
        if ward and ward.lower() != "all":
            clauses.append("LOWER(hb.ward) = LOWER(?)")
            params.append(ward.strip())
        if status and status.lower() != "all":
            clauses.append("LOWER(hb.status) = LOWER(?)")
            params.append(status.strip())
            
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
            
        query += " ORDER BY hb.ward ASC, hb.bed_no ASC"
        cursor.execute(query, tuple(params))
        rows = [dict(r) for r in cursor.fetchall()]
        
        # Calculate summary metrics
        cursor.execute("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied FROM hospital_beds")
        summary_row = cursor.fetchone()
        total_capacity = summary_row[0] if summary_row else len(rows)
        occupied_count = summary_row[1] if summary_row and summary_row[1] else 0
        available_count = max(0, total_capacity - occupied_count)
        occupancy_rate = round((occupied_count / total_capacity * 100), 1) if total_capacity > 0 else 0
        
        # Distinct wards and per-ward stats
        cursor.execute("""
            SELECT ward,
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
                   SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
                   SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) as maintenance
            FROM hospital_beds
            GROUP BY ward
            ORDER BY ward ASC
        """)
        ward_stats = {}
        wards = []
        for w_row in cursor.fetchall():
            w_name = w_row[0]
            wards.append(w_name)
            ward_stats[w_name] = {
                "total": int(w_row[1] or 0),
                "available": int(w_row[2] or 0),
                "occupied": int(w_row[3] or 0),
                "maintenance": int(w_row[4] or 0),
            }
        
        return {
            "beds": rows,
            "summary": {
                "total": total_capacity,
                "occupied": occupied_count,
                "available": available_count,
                "maintenance": 0,
                "total_capacity": total_capacity,
                "occupied_count": occupied_count,
                "available_count": available_count,
                "occupancy_rate": occupancy_rate,
                "wards": ward_stats,
            },
            "wards": wards,
        }



def create_hospital_bed(db, ward, room_no, bed_no, daily_rate, bed_type="Standard", notes=""):
    """Adds a new bed dynamically into the chosen ward."""
    init_beds_table(db)
    ward = (ward or "").strip()
    bed_no = (bed_no or "").strip()
    room_no = (room_no or "").strip()
    rate = float(daily_rate or 1000.0)
    
    if not ward or not bed_no:
        raise ValueError("Ward and Bed Number are required.")
        
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO hospital_beds (ward, room_no, bed_no, bed_type, daily_rate, status, notes)
            VALUES (?, ?, ?, ?, ?, 'available', ?)
            RETURNING id
            """,
            (ward, room_no, bed_no, bed_type, rate, notes)
        )
        new_id = cursor.fetchone()[0]
        
        # Also update global bed_config capacity
        cursor.execute("SELECT COUNT(*) FROM hospital_beds")
        total_count = cursor.fetchone()[0]
        cursor.execute("UPDATE bed_config SET capacity = ?", (total_count,))
        conn.commit()
        return new_id



def update_bed_status_by_number(db, ward, bed_no, status):
    """Updates the status of a specific bed (e.g. available, occupied, maintenance)."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE hospital_beds SET status = ? WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
            (status, ward.strip(), bed_no.strip())
        )
        conn.commit()



def get_admission_clinical_history(db, identifier, hospital_id=None):
    """Retrieves complete inpatient clinical history for an admission number or UHID,
    formatting chronological treatments, vitals, medications, and timings for discharge summary."""
    import re
    from datetime import datetime
    
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    raw_ident = str(identifier or "").strip()
    if not raw_ident:
        raise ValueError("Admission Number or UHID is required.")
        
    num_match = re.search(r"(\d+)", raw_ident)
    numeric_id = int(num_match.group(1)) if num_match else None
    
    with get_connection(db) as conn:
        cursor = conn.cursor()
        adm = None
        
        # 1. Try finding by admission ID
        if numeric_id and not raw_ident.upper().startswith("PAT-"):
            cursor.execute("SELECT * FROM admissions WHERE id = ?", (numeric_id,))
            adm = cursor.fetchone()
            
        # 2. Try finding by UHID / patient_id
        if not adm:
            cursor.execute(
                "SELECT * FROM admissions WHERE LOWER(patient_id) = LOWER(?) ORDER BY admission_date DESC LIMIT 1",
                (raw_ident,)
            )
            adm = cursor.fetchone()
            
        # 3. Fallback: try numeric_id
        if not adm and numeric_id:
            cursor.execute("SELECT * FROM admissions WHERE id = ?", (numeric_id,))
            adm = cursor.fetchone()
            
        if not adm:
            # Check if there is an active bed allocation for this identifier
            cursor.execute(
                "SELECT * FROM bed_allocations WHERE id = ? OR LOWER(patient_id) = LOWER(?) ORDER BY allocated_at DESC LIMIT 1",
                (numeric_id or -1, raw_ident)
            )
            ba = cursor.fetchone()
            if ba and ba["admission_id"]:
                cursor.execute("SELECT * FROM admissions WHERE id = ?", (ba["admission_id"],))
                adm = cursor.fetchone()
            elif ba:
                # Synthesize admission record from allocation
                adm = {
                    "id": ba["id"],
                    "patient_id": ba["patient_id"],
                    "admission_date": ba["allocated_at"],
                    "discharge_date": None,
                    "notes": f"Admitted to {ba['ward']} / Bed {ba['bed_no']}",
                    "hospital_id": scoped_hospital_id,
                }
                
        if not adm:
            raise ValueError(f"No inpatient admission found for identifier '{raw_ident}'.")
            
        adm_id = adm["id"]
        patient_id = adm["patient_id"]
        adm_date = adm["admission_date"]
        adm_notes = str(adm["notes"] or "")
        
        # Fetch Patient Record
        cursor.execute("SELECT * FROM patients WHERE LOWER(patient_id) = LOWER(?)", (patient_id,))
        patient_row = cursor.fetchone()
        patient_name = "Patient"
        patient_age = "Adult"
        patient_gender = "N/A"
        patient_phone = ""
        if patient_row:
            patient_name = " ".join(filter(None, [patient_row["name"], patient_row["middle_name"] if "middle_name" in patient_row.keys() else "", patient_row["last_name"] if "last_name" in patient_row.keys() else ""])).strip() or patient_row["name"]
            patient_age = f"{patient_row['age']} yrs" if patient_row["age"] else ""
            patient_gender = patient_row["gender"] or ""
            patient_phone = patient_row["phone"] or ""
            
        # Fetch Bed Allocation
        cursor.execute(
            """
            SELECT * FROM bed_allocations
            WHERE (admission_id = ? OR LOWER(patient_id) = LOWER(?))
            ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, allocated_at DESC LIMIT 1
            """,
            (adm_id, patient_id)
        )
        bed_row = cursor.fetchone()
        ward_name = bed_row["ward"] if bed_row else "General Ward"
        room_no = bed_row["room_no"] if bed_row else "GW-1"
        bed_no = bed_row["bed_no"] if bed_row else "GW-01"
        alloc_time = bed_row["allocated_at"] if bed_row else adm_date
        
        # Parse notes for clinical metadata -- honest "not specified"
        # placeholders when the admission notes don't actually contain this
        # information, never a plausible-looking invented doctor/department.
        parsed_dept = "Not specified"
        parsed_doc = "Not specified"
        parsed_reason = "To be completed by attending physician"
        parsed_stay = ""
        parsed_ins = "Cashless"
        
        for part in adm_notes.split("|"):
            part_str = part.strip()
            if part_str.lower().startswith("department:"):
                parsed_dept = part_str.split(":", 1)[1].strip()
            elif part_str.lower().startswith("consulting doctor:") or part_str.lower().startswith("consultant:"):
                parsed_doc = part_str.split(":", 1)[1].strip()
            elif part_str.lower().startswith("reason:"):
                parsed_reason = part_str.split(":", 1)[1].strip()
            elif part_str.lower().startswith("expected stay:"):
                parsed_stay = part_str.split(":", 1)[1].strip()
            elif part_str.lower().startswith("admission type:"):
                pass
            elif not parsed_reason or parsed_reason == "To be completed by attending physician":
                if part_str and not ":" in part_str:
                    parsed_reason = part_str
                    
        # Parse Dates & Timings
        now_dt = current_ist_datetime()
        adm_dt = None
        if adm_date:
            try:
                adm_dt = datetime.fromisoformat(str(adm_date).replace("Z", ""))
            except Exception:
                adm_dt = now_dt
        else:
            adm_dt = now_dt
            
        adm_formatted_date = adm_dt.strftime("%Y-%m-%d")
        adm_formatted_time = adm_dt.strftime("%I:%M %p")
        adm_display_full = f"{adm_formatted_date} at {adm_formatted_time}"
        
        dis_formatted_date = now_dt.strftime("%Y-%m-%d")
        dis_formatted_time = now_dt.strftime("%I:%M %p")
        dis_display_full = f"{dis_formatted_date} at {dis_formatted_time}"
        
        stay_seconds = max(0, (now_dt.replace(tzinfo=None) - adm_dt.replace(tzinfo=None)).total_seconds())
        stay_days = max(1, int(math.ceil(stay_seconds / 86400.0)))
        stay_hours = round(stay_seconds / 3600.0, 1)
        
        # Fetch Vitals History
        vitals_list = []
        try:
            cursor.execute(
                """
                SELECT * FROM patient_vitals
                WHERE LOWER(patient_id) = LOWER(?)
                ORDER BY created_at ASC
                """,
                (patient_id,)
            )
            vitals_list = [dict(r) for r in cursor.fetchall()]
        except Exception:
            pass
            
        # Fetch Nursing Care Logs
        care_logs = []
        try:
            cursor.execute(
                """
                SELECT * FROM nursing_care_logs
                WHERE LOWER(patient_id) = LOWER(?)
                ORDER BY created_at ASC
                """,
                (patient_id,)
            )
            care_logs = [dict(r) for r in cursor.fetchall()]
        except Exception:
            pass
            
        # Fetch Pharmacy Medications Administered
        pharm_sales = []
        try:
            cursor.execute(
                """
                SELECT * FROM pharmacy_sales
                WHERE (admission_id = ? OR LOWER(patient_id) = LOWER(?))
                ORDER BY sold_at ASC
                """,
                (adm_id, patient_id)
            )
            pharm_sales = [dict(r) for r in cursor.fetchall()]
        except Exception:
            pass
            
        # Synthesize Detailed Clinical Treatment Summary with Timestamps
        treatment_lines = [
            f"• ADMISSION TIMELINE: Admitted on {adm_display_full} to {ward_name} (Room: {room_no}, Bed: {bed_no}) under {parsed_doc} ({parsed_dept}).",
            f"• CHIEF PRESENTING COMPLAINT: {parsed_reason}.",
        ]
        
        if vitals_list:
            treatment_lines.append("• VITALS MONITORING HISTORY:")
            for v in vitals_list[-4:]:
                v_time = str(v.get("created_at") or "")
                try:
                    v_dt = datetime.fromisoformat(v_time.replace("Z", ""))
                    v_time_str = v_dt.strftime("%d %b %I:%M %p")
                except Exception:
                    v_time_str = v_time
                bp_str = f"BP: {v.get('bp_systolic')}/{v.get('bp_diastolic')} mmHg" if v.get("bp_systolic") else (f"BP: {v.get('blood_pressure')}" if v.get("blood_pressure") else "")
                pulse_str = f"Pulse: {v.get('heart_rate') or v.get('pulse')} bpm" if (v.get('heart_rate') or v.get('pulse')) else ""
                spo2_str = f"SpO2: {v.get('spo2')}%" if v.get('spo2') else ""
                temp_str = f"Temp: {v.get('temperature')}°F" if v.get('temperature') else ""
                v_parts = ", ".join(filter(None, [bp_str, pulse_str, temp_str, spo2_str]))
                treatment_lines.append(f"   [{v_time_str}] {v_parts or 'Vitals stable'}")
        else:
            treatment_lines.append("• VITALS MONITORING: No vitals were recorded against this admission -- record actual readings before finalizing.")

        if care_logs:
            treatment_lines.append("• NURSING INTERVENTIONS & MONITORING:")
            for cl in care_logs[-4:]:
                c_time = str(cl.get("created_at") or "")
                try:
                    c_dt = datetime.fromisoformat(c_time.replace("Z", ""))
                    c_time_str = c_dt.strftime("%d %b %I:%M %p")
                except Exception:
                    c_time_str = c_time
                nurse = cl.get("nurse_name") or "Staff Nurse"
                activity = cl.get("activity") or "Routine patient monitoring and care"
                treatment_lines.append(f"   [{c_time_str}] {activity} (Nurse: {nurse})")
        else:
            treatment_lines.append("• NURSING COURSE: No nursing care log entries were recorded against this admission.")

        if pharm_sales:
            med_names = list(set([str(s.get("medicine_name")) for s in pharm_sales if s.get("medicine_name")]))
            treatment_lines.append(f"• INPATIENT PHARMACOTHERAPY: Received {', '.join(med_names[:5])}.")

        treatment_lines.append(f"• DISCHARGE CONDITION [{dis_display_full}]: To be assessed and documented by the attending physician.")

        # Discharge medicines -- only ever lists what was actually dispensed
        # to this admission through Pharmacy; never a plausible-looking
        # invented drug list.
        if pharm_sales:
            discharge_meds_lines = []
            seen = set()
            for s in pharm_sales:
                mname = str(s.get("medicine_name") or "").strip()
                if mname and mname.lower() not in seen:
                    seen.add(mname.lower())
                    discharge_meds_lines.append(f"{len(discharge_meds_lines) + 1}. {mname} - As prescribed / directed by physician")
            discharge_meds_lines = discharge_meds_lines[:6]
        else:
            discharge_meds_lines = ["No medicines were dispensed to this admission through the pharmacy module -- enter discharge medications manually before finalizing."]

        # Follow-up plan -- generic safety advice only; never asserts a
        # specific follow-up appointment or schedule that was never actually
        # made.
        follow_up_lines = [
            f"• Follow-up consultation to be scheduled with the attending physician{f' ({parsed_doc})' if parsed_doc != 'Not specified' else ''} -- enter the actual review date before finalizing.",
            "• Dietary guidelines: Balanced, low-salt, easily digestible diet with adequate hydration (2.5 - 3 Liters/day).",
            "• Emergency instructions: Report immediately to Emergency Room (ER) if high-grade fever (>101°F), persistent vomiting, or severe pain recurs.",
        ]

        # Real billing total for this admission -- every invoice actually
        # linked to it (diagnostics billed to discharge, pharmacy billed to
        # the admission, and the room/bed discharge invoice), never a status
        # inferred only from whether discharge_date happens to be set.
        cursor.execute(
            """
            SELECT DISTINCT oi.discharge_invoice_id AS iid FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND oi.discharge_invoice_id IS NOT NULL
            UNION
            SELECT DISTINCT ps.invoice_id AS iid FROM pharmacy_sales ps WHERE ps.admission_id = ? AND ps.invoice_id IS NOT NULL
              -- an insurance invoice is the insurer's to pay until its claim is rejected/closed
              AND NOT EXISTS (SELECT 1 FROM insurance_claims c WHERE c.invoice_id = ps.invoice_id
                              AND c.claim_status NOT IN ('rejected', 'closed'))
            """,
            (adm_id, adm_id),
        )
        billing_invoice_ids = {r["iid"] for r in cursor.fetchall() if r["iid"]}
        cursor.execute(
            """
            SELECT COALESCE(SUM(i.due_amount), 0) AS d FROM invoices i
            WHERE i.id IN (SELECT DISTINCT ps.invoice_id FROM pharmacy_sales ps WHERE ps.admission_id = ? AND ps.invoice_id IS NOT NULL)
              AND EXISTS (SELECT 1 FROM insurance_claims c WHERE c.invoice_id = i.id AND c.claim_status NOT IN ('rejected', 'closed'))
            """,
            (adm_id,),
        )
        insurance_due = float(cursor.fetchone()["d"] or 0)
        cursor.execute(
            "SELECT id FROM invoices WHERE LOWER(patient_id) = LOWER(?) AND module = 'IP' AND invoice_type = 'DISCHARGE'",
            (patient_id,),
        )
        billing_invoice_ids.update(r["id"] for r in cursor.fetchall())

        total_bill = paid_amount = due_amount = 0.0
        if billing_invoice_ids:
            cursor.execute(
                "SELECT COALESCE(SUM(total_amount),0) AS t, COALESCE(SUM(paid_amount),0) AS p, COALESCE(SUM(due_amount),0) AS d "
                "FROM invoices WHERE id = ANY(?)",
                (list(billing_invoice_ids),),
            )
            bill_row = cursor.fetchone()
            total_bill = float(bill_row["t"] or 0)
            paid_amount = float(bill_row["p"] or 0)
            due_amount = float(bill_row["d"] or 0)

        return {
            "admission_id": f"ADM-{adm_id}",
            "raw_admission_id": adm_id,
            "insurance_due": insurance_due,
            "patient_id": patient_id,
            "patient_name": patient_name,
            "patient_age": patient_age,
            "patient_gender": patient_gender,
            "patient_phone": patient_phone,
            "ward": ward_name,
            "room_no": room_no,
            "bed_no": bed_no,
            "department": parsed_dept,
            "consulting_doctor": parsed_doc,
            "final_diagnosis": parsed_reason,
            "admission_date": adm_formatted_date,
            "admission_time": adm_formatted_time,
            "admission_date_full": adm_display_full,
            "discharge_date": dis_formatted_date,
            "discharge_time": dis_formatted_time,
            "discharge_date_full": dis_display_full,
            "days_stayed": stay_days,
            "hours_stayed": stay_hours,
            "treatment_summary": "\n".join(treatment_lines),
            "discharge_medicines": "\n".join(discharge_meds_lines),
            "follow_up_plan": "\n".join(follow_up_lines),
            "total_bill": round(total_bill, 2),
            "amount_paid": round(paid_amount, 2),
            "amount_due": round(due_amount, 2),
            "billing_clearance": "cleared" if due_amount <= 0 else "pending",
            "status": "final" if adm.get("discharge_date") else "draft",
        }
