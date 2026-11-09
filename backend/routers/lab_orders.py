"""Lab order service types: Outsourcing / Home Visit ordering, sample routing,
partner-lab costs, lab settings and the unified Order History.

Logic lives in diag_service_types.py; schema in migrations/migrations_diag_service_types.sql.
"""
from typing import Optional

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

# Every write below commits together with its audit_logs row (see database.get_audited_db).
from database import get_audited_db
from deps import require_permissions
from access_scope import patient_scope, filter_rows
from common import log_audit_event, client_ip
import diag_service_types as dst
import file_import
import lab_result_import
import legacy_queries as lq

router = APIRouter(prefix="/api", tags=["lab-orders"])


def _optional_int(value, field):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a number.")


# -------------------------------------------------------------------- settings --

@router.get("/diag/settings")
def diag_settings_get(db: Session = Depends(get_audited_db), user: dict = Depends(require_permissions("diag.read"))):
    return dst.get_settings(db)


@router.put("/diag/settings")
def diag_settings_update(request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                         user: dict = Depends(require_permissions("diag.catalogue"))):
    settings = dst.update_settings(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "update", "diag_settings", "lab", payload)
    return settings


# ---------------------------------------------- catalogue: equipment + partner lab --

@router.get("/diag/services/{service_id}/routing")
def diag_service_routing_get(service_id: int, db: Session = Depends(get_audited_db),
                             user: dict = Depends(require_permissions("diag.read"))):
    routing = dst.get_service_routing(db, service_id)
    if not routing:
        raise HTTPException(status_code=404, detail="Test not found")
    return routing


@router.put("/diag/services/{service_id}/routing")
def diag_service_routing_update(service_id: int, request: Request, payload: dict = Body(...),
                                db: Session = Depends(get_audited_db),
                                user: dict = Depends(require_permissions("diag.catalogue"))):
    equipment_ids = payload.get("equipment_ids") or []
    if not isinstance(equipment_ids, list):
        raise HTTPException(status_code=400, detail="equipment_ids must be a list.")
    vendor_id = _optional_int(payload.get("preferred_vendor_id"), "preferred_vendor_id")
    routing = dst.set_service_routing(db, service_id, equipment_ids, vendor_id)
    log_audit_event(db, user, client_ip(request), "update_routing", "diag_services", str(service_id),
                    {"equipment_ids": equipment_ids, "preferred_vendor_id": vendor_id})
    return routing


# ------------------------------------------------------------ partner-lab costs --

@router.get("/diag/vendor-rates")
def diag_vendor_rates_list(vendor_id: Optional[int] = None, service_id: Optional[int] = None,
                           db: Session = Depends(get_audited_db),
                           user: dict = Depends(require_permissions("diag.catalogue"))):
    # Hospital cost and margin: catalogue managers only.
    return {"rates": dst.list_vendor_rates(db, vendor_id, service_id)}


@router.put("/diag/vendor-rates")
def diag_vendor_rate_save(request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                          user: dict = Depends(require_permissions("diag.catalogue"))):
    vendor_id = _optional_int(payload.get("vendor_id"), "vendor_id")
    service_id = _optional_int(payload.get("service_id"), "service_id")
    if not vendor_id or not service_id:
        raise HTTPException(status_code=400, detail="Select the partner lab and the test.")
    cost = dst.save_vendor_rate(db, vendor_id, service_id, payload.get("cost"), user.get("username"))
    log_audit_event(db, user, client_ip(request), "upsert" if cost is not None else "delete", "diag_vendor_service_rates",
                    f"{vendor_id}:{service_id}", {"cost": cost})
    return {"vendor_id": vendor_id, "service_id": service_id, "cost": cost}


# --------------------------------------------------------------- routing queue --

@router.get("/diag/routing/pending-vendor")
def diag_pending_vendor_items(db: Session = Depends(get_audited_db), user: dict = Depends(require_permissions("diag.read"))):
    return {"items": dst.list_pending_vendor_items(db)}


@router.post("/diag/order-items/{item_id}/assign-vendor")
def diag_item_assign_vendor(item_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                            user: dict = Depends(require_permissions("diag.specimen"))):
    vendor_id = _optional_int(payload.get("vendor_id"), "vendor_id")
    if not vendor_id:
        raise HTTPException(status_code=400, detail="Select the partner lab.")
    result = dst.assign_vendor(db, item_id, vendor_id, user.get("username"))
    log_audit_event(db, user, client_ip(request), "assign_vendor", "diag_order_items", str(item_id), {"vendor_id": vendor_id})
    return result


# ---------------------------------------------------- outsourcing / home-visit orders --

@router.post("/diag/service-orders")
def diag_service_order_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                              user: dict = Depends(require_permissions("diag.order"))):
    """Draft Outsourcing / Home Visit order. Confirm with POST /diag/orders/{id}/confirm (raises the invoice)."""
    order_id = dst.create_service_order(db, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "diag_orders", str(order_id), {
        "service_type": str(payload.get("service_type") or "").upper(),
        "patient_id": payload.get("patient_id"), "outsource_vendor_id": payload.get("outsource_vendor_id"),
    })
    return {"order_id": order_id}


@router.get("/diag/home-visits")
def diag_home_visits_list(visit_status: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                          q: Optional[str] = None, db: Session = Depends(get_audited_db),
                          user: dict = Depends(require_permissions("diag.read")), scope: set | None = Depends(patient_scope)):
    return {"visits": filter_rows(dst.list_home_visits(db, visit_status, date_from, date_to, q), scope)}


@router.post("/diag/home-visits/{order_id}/collect")
def diag_home_visit_collect(order_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                            user: dict = Depends(require_permissions("diag.specimen"))):
    result = dst.collect_home_visit(db, order_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "home_visit_collect", "diag_orders", str(order_id), result)
    return result


@router.post("/diag/home-visits/{order_id}/receive")
def diag_home_visit_receive(order_id: int, request: Request, payload: dict = Body(default={}), db: Session = Depends(get_audited_db),
                            user: dict = Depends(require_permissions("diag.specimen"))):
    result = dst.receive_home_visit(db, order_id, payload or {}, user.get("username"))
    log_audit_event(db, user, client_ip(request), "home_visit_receive", "diag_orders", str(order_id), {
        "received_specimens": result["received_specimens"],
        "routing": [{"item_id": o["item_id"], "routing": o["routing"], "vendor_id": o["vendor_id"]} for o in result["routing"]],
    })
    return result


@router.post("/diag/home-visits/{order_id}/reschedule")
def diag_home_visit_reschedule(order_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                               user: dict = Depends(require_permissions("diag.order"))):
    result = dst.reschedule_home_visit(db, order_id, payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "home_visit_reschedule", "diag_orders", str(order_id), result)
    return result


@router.post("/diag/home-visits/{order_id}/cancel")
def diag_home_visit_cancel(order_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_audited_db),
                           user: dict = Depends(require_permissions("diag.order"))):
    result = dst.cancel_home_visit(db, order_id, payload.get("reason"), user.get("username"), payload.get("refund_mode"))
    log_audit_event(db, user, client_ip(request), "home_visit_cancel", "diag_orders", str(order_id),
                    {"reason": payload.get("reason"), **result})
    return result


# ----------------------------------------------------------------- order history --

@router.get("/diag/order-history")
def diag_order_history(service_type: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
                       q: Optional[str] = None, status: Optional[str] = None, page: int = 1, page_size: int = 50,
                       db: Session = Depends(get_audited_db), user: dict = Depends(require_permissions("diag.read")),
                       scope: set | None = Depends(patient_scope)):
    service_type = (service_type or "").upper() or None
    if service_type == "ALL":
        service_type = None
    for label, value in (("date_from", date_from), ("date_to", date_to)):
        if value and not _is_iso_date(value):
            raise HTTPException(status_code=400, detail=f"{label} must be YYYY-MM-DD.")
    return dst.list_order_history(db, service_type, date_from, date_to, q, status, page, page_size, allowed_patient_ids=scope)


def _is_iso_date(value: str) -> bool:
    from datetime import date
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


# ------------------------------------------------------- result import (CSV/PDF/image) --

@router.post("/diag/lab/items/{item_id}/results/import")
def diag_results_import(item_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_audited_db),
                        user: dict = Depends(require_permissions("diag.result"))):
    """One upload for a test's results: CSV is parsed directly, PDF/image go through OCR.
    Returns draft values for the Lab page to fill; nothing is saved here."""
    item = lq.get_diag_lab_item_detail(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Order item not found")
    if item.get("cancelled_at"):
        raise HTTPException(status_code=400, detail="This test has been cancelled.")
    patient = item.get("patient") or {}
    patient_name = f"{patient.get('name') or ''} {patient.get('last_name') or ''}".strip() or (item.get("walkin_name") or "")
    specimen_nos = [s.get("specimen_no") for s in item.get("specimens") or []]
    # Read one byte past the limit so oversized uploads are rejected without buffering them whole.
    content = file.file.read(file_import.MAX_UPLOAD_BYTES + 1)
    db.rollback()  # return the pooled connection during the (possibly slow) model call
    try:
        result = lab_result_import.import_lab_results(
            file.filename, content, item.get("parameters") or [], item.get("service_name") or "", patient_name, specimen_nos)
    except file_import.FileImportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    log_audit_event(db, user, client_ip(request), "results_import", "diag_results", str(item_id), {
        "file_name": file.filename, "file_type": result["file_type"], "processing": result["processing"],
        "values_read": len(result["values"]), "skipped": len(result["skipped"]),
        "unmatched": len(result.get("unmatched") or []), "identity_warnings": result["identity_warnings"],
    })
    return result
