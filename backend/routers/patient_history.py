"""Per-patient history of one module (Bills & Payment, Pharmacy, Diagnostics, IP Discharge), shown inside the
Patient Journey page so staff do not have to leave it. Read only; each module needs that module's read permission."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions
import legacy_sql
import patient_journey
import security

router = APIRouter(prefix="/api", tags=["patient-history"])

MODULE_PERMISSION = {
    "bills": "billing.read",
    "pharmacy": "pharmacy.read",
    "diagnostics": "diag.read",
    "discharge": "billing.read",
    "consultations": "patients.read",
    "vitals": "patients.read",
    "patient360": "patients.read",
}
LIMIT = 300


def _fmt(v):
    if v is None:
        return ""
    if hasattr(v, "hour"):
        return v.isoformat(sep=" ", timespec="minutes")
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, float):
        return round(v, 2)
    return v


def _section(cursor, title, columns, sql, params, note=None):
    cursor.execute(sql, tuple(params))
    rows = [[_fmt(c) for c in r] for r in cursor.fetchall()]
    return {"title": title, "columns": columns, "rows": rows, "note": note}


@router.get("/patients/{patient_id}/module-history/{module}")
def patient_module_history(patient_id: str, module: str, db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    permission = MODULE_PERMISSION.get(module)
    if not permission:
        raise HTTPException(status_code=400, detail="Unknown module.")
    if permission not in security.resolve_user_permissions(user):
        raise HTTPException(status_code=403, detail="You do not have permission to view this module's history.")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM patients WHERE patient_id = ?", (patient_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Patient not found.")

        if module == "bills":
            sections = [
                _section(cursor, "Invoices", ["Date", "Invoice", "Module", "Total", "Paid", "Due", "Status"],
                         f"""SELECT created_at, invoice_no, module, total_amount, paid_amount, due_amount, payment_status FROM invoices
                             WHERE patient_id = ? ORDER BY created_at DESC LIMIT {LIMIT}""", (patient_id,)),
                _section(cursor, "Payments received", ["Date", "Invoice", "Mode", "Amount", "Receipt"],
                         f"""SELECT ip.created_at, i.invoice_no, ip.payment_mode, ip.amount, COALESCE(ip.receipt_no, 'PMT-' || ip.id) FROM invoice_payments ip
                             JOIN invoices i ON i.id = ip.invoice_id WHERE i.patient_id = ? ORDER BY ip.created_at DESC LIMIT {LIMIT}""", (patient_id,)),
                _section(cursor, "Advance deposits", ["Date", "Advance", "Mode", "Amount", "Used", "Refunded", "Status"],
                         f"""SELECT created_at, advance_no, payment_mode, amount, allocated_amount, refunded_amount, status FROM patient_advances
                             WHERE patient_id = ? ORDER BY created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "Bills & Payment history", "sections": sections}

        if module == "pharmacy":
            sections = [
                _section(cursor, "Pharmacy sales", ["Date", "Medicine", "Qty", "Unit price", "Amount", "GST / Tax", "Total", "Billing", "Invoice", "Payment"],
                         f"""SELECT ps.sold_at, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount,
                                    ROUND(CAST(CASE WHEN i.subtotal > 0 AND i.tax > 0 THEN (ps.amount / i.subtotal) * i.tax ELSE COALESCE(i.tax, 0) END AS NUMERIC), 2) AS gst_amount,
                                    ROUND(CAST(ps.amount + CASE WHEN i.subtotal > 0 AND i.tax > 0 THEN (ps.amount / i.subtotal) * i.tax ELSE COALESCE(i.tax, 0) END AS NUMERIC), 2) AS total_amount,
                                    ps.billing_type, i.invoice_no, ps.payment_mode
                             FROM pharmacy_sales ps LEFT JOIN invoices i ON i.id = ps.invoice_id
                             WHERE ps.patient_id = ? ORDER BY ps.sold_at DESC LIMIT {LIMIT}""", (patient_id,)),
                _section(cursor, "Prescriptions written", ["Date", "Prescription", "Doctor", "Diagnosis", "Medicines", "Dispense status"],
                         f"""SELECT p.created_at, '#' || p.id, p.doctor_name, p.diagnosis,
                                    (SELECT string_agg(m.medicine_name, ', ' ORDER BY m.id) FROM prescription_medicines m WHERE m.prescription_id = p.id), p.dispense_status
                             FROM prescriptions p WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "Pharmacy history", "sections": sections}

        if module == "diagnostics":
            sections = [
                _section(cursor, "Lab & imaging tests", ["Date", "Order", "Test", "Department", "Amount", "Progress", "Report"],
                         f"""SELECT o.created_at, o.order_no, oi.service_name, oi.department_type, oi.amount, oi.progress_status,
                                    (SELECT r.status FROM diag_reports r WHERE r.order_item_id = oi.id ORDER BY r.version DESC LIMIT 1)
                             FROM diag_orders o JOIN diag_order_items oi ON oi.order_id = o.id
                             WHERE o.patient_id = ? AND oi.cancelled_at IS NULL ORDER BY o.created_at DESC, oi.id LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "Diagnostics history", "sections": sections}

        if module == "consultations":
            sections = [
                _section(cursor, "Doctor Consultations & Appointments", ["Date", "Token", "Visit Type", "Department", "Doctor", "Status", "Consultation Fee", "Started At", "Completed At", "Notes"],
                         f"""SELECT appointment_date, COALESCE(token_no::text, '—'), visit_type, COALESCE(department, '—'), COALESCE(doctor_name, '—'), status, consultation_fee,
                                    consultation_started_at, consultation_completed_at, COALESCE(notes, '—')
                             FROM appointments WHERE patient_id = ? ORDER BY appointment_date DESC LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "Consultations & Queue history", "sections": sections}

        if module == "vitals":
            sections = [
                _section(cursor, "Patient Vitals & Clinical Measurements", ["Recorded At", "BP", "Pulse (bpm)", "Temp (°C)", "SpO2 (%)", "Weight (kg)", "Height (cm)", "Recorded By"],
                         f"""SELECT COALESCE(recorded_at, record_time, created_at), COALESCE(bp, '—'), pulse, temperature, spo2, weight, height, COALESCE(recorded_by, 'Clinical Staff')
                             FROM patient_vitals WHERE patient_id = ? ORDER BY COALESCE(recorded_at, record_time, created_at) DESC LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "Vitals & Measurements history", "sections": sections}

        if module == "discharge":
            admissions = _section(cursor, "Admissions and discharge billing", ["Admission", "Admitted", "Discharged", "Ward / Bed", "Doctor", "Final bill", "Total", "Paid", "Due"],
                                  f"""SELECT 'ADM-' || a.id, a.admission_date, a.discharge_date, COALESCE(ba.ward, '') || CASE WHEN ba.bed_no IS NOT NULL THEN ' / ' || ba.bed_no ELSE '' END,
                                             COALESCE(ba.assigned_doctor, ''), inv.invoice_no, inv.total_amount, inv.paid_amount, inv.due_amount
                                      FROM admissions a
                                      LEFT JOIN LATERAL (SELECT ward, bed_no, assigned_doctor FROM bed_allocations WHERE admission_id = a.id
                                                         ORDER BY (status = 'active') DESC, allocated_at DESC LIMIT 1) ba ON TRUE
                                      LEFT JOIN LATERAL (SELECT invoice_no, total_amount, paid_amount, due_amount FROM invoices
                                                         WHERE admission_id = a.id AND module = 'IP' ORDER BY created_at DESC LIMIT 1) inv ON TRUE
                                      WHERE a.patient_id = ? AND COALESCE(a.notes, '') != 'Initial registration' ORDER BY a.admission_date DESC LIMIT {LIMIT}""", (patient_id,))
            for row in admissions["rows"]:
                row[2] = row[2] or "Admitted"
                row[5] = row[5] or "Not billed yet"
            sections = [
                admissions,
                _section(cursor, "Discharge summaries", ["Visit", "Status", "Version", "Prepared by", "Updated"],
                         f"""SELECT encounter_label, status, current_version, created_by, updated_at FROM discharge_summaries
                             WHERE patient_id = ? ORDER BY updated_at DESC LIMIT {LIMIT}""", (patient_id,)),
            ]
            return {"title": "IP Discharge history", "sections": sections}

        # Patient 360: Complete end-to-end dossier across ALL hospital modules
        admissions_360 = _section(cursor, "7. Inpatient Admissions & Bed Stays", ["Admission", "Admitted", "Discharged", "Ward / Bed", "Doctor", "Final bill", "Total", "Paid", "Due"],
                                  f"""SELECT 'ADM-' || a.id, a.admission_date, a.discharge_date, COALESCE(ba.ward, '') || CASE WHEN ba.bed_no IS NOT NULL THEN ' / ' || ba.bed_no ELSE '' END,
                                             COALESCE(ba.assigned_doctor, ''), inv.invoice_no, inv.total_amount, inv.paid_amount, inv.due_amount
                                      FROM admissions a
                                      LEFT JOIN LATERAL (SELECT ward, bed_no, assigned_doctor FROM bed_allocations WHERE admission_id = a.id
                                                         ORDER BY (status = 'active') DESC, allocated_at DESC LIMIT 1) ba ON TRUE
                                      LEFT JOIN LATERAL (SELECT invoice_no, total_amount, paid_amount, due_amount FROM invoices
                                                         WHERE admission_id = a.id AND module = 'IP' ORDER BY created_at DESC LIMIT 1) inv ON TRUE
                                      WHERE a.patient_id = ? AND COALESCE(a.notes, '') != 'Initial registration' ORDER BY a.admission_date DESC LIMIT {LIMIT}""", (patient_id,))
        for row in admissions_360["rows"]:
            row[2] = row[2] or "Admitted"
            row[5] = row[5] or "Not billed yet"

        sections = [
            _section(cursor, "1. Patient Demographics & Profile", ["Registered At", "UHID", "Name", "Age", "Gender", "Phone", "Address", "Email"],
                     "SELECT created_at, patient_id, name, age, gender, phone, address, email FROM patients WHERE patient_id = ?", (patient_id,)),
            _section(cursor, "2. OP Consultations & Appointments", ["Date", "Token", "Visit Type", "Department", "Doctor", "Status", "Consultation Fee", "Started At", "Completed At", "Notes"],
                     f"""SELECT appointment_date, COALESCE(token_no::text, '—'), visit_type, COALESCE(department, '—'), COALESCE(doctor_name, '—'), status, consultation_fee,
                                consultation_started_at, consultation_completed_at, COALESCE(notes, '—')
                         FROM appointments WHERE patient_id = ? ORDER BY appointment_date DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "3. Clinical Vitals & Triage Measurements", ["Recorded At", "BP", "Pulse (bpm)", "Temp (°C)", "SpO2 (%)", "Weight (kg)", "Height (cm)", "Recorded By"],
                     f"""SELECT COALESCE(recorded_at, record_time, created_at), COALESCE(bp, '—'), pulse, temperature, spo2, weight, height, COALESCE(recorded_by, 'Clinical Staff')
                         FROM patient_vitals WHERE patient_id = ? ORDER BY COALESCE(recorded_at, record_time, created_at) DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "4. Doctor Prescriptions & Medications", ["Date", "Prescription", "Doctor", "Diagnosis", "Medicines", "Dispense status"],
                     f"""SELECT p.created_at, '#' || p.id, p.doctor_name, p.diagnosis,
                                (SELECT string_agg(m.medicine_name, ', ' ORDER BY m.id) FROM prescription_medicines m WHERE m.prescription_id = p.id), p.dispense_status
                         FROM prescriptions p WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "5. Diagnostics (Lab & Radiology Orders)", ["Date", "Order", "Test", "Department", "Amount", "Progress", "Report"],
                     f"""SELECT o.created_at, o.order_no, oi.service_name, oi.department_type, oi.amount, oi.progress_status,
                                (SELECT r.status FROM diag_reports r WHERE r.order_item_id = oi.id ORDER BY r.version DESC LIMIT 1)
                         FROM diag_orders o JOIN diag_order_items oi ON oi.order_id = o.id
                         WHERE o.patient_id = ? AND oi.cancelled_at IS NULL ORDER BY o.created_at DESC, oi.id LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "6. Pharmacy Dispensing & Sales (with GST)", ["Date", "Medicine", "Qty", "Unit price", "Amount", "GST / Tax", "Total", "Billing", "Invoice", "Payment"],
                     f"""SELECT ps.sold_at, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount,
                                ROUND(CAST(CASE WHEN i.subtotal > 0 AND i.tax > 0 THEN (ps.amount / i.subtotal) * i.tax ELSE COALESCE(i.tax, 0) END AS NUMERIC), 2) AS gst_amount,
                                ROUND(CAST(ps.amount + CASE WHEN i.subtotal > 0 AND i.tax > 0 THEN (ps.amount / i.subtotal) * i.tax ELSE COALESCE(i.tax, 0) END AS NUMERIC), 2) AS total_amount,
                                ps.billing_type, i.invoice_no, ps.payment_mode
                         FROM pharmacy_sales ps LEFT JOIN invoices i ON i.id = ps.invoice_id
                         WHERE ps.patient_id = ? ORDER BY ps.sold_at DESC LIMIT {LIMIT}""", (patient_id,)),
            admissions_360,
            _section(cursor, "8. Invoices & Billing Summary", ["Date", "Invoice", "Module", "Total", "Paid", "Due", "Status"],
                     f"""SELECT created_at, invoice_no, module, total_amount, paid_amount, due_amount, payment_status FROM invoices
                         WHERE patient_id = ? ORDER BY created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "9. Payments & Receipts Received", ["Date", "Invoice", "Mode", "Amount", "Receipt"],
                     f"""SELECT ip.created_at, i.invoice_no, ip.payment_mode, ip.amount, COALESCE(ip.receipt_no, 'PMT-' || ip.id) FROM invoice_payments ip
                         JOIN invoices i ON i.id = ip.invoice_id WHERE i.patient_id = ? ORDER BY ip.created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "10. Advance Deposits & Refunds", ["Date", "Advance", "Mode", "Amount", "Used", "Refunded", "Status"],
                     f"""SELECT created_at, advance_no, payment_mode, amount, allocated_amount, refunded_amount, status FROM patient_advances
                         WHERE patient_id = ? ORDER BY created_at DESC LIMIT {LIMIT}""", (patient_id,)),
            _section(cursor, "11. Discharge Summaries & Clinical Exit", ["Visit", "Status", "Version", "Prepared by", "Updated"],
                     f"""SELECT encounter_label, status, current_version, created_by, updated_at FROM discharge_summaries
                         WHERE patient_id = ? ORDER BY updated_at DESC LIMIT {LIMIT}""", (patient_id,)),
        ]
        return {"title": "Patient 360 — Full Hospital Dossier", "sections": sections}
