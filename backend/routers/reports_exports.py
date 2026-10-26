import csv
import io
import uuid
from datetime import datetime

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, get_current_user, current_hospital_id
import legacy_queries as lq
from export_utils import generate_pdf, generate_word, generate_standard_report_pdf
from storage import ObjectStorage

router = APIRouter(prefix="/api", tags=["reports"])
STORAGE = ObjectStorage()


def _build_reports_export_text(overview):
    lines = [
        "# HospAI Reports Overview", "",
        "## Financial Summary",
        f"- Total billed: INR {overview['billing_summary']['total_billed']:.2f}",
        f"- Total collected: INR {overview['billing_summary']['total_collected']:.2f}",
        f"- Total due: INR {overview['billing_summary']['total_due']:.2f}",
        f"- Net position: INR {overview['accounts_summary']['net_position']:.2f}",
        "",
        "## Operations",
        f"- Monthly OP: {overview['hospital_summary']['ip_op_counts']['monthly_op']}",
        f"- Monthly IP: {overview['hospital_summary']['ip_op_counts']['monthly_ip']}",
        f"- Average LOS: {overview['alos_summary']['average_los_days']} days",
        f"- Admissions counted: {overview['alos_summary']['admission_count']}",
        "", "## Clinic Income",
    ]
    for row in overview.get("clinic_income", []):
        lines.append(f"- {row['label']}: INR {float(row['count']):.2f}")
    lines.extend(["", "## Discounts by Module"])
    for row in overview.get("discount_by_module", []):
        lines.append(f"- {row['label']}: INR {float(row['count']):.2f}")
    lines.extend(["", "## Payment Status"])
    for row in overview.get("payment_status_breakdown", []):
        lines.append(f"- {row['label']}: {row['count']} invoice(s)")
    return "\n".join(lines)


@router.get("/reports/overview")
def reports_overview(db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    try:
        return lq.get_reports_overview(db)
    except Exception:
        raise HTTPException(status_code=500, detail={"success": False, "message": "Unable to fetch reports overview"})


@router.get("/reports/revenue-summary")
def reports_revenue_summary(date: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    return lq.get_revenue_summary(db, collection_date=date)


@router.get("/reports/live-summary")
def reports_live_summary(period: str = "month", db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    try:
        overview = lq.get_reports_overview(db)
        return {"success": True, "period": period, "overview": overview}
    except Exception:
        return {"success": True, "period": period, "overview": {}}


@router.get("/reports/patient-history")
def reports_patient_history(date: str | None = None, type: str | None = None, value: str | None = None,
                             db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    return lq.get_report_patient_history(db, collection_date=date, filter_type=type, filter_value=value)


@router.get("/reports/export/csv")
def reports_export_csv(db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    overview = lq.get_reports_overview(db)
    csv_stream = io.StringIO()
    writer = csv.writer(csv_stream)
    writer.writerow(["section", "label", "value"])
    writer.writerow(["billing", "total_billed", overview["billing_summary"]["total_billed"]])
    writer.writerow(["billing", "total_collected", overview["billing_summary"]["total_collected"]])
    writer.writerow(["billing", "total_due", overview["billing_summary"]["total_due"]])
    writer.writerow(["accounts", "net_position", overview["accounts_summary"]["net_position"]])
    writer.writerow(["operations", "monthly_op", overview["hospital_summary"]["ip_op_counts"]["monthly_op"]])
    writer.writerow(["operations", "monthly_ip", overview["hospital_summary"]["ip_op_counts"]["monthly_ip"]])
    writer.writerow(["operations", "average_los_days", overview["alos_summary"]["average_los_days"]])
    for row in overview.get("clinic_income", []):
        writer.writerow(["clinic_income", row["label"], row["count"]])
    for row in overview.get("discount_by_module", []):
        writer.writerow(["discount_by_module", row["label"], row["count"]])
    for row in overview.get("payment_status_breakdown", []):
        writer.writerow(["payment_status", row["label"], row["count"]])
    return StreamingResponse(io.BytesIO(csv_stream.getvalue().encode("utf-8")), media_type="text/csv",
                              headers={"Content-Disposition": 'attachment; filename="reports-overview.csv"'})


@router.get("/reports/export/pdf")
def reports_export_pdf(db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    overview = lq.get_reports_overview(db)
    pdf_bytes = generate_pdf("Hospital Operations", "reports_overview", _build_reports_export_text(overview), datetime.now().strftime("%Y-%m-%d %H:%M"))
    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf",
                              headers={"Content-Disposition": 'attachment; filename="reports-overview.pdf"'})


@router.get("/reports/export/word")
def reports_export_word(db: Session = Depends(get_db), user: dict = Depends(require_permissions("reports.read"))):
    overview = lq.get_reports_overview(db)
    word_bytes = generate_word("Hospital Operations", "reports_overview", _build_reports_export_text(overview), datetime.now().strftime("%Y-%m-%d %H:%M"))
    return StreamingResponse(io.BytesIO(word_bytes), media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                              headers={"Content-Disposition": 'attachment; filename="reports-overview.docx"'})


# --------------------------------------------------------- dashboard exports --

def _build_dashboard_export_payload(db: Session, hospital_id: int):
    summary = lq.get_hospital_dashboard_summary(db)
    revenue = summary.get("revenue") or {}
    payment_summary = summary.get("payment_summary") or {}
    return {
        "generated_at": lq.current_ist_datetime().strftime("%Y-%m-%d %H:%M:%S"),
        "revenue": {
            "today": revenue.get("today_total", 0) or 0,
            "weekly": revenue.get("weekly_revenue", revenue.get("weekly_total", 0)) or 0,
            "monthly": revenue.get("monthly_total", 0) or 0,
            "yearly": revenue.get("yearly_total", 0) or 0,
        },
        "payment_summary": {
            "total_collection": payment_summary.get("total_collection", revenue.get("total_collection", 0)) or 0,
            "pending_payments": payment_summary.get("pending_payments", revenue.get("pending_payments", 0)) or 0,
            "paid_payments": payment_summary.get("paid_payments", revenue.get("paid_payments", 0)) or 0,
            "today_collection": payment_summary.get("today_collection", revenue.get("today_collection", 0)) or 0,
        },
        "operations_today": summary.get("operations_today") or {},
        "ip_op_counts": summary.get("ip_op_counts") or {},
    }


def _dashboard_pdf_text(payload):
    lines = [
        "# Executive Dashboard", f"Generated: {payload['generated_at']}", "",
        "## Revenue",
        f"- Today: INR {payload['revenue']['today']}",
        f"- Weekly: INR {payload['revenue']['weekly']}",
        f"- Monthly: INR {payload['revenue']['monthly']}",
        f"- Yearly: INR {payload['revenue']['yearly']}",
        "", "## Payment Summary",
        f"- Total collection: INR {payload['payment_summary']['total_collection']}",
        f"- Pending payments: {payload['payment_summary']['pending_payments']}",
        f"- Paid payments: {payload['payment_summary']['paid_payments']}",
        f"- Today's collection: INR {payload['payment_summary']['today_collection']}",
    ]
    return "\n".join(lines)


@router.get("/dashboard/export/pdf")
def dashboard_export_pdf(db: Session = Depends(get_db), user: dict = Depends(get_current_user), hospital_id: int = Depends(current_hospital_id)):
    try:
        payload = _build_dashboard_export_payload(db, hospital_id)
        pdf_bytes = generate_pdf("Executive Dashboard", "executive_dashboard", _dashboard_pdf_text(payload), payload["generated_at"])
        return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf",
                                  headers={"Content-Disposition": 'attachment; filename="executive-dashboard.pdf"'})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "Unable to generate dashboard PDF.", "message": str(exc)})


@router.get("/dashboard/print/pdf")
def dashboard_print_pdf(db: Session = Depends(get_db), user: dict = Depends(get_current_user), hospital_id: int = Depends(current_hospital_id)):
    return dashboard_export_pdf(db=db, user=user, hospital_id=hospital_id)


@router.get("/dashboard/export/csv")
def dashboard_export_csv(db: Session = Depends(get_db), user: dict = Depends(get_current_user), hospital_id: int = Depends(current_hospital_id)):
    try:
        payload = _build_dashboard_export_payload(db, hospital_id)
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["metric", "value"])
        writer.writerow(["today_revenue", payload["revenue"]["today"]])
        writer.writerow(["weekly_revenue", payload["revenue"]["weekly"]])
        writer.writerow(["monthly_revenue", payload["revenue"]["monthly"]])
        writer.writerow(["yearly_revenue", payload["revenue"]["yearly"]])
        writer.writerow(["total_collection", payload["payment_summary"]["total_collection"]])
        writer.writerow(["pending_payments", payload["payment_summary"]["pending_payments"]])
        writer.writerow(["paid_payments", payload["payment_summary"]["paid_payments"]])
        writer.writerow(["today_collection", payload["payment_summary"]["today_collection"]])
        return StreamingResponse(io.BytesIO(buffer.getvalue().encode("utf-8")), media_type="text/csv",
                                  headers={"Content-Disposition": 'attachment; filename="executive-dashboard.csv"'})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "Unable to generate dashboard CSV.", "message": str(exc)})


@router.get("/dashboard/export/excel")
def dashboard_export_excel(db: Session = Depends(get_db), user: dict = Depends(get_current_user), hospital_id: int = Depends(current_hospital_id)):
    try:
        from openpyxl import Workbook
        payload = _build_dashboard_export_payload(db, hospital_id)
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Dashboard"
        sheet.append(["metric", "value"])
        sheet.append(["today_revenue", payload["revenue"]["today"]])
        sheet.append(["weekly_revenue", payload["revenue"]["weekly"]])
        sheet.append(["monthly_revenue", payload["revenue"]["monthly"]])
        sheet.append(["yearly_revenue", payload["revenue"]["yearly"]])
        sheet.append(["total_collection", payload["payment_summary"]["total_collection"]])
        sheet.append(["pending_payments", payload["payment_summary"]["pending_payments"]])
        sheet.append(["paid_payments", payload["payment_summary"]["paid_payments"]])
        sheet.append(["today_collection", payload["payment_summary"]["today_collection"]])
        output = io.BytesIO()
        workbook.save(output)
        output.seek(0)
        return StreamingResponse(output, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                  headers={"Content-Disposition": 'attachment; filename="executive-dashboard.xlsx"'})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "Unable to generate dashboard Excel export.", "message": str(exc)})


@router.post("/reports/export/pdf")
def standard_module_report_export_pdf(payload: dict = Body(default={}), db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Renders the caller's own StandardPdfPayload (title/sections/patient_info/
    totals) into a real PDF. Every module's 'Download PDF' button (Dashboard,
    Billing, Lab, Patients, Patient Journey) posts its own report here; a
    payload with no `sections` at all falls back to the hospital-operations
    overview, matching this endpoint's original GET behavior."""
    if payload and payload.get("sections"):
        pdf_bytes = generate_standard_report_pdf(payload)
    else:
        overview = lq.get_reports_overview(db)
        pdf_bytes = generate_pdf("Hospital Operations", "reports_overview", _build_reports_export_text(overview), datetime.now().strftime("%Y-%m-%d %H:%M"))
    filename = str((payload or {}).get("filename") or "Hospital_Report.pdf")
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf",
                              headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ------------------------------------------------------------------- share --

@router.post("/share/upload")
def share_upload(request: Request, db: Session = Depends(get_db), user: dict = Depends(get_current_user), file: UploadFile = File(...)):
    file_bytes = file.file.read()
    filename = file.filename or "export.bin"
    mimetype = file.content_type or "application/octet-stream"
    file_path = STORAGE.store(doc_type="shared_exports", file_name=filename, data=file_bytes, mime_type=mimetype)
    share_token = uuid.uuid4().hex
    lq.create_shared_export(db, share_token, file_path, filename, mimetype)
    share_url = f"{request.url.scheme}://{request.url.netloc}/api/share/view/{share_token}"
    return {"share_url": share_url, "share_token": share_token}


@router.get("/share/view/{share_token}")
def share_view(share_token: str, db: Session = Depends(get_db)):
    record = lq.get_shared_export(db, share_token)
    if not record:
        raise HTTPException(status_code=404, detail="Shared export not found")
    file_path = record["file_path"]
    file_name = record["file_name"] or "export"
    mime_type = record["mime_type"] or "application/octet-stream"
    file_bytes = STORAGE.read(file_path)
    if not file_bytes:
        raise HTTPException(status_code=404, detail="Shared file content unavailable")
    return StreamingResponse(io.BytesIO(file_bytes), media_type=mime_type,
                              headers={"Content-Disposition": f'inline; filename="{file_name}"', "Cache-Control": "public, max-age=86400"})
