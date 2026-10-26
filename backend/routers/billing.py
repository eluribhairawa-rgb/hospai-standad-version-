from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id
from common import (
    rows_to_dicts, validate_required_fields, log_audit_event, client_ip,
    normalize_payment_mode, normalize_billing_module, require_razorpay_configured,
    to_amount_paise, create_razorpay_order, verify_razorpay_signature, RAZORPAY_KEY_ID,
)
import legacy_queries as lq
import legacy_sql

router = APIRouter(prefix="/api/billing", tags=["billing"])


@router.get("/invoices")
def billing_invoices(patient_id: str | None = None, module: str | None = None, db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("billing.read"))):
    return {"invoices": rows_to_dicts(lq.list_invoices(db, patient_id=patient_id, module=module))}


@router.post("/invoices")
def billing_create_invoice(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    validate_required_fields(payload, ["module", "total_amount"])
    invoice_no = payload.get("invoice_no") or f"INV-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    invoice_id = lq.create_invoice(db, {
        "invoice_no": invoice_no, "patient_id": payload.get("patient_id"), "module": payload.get("module", "OP"),
        "doctor_name": payload.get("doctor_name"), "clinic_name": payload.get("clinic_name"),
        "referral_source": payload.get("referral_source"), "subtotal": payload.get("subtotal", 0),
        "tax": payload.get("tax", 0), "discount": payload.get("discount", 0), "total_amount": payload.get("total_amount", 0),
        "paid_amount": payload.get("paid_amount", 0), "advance_amount": payload.get("advance_amount", 0),
        "refunded_amount": payload.get("refunded_amount", 0), "payment_status": payload.get("payment_status", "due"),
        "created_by": user.get("username"),
    })
    log_audit_event(db, user, client_ip(request), "create", "billing_invoices", str(invoice_id), {"invoice_no": invoice_no})
    return {"invoice_id": invoice_id, "invoice_no": invoice_no}


@router.put("/invoices/{invoice_id}")
def billing_update_invoice(invoice_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    if not lq.update_invoice(db, invoice_id, payload):
        raise HTTPException(status_code=404, detail="Invoice not found")
    log_audit_event(db, user, client_ip(request), "update", "billing_invoices", str(invoice_id), {"invoice_id": invoice_id})
    return {"status": "ok"}


@router.delete("/invoices/{invoice_id}")
def billing_delete_invoice(invoice_id: int, request: Request, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    if not lq.delete_invoice(db, invoice_id):
        raise HTTPException(status_code=404, detail="Invoice not found")
    log_audit_event(db, user, client_ip(request), "delete", "billing_invoices", str(invoice_id), {"invoice_id": invoice_id})
    return {"status": "ok"}


@router.post("/razorpay/order")
def billing_razorpay_order(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write")),
                            hospital_id: int = Depends(current_hospital_id)):
    require_razorpay_configured()
    validate_required_fields(payload, ["invoice_id", "amount"])
    amount_paise = to_amount_paise(payload.get("amount"))
    if amount_paise is None:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero.")
    try:
        invoice_id = int(payload.get("invoice_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invoice_id must be a valid number.")
    if not lq.get_invoice_by_id(db, invoice_id):
        raise HTTPException(status_code=404, detail="Invoice not found")
    receipt = payload.get("receipt") or f"bill-{invoice_id}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    notes = payload.get("notes") if isinstance(payload.get("notes"), dict) else {}
    notes = {**notes, "invoice_id": str(invoice_id), "hospital_id": str(hospital_id)}
    try:
        order = create_razorpay_order(amount_paise, currency=payload.get("currency", "INR"), receipt=receipt, notes=notes)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error))
    return {"key_id": RAZORPAY_KEY_ID, "order_id": order.get("id"), "amount": order.get("amount"),
            "currency": order.get("currency"), "receipt": order.get("receipt")}


@router.post("/razorpay/verify")
def billing_razorpay_verify(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("billing.write"))):
    require_razorpay_configured()
    validate_required_fields(payload, ["invoice_id", "amount", "razorpay_order_id", "razorpay_payment_id", "razorpay_signature"])
    if not verify_razorpay_signature(payload.get("razorpay_order_id"), payload.get("razorpay_payment_id"), payload.get("razorpay_signature")):
        raise HTTPException(status_code=400, detail="Invalid Razorpay signature.")
    amount = float(payload.get("amount") or 0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero.")
    try:
        invoice_id = int(payload.get("invoice_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invoice_id must be a valid number.")

    payment_id = lq.record_invoice_payment(db, invoice_id, {
        "amount": amount, "payment_mode": normalize_payment_mode(payload.get("payment_mode")),
        "gateway_ref": payload.get("razorpay_payment_id"), "converted_from_mode": payload.get("converted_from_mode"),
        "converted_to_mode": payload.get("converted_to_mode"),
    })
    if payment_id is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    log_audit_event(db, user, client_ip(request), "create", "billing_payments", str(payment_id), {
        "invoice_id": invoice_id, "gateway_ref": payload.get("razorpay_payment_id"), "razorpay_order_id": payload.get("razorpay_order_id"),
    })
    return {"payment_id": payment_id}


@router.post("/invoices/{invoice_id}/payments")
def billing_record_payment(invoice_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    validate_required_fields(payload, ["amount", "payment_mode"])
    payment_id = lq.record_invoice_payment(db, invoice_id, {
        "amount": payload.get("amount", 0), "payment_mode": payload.get("payment_mode", "cash"),
        "gateway_ref": payload.get("gateway_ref"), "converted_from_mode": payload.get("converted_from_mode"),
        "converted_to_mode": payload.get("converted_to_mode"),
    })
    if payment_id is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    log_audit_event(db, user, client_ip(request), "create", "billing_payments", str(payment_id), {"invoice_id": invoice_id})
    return {"payment_id": payment_id}


@router.post("/direct-payment")
def billing_direct_payment(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    validate_required_fields(payload, ["patient_id", "amount", "payment_mode"])
    amount = float(payload.get("amount") or 0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero.")
    payment_for = str(payload.get("payment_for") or payload.get("module") or "OP").strip()
    module = normalize_billing_module(payment_for)
    invoice_no = f"PAY-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
    invoice_id = lq.create_invoice(db, {
        "invoice_no": invoice_no, "patient_id": payload.get("patient_id"), "module": module,
        "clinic_name": payload.get("patient_name"), "referral_source": payment_for, "total_amount": amount,
        "paid_amount": 0, "advance_amount": 0, "refunded_amount": 0, "payment_status": "due", "created_by": user.get("username"),
    })
    payment_id = lq.record_invoice_payment(db, invoice_id, {
        "amount": amount, "payment_mode": normalize_payment_mode(payload.get("payment_mode")),
        "gateway_ref": payload.get("gateway_ref"), "converted_from_mode": payload.get("converted_from_mode"),
        "converted_to_mode": payload.get("converted_to_mode"),
    })
    log_audit_event(db, user, client_ip(request), "create", "billing_direct_payment", str(payment_id),
                     {"invoice_id": invoice_id, "patient_id": payload.get("patient_id"), "payment_for": payment_for})
    return {"invoice_id": invoice_id, "invoice_no": invoice_no, "payment_id": payment_id, "module": module}


@router.get("/revenue-summary")
def billing_revenue_summary(date: str | None = None, month: str | None = None, db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("billing.read"))):
    try:
        return lq.get_revenue_summary(db, collection_date=date, collection_month=month)
    except Exception:
        raise HTTPException(status_code=500, detail={"success": False, "message": "Unable to fetch revenue summary"})


@router.get("/revenue-by-date")
def billing_revenue_by_date(date: str | None = None, db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("billing.read"))):
    if not date:
        raise HTTPException(status_code=400, detail="date parameter is required")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD")
    try:
        return lq.get_revenue_summary(db, collection_date=date)
    except Exception:
        raise HTTPException(status_code=500, detail={"success": False, "message": "Unable to fetch revenue summary"})


@router.get("/claims")
def billing_claims(invoice_id: int | None = None, status: str | None = None, db: Session = Depends(get_db),
                    user: dict = Depends(require_permissions("billing.read"))):
    return {"claims": rows_to_dicts(lq.list_insurance_claims(db, invoice_id=invoice_id, status=status))}


@router.post("/claims")
def billing_create_claim(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("billing.write"))):
    validate_required_fields(payload, ["invoice_id", "insurer_name", "claim_amount"])
    claim_id = lq.create_insurance_claim(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "insurance_claims", str(claim_id), {"invoice_id": payload.get("invoice_id")})
    return {"claim_id": claim_id}


@router.put("/claims/{claim_id}")
def billing_update_claim(claim_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("billing.write"))):
    if not lq.update_insurance_claim(db, claim_id, payload):
        raise HTTPException(status_code=404, detail="Claim not found")
    log_audit_event(db, user, client_ip(request), "update", "insurance_claims", str(claim_id), {"claim_id": claim_id})
    return {"status": "ok"}


@router.delete("/claims/{claim_id}")
def billing_delete_claim(claim_id: int, request: Request, db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("billing.write"))):
    if not lq.delete_insurance_claim(db, claim_id):
        raise HTTPException(status_code=404, detail="Claim not found")
    log_audit_event(db, user, client_ip(request), "delete", "insurance_claims", str(claim_id), {"claim_id": claim_id})
    return {"status": "ok"}


# ==============================================================================
# ENHANCED BILLING & ACCOUNTS DEPARTMENT ENDPOINTS
# ==============================================================================
import billing_service as bs
from fastapi.responses import Response


@router.get("/overview-stats")
def billing_overview_stats(date: str | None = None, cashier: str | None = None, counter: str | None = None,
                           db: Session = Depends(get_db), user: dict = Depends(require_permissions("billing.read"))):
    return bs.get_billing_overview_stats(db, target_date=date, cashier=cashier, counter=counter)


@router.get("/worklist")
def billing_worklist(tab: str = "pending_payments", department: str | None = None,
                     visit_type: str | None = None, q: str | None = None,
                     db: Session = Depends(get_db), user: dict = Depends(require_permissions("billing.read"))):
    return bs.get_billing_worklist(db, tab=tab, department=department, visit_type=visit_type, q=q)


@router.get("/cashier-session/current")
def billing_cashier_session_current(counter: str = "Main Billing Counter",
                                    db: Session = Depends(get_db), user: dict = Depends(require_permissions("billing.read"))):
    session = bs.get_or_create_active_cashier_session(db, user, counter_name=counter)
    return bs.get_cashier_session_summary(db, session["id"])


@router.post("/cashier-session/close")
def billing_cashier_session_close(payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("billing.write"))):
    session_id = int(payload.get("session_id"))
    counted_cash = float(payload.get("counted_cash") or 0)
    notes = str(payload.get("notes") or "")
    return bs.close_cashier_session(db, session_id, counted_cash, notes, user)


@router.get("/patient-bills/{patient_id}")
def billing_patient_bills(patient_id: str, db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("billing.read"))):
    return bs.get_patient_bills_and_history(db, patient_id)


@router.post("/collect-multi")
def billing_collect_multi(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("billing.write"))):
    idempotency_key = request.headers.get("X-Idempotency-Key") or payload.get("idempotency_key")
    res = bs.record_multi_bill_payment(db, payload, user, idempotency_key=idempotency_key)
    log_audit_event(db, user, client_ip(request), "collect_multi", "financial_receipts", str(res.get("receipt_id")),
                    {"receipt_no": res.get("receipt_no"), "total_amount": res.get("total_amount")})
    return res


@router.get("/ip-discharge/{admission_id}")
def billing_ip_discharge(admission_id: str, db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("billing.read"))):
    return bs.get_ip_discharge_details(db, admission_id)


@router.post("/ip-discharge/finalise")
def billing_ip_discharge_finalise(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("billing.write"))):
    res = bs.finalise_ip_discharge_settlement(db, payload, user)
    log_audit_event(db, user, client_ip(request), "finalise_discharge", "admissions", str(res.get("admission_id")), res)
    return res


@router.get("/advances")
def billing_advances_list(patient_id: str | None = None, admission_id: int | None = None,
                          db: Session = Depends(get_db), user: dict = Depends(require_permissions("billing.read"))):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # Staff often key in just the trailing digits printed on a
        # receipt/wristband, or the patient's name, rather than the full
        # "PAT-YYYYMMDD-NNNN" UHID -- resolve to the exact UHID first so the
        # advances/refunds/allocations queries below (and the patient info
        # block) all agree on the same patient instead of each doing their
        # own narrower exact-match lookup.
        if patient_id:
            q = patient_id.strip()
            like = f"%{q.lower()}%"
            cursor.execute(
                """
                SELECT patient_id FROM patients
                WHERE LOWER(patient_id) = LOWER(?)
                   OR patient_id LIKE ?
                   OR LOWER(name) LIKE ?
                   OR LOWER(COALESCE(last_name, '')) LIKE ?
                   OR LOWER(TRIM(COALESCE(name, '') || ' ' || COALESCE(last_name, ''))) LIKE ?
                ORDER BY CASE WHEN LOWER(patient_id) = LOWER(?) THEN 0 ELSE 1 END, created_at DESC
                LIMIT 1
                """,
                (q, f"%{q}", like, like, like, q)
            )
            resolved = cursor.fetchone()
            if resolved:
                patient_id = resolved["patient_id"]

        query = "SELECT * FROM patient_advances WHERE 1=1"
        params = []
        if patient_id:
            query += " AND patient_id = ?"
            params.append(patient_id)
        if admission_id:
            query += " AND admission_id = ?"
            params.append(admission_id)
        query += " ORDER BY created_at DESC"
        cursor.execute(query, tuple(params))
        advances = [dict(r) for r in cursor.fetchall()]

        tot_adv = sum((bs.to_decimal(a["amount"]) for a in advances), bs.D_ZERO)
        tot_alloc = sum((bs.to_decimal(a["allocated_amount"]) for a in advances), bs.D_ZERO)
        tot_ref = sum((bs.to_decimal(a["refunded_amount"]) for a in advances), bs.D_ZERO)
        tot_res = sum((bs.to_decimal(a["reserved_refund_amount"]) for a in advances), bs.D_ZERO)
        available = bs.quantize_dec(tot_adv - tot_alloc - tot_ref - tot_res)

        # Refund history
        rf_query = "SELECT * FROM refund_requests WHERE 1=1"
        rf_params = []
        if patient_id:
            rf_query += " AND patient_id = ?"
            rf_params.append(patient_id)
        rf_query += " ORDER BY created_at DESC"
        cursor.execute(rf_query, tuple(rf_params))
        refunds = [dict(r) for r in cursor.fetchall()]

        # Advance Allocations
        alloc_query = """
            SELECT aa.id, aa.amount, aa.created_at as allocated_at, aa.allocated_by, pa.advance_no, inv.invoice_no, inv.module as invoice_module
            FROM advance_allocations aa
            JOIN patient_advances pa ON pa.id = aa.advance_id
            JOIN invoices inv ON inv.id = aa.invoice_id
            WHERE 1=1
        """
        alloc_params = []
        if patient_id:
            alloc_query += " AND pa.patient_id = ?"
            alloc_params.append(patient_id)
        alloc_query += " ORDER BY aa.created_at DESC LIMIT 50"
        cursor.execute(alloc_query, tuple(alloc_params))
        allocations = [dict(a) for a in cursor.fetchall()]

        patient = None
        target_pid = patient_id
        if not target_pid and admission_id:
            cursor.execute("SELECT patient_id FROM admissions WHERE id = ?", (admission_id,))
            adm_row = cursor.fetchone()
            if adm_row:
                target_pid = adm_row["patient_id"]
        if target_pid:
            cursor.execute("SELECT patient_id, name, last_name, gender, age FROM patients WHERE patient_id = ?", (target_pid,))
            p_row = cursor.fetchone()
            if p_row:
                patient = dict(p_row)
                patient["name"] = f"{patient.get('name') or ''} {patient.get('last_name') or ''}".strip()

        return {
            "summary": {
                "total_advances": float(tot_adv),
                "applied_to_bills": float(tot_alloc),
                "refunded": float(tot_ref),
                "reserved_refund": float(tot_res),
                "available_advance": float(available),
            },
            "advances": advances,
            "refund_history": refunds,
            "allocations": allocations,
            "patient": patient,
        }


@router.post("/advances")
def billing_advances_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    res = bs.record_patient_advance(db, payload, user)
    log_audit_event(db, user, client_ip(request), "create_advance", "patient_advances", str(res.get("advance_id")), res)
    return res


@router.post("/refunds/request")
def billing_refunds_request(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.write"))):
    res = bs.request_advance_refund(db, payload, user)
    log_audit_event(db, user, client_ip(request), "request_refund", "refund_requests", str(res.get("refund_id")), res)
    return res


@router.post("/refunds/{refund_id}/approve")
def billing_refunds_approve(refund_id: int, request: Request, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("billing.supervisor"))):
    res = bs.approve_refund_request(db, refund_id, user)
    log_audit_event(db, user, client_ip(request), "approve_refund", "refund_requests", str(refund_id), res)
    return res


@router.post("/refunds/{refund_id}/reject")
def billing_refunds_reject(refund_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("billing.supervisor"))):
    reason = str(payload.get("reason") or "Rejected by supervisor")
    res = bs.reject_refund_request(db, refund_id, reason, user)
    log_audit_event(db, user, client_ip(request), "reject_refund", "refund_requests", str(refund_id), res)
    return res


@router.post("/refunds/{refund_id}/pay")
def billing_refunds_pay(refund_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("billing.write"))):
    payment_ref = str(payload.get("payment_ref") or payload.get("reference") or "")
    res = bs.pay_approved_refund(db, refund_id, payment_ref, user)
    log_audit_event(db, user, client_ip(request), "pay_refund", "refund_requests", str(refund_id), res)
    return res


@router.get("/doctor-payouts/summary")
def billing_doctor_payouts_summary(month: str | None = None, department: str | None = None, q: str | None = None,
                                   db: Session = Depends(get_db), user: dict = Depends(require_permissions("accounts.read"))):
    return bs.get_doctor_payout_summary_and_statements(db, period_month=month, department=department, search=q)


@router.post("/doctor-payouts/statements/{statement_id}/pay")
def billing_doctor_payouts_pay(statement_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("accounts.write"))):
    res = bs.record_doctor_statement_payout(db, statement_id, payload, user)
    log_audit_event(db, user, client_ip(request), "pay_doctor_statement", "doctor_statements", str(statement_id), res)
    return res


@router.get("/reports/data")
def billing_reports_data(date: str | None = None, cashier: str | None = None, counter: str | None = None,
                         db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    return bs.get_reports_day_close_data(db, target_date=date, cashier=cashier, counter=counter)


@router.get("/reports/export")
def billing_reports_export(date: str | None = None, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reports.read"))):
    data = bs.get_reports_day_close_data(db, target_date=date)
    rows = ["Receipt No,Time,Payment Method,Amount"]
    for r in data["receipt_register"]:
        r_no = bs.sanitize_csv_cell(r["receipt_no"])
        t = bs.sanitize_csv_cell(r["time"])
        m = bs.sanitize_csv_cell(r["payment_mode"])
        amt = bs.sanitize_csv_cell(r["amount"])
        rows.append(f"{r_no},{t},{m},{amt}")
    csv_content = "\n".join(rows)
    return Response(content=csv_content, media_type="text/csv", headers={"Content-Disposition": f"attachment; filename=billing_report_{date or 'today'}.csv"})


@router.post("/cashier-session/open")
def billing_cashier_session_open(request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("billing.write"))):
    """Explicitly open a new cashier session with a given counter name and opening float."""
    res = bs.open_cashier_session(db, payload, user)
    log_audit_event(db, user, client_ip(request), "open_cashier_session", "cashier_sessions",
                    str(res.get("id")), {"session_code": res.get("session_code"), "counter_name": res.get("counter_name")})
    return res


@router.get("/reports/monthly")
def billing_reports_monthly(month: str | None = None, db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("reports.read"))):
    """Daily breakdown of collections for a calendar month (YYYY-MM)."""
    return bs.get_monthly_summary(db, period_month=month)


@router.get("/reports/department")
def billing_reports_department(date: str | None = None, end_date: str | None = None,
                                db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("reports.read"))):
    """Collections and outstanding grouped by department/module for a date range."""
    return bs.get_department_report(db, target_date=date, end_date=end_date)


@router.get("/reports/day-close-history")
def billing_reports_day_close_history(limit: int = 30, db: Session = Depends(get_db),
                                       user: dict = Depends(require_permissions("reports.read"))):
    """List of cashier sessions with drawer reconciliation for historical review."""
    return bs.get_day_close_history(db, limit=min(limit, 100))

