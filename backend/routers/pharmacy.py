from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session
import re

from database import get_db
from deps import require_permissions
from access_scope import patient_scope, filter_rows
from common import rows_to_dicts, validate_required_fields, log_audit_event, client_ip
import legacy_queries as lq
from qwen_ocr import extract_supplier_invoice_fields

router = APIRouter(prefix="/api/pharmacy", tags=["pharmacy"])


@router.get("/medicines")
def pharmacy_medicines_list(active_only: bool = False, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"medicines": rows_to_dicts(lq.list_medicines(db, active_only=active_only))}


@router.post("/medicines")
def pharmacy_medicines_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.write"))):
    validate_required_fields(payload, ["name"])
    medicine_id = lq.create_medicine(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "medicines", str(medicine_id), {"name": payload.get("name")})
    return {"medicine_id": medicine_id}


@router.put("/medicines/{medicine_id}")
def pharmacy_medicines_update(medicine_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.write"))):
    if not lq.update_medicine(db, medicine_id, payload):
        raise HTTPException(status_code=404, detail="Medicine not found")
    log_audit_event(db, user, client_ip(request), "update", "medicines", str(medicine_id), {})
    return {"status": "ok"}


@router.get("/stock")
def pharmacy_stock_list(stock_source: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"batches": rows_to_dicts(lq.list_inventory_items(db, stock_source=stock_source))}


@router.post("/stock")
def pharmacy_stock_upsert(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("pharmacy.receive"))):
    validate_required_fields(payload, ["medicine_name"])
    try:
        item_id = lq.upsert_inventory_item(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "upsert", "pharmacy_inventory", str(item_id), {"medicine_name": payload.get("medicine_name")})
    return {"id": item_id}


@router.post("/stock/{batch_id}/classify-source")
def pharmacy_stock_classify_source(batch_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.adjust"))):
    validate_required_fields(payload, ["stock_source"])
    try:
        lq.classify_legacy_batch(db, batch_id, payload["stock_source"], user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "classify", "pharmacy_inventory", str(batch_id), {"stock_source": payload["stock_source"]})
    return {"status": "ok"}


@router.get("/stock/ledger")
def pharmacy_stock_ledger(stock_source: str | None = None, medicine_name: str | None = None, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("pharmacy.report"))):
    return {"movements": rows_to_dicts(lq.list_stock_movements(db, stock_source=stock_source, medicine_name=medicine_name))}


@router.delete("/stock/{item_id}")
def pharmacy_stock_delete(item_id: int, request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.write"))):
    if not lq.delete_inventory_item(db, item_id):
        raise HTTPException(status_code=404, detail="Stock batch not found")
    log_audit_event(db, user, client_ip(request), "delete", "pharmacy_inventory", str(item_id), {})
    return {"status": "ok"}


@router.post("/stock/adjust")
def pharmacy_stock_adjust(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("pharmacy.adjust"))):
    validate_required_fields(payload, ["pharmacy_inventory_id", "delta_qty", "reason"])
    try:
        adjustment_id = lq.create_stock_adjustment(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "stock_adjustments", str(adjustment_id), payload)
    return {"adjustment_id": adjustment_id}


@router.get("/stock/adjustments")
def pharmacy_stock_adjustments_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"adjustments": rows_to_dicts(lq.list_stock_adjustments(db))}


@router.get("/suppliers")
def pharmacy_suppliers_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"suppliers": rows_to_dicts(lq.list_pharmacy_suppliers(db))}


@router.post("/suppliers")
def pharmacy_suppliers_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.write"))):
    validate_required_fields(payload, ["supplier_name"])
    phone = payload.get("phone")
    if phone:
        digits = re.sub(r"\D", "", str(phone))
        if len(digits) > 10:
            digits = digits[:10]
        if digits and len(digits) != 10:
            raise HTTPException(status_code=400, detail="Mobile number must be exactly 10 digits")
        payload["phone"] = digits
    supplier_id = lq.create_pharmacy_supplier(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "pharmacy_suppliers", str(supplier_id), {"supplier_name": payload.get("supplier_name")})
    return {"supplier_id": supplier_id}


@router.put("/suppliers/{supplier_id}")
def pharmacy_suppliers_update(supplier_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.write"))):
    phone = payload.get("phone")
    if phone:
        digits = re.sub(r"\D", "", str(phone))
        if len(digits) > 10:
            digits = digits[:10]
        if digits and len(digits) != 10:
            raise HTTPException(status_code=400, detail="Mobile number must be exactly 10 digits")
        payload["phone"] = digits
    if not lq.update_pharmacy_supplier(db, supplier_id, payload):
        raise HTTPException(status_code=404, detail="Supplier not found")
    log_audit_event(db, user, client_ip(request), "update", "pharmacy_suppliers", str(supplier_id), {})
    return {"status": "ok"}


@router.delete("/suppliers/{supplier_id}")
def pharmacy_suppliers_delete(supplier_id: int, request: Request, db: Session = Depends(get_db),
                               user: dict = Depends(require_permissions("pharmacy.write"))):
    if not lq.delete_pharmacy_supplier(db, supplier_id):
        raise HTTPException(status_code=404, detail="Supplier not found")
    log_audit_event(db, user, client_ip(request), "delete", "pharmacy_suppliers", str(supplier_id), {})
    return {"status": "ok"}


@router.get("/purchase-orders")
def pharmacy_purchase_orders_list(status: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"purchase_orders": rows_to_dicts(lq.list_pharmacy_purchases(db, status=status))}


@router.post("/purchase-orders")
def pharmacy_purchase_orders_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("pharmacy.write"))):
    validate_required_fields(payload, ["medicine_name", "quantity", "unit_cost"])
    purchase_id = lq.create_pharmacy_purchase(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "pharmacy_purchases", str(purchase_id), {"medicine_name": payload.get("medicine_name")})
    return {"purchase_id": purchase_id}


@router.put("/purchase-orders/{purchase_id}")
def pharmacy_purchase_orders_update(purchase_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("pharmacy.write"))):
    if not lq.update_pharmacy_purchase(db, purchase_id, payload):
        raise HTTPException(status_code=404, detail="Purchase order not found")
    log_audit_event(db, user, client_ip(request), "update", "pharmacy_purchases", str(purchase_id), {})
    return {"status": "ok"}


@router.delete("/purchase-orders/{purchase_id}")
def pharmacy_purchase_orders_delete(purchase_id: int, request: Request, db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("pharmacy.write"))):
    if not lq.delete_pharmacy_purchase(db, purchase_id):
        raise HTTPException(status_code=404, detail="Purchase order not found")
    log_audit_event(db, user, client_ip(request), "delete", "pharmacy_purchases", str(purchase_id), {})
    return {"status": "ok"}


@router.get("/goods-receipts")
def pharmacy_goods_receipts_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"goods_receipts": lq.list_goods_receipts(db)}


@router.post("/goods-receipts")
def pharmacy_goods_receipts_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.receive"))):
    if not payload.get("supplier_id"):
        raise HTTPException(status_code=400, detail="Supplier selection is mandatory for goods receipt notes.")
    if not payload.get("items"):
        raise HTTPException(status_code=400, detail="At least one item line is required.")
    try:
        grn_id, grn_no = lq.create_goods_receipt(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "goods_receipts", str(grn_id), {"grn_no": grn_no})
    return {"grn_id": grn_id, "grn_no": grn_no}


@router.post("/goods-receipts/ocr")
def pharmacy_goods_receipts_ocr(file: UploadFile = File(...), user: dict = Depends(require_permissions("pharmacy.receive"))):
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    try:
        fields = extract_supplier_invoice_fields(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"fields": fields}


@router.post("/goods-receipts/{grn_id}/verify")
def pharmacy_goods_receipts_verify(grn_id: int, request: Request, db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.receive"))):
    try:
        lq.verify_goods_receipt(db, grn_id, actor=user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "verify", "goods_receipts", str(grn_id), {})
    return {"status": "ok"}


@router.get("/prescriptions")
def pharmacy_prescriptions_list(status: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read")), scope: set | None = Depends(patient_scope)):
    return {"prescriptions": filter_rows(lq.list_pharmacy_incoming_prescriptions(db, status=status), scope)}


@router.post("/prescriptions/{prescription_id}/dismiss")
def pharmacy_prescription_dismiss(prescription_id: int, request: Request, db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("pharmacy.dispense"))):
    try:
        lq.dismiss_pharmacy_prescription(db, prescription_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "dismiss", "prescriptions", str(prescription_id), {})
    return {"status": "ok"}


@router.get("/prescription-scans")
def pharmacy_prescription_scans_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"scans": rows_to_dicts(lq.list_recent_prescription_scans(db))}


@router.post("/dispense")
def pharmacy_dispense(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("pharmacy.dispense"))):
    if not payload.get("items"):
        raise HTTPException(status_code=400, detail="At least one medicine line is required to dispense.")
    try:
        result = lq.create_pharmacy_dispense(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "pharmacy_sales", ",".join(str(i) for i in result["sale_ids"]),
                     {"total_amount": result["total_amount"], "stock_source": result["stock_source"]})
    return result


@router.get("/returns")
def pharmacy_returns_list(status: str | None = None, admission_id: int | None = None, patient_id: str | None = None,
                           db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"returns": rows_to_dicts(lq.list_pharmacy_returns(db, status=status, admission_id=admission_id, patient_id=patient_id))}


@router.post("/returns")
def pharmacy_returns_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("pharmacy.return"))):
    validate_required_fields(payload, ["original_sale_id", "quantity", "reason"])
    try:
        return_id = lq.create_pharmacy_return(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "pharmacy_returns", str(return_id), {})
    return {"return_id": return_id}


@router.post("/returns/{return_id}/release")
def pharmacy_returns_release(return_id: int, request: Request, db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("pharmacy.return"))):
    try:
        lq.release_pharmacy_return(db, return_id, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "release", "pharmacy_returns", str(return_id), {})
    return {"status": "ok"}


@router.post("/returns/{return_id}/reject")
def pharmacy_returns_reject(return_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("pharmacy.return"))):
    payload = payload or {}
    try:
        lq.reject_pharmacy_return(db, return_id, user.get("username"), reason=payload.get("reason"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "reject", "pharmacy_returns", str(return_id), {})
    return {"status": "ok"}


@router.get("/invoices")
def pharmacy_invoices_list(
    patient_id: str | None = None,
    payment_status: str | None = None,
    search: str | None = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("pharmacy.read")), scope: set | None = Depends(patient_scope)):
    return {"invoices": filter_rows(rows_to_dicts(lq.list_invoices(db, patient_id=patient_id, module="PHARMACY", payment_status=payment_status, search=search, limit=limit)), scope)}


@router.get("/invoices/{invoice_id}")
def pharmacy_invoice_detail(invoice_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    invoice = lq.get_invoice_by_id(db, invoice_id)
    if not invoice or invoice["module"] != "PHARMACY":
        raise HTTPException(status_code=404, detail="Invoice not found")
    payments = rows_to_dicts(lq.get_invoice_payments(db, invoice_id))
    inv_dict = dict(invoice.items())
    inv_dict["payments"] = payments
    return inv_dict


@router.get("/invoices/{invoice_id}/payments")
def pharmacy_invoice_payments_list(invoice_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"payments": rows_to_dicts(lq.get_invoice_payments(db, invoice_id))}


@router.get("/insurance-cases")
def pharmacy_insurance_cases_list(invoice_id: int | None = None, status: str | None = None, db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"cases": rows_to_dicts(lq.list_insurance_claims(db, invoice_id=invoice_id, status=status))}


@router.put("/insurance-cases/{claim_id}")
def pharmacy_insurance_case_update(claim_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.settle"))):
    if not lq.update_insurance_claim(db, claim_id, payload):
        raise HTTPException(status_code=404, detail="Insurance case not found")
    log_audit_event(db, user, client_ip(request), "update", "insurance_claims", str(claim_id), {"claim_id": claim_id})
    return {"status": "ok"}


@router.post("/invoices/{invoice_id}/payment")
@router.post("/invoices/{invoice_id}/payments")
def pharmacy_invoice_payment(invoice_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("pharmacy.collect"))):
    validate_required_fields(payload, ["amount", "payment_mode"])
    try:
        payment_id = lq.record_invoice_payment(db, invoice_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if payment_id is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    log_audit_event(db, user, client_ip(request), "create", "invoice_payments", str(payment_id), {"invoice_id": invoice_id, "amount": payload.get("amount")})
    inv = lq.get_invoice_by_id(db, invoice_id)
    return {
        "payment_id": payment_id,
        "invoice_id": invoice_id,
        "paid_amount": float(inv["paid_amount"] or 0) if inv else 0,
        "due_amount": float(inv["due_amount"] or 0) if inv else 0,
        "payment_status": inv["payment_status"] if inv else "paid"
    }



@router.post("/insurance-cases/{claim_id}/settle")
def pharmacy_insurance_case_settle(claim_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.settle"))):
    validate_required_fields(payload, ["amount"])
    claim = lq.get_insurance_claim(db, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Insurance case not found")
    amount = float(payload["amount"])
    settlement_status = claim["settlement_status"] or "unpaid"
    if claim["invoice_id"]:
        payment_id = lq.record_invoice_payment(db, claim["invoice_id"], {
            "amount": amount, "payment_mode": payload.get("payment_mode", "bank_transfer"), "gateway_ref": payload.get("reference"),
        })
        if payment_id is None:
            raise HTTPException(status_code=404, detail="Linked invoice not found")
        invoice = lq.get_invoice_by_id(db, claim["invoice_id"])
        paid_amount = float(invoice["paid_amount"] or 0) if invoice else 0
        total_amount = float(invoice["total_amount"] or 0) if invoice else 0
        settlement_status = "paid" if total_amount > 0 and paid_amount >= total_amount else ("part_paid" if paid_amount > 0 else "unpaid")
    lq.update_insurance_claim(db, claim_id, {"settlement_status": settlement_status})
    log_audit_event(db, user, client_ip(request), "settle", "insurance_claims", str(claim_id), {"amount": amount})
    return {"status": "ok", "settlement_status": settlement_status}


@router.get("/sales")
def pharmacy_sales_list(medicine_name: str | None = None, patient_id: str | None = None, invoice_id: str | None = None,
                         admission_id: int | None = None, billing_type: str | None = None,
                         from_date: str | None = None, to_date: str | None = None, q: str | None = None,
                         db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("pharmacy.read")), scope: set | None = Depends(patient_scope)):
    return {"sales": filter_rows(rows_to_dicts(lq.list_pharmacy_sales(db, medicine_name=medicine_name, patient_id=patient_id,
                                                           invoice_id=invoice_id, admission_id=admission_id, billing_type=billing_type,
                                                           from_date=from_date, to_date=to_date, q=q)), scope)}


@router.get("/summary")
def pharmacy_summary(db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return lq.get_pharmacy_summary(db)


@router.get("/purchase-requests")
def pharmacy_purchase_requests_list(status: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    return {"purchase_requests": lq.list_purchase_requests(db, status=status)}


@router.post("/purchase-requests")
def pharmacy_purchase_requests_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                       user: dict = Depends(require_permissions("pharmacy.write"))):
    if not payload.get("items"):
        raise HTTPException(status_code=400, detail="At least one item line is required for a purchase request.")
    if not (payload.get("preferred_supplier_id") or payload.get("supplier_id")):
        raise HTTPException(status_code=400, detail="Supplier selection is mandatory for purchase requests.")
    try:
        pr_id, pr_no = lq.create_purchase_request(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "purchase_requests", str(pr_id), {"pr_no": pr_no})
    return {"pr_id": pr_id, "pr_no": pr_no}


@router.post("/purchase-requests/{pr_id}/approve")
def pharmacy_purchase_requests_approve(pr_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                        user: dict = Depends(require_permissions("pharmacy.write"))):
    payload = payload or {}
    try:
        po_ids = lq.approve_purchase_request(db, pr_id, user.get("username"), supplier_id=payload.get("supplier_id"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "approve", "purchase_requests", str(pr_id), {"created_po_ids": po_ids})
    return {"status": "ok", "created_po_ids": po_ids}


@router.post("/purchase-requests/{pr_id}/reject")
def pharmacy_purchase_requests_reject(pr_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                       user: dict = Depends(require_permissions("pharmacy.write"))):
    payload = payload or {}
    try:
        lq.reject_purchase_request(db, pr_id, user.get("username"), reason=payload.get("reason"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "reject", "purchase_requests", str(pr_id), {"reason": payload.get("reason")})
    return {"status": "ok", "message": "Purchase request rejected."}


@router.post("/purchase-requests/{pr_id}/status")
def pharmacy_purchase_requests_update_status(pr_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                              user: dict = Depends(require_permissions("pharmacy.write"))):
    status = payload.get("status")
    if not status:
        raise HTTPException(status_code=400, detail="status is required")
    try:
        lq.update_purchase_request_status(db, pr_id, status, username=user.get("username"), reason=payload.get("reason"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "status_update", "purchase_requests", str(pr_id), {"status": status, "reason": payload.get("reason")})
    return {"status": "ok", "new_status": status}


@router.get("/suppliers/{supplier_id}/ledger")
def pharmacy_supplier_ledger_get(supplier_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("pharmacy.read"))):
    try:
        return lq.get_supplier_ledger(db, supplier_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/ward-indents")
def pharmacy_ward_indents_list(status: str | None = None, ward: str | None = None, patient_id: str | None = None,
                                admission_id: int | None = None, db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("pharmacy.read")), scope: set | None = Depends(patient_scope)):
    return {"indents": filter_rows(lq.list_ward_indents(db, status=status, ward=ward, patient_id=patient_id, admission_id=admission_id), scope)}


@router.post("/ward-indents")
def pharmacy_ward_indents_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("pharmacy.write"))):
    validate_required_fields(payload, ["patient_id", "items"])
    try:
        indent_id, indent_no = lq.create_ward_indent(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "ward_indents", str(indent_id), {"indent_no": indent_no, "patient_id": payload["patient_id"]})
    return {"indent_id": indent_id, "indent_no": indent_no}


@router.put("/ward-indent-items/{item_id}")
def pharmacy_ward_indent_item_update(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("pharmacy.write"))):
    try:
        lq.update_ward_indent_item(db, item_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "update", "ward_indent_items", str(item_id), {})
    return {"status": "ok"}


@router.post("/ward-indent-items/{item_id}/cancel")
def pharmacy_ward_indent_item_cancel(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("pharmacy.write"))):
    validate_required_fields(payload, ["reason"])
    try:
        lq.cancel_ward_indent_item(db, item_id, payload["reason"], user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "cancel", "ward_indent_items", str(item_id), {"reason": payload["reason"]})
    return {"status": "ok"}


@router.post("/ward-indents/{indent_id}/dispense")
def pharmacy_ward_indents_dispense(indent_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("pharmacy.dispense"))):
    payload["indent_id"] = indent_id
    payload["billing_type"] = payload.get("billing_type", "IPD_RUNNING")
    if not payload.get("items"):
        raise HTTPException(status_code=400, detail="At least one medicine line is required to dispense.")
    try:
        result = lq.create_pharmacy_dispense(db, payload, user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "dispense", "ward_indents", str(indent_id),
                     {"total_amount": result["total_amount"], "stock_source": result["stock_source"]})
    return result


# ------------------------------------------------------------------ emar --

emar_router = APIRouter(prefix="/api", tags=["emar"])


@emar_router.get("/patients/{patient_id}/emar")
def patient_emar_list(patient_id: str, admission_id: int | None = None, status: str | None = None,
                       db: Session = Depends(get_db), user: dict = Depends(require_permissions("patients.read"))):
    # awaiting_pharmacy: ordered medications not yet issued, so they have no doses yet.
    return {
        "emar": lq.list_emar_records(db, patient_id=patient_id, admission_id=admission_id, status=status),
        "counts": lq.count_emar_by_status(db, patient_id, admission_id=admission_id),
        "awaiting_pharmacy": lq.list_unissued_medication_orders(db, patient_id, admission_id=admission_id),
        "server_time": lq.current_ist_datetime().replace(tzinfo=None).isoformat(timespec="seconds"),
    }


@emar_router.post("/emar/{emar_id}/administer")
def emar_administer(emar_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.write"))):
    payload = payload or {}
    try:
        lq.administer_emar_record(db, emar_id, user.get("username"), notes=payload.get("notes"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "administer", "emar_records", str(emar_id), {})
    return {"status": "ok"}


@emar_router.post("/emar/{emar_id}/status")
def emar_set_status(emar_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["status"])
    try:
        lq.record_emar_status(db, emar_id, payload["status"], user.get("username"), notes=payload.get("notes"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), payload["status"], "emar_records", str(emar_id), {})
    return {"status": "ok"}


@emar_router.post("/emar/indent-items/{indent_item_id}/discontinue")
def emar_discontinue(indent_item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("patients.write"))):
    validate_required_fields(payload, ["reason"])
    try:
        result = lq.discontinue_emar_schedule(db, indent_item_id, payload["reason"], user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "discontinue", "emar_records", str(indent_item_id),
                     {"reason": payload["reason"], "discontinued_count": result["discontinued_count"]})
    return result


@emar_router.post("/emar/{emar_id}/return")
def emar_return(emar_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                 user: dict = Depends(require_permissions("pharmacy.return"))):
    validate_required_fields(payload, ["reason"])
    try:
        lq.return_emar_record(db, emar_id, payload.get("quantity", 1), payload["reason"], user.get("username"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "return", "emar_records", str(emar_id), {"reason": payload["reason"]})
    return {"status": "ok"}


@emar_router.get("/admissions/{admission_id}/running-pharmacy-charges")
def admission_running_pharmacy_charges(admission_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("billing.read"))):
    return lq.get_running_ipd_pharmacy_charges(db, admission_id)
