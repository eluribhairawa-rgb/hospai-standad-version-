import io
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id_for
from common import log_audit_event, client_ip
import patient_reach as pr

router = APIRouter(prefix="/api/reach", tags=["patient-reach"])


def _hid(user: dict, request: Request, db: Session) -> int:
    return current_hospital_id_for(user, request, db)


# --------------------------------------------------------- survey templates --

@router.get("/survey-templates")
def survey_templates_list(request: Request, status: Optional[str] = None, survey_type: Optional[str] = None, q: Optional[str] = None,
                          db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    hid = _hid(user, request, db)
    pr.ensure_defaults(db, hid)
    return {"templates": pr.list_survey_templates(db, hid, status, survey_type, q)}


@router.get("/survey-templates/{template_id}")
def survey_template_detail(template_id: int, request: Request, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.read"))):
    tpl = pr.get_survey_template(db, _hid(user, request, db), template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Survey template not found")
    return tpl


@router.post("/survey-templates")
def survey_template_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    template_id = pr.create_survey_template(db, _hid(user, request, db), payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "reach_survey_templates", str(template_id), {"name": payload.get("name")})
    return {"template_id": template_id}


@router.put("/survey-templates/{template_id}")
def survey_template_update(template_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    if not pr.update_survey_template(db, _hid(user, request, db), template_id, payload, user.get("username")):
        raise HTTPException(status_code=404, detail="Survey template not found")
    log_audit_event(db, user, client_ip(request), "update", "reach_survey_templates", str(template_id), {"name": payload.get("name")})
    return {"status": "ok"}


@router.put("/survey-templates/{template_id}/status")
def survey_template_status(template_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    if not pr.set_survey_template_status(db, _hid(user, request, db), template_id, payload.get("status"), user.get("username")):
        raise HTTPException(status_code=404, detail="Survey template not found")
    log_audit_event(db, user, client_ip(request), "status", "reach_survey_templates", str(template_id), {"status": payload.get("status")})
    return {"status": "ok"}


@router.post("/survey-templates/{template_id}/duplicate")
def survey_template_duplicate(template_id: int, request: Request, db: Session = Depends(get_db),
                              user: dict = Depends(require_permissions("reach.write"))):
    new_id = pr.duplicate_survey_template(db, _hid(user, request, db), template_id, user.get("username"))
    if not new_id:
        raise HTTPException(status_code=404, detail="Survey template not found")
    log_audit_event(db, user, client_ip(request), "duplicate", "reach_survey_templates", str(new_id), {"source": template_id})
    return {"template_id": new_id}


@router.delete("/survey-templates/{template_id}")
def survey_template_delete(template_id: int, request: Request, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    if not pr.delete_survey_template(db, _hid(user, request, db), template_id, user.get("username")):
        raise HTTPException(status_code=404, detail="Survey template not found")
    log_audit_event(db, user, client_ip(request), "delete", "reach_survey_templates", str(template_id), {})
    return {"status": "ok"}


# -------------------------------------------------------- whatsapp templates --

@router.get("/whatsapp-templates")
def whatsapp_templates_list(request: Request, category: Optional[str] = None, active_only: bool = False, q: Optional[str] = None,
                            db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    hid = _hid(user, request, db)
    pr.ensure_defaults(db, hid)
    return {"templates": pr.list_whatsapp_templates(db, hid, category, active_only, q), "hospital_name": pr.hospital_name(db, hid)}


@router.post("/whatsapp-templates")
def whatsapp_template_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("reach.write"))):
    template_id = pr.create_whatsapp_template(db, _hid(user, request, db), payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "reach_whatsapp_templates", str(template_id), {"name": payload.get("name")})
    return {"template_id": template_id}


@router.put("/whatsapp-templates/{template_id}")
def whatsapp_template_update(template_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("reach.write"))):
    if not pr.update_whatsapp_template(db, _hid(user, request, db), template_id, payload, user.get("username")):
        raise HTTPException(status_code=404, detail="WhatsApp template not found")
    log_audit_event(db, user, client_ip(request), "update", "reach_whatsapp_templates", str(template_id), {"name": payload.get("name")})
    return {"status": "ok"}


@router.delete("/whatsapp-templates/{template_id}")
def whatsapp_template_delete(template_id: int, request: Request, db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("reach.write"))):
    if not pr.delete_whatsapp_template(db, _hid(user, request, db), template_id, user.get("username")):
        raise HTTPException(status_code=404, detail="WhatsApp template not found")
    log_audit_event(db, user, client_ip(request), "delete", "reach_whatsapp_templates", str(template_id), {})
    return {"status": "ok"}


# ---------------------------------------------------- survey requests / list --

def _filters(status=None, q=None, template_id=None, patient_id=None, survey_type=None, rating=None,
             date_from=None, date_to=None, limit=None, offset=None):
    return {"status": status, "q": q, "template_id": template_id, "patient_id": patient_id, "survey_type": survey_type,
            "rating": rating, "date_from": date_from, "date_to": date_to, "limit": limit, "offset": offset}


@router.get("/surveys")
def surveys_list(request: Request, status: Optional[str] = None, q: Optional[str] = None, template_id: Optional[str] = None,
                 patient_id: Optional[str] = None, survey_type: Optional[str] = None, rating: Optional[str] = None,
                 date_from: Optional[str] = None, date_to: Optional[str] = None, limit: Optional[str] = None, offset: Optional[str] = None,
                 db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    return pr.list_survey_requests(db, _hid(user, request, db),
                                   _filters(status, q, template_id, patient_id, survey_type, rating, date_from, date_to, limit, offset))


@router.get("/surveys/export.xlsx")
def surveys_export_xlsx(request: Request, status: Optional[str] = None, q: Optional[str] = None, template_id: Optional[str] = None,
                        patient_id: Optional[str] = None, survey_type: Optional[str] = None, rating: Optional[str] = None,
                        date_from: Optional[str] = None, date_to: Optional[str] = None,
                        db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    data = pr.list_survey_requests(db, _hid(user, request, db),
                                   _filters(status, q, template_id, patient_id, survey_type, rating, date_from, date_to, 5000, 0))
    items = data["items"]
    categories = sorted({c for row in items for c in (row.get("category_ratings") or {})})
    wb = Workbook()
    ws = wb.active
    ws.title = "Survey Responses"
    headers = ["Sl.No", "Patient Name", "UHID", "Phone", "Survey", "Doctor", "Department", "Status", "Sent On",
               "Submitted On", "Overall Rating", *categories, "Comments", "Channel", "Recorded By"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="00828A")
    for idx, row in enumerate(items, start=1):
        ratings = row.get("category_ratings") or {}
        ws.append([
            idx, row.get("patient_name"), row.get("patient_id"), row.get("phone"), row.get("template_name"),
            row.get("doctor_name"), row.get("department"), (row.get("status") or "").replace("_", " ").title(),
            row["sent_at"].strftime("%d-%m-%Y %H:%M") if row.get("sent_at") else "",
            row["submitted_at"].strftime("%d-%m-%Y %H:%M") if row.get("submitted_at") else "",
            row.get("overall_rating"), *[ratings.get(c) for c in categories],
            row.get("comments"), (row.get("channel") or "").replace("_", " ").title(), row.get("recorded_by"),
        ])
    for column in ws.columns:
        width = max(len(str(c.value or "")) for c in column)
        ws.column_dimensions[column[0].column_letter].width = min(max(width + 2, 10), 60)
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return StreamingResponse(output, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": 'attachment; filename="survey-responses.xlsx"'})


@router.get("/surveys/{request_id}")
def survey_detail(request_id: int, request: Request, db: Session = Depends(get_db),
                  user: dict = Depends(require_permissions("reach.read"))):
    req = pr.get_survey_request(db, _hid(user, request, db), request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Survey not found")
    return req


@router.post("/surveys")
def surveys_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                   user: dict = Depends(require_permissions("reach.write"))):
    result = pr.create_survey_requests(db, _hid(user, request, db), payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "reach_survey_requests", ",".join(map(str, result["created"])),
                    {"template_id": payload.get("template_id"), "skipped": len(result["skipped"])})
    return result


@router.post("/surveys/{request_id}/mark-sent")
def survey_mark_sent(request_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("reach.write"))):
    req = pr.mark_request_sent(db, _hid(user, request, db), request_id, payload, user.get("username"))
    if not req:
        raise HTTPException(status_code=404, detail="Survey not found")
    log_audit_event(db, user, client_ip(request), "whatsapp_sent", "reach_survey_requests", str(request_id), {"phone": req.get("phone")})
    return req


@router.post("/surveys/{request_id}/cancel")
def survey_cancel(request_id: int, request: Request, db: Session = Depends(get_db),
                  user: dict = Depends(require_permissions("reach.write"))):
    if not pr.cancel_survey_request(db, _hid(user, request, db), request_id):
        raise HTTPException(status_code=404, detail="Survey not found")
    log_audit_event(db, user, client_ip(request), "cancel", "reach_survey_requests", str(request_id), {})
    return {"status": "ok"}


# --------------------------------------------------------- survey responses --

@router.post("/survey-responses")
def survey_response_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    result = pr.create_survey_response(db, _hid(user, request, db), payload, user.get("username"))
    log_audit_event(db, user, client_ip(request), "create", "reach_survey_responses", str(result["response_id"]),
                    {"request_id": result["request_id"], "overall_rating": payload.get("overall_rating")})
    return result


@router.delete("/survey-responses/{response_id}")
def survey_response_delete(response_id: int, request: Request, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("reach.write"))):
    if not pr.delete_survey_response(db, _hid(user, request, db), response_id):
        raise HTTPException(status_code=404, detail="Survey response not found")
    log_audit_event(db, user, client_ip(request), "delete", "reach_survey_responses", str(response_id), {})
    return {"status": "ok"}


@router.get("/survey-summary")
def survey_summary(request: Request, patient_id: Optional[str] = None, template_id: Optional[str] = None,
                   db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    return pr.survey_summary(db, _hid(user, request, db), patient_id, template_id)


@router.get("/survey-reports")
def survey_reports(request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None, template_id: Optional[str] = None,
                   survey_type: Optional[str] = None, doctor: Optional[str] = None, department: Optional[str] = None,
                   db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    return pr.survey_report(db, _hid(user, request, db), {
        "date_from": date_from, "date_to": date_to, "template_id": template_id,
        "survey_type": survey_type, "doctor": doctor, "department": department,
    })


# --------------------------------------------------------- whatsapp messages --

@router.get("/whatsapp-messages")
def whatsapp_messages_list(request: Request, patient_id: Optional[str] = None, purpose: Optional[str] = None, limit: Optional[str] = None,
                           db: Session = Depends(get_db), user: dict = Depends(require_permissions("reach.read"))):
    return {"messages": pr.list_whatsapp_messages(db, _hid(user, request, db), patient_id, purpose, limit)}


@router.post("/whatsapp-messages")
def whatsapp_message_log(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("reach.write"))):
    message_id = pr.log_whatsapp_message(db, _hid(user, request, db), payload, user.get("username"))
    return {"message_id": message_id}
