from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy.orm import Session
from typing import Optional

# Every write below commits together with its audit_logs row (see database.get_audited_db).
from database import get_audited_db as get_db
from deps import require_permissions
from common import rows_to_dicts, validate_required_fields, log_audit_event, client_ip
import legacy_queries as lq
from qwen_ocr import extract_lab_results, lab_identity_warnings

router = APIRouter(prefix="/api", tags=["diagnostics"])


# -------------------------------------------------------------------- overview --

@router.get("/diag/overview")
def diag_overview(db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return lq.get_diag_overview(db)


# ---------------------------------------------------------- test catalogue --

@router.get("/diag/services")
def diag_services_list(service_type: Optional[str] = None, department: Optional[str] = None,
                        active_only: Optional[str] = None, q: Optional[str] = None,
                        db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    active_flag = None
    if active_only is not None:
        active_flag = active_only.lower() in ("1", "true", "yes")
    return {"services": rows_to_dicts(lq.list_diag_services(db, service_type, department, active_flag, q))}


@router.post("/diag/services")
def diag_services_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.catalogue"))):
    validate_required_fields(payload, ["code", "name", "service_type"])
    service_id = lq.create_diag_service(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_services", str(service_id), {"code": payload["code"]})
    return {"service_id": service_id}


@router.get("/diag/services/{service_id}")
def diag_service_detail(service_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    service = lq.get_diag_service(db, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    data = dict(service.items())
    data["parameters"] = rows_to_dicts(lq.list_diag_service_parameters(db, service_id))
    data["pricing_history"] = rows_to_dicts(lq.get_diag_service_pricing_history(db, service_id))
    return data


@router.put("/diag/services/{service_id}")
def diag_services_update(service_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.catalogue"))):
    if not lq.update_diag_service(db, service_id, payload, user.get("username")):
        raise HTTPException(status_code=404, detail="Service not found")
    log_audit_event(db, user, client_ip(request), "update", "diag_services", str(service_id), {})
    return {"status": "ok"}


@router.delete("/diag/services/{service_id}")
def diag_services_deactivate(service_id: int, request: Request, db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("diag.catalogue"))):
    if not lq.deactivate_diag_service(db, service_id):
        raise HTTPException(status_code=404, detail="Service not found")
    log_audit_event(db, user, client_ip(request), "deactivate", "diag_services", str(service_id), {})
    return {"status": "ok"}


@router.put("/diag/services/{service_id}/parameters")
def diag_service_parameters_update(service_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("diag.catalogue"))):
    lq.replace_diag_service_parameters(db, service_id, payload.get("parameters") or [])
    log_audit_event(db, user, client_ip(request), "update", "diag_service_parameters", str(service_id), {"count": len(payload.get("parameters") or [])})
    return {"status": "ok"}


@router.get("/diag/packages")
def diag_packages_list(active_only: bool = False, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"packages": lq.list_diag_packages(db, active_only)}


@router.post("/diag/packages")
def diag_packages_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.catalogue"))):
    validate_required_fields(payload, ["code", "name"])
    package_id = lq.create_diag_package(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_packages", str(package_id), {"code": payload["code"]})
    return {"package_id": package_id}


@router.put("/diag/packages/{package_id}")
def diag_packages_update(package_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.catalogue"))):
    if not lq.update_diag_package(db, package_id, payload):
        raise HTTPException(status_code=404, detail="Package not found")
    log_audit_event(db, user, client_ip(request), "update", "diag_packages", str(package_id), {})
    return {"status": "ok"}


@router.get("/diag/report-templates")
def diag_report_templates_list(report_type: Optional[str] = None, db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("diag.read"))):
    return {"templates": rows_to_dicts(lq.list_diag_report_templates(db, report_type))}


@router.post("/diag/report-templates")
def diag_report_templates_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("diag.catalogue"))):
    validate_required_fields(payload, ["code", "name", "report_type"])
    template_id = lq.create_diag_report_template(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "diag_report_templates", str(template_id), {"code": payload["code"]})
    return {"template_id": template_id}


@router.delete("/diag/report-templates/{template_id}")
def diag_report_templates_deactivate(template_id: int, request: Request, db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("diag.catalogue"))):
    if not lq.deactivate_diag_report_template(db, template_id):
        raise HTTPException(status_code=404, detail="Template not found")
    log_audit_event(db, user, client_ip(request), "deactivate", "diag_report_templates", str(template_id), {})
    return {"status": "ok"}


# ------------------------------------------------------------ orders & billing --

@router.post("/diag/orders")
def diag_orders_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.order"))):
    is_external_sale = str(payload.get("sale_type") or "").upper() == "EXTERNAL"
    validate_required_fields(payload, ["walkin_name", "walkin_mobile", "items"] if is_external_sale else ["patient_id", "encounter_type", "items"])
    order_id = lq.create_diag_order(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_orders", str(order_id),
                    {"sale_type": "EXTERNAL"} if is_external_sale else {"patient_id": payload["patient_id"]})
    return {"order_id": order_id}


@router.get("/diag/orders")
def diag_orders_list(patient_id: Optional[str] = None, status: Optional[str] = None, department_type: Optional[str] = None,
                      priority: Optional[str] = None, encounter_type: Optional[str] = None, admission_id: Optional[int] = None,
                      sale_type: Optional[str] = None, q: Optional[str] = None,
                      db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"orders": lq.list_diag_orders(db, patient_id=patient_id, status=status, department_type=department_type,
                                           priority=priority, encounter_type=encounter_type, admission_id=admission_id,
                                           sale_type=sale_type, search=q)}


@router.get("/diag/orders/check-duplicates")
def diag_orders_check_duplicates(patient_id: Optional[str] = None, service_id: list[int] = Query(default=[]),
                                  admission_id: Optional[int] = None, appointment_id: Optional[int] = None,
                                  db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    if not patient_id or not service_id:
        return {"duplicate_service_ids": []}
    return {"duplicate_service_ids": lq.check_diag_duplicate_active_services(db, patient_id, service_id, admission_id, appointment_id)}


@router.get("/diag/orders/{order_id}")
def diag_order_detail(order_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    order = lq.get_diag_order(db, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@router.post("/diag/orders/{order_id}/confirm")
def diag_order_confirm(order_id: int, request: Request, db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.order"))):
    result = lq.confirm_diag_order(db, order_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "confirm", "diag_orders", str(order_id), result)
    return result


@router.post("/diag/orders/{order_id}/cancel")
def diag_order_cancel_draft(order_id: int, request: Request, db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("diag.order"))):
    lq.cancel_diag_draft_order(db, order_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "cancel", "diag_orders", str(order_id), {})
    return {"status": "ok"}


@router.post("/diag/orders/{order_id}/items")
def diag_order_add_items(order_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.order"))):
    items = payload.get("items") or []
    if not items:
        raise HTTPException(status_code=400, detail="No services provided")
    added_ids = lq.add_diag_order_items(db, order_id, items, user.get("username"))
    log_audit_event(db, user, client_ip(request), "add_items", "diag_orders", str(order_id), {"item_ids": added_ids})
    return {"item_ids": added_ids}


@router.post("/diag/order-items/{item_id}/cancel")
def diag_order_item_cancel(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("diag.order"))):
    result = lq.cancel_diag_order_item(db, item_id, payload.get("reason"), user.get("username"), payload.get("refund_mode"))
    log_audit_event(db, user, client_ip(request), "cancel", "diag_order_items", str(item_id),
                    {"reason": payload.get("reason"), "refund_amount": result["refund_amount"]})
    return {"status": "ok", **result}


@router.get("/admissions/{admission_id}/diag-running-charges")
def diag_running_charges(admission_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return lq.get_diag_patient_running_charges(db, admission_id)


@router.get("/diag/invoices")
def diag_invoices_list(patient_id: Optional[str] = None, sale_type: Optional[str] = None,
                       db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    # Internal Sale (default) lists UHID-linked invoices only; walk-in invoices belong to External Sale.
    external = (sale_type or "").upper() == "EXTERNAL"
    return {"invoices": rows_to_dicts(lq.list_invoices(db, patient_id=patient_id, module="LAB", external_sale=external))}


@router.get("/diag/invoices/{invoice_id}")
def diag_invoice_detail(invoice_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    invoice = lq.get_invoice_by_id(db, invoice_id)
    if not invoice or invoice["module"] != "LAB":
        raise HTTPException(status_code=404, detail="Invoice not found")
    return dict(invoice.items())


@router.post("/diag/invoices/{invoice_id}/payments")
def diag_invoice_record_payment(invoice_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("diag.bill"))):
    invoice = lq.get_invoice_by_id(db, invoice_id)
    if not invoice or invoice["module"] != "LAB":
        raise HTTPException(status_code=404, detail="Invoice not found")
    validate_required_fields(payload, ["amount", "payment_mode"])
    try:
        amount = float(payload.get("amount"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Enter a valid payment amount.")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be greater than zero.")
    due = float(invoice["due_amount"] or 0)
    if amount > due + 0.005:
        raise HTTPException(status_code=400, detail=f"Payment of Rs. {amount:g} exceeds the balance due (Rs. {due:g}).")
    payment_id = lq.record_invoice_payment(db, invoice_id, {
        "amount": amount, "payment_mode": payload.get("payment_mode", "cash"),
        "gateway_ref": payload.get("gateway_ref"),
    })
    log_audit_event(db, user, client_ip(request), "create", "diag_invoice_payments", str(payment_id), {"invoice_id": invoice_id})
    return {"payment_id": payment_id}


# ------------------------------------------------------------------ laboratory --

@router.get("/diag/lab/worklist")
def diag_lab_worklist(stage: Optional[str] = None, q: Optional[str] = None, priority: Optional[str] = None,
                       db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"items": lq.list_diag_lab_worklist(db, stage=stage, search=q, priority=priority)}


@router.get("/diag/lab/items/{item_id}")
def diag_lab_item_detail(item_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    item = lq.get_diag_lab_item_detail(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Order item not found")
    return item


@router.post("/diag/lab/specimens/{specimen_id}/collect")
def diag_specimen_collect(specimen_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.specimen"))):
    lq.collect_diag_specimen(db, specimen_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "collect", "diag_specimens", str(specimen_id), {})
    return {"status": "ok"}


@router.post("/diag/lab/specimens/{specimen_id}/receive")
def diag_specimen_receive(specimen_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.specimen"))):
    lq.receive_diag_specimen(db, specimen_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "receive", "diag_specimens", str(specimen_id), {"accept": payload.get("accept", True)})
    return {"status": "ok"}


@router.post("/diag/lab/items/{item_id}/ocr")
def diag_results_ocr(item_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("diag.result"))):
    item = lq.get_diag_lab_item_detail(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Order item not found")
    parameters = item.get("parameters") or []
    if not parameters:
        raise HTTPException(status_code=400, detail="No parameters are configured for this test in the catalogue.")
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    try:
        extracted = extract_lab_results(content, parameters, item.get("service_name"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    patient = item.get("patient") or {}
    patient_name = f"{patient.get('name') or ''} {patient.get('last_name') or ''}".strip() or (item.get("walkin_name") or "")
    extracted["identity_warnings"] = lab_identity_warnings(
        extracted, patient_name, [s.get("specimen_no") for s in item.get("specimens") or []])
    log_audit_event(db, user, client_ip(request), "ocr_scan", "diag_results", str(item_id), {
        "file_name": file.filename, "values_read": len(extracted["values"]),
        "skipped": len(extracted.get("skipped") or []), "identity_warnings": extracted["identity_warnings"],
    })
    return extracted


@router.post("/diag/lab/items/{item_id}/results")
def diag_results_save(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("diag.result"))):
    results = payload.get("results") or []
    if not results:
        raise HTTPException(status_code=400, detail="No results provided")
    outcome = lq.save_diag_results(db, item_id, results, user.get("username"), bool(payload.get("is_draft", True)))
    log_audit_event(db, user, client_ip(request), "save_results", "diag_results", str(item_id), {"is_draft": payload.get("is_draft", True)})
    return outcome


@router.post("/diag/lab/items/{item_id}/external-referral")
def diag_external_referral_create(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("diag.specimen"))):
    referral_id = lq.create_diag_external_referral(db, item_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_external_referrals", str(referral_id), {})
    return {"referral_id": referral_id}


@router.put("/diag/lab/external-referral/{referral_id}")
def diag_external_referral_update(referral_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("diag.specimen"))):
    if not lq.update_diag_external_referral(db, referral_id, payload):
        raise HTTPException(status_code=404, detail="Referral not found")
    log_audit_event(db, user, client_ip(request), "update", "diag_external_referrals", str(referral_id), {})
    return {"status": "ok"}


@router.get("/diag/lab/external-referrals")
def diag_external_referrals_list(status: Optional[str] = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"referrals": rows_to_dicts(lq.list_diag_external_referrals(db, status))}


@router.get("/lab/vendors-list")
def diag_lab_vendors_for_referral(db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"vendors": rows_to_dicts(lq.list_lab_vendors(db))}


# --------------------------------------------------------------------- imaging --

@router.get("/diag/imaging/worklist")
def diag_imaging_worklist(stage: Optional[str] = None, modality: Optional[str] = None, room: Optional[str] = None,
                           q: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                           db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"items": lq.list_diag_imaging_worklist(db, stage=stage, modality=modality, room=room, search=q,
                                                    date_from=date_from, date_to=date_to)}


@router.get("/diag/imaging/items/{item_id}")
def diag_imaging_item_detail(item_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    item = lq.get_diag_imaging_detail(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Order item not found")
    return item


@router.post("/diag/imaging/exams/{exam_id}/schedule")
def diag_imaging_schedule(exam_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.imaging"))):
    lq.schedule_diag_imaging_exam(db, exam_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "schedule", "diag_imaging_exams", str(exam_id), {"scheduled_at": payload.get("scheduled_at")})
    return {"status": "ok"}


@router.post("/diag/imaging/exams/{exam_id}/cancel")
def diag_imaging_cancel(exam_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("diag.imaging"))):
    lq.cancel_diag_imaging_exam(db, exam_id, payload.get("reason"), user.get("username"))
    log_audit_event(db, user, client_ip(request), "cancel", "diag_imaging_exams", str(exam_id), {"reason": payload.get("reason")})
    return {"status": "ok"}


@router.post("/diag/imaging/exams/{exam_id}/status")
def diag_imaging_status_update(exam_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                user: dict = Depends(require_permissions("diag.imaging"))):
    status = payload.get("status")
    if not status:
        raise HTTPException(status_code=400, detail="status is required")
    lq.update_diag_imaging_status(db, exam_id, status, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "status", "diag_imaging_exams", str(exam_id), {"status": status})
    return {"status": "ok"}


# --------------------------------------------------------- reports & approval --

@router.post("/diag/items/{item_id}/report-draft")
def diag_report_draft_get_or_create(item_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("diag.report"))):
    payload = payload or {}
    report = lq.get_or_create_diag_report_draft(db, item_id, payload.get("report_type", "LAB"), user.get("username"), payload.get("template"))
    if report.get("created"):
        log_audit_event(db, user, client_ip(request), "create", "diag_reports", str(report["id"]), {"order_item_id": item_id})
    return report


@router.put("/diag/reports/{report_id}")
def diag_report_save(report_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("diag.report"))):
    lq.save_diag_report_draft(db, report_id, payload.get("content") or {}, user.get("username"), bool(payload.get("is_preliminary", False)))
    log_audit_event(db, user, client_ip(request), "save_draft", "diag_reports", str(report_id),
                    {"is_preliminary": bool(payload.get("is_preliminary", False))})
    return {"status": "ok"}


@router.post("/diag/reports/{report_id}/submit")
def diag_report_submit(report_id: int, request: Request, db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.report"))):
    lq.submit_diag_report_for_review(db, report_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "submit", "diag_reports", str(report_id), {})
    return {"status": "ok"}


@router.post("/diag/reports/{report_id}/return")
def diag_report_return(report_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.authorize"))):
    lq.return_diag_report_for_correction(db, report_id, payload.get("reason"), user.get("username"))
    log_audit_event(db, user, client_ip(request), "return_for_correction", "diag_reports", str(report_id), {"reason": payload.get("reason")})
    return {"status": "ok"}


@router.post("/diag/reports/{report_id}/authorize")
def diag_report_authorize(report_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.authorize"))):
    payload = payload or {}
    lq.authorize_diag_report(db, report_id, user.get("username"), bool(payload.get("also_release", False)))
    log_audit_event(db, user, client_ip(request), "authorize", "diag_reports", str(report_id), {"also_release": payload.get("also_release", False)})
    return {"status": "ok"}


@router.post("/diag/reports/{report_id}/release")
def diag_report_release(report_id: int, request: Request, db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("diag.authorize"))):
    lq.release_diag_report(db, report_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "release", "diag_reports", str(report_id), {})
    return {"status": "ok"}


@router.post("/diag/reports/{report_id}/amend")
def diag_report_amend(report_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("diag.authorize"))):
    new_id = lq.create_diag_report_amendment(db, report_id, payload.get("reason"), payload.get("content") or {}, user.get("username"))
    log_audit_event(db, user, client_ip(request), "amend", "diag_reports", str(report_id), {"new_report_id": new_id, "reason": payload.get("reason")})
    return {"report_id": new_id}


@router.get("/diag/reports")
def diag_reports_worklist(status: Optional[str] = None, report_type: Optional[str] = None, q: Optional[str] = None,
                           date_from: Optional[str] = None, date_to: Optional[str] = None,
                           db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"reports": lq.list_diag_reports_worklist(db, status=status, report_type=report_type, search=q,
                                                       date_from=date_from, date_to=date_to)}


@router.get("/diag/reports/{report_id}")
def diag_report_detail(report_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    report = lq.get_diag_report_detail(db, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@router.get("/diag/critical-alerts")
def diag_critical_alerts_list(open_only: bool = True, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"alerts": lq.list_diag_critical_alerts(db, open_only)}


@router.post("/diag/critical-alerts/{alert_id}/contact")
def diag_critical_alert_contact(alert_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("diag.report"))):
    lq.record_diag_critical_contact(db, alert_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "contact", "diag_critical_alerts", str(alert_id), {"contacted_person": payload.get("contacted_person")})
    return {"status": "ok"}


@router.post("/diag/critical-alerts/{alert_id}/escalate")
def diag_critical_alert_escalate(alert_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("diag.report"))):
    lq.escalate_diag_critical_alert(db, alert_id, payload.get("escalated_to"), user.get("username"))
    log_audit_event(db, user, client_ip(request), "escalate", "diag_critical_alerts", str(alert_id), {"escalated_to": payload.get("escalated_to")})
    return {"status": "ok"}


@router.post("/diag/critical-alerts/{alert_id}/resolve")
def diag_critical_alert_resolve(alert_id: int, request: Request, db: Session = Depends(get_db),
                                 user: dict = Depends(require_permissions("diag.report"))):
    lq.resolve_diag_critical_alert(db, alert_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "resolve", "diag_critical_alerts", str(alert_id), {})
    return {"status": "ok"}


# ---------------------------------------------------------- quality & equipment --

@router.get("/diag/quality/overview")
def diag_quality_overview(db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return lq.get_diag_quality_overview(db)


@router.get("/diag/equipment")
def diag_equipment_list(status: Optional[str] = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"equipment": rows_to_dicts(lq.list_diag_equipment(db, status))}


@router.post("/diag/equipment")
def diag_equipment_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.qc"))):
    validate_required_fields(payload, ["asset_id", "name"])
    equipment_id = lq.create_diag_equipment(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "diag_equipment", str(equipment_id), {"asset_id": payload["asset_id"]})
    return {"equipment_id": equipment_id}


@router.put("/diag/equipment/{equipment_id}")
def diag_equipment_update(equipment_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("diag.qc"))):
    if not lq.update_diag_equipment(db, equipment_id, payload):
        raise HTTPException(status_code=404, detail="Equipment not found")
    log_audit_event(db, user, client_ip(request), "update", "diag_equipment", str(equipment_id), {})
    return {"status": "ok"}


@router.post("/diag/equipment/{equipment_id}/return-to-service")
def diag_equipment_return_to_service(equipment_id: int, request: Request, db: Session = Depends(get_db),
                                      user: dict = Depends(require_permissions("diag.qc"))):
    lq.return_diag_equipment_to_service(db, equipment_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "return_to_service", "diag_equipment", str(equipment_id), {})
    return {"status": "ok"}


@router.get("/diag/equipment/{equipment_id}/maintenance")
def diag_equipment_maintenance_list(equipment_id: int, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"logs": lq.list_diag_equipment_maintenance(db, equipment_id)}


@router.post("/diag/equipment/maintenance")
def diag_equipment_maintenance_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                       user: dict = Depends(require_permissions("diag.qc"))):
    validate_required_fields(payload, ["equipment_id"])
    log_id = lq.log_diag_equipment_maintenance(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "log_maintenance", "diag_equipment_maintenance", str(log_id), {"equipment_id": payload["equipment_id"]})
    return {"log_id": log_id}


@router.get("/diag/qc/runs")
def diag_qc_runs_list(equipment_id: Optional[int] = None, outcome: Optional[str] = None,
                       db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"runs": lq.list_diag_qc_runs(db, equipment_id, outcome)}


@router.post("/diag/qc/runs")
def diag_qc_run_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.qc"))):
    validate_required_fields(payload, ["equipment_id", "outcome"])
    result = lq.record_diag_qc_run(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "record_qc", "diag_qc_runs", str(result["run_id"]), {"outcome": payload.get("outcome")})
    return result


@router.post("/diag/qc/runs/{run_id}/review")
def diag_qc_run_review(run_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("diag.qc"))):
    payload = payload or {}
    lq.review_diag_qc_run(db, run_id, user.get("username"), payload.get("notes"))
    log_audit_event(db, user, client_ip(request), "review_qc", "diag_qc_runs", str(run_id), {})
    return {"status": "ok"}


@router.get("/diag/qc/holds")
def diag_qc_holds_list(status: Optional[str] = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"holds": lq.list_diag_qc_holds(db, status)}


@router.post("/diag/qc/holds/{hold_id}/corrective-action")
def diag_qc_hold_corrective_action(hold_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("diag.qc"))):
    lq.record_diag_qc_corrective_action(db, hold_id, payload.get("corrective_action"), payload.get("assigned_to"), user.get("username"))
    log_audit_event(db, user, client_ip(request), "corrective_action", "diag_qc_holds", str(hold_id), {})
    return {"status": "ok"}


@router.post("/diag/qc/holds/{hold_id}/repeat-qc")
def diag_qc_hold_repeat(hold_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("diag.qc"))):
    result = lq.record_diag_repeat_qc(db, hold_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "repeat_qc", "diag_qc_holds", str(hold_id), result)
    return result


@router.post("/diag/qc/holds/{hold_id}/release")
def diag_qc_hold_release(hold_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("diag.qc"))):
    payload = payload or {}
    lq.release_diag_qc_hold(db, hold_id, user.get("username"), payload.get("release_notes"))
    log_audit_event(db, user, client_ip(request), "release_hold", "diag_qc_holds", str(hold_id), {})
    return {"status": "ok"}


@router.get("/diag/reagent-lots")
def diag_reagent_lots_list(status: Optional[str] = None, expiring_within_days: Optional[int] = None,
                            db: Session = Depends(get_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"lots": rows_to_dicts(lq.list_diag_reagent_lots(db, status, expiring_within_days))}


@router.post("/diag/reagent-lots")
def diag_reagent_lot_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("diag.qc"))):
    validate_required_fields(payload, ["item_name", "lot_no"])
    lot_id = lq.create_diag_reagent_lot(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_reagent_lots", str(lot_id), {"item_name": payload["item_name"]})
    return {"lot_id": lot_id}


@router.post("/diag/reagent-lots/{lot_id}/status")
def diag_reagent_lot_status_update(lot_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("diag.qc"))):
    status = payload.get("status")
    if not status:
        raise HTTPException(status_code=400, detail="status is required")
    lq.update_diag_reagent_lot_status(db, lot_id, status, user.get("username"), payload.get("notes"))
    log_audit_event(db, user, client_ip(request), "status", "diag_reagent_lots", str(lot_id), {"status": status})
    return {"status": "ok"}
