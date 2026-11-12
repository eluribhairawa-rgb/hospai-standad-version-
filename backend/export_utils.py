"""Export utilities for generating PDF and Word documents from OCR text"""
import io
import os
import re
from datetime import datetime
from functools import lru_cache
from fpdf import FPDF
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

BRAND_NAME = "HospAI"
BRAND_TAGLINE = "POLYCLINIC & DIAGNOSTICS"


@lru_cache(maxsize=1)
def _frontend_logo_path():
    """Return the approved black HospAI print logo for offline/PyInstaller builds."""
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    meipass = getattr(__import__("sys"), "_MEIPASS", "")
    candidates = [
        os.path.join(root, "backend", "assets", "hospai_print_logo.png"),
        os.path.join(root, "assets", "hospai_print_logo.png"),
        os.path.join(meipass, "assets", "hospai_print_logo.png") if meipass else "",
        os.path.join(root, "frontend", "public", "hospai_print_logo.png"),
        os.path.join(root, "frontend", "dist", "hospai_print_logo.png"),
    ]
    return next((path for path in candidates if path and os.path.exists(path)), None)


@lru_cache(maxsize=1)
def _footer_logo_path():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    candidates = [
        os.path.join(root, "backend", "assets", "hospai_print_logo.png"),
        os.path.join(root, "assets", "hospai_print_logo.png"),
        os.path.join(getattr(__import__("sys"), "_MEIPASS", ""), "assets", "hospai_print_logo.png"),
        os.path.join(root, "frontend", "public", "hospai_print_logo.png"),
        os.path.join(root, "frontend", "dist", "hospai_print_logo.png"),
    ]
    return next((path for path in candidates if path and os.path.exists(path)), None)


def _brand():
    """Custom document branding (Admin > Branding & Templates), or None for the built-in defaults."""
    try:
        import branding
        return branding.get_branding()
    except Exception:
        return None


def _latin(value: str) -> str:
    return (value or "").encode("latin-1", "replace").decode("latin-1")


def brand_title() -> str:
    b = _brand()
    return _latin(b["hospital_title"]) if b and b.get("hospital_title") else BRAND_NAME


def _custom_image(pdf, path, mime, w_px, h_px, box_w, box_h, auto_fit, x_fn, y):
    """Draw a branding image scaled into its box (aspect ratio kept). Returns the drawn (x, w, h) or None."""
    import branding
    w, h = branding.fit_mm(w_px, h_px, box_w, box_h, auto_fit)
    if h > box_h:  # auto-fit off: still never exceed the vertical space reserved for it
        w, h = branding.fit_mm(w_px, h_px, box_w, box_h, True)
    x = x_fn(w)
    pdf.image(path, x=x, y=y, w=w, h=h)
    return x, w, h


def draw_pdf_brand_header(pdf, left_margin: float, top_y: float, title_width: float = 120):
    """Draw the letterhead used by every PDF export: the hospital's custom logo/title
    when configured in Branding & Templates, otherwise the approved HospAI logo."""
    b = _brand()
    drawn = None
    if b and b.get("logo_file"):
        try:
            import branding
            align = b.get("logo_alignment") or "left"
            right_edge = 195
            bw, bh = branding.LOGO_BOX_MM

            def x_for(w):
                base = {"left": left_margin, "center": (left_margin + right_edge - w) / 2, "right": right_edge - w}.get(align, left_margin)
                return min(max(base + b["logo_offset_x_mm"], 0), 210 - w)
            y = min(max(top_y + b["logo_offset_y_mm"], 0), top_y + 33 - 4)
            drawn = _custom_image(pdf, b["logo_file"], b.get("logo_mime"), b.get("logo_width_px"), b.get("logo_height_px"),
                                  bw, bh, bool(b.get("auto_fit_scaling")), x_for, y)
        except Exception:
            drawn = None
    if drawn:
        x, w, _h = drawn
        title = brand_title() if b.get("hospital_title") else ""
        if title and (b.get("logo_alignment") or "left") != "center":
            on_left = (b.get("logo_alignment") or "left") == "right"
            pdf.set_xy(left_margin if on_left else 195 - 80, top_y + 8)
            pdf.set_font("Helvetica", "B", 15)
            pdf.set_text_color(0, 0, 0)
            pdf.cell(80, 12, title, align="L" if on_left else "R")
    else:
        logo_path = None if (b and b.get("hospital_title") and not b.get("logo_file")) else _frontend_logo_path()
        if logo_path:
            try:
                pdf.image(logo_path, x=left_margin, y=top_y, w=0, h=28)
            except Exception:
                logo_path = None
        if not logo_path:
            pdf.set_xy(left_margin, top_y + 3)
            pdf.set_font("Helvetica", "B", 15)
            pdf.set_text_color(0, 0, 0)
            pdf.cell(120, 12, brand_title())

    pdf.set_draw_color(0, 0, 0)
    pdf.set_line_width(0.65)
    pdf.line(left_margin, top_y + 33, 195, top_y + 33)
    pdf.set_text_color(0, 0, 0)


def draw_pdf_brand_footer(pdf):
    """Draw the footer (rule - logo - rule, thank-you line, "Page X of Y") at the bottom of
    the current page, honouring a custom footer image/text from Branding & Templates.
    Call from FPDF.footer(); needs pdf.alias_nb_pages()."""
    b = _brand()
    custom_img = None
    if b and b.get("footer_file"):
        custom_img = b
    pdf.set_draw_color(0, 0, 0)
    pdf.set_line_width(0.45)
    if custom_img:
        pdf.line(15, 280.2, 195.0, 280.2)
        try:
            import branding
            bw, bh = branding.FOOTER_BOX_MM
            _custom_image(pdf, b["footer_file"], b.get("footer_mime"), b.get("footer_width_px"), b.get("footer_height_px"),
                          bw, bh, True, lambda w: 15 + (180 - w) / 2, 281.0)
        except Exception:
            pass
        text_y = -7.0
    else:
        pdf.line(15, 280.2, 99.0, 280.2)
        pdf.line(111.0, 280.2, 195.0, 280.2)
        logo_path = None if (b and b.get("hospital_title")) else _footer_logo_path()
        if logo_path:
            try:
                # w=0 maintains aspect ratio relative to h=8.0
                pdf.image(logo_path, x=100.2, y=276.2, w=0, h=8.0)
            except Exception:
                pass
        text_y = -13.8
    custom_text = _latin(b["footer_text"]) if b and b.get("footer_text") else ""
    default_text = f"Thank you for choosing {brand_title().rstrip('. ')}."
    pdf.set_y(text_y)
    pdf.set_font("Helvetica", "I", 7.5)
    pdf.set_text_color(0, 0, 0)
    pdf.set_x(15)
    pdf.cell(110 if custom_text else 82, 5, custom_text or default_text, align="L")
    pdf.set_x(155)
    pdf.cell(40, 5, f"Page {pdf.page_no()} of {{nb}}", align="R")


def parse_markdown_line(line):
    """Parse a line and return (type, content, is_bold_segments)
    Types: header, bullet, table_row, text
    """
    line = line.strip()
    if not line:
        return ("empty", "", [])

    header_match = re.match(r"^(#{1,6})\s+(.+)$", line)
    if header_match:
        return ("header", header_match.group(2).replace("**", ""), [])

    bullet_match = re.match(r"^[\•\-\*]\s+(.+)$", line)
    if bullet_match:
        content = bullet_match.group(1)
        return ("bullet", content, parse_bold_segments(content))

    if line.startswith("|") and line.endswith("|"):
        if re.match(r"^\|[\s\-\|:]+\|$", line):
            return ("table_sep", "", [])
        cells = [c.strip().replace("**", "") for c in line.strip("|").split("|")]
        return ("table_row", cells, [])

    return ("text", line, parse_bold_segments(line))


def parse_bold_segments(text):
    """Parse text and return list of (text, is_bold) tuples"""
    segments = []
    pattern = r"\*\*([^*]+)\*\*"
    last_end = 0

    for match in re.finditer(pattern, text):
        if match.start() > last_end:
            segments.append((text[last_end:match.start()], False))
        segments.append((match.group(1), True))
        last_end = match.end()

    if last_end < len(text):
        segments.append((text[last_end:], False))

    if not segments:
        segments = [(text, False)]

    return segments


_NON_PATIENT_DOC_TYPES = {"executive_dashboard", "reports_overview"}


def generate_pdf(patient_name: str, doc_type: str, ocr_text: str, date_str: str = None, hospital_id: int = None) -> bytes:
    """Generate a hospital-standard A4 PDF with client hospital branding."""
    import branding
    with branding.use_hospital(hospital_id):
        return _generate_pdf(patient_name, doc_type, ocr_text, date_str)


def _generate_pdf(patient_name, doc_type, ocr_text, date_str=None) -> bytes:
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    is_patient_document = (doc_type or "").strip().lower() not in _NON_PATIENT_DOC_TYPES

    class HospitalDocumentPDF(FPDF):
        def footer(self):
            draw_pdf_brand_footer(self)

    def _title_for_doc(value: str) -> str:
        normalized = (value or "").replace("-", "_").lower()
        if "prescription" in normalized:
            return "Doctor Prescription"
        if "discharge" in normalized:
            return "Discharge Summary"
        if "patient_journey" in normalized or "journey" in normalized:
            return "Patient Journey Report"
        return (value or "Medical Document").replace("_", " ").title()

    def _pdf_clean(value) -> str:
        text = "" if value is None else str(value)
        text = text.replace("₹", "Rs.").replace("•", "-").replace("–", "-").replace("—", "-")
        return text.encode("latin-1", errors="replace").decode("latin-1")

    def _ensure_space(height: float):
        if pdf.get_y() + height > 276:
            pdf.add_page()
            _draw_document_header()

    def _cell_label_value(label: str, value: str, x: float, y: float, w: float, h: float = 12):
        pdf.set_xy(x, y)
        pdf.set_fill_color(248, 252, 255)
        pdf.set_draw_color(210, 226, 236)
        pdf.rect(x, y, w, h, style="DF")
        pdf.set_xy(x + 2.5, y + 2)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(59, 89, 111)
        pdf.cell(w - 5, 3.5, _pdf_clean(label.upper()), ln=True)
        pdf.set_x(x + 2.5)
        pdf.set_font("Helvetica", "", 8.5)
        pdf.set_text_color(15, 23, 42)
        pdf.multi_cell(w - 5, 4, _pdf_clean(value or "-"))
        pdf.set_text_color(0, 0, 0)

    def _draw_document_header():
        draw_pdf_brand_header(pdf, left_margin, 8, title_width=92)
        pdf.set_xy(left_margin, 45)
        pdf.set_font("Helvetica", "B", 13)
        pdf.set_text_color(0, 0, 0)
        pdf.cell(105, 6, _pdf_clean(document_title), ln=True)
        pdf.set_x(left_margin)
        pdf.set_font("Helvetica", "", 8.5)
        pdf.cell(105, 5, _pdf_clean(f"{brand_title()} | Pharmacy | Diagnostic" if _brand() and _brand().get("hospital_title") else "HospAI | Pharmacy | Diagnostic"))

        try:
            generated_dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M")
        except Exception:
            generated_dt = datetime.now()
        meta = (
            ("Print Date", generated_dt.strftime("%d/%m/%Y")),
            ("Generated By", "HospAI System" if brand_title() == BRAND_NAME else "Hospital System"),
            ("Generated Time", generated_dt.strftime("%I:%M:%S %p")),
        )
        y = 45
        for label, value in meta:
            pdf.set_xy(130, y)
            pdf.set_font("Helvetica", "", 7.8)
            pdf.cell(27, 5, _pdf_clean(label))
            pdf.cell(5, 5, ":", align="C")
            pdf.cell(38, 5, _pdf_clean(value))
            y += 5
        pdf.set_text_color(0, 0, 0)
        pdf.set_y(64)

    def _section(title: str):
        _ensure_space(15)
        pdf.ln(2)
        pdf.set_fill_color(231, 247, 250)
        pdf.set_draw_color(190, 222, 233)
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(11, 95, 118)
        pdf.cell(effective_width, 8, _pdf_clean(title), border=1, fill=True, ln=True)
        pdf.set_text_color(0, 0, 0)

    def _paragraph(text: str):
        for raw in (text or "-").splitlines() or ["-"]:
            _ensure_space(8)
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(30, 41, 59)
            pdf.multi_cell(effective_width, 5, _pdf_clean(raw.strip() or " "))
        pdf.set_text_color(0, 0, 0)

    def _two_column_details(rows):
        y = pdf.get_y()
        col_w = (effective_width - 4) / 2
        for index, (label, value) in enumerate(rows):
            if index % 2 == 0:
                _ensure_space(14)
                y = pdf.get_y()
            x = left_margin + (col_w + 4) * (index % 2)
            _cell_label_value(label, value, x, y, col_w, 13)
            if index % 2 == 1:
                pdf.set_y(y + 15)
        if len(rows) % 2 == 1:
            pdf.set_y(y + 15)

    def _markdown_table(cells):
        col_count = max(len(cells), 1)
        col_w = effective_width / col_count
        _ensure_space(8)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_fill_color(241, 248, 252)
        pdf.set_draw_color(215, 226, 236)
        for cell in cells:
            pdf.cell(col_w, 7, _pdf_clean(cell)[:24], border=1, fill=True)
        pdf.ln(7)

    pdf = HospitalDocumentPDF(format="A4")
    left_margin = 15
    right_margin = 15
    document_title = _title_for_doc(doc_type)
    pdf.set_left_margin(left_margin)
    pdf.set_right_margin(right_margin)
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.alias_nb_pages()
    pdf.add_page()

    page_width = pdf.w
    effective_width = page_width - left_margin - right_margin

    _draw_document_header()
    if is_patient_document:
        _section("Patient Information")
        _two_column_details([
            ("Patient Name", patient_name or "-"),
            ("Document Type", document_title),
            ("Generated On", date_str),
            ("Hospital System", brand_title()),
        ])
    else:
        _section("Document Information")
        _two_column_details([
            ("Report Title", patient_name or document_title),
            ("Document Type", document_title),
            ("Generated On", date_str),
            ("Hospital System", brand_title()),
        ])
    _section("Clinical Document Details")

    lines = ocr_text.split("\n")
    current_table_header = None

    for line in lines:
        line_type, content, segments = parse_markdown_line(line)

        if line_type == "empty":
            pdf.ln(2)
            continue

        if line_type == "header":
            current_table_header = None
            _section(content)
            continue

        if line_type == "bullet":
            _ensure_space(8)
            pdf.set_x(left_margin + 3)
            pdf.set_font("Helvetica", "", 10)
            pdf.cell(5, 5, "-")
            for text, is_bold in segments:
                text = text.replace("**", "")
                pdf.set_font("Helvetica", "B" if is_bold else "", 10)
                pdf.write(5, _pdf_clean(text))
            pdf.ln(5)
            continue

        if line_type == "table_row":
            if current_table_header is None:
                current_table_header = content
                _markdown_table(content)
            else:
                col_count = max(len(current_table_header), len(content), 1)
                col_w = effective_width / col_count
                row_h = 7
                _ensure_space(row_h)
                pdf.set_font("Helvetica", "", 8)
                pdf.set_draw_color(225, 233, 240)
                for index in range(col_count):
                    value = content[index] if index < len(content) else ""
                    pdf.cell(col_w, row_h, _pdf_clean(value)[:28], border=1)
                pdf.ln(row_h)
            continue

        if line_type == "table_sep":
            continue

        if line_type == "text":
            current_table_header = None
            _ensure_space(8)
            for text, is_bold in segments:
                text = text.replace("**", "")
                pdf.set_font("Helvetica", "B" if is_bold else "", 10)
                pdf.write(5.3, _pdf_clean(text))
            pdf.ln(5.5)

    if "prescription" in (doc_type or "").lower():
        _section("Doctor Signature")
        pdf.ln(14)
        pdf.set_draw_color(120, 140, 160)
        pdf.line(132, pdf.get_y(), 190, pdf.get_y())
        pdf.set_xy(132, pdf.get_y() + 2)
        pdf.set_font("Helvetica", "", 8)
        pdf.cell(58, 5, _pdf_clean("Doctor Signature / Seal"), align="C")
    elif "discharge" in (doc_type or "").lower():
        _section("Doctor Certification")
        _paragraph("The above discharge summary has been prepared from available hospital records and clinical notes.")
        pdf.ln(10)
        pdf.set_draw_color(120, 140, 160)
        pdf.line(132, pdf.get_y(), 190, pdf.get_y())
        pdf.set_xy(132, pdf.get_y() + 2)
        pdf.set_font("Helvetica", "", 8)
        pdf.cell(58, 5, _pdf_clean("Consultant Signature / Seal"), align="C")

    out = pdf.output(dest="S")
    return bytes(out) if isinstance(out, bytearray) else (out if isinstance(out, bytes) else out.encode("latin-1"))


def generate_standard_report_pdf(payload: dict, hospital_id: int = None) -> bytes:
    import branding
    with branding.use_hospital(hospital_id):
        return _generate_standard_report_pdf(payload)


def _generate_standard_report_pdf(payload: dict) -> bytes:
    """Renders the frontend's StandardPdfPayload (title/subtitle/patient_info/
    sections-of-real-table-rows/totals/payment_details) into a real branded
    PDF. Used by every module's generic 'Download PDF' button (Dashboard,
    Billing, Lab, Patients, Patient Journey) -- previously this endpoint
    silently ignored the payload and always returned the reports-overview
    PDF instead, so every one of those buttons downloaded the wrong report."""

    def _clean(value) -> str:
        text = "" if value is None else str(value)
        text = text.replace("₹", "Rs.").replace("•", "-").replace("–", "-").replace("—", "-")
        return text.encode("latin-1", errors="replace").decode("latin-1")

    class ReportPDF(FPDF):
        def footer(self):
            draw_pdf_brand_footer(self)

    pdf = ReportPDF(format="A4")
    left_margin = 15
    right_margin = 15
    pdf.set_left_margin(left_margin)
    pdf.set_right_margin(right_margin)
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.alias_nb_pages()
    pdf.add_page()

    page_width = pdf.w
    effective_width = page_width - left_margin - right_margin

    def _ensure_space(height: float):
        if pdf.get_y() + height > 276:
            pdf.add_page()
            pdf.set_y(15)

    def _section(title: str):
        _ensure_space(15)
        pdf.ln(2)
        pdf.set_fill_color(231, 247, 250)
        pdf.set_draw_color(190, 222, 233)
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(11, 95, 118)
        pdf.cell(effective_width, 8, _clean(title), border=1, fill=True, ln=True)
        pdf.set_text_color(0, 0, 0)

    def _cell_label_value(label: str, value: str, x: float, y: float, w: float, h: float = 12):
        pdf.set_xy(x, y)
        pdf.set_fill_color(248, 252, 255)
        pdf.set_draw_color(210, 226, 236)
        pdf.rect(x, y, w, h, style="DF")
        pdf.set_xy(x + 2.5, y + 2)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(59, 89, 111)
        pdf.cell(w - 5, 3.5, _clean(label.upper()), ln=True)
        pdf.set_x(x + 2.5)
        pdf.set_font("Helvetica", "", 8.5)
        pdf.set_text_color(15, 23, 42)
        pdf.multi_cell(w - 5, 4, _clean(value or "-"))
        pdf.set_text_color(0, 0, 0)

    def _two_column_details(rows):
        y = pdf.get_y()
        col_w = (effective_width - 4) / 2
        for index, (label, value) in enumerate(rows):
            if index % 2 == 0:
                _ensure_space(14)
                y = pdf.get_y()
            x = left_margin + (col_w + 4) * (index % 2)
            _cell_label_value(label, value, x, y, col_w, 13)
            if index % 2 == 1:
                pdf.set_y(y + 15)
        if len(rows) % 2 == 1:
            pdf.set_y(y + 15)

    _NARROW_TABLE_HEADERS = {
        "time", "date", "charge", "received", "qty", "quantity", "status",
        "unit price", "amount", "rate", "discount",
    }

    def _table(headers, rows):
        col_count = max(len(headers), 1)
        narrow = [h.strip().lower() in _NARROW_TABLE_HEADERS for h in headers]
        narrow_w = min(24.0, effective_width / col_count)
        wide_count = max(sum(1 for n in narrow if not n), 1)
        remaining = effective_width - narrow_w * sum(1 for n in narrow if n)
        wide_w = remaining / wide_count
        col_widths = [narrow_w if n else wide_w for n in narrow]

        _ensure_space(8)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_fill_color(241, 248, 252)
        pdf.set_draw_color(215, 226, 236)
        for h, w in zip(headers, col_widths):
            pdf.cell(w, 7, _clean(h)[:30], border=1, fill=True)
        pdf.ln(7)
        pdf.set_font("Helvetica", "", 8)
        for row in rows:
            cell_texts = [_clean(row[i] if i < len(row) else "") for i in range(col_count)]
            line_counts = [max(1, int(pdf.get_string_width(text) / max(1, col_widths[i] - 2)) + 1 + text.count('\n')) for i, text in enumerate(cell_texts)]
            row_h = max(line_counts) * 4 + 2
            _ensure_space(row_h)
            y = pdf.get_y()
            x = pdf.get_x()
            for i, text in enumerate(cell_texts):
                pdf.set_xy(x, y)
                pdf.multi_cell(col_widths[i], 4, text, border=1)
                x += col_widths[i]
            pdf.set_xy(left_margin, y + row_h)

    draw_pdf_brand_header(pdf, left_margin, 8, title_width=92)
    pdf.set_xy(left_margin, 45)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(effective_width, 6, _clean(payload.get("title") or "Hospital Report"), ln=True)
    pdf.set_x(left_margin)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.cell(effective_width, 5, _clean(payload.get("subtitle") or ""), ln=True)
    generated = datetime.now().strftime("%d/%m/%Y %I:%M %p")
    pdf.set_x(left_margin)
    pdf.set_font("Helvetica", "", 7.8)
    pdf.cell(effective_width, 5, _clean(f"Generated: {generated}" + (f"  |  By: {payload.get('operator_name')}" if payload.get("operator_name") else "")), ln=True)
    pdf.set_y(max(pdf.get_y() + 2, 64))

    invoice_meta = payload.get("invoice_meta") or {}
    if invoice_meta.get("invoice_number") or invoice_meta.get("invoice_date"):
        _section("Invoice Details")
        _two_column_details([
            ("Invoice Number", invoice_meta.get("invoice_number") or "-"),
            ("Invoice Date", invoice_meta.get("invoice_date") or "-"),
        ])

    patient_info = payload.get("patient_info") or {}
    if patient_info:
        _section("Patient Information")
        rows = [
            ("Patient Name", patient_info.get("patient_name") or "-"),
            ("Patient ID", patient_info.get("patient_id") or "-"),
            ("Age / Gender", f"{patient_info.get('age') or '-'} / {patient_info.get('gender') or '-'}"),
            ("Mobile", patient_info.get("mobile") or "-"),
        ]
        if patient_info.get("consulting_doctor"):
            rows.append(("Consulting Doctor", patient_info.get("consulting_doctor")))
        if patient_info.get("address"):
            rows.append(("Address", patient_info.get("address")))
        _two_column_details(rows)

    for section in payload.get("sections") or []:
        _section(section.get("title") or "Details")
        headers = section.get("headers") or []
        rows = section.get("rows") or []
        if headers and rows:
            _table(headers, rows)
        elif not rows:
            _ensure_space(8)
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(100, 116, 139)
            pdf.cell(effective_width, 7, _clean("No data recorded for this section."), ln=True)
            pdf.set_text_color(0, 0, 0)

    totals = payload.get("totals") or {}
    if totals:
        _section("Summary")
        tile_labels = [
            ("Subtotal", totals.get("subtotal")),
            ("Grand Total", totals.get("grand_total")),
            ("Amount Received", totals.get("amount_received")),
            ("Balance", totals.get("balance")),
        ]
        tile_labels = [(label, value) for label, value in tile_labels if value not in (None, "")]
        if tile_labels:
            tile_w = effective_width / len(tile_labels)
            y = pdf.get_y()
            for label, value in tile_labels:
                x = pdf.get_x()
                pdf.set_fill_color(248, 250, 252)
                pdf.set_draw_color(226, 232, 240)
                pdf.rect(x, y, tile_w - 3, 18, style="DF")
                pdf.set_xy(x + 3, y + 3)
                pdf.set_font("Helvetica", "B", 7)
                pdf.set_text_color(100, 116, 139)
                pdf.cell(tile_w - 6, 4, _clean(str(label).upper()))
                pdf.set_xy(x + 3, y + 9)
                pdf.set_font("Helvetica", "B", 12)
                pdf.set_text_color(15, 23, 42)
                pdf.cell(tile_w - 6, 6, _clean(str(value)))
                pdf.set_xy(x + tile_w, y)
            pdf.set_y(y + 22)
            pdf.set_text_color(0, 0, 0)

    payment_details = payload.get("payment_details") or {}
    if payment_details:
        _section("Payment Details")
        _two_column_details([
            ("Receipt Number", payment_details.get("receipt_number") or "-"),
            ("Payment Date", payment_details.get("payment_date") or "-"),
            ("Payment Mode", payment_details.get("payment_mode") or "-"),
            ("Amount Paid", str(payment_details.get("amount_paid") or "-")),
        ])

    out = pdf.output(dest="S")
    return bytes(out) if isinstance(out, bytearray) else (out if isinstance(out, bytes) else out.encode("latin-1"))


def generate_word(patient_name: str, doc_type: str, ocr_text: str, date_str: str = None, hospital_id: int = None) -> bytes:
    """Generate Word document with OCR extracted text - properly formatted"""
    import branding
    with branding.use_hospital(hospital_id):
        return _generate_word(patient_name, doc_type, ocr_text, date_str)


def _generate_word(patient_name, doc_type, ocr_text, date_str=None) -> bytes:
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    doc = Document()

    b = _brand()
    align_map = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}
    logo_done = False
    if b and b.get("logo_file") and (b.get("logo_mime") == "image/png"):  # python-docx cannot embed SVG
        try:
            import branding
            from docx.shared import Mm
            w, _h = branding.fit_mm(b.get("logo_width_px"), b.get("logo_height_px"), *branding.LOGO_BOX_MM, bool(b.get("auto_fit_scaling")))
            logo_par = doc.add_paragraph()
            logo_par.alignment = align_map.get(b.get("logo_alignment") or "left", WD_ALIGN_PARAGRAPH.LEFT)
            logo_par.add_run().add_picture(b["logo_file"], width=Mm(w))
            logo_done = True
        except Exception:
            logo_done = False

    brand = doc.add_paragraph()
    brand.alignment = align_map.get((b or {}).get("logo_alignment") or "center", WD_ALIGN_PARAGRAPH.CENTER) if logo_done else WD_ALIGN_PARAGRAPH.CENTER
    brand_run = brand.add_run(brand_title())
    brand_run.bold = True
    brand_run.font.size = Pt(24)
    brand_run.font.color.rgb = RGBColor(20, 61, 94)

    if not (b and b.get("hospital_title")):
        subtitle = doc.add_paragraph()
        subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub_run = subtitle.add_run(BRAND_TAGLINE)
        sub_run.font.size = Pt(10)
        sub_run.font.color.rgb = RGBColor(100, 100, 100)

    title = doc.add_heading("Medical Document Report", 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    doc.add_paragraph()

    table = doc.add_table(rows=3, cols=2)
    table.style = "Table Grid"

    cells = table.rows[0].cells
    cells[0].text = "Patient Name"
    cells[1].text = patient_name

    cells = table.rows[1].cells
    cells[0].text = "Document Type"
    cells[1].text = doc_type.replace("_", " ").title()

    cells = table.rows[2].cells
    cells[0].text = "Date"
    cells[1].text = date_str

    for row in table.rows:
        row.cells[0].paragraphs[0].runs[0].bold = True

    doc.add_paragraph()

    lines = ocr_text.split("\n")

    for line in lines:
        line_type, content, segments = parse_markdown_line(line)

        if line_type == "empty":
            doc.add_paragraph()
            continue

        if line_type == "header":
            doc.add_heading(content, level=2)
            continue

        if line_type == "bullet":
            para = doc.add_paragraph(style="List Bullet")
            for text, is_bold in segments:
                text = text.replace("**", "")
                run = para.add_run(text)
                run.bold = is_bold
            continue

        if line_type == "table_row":
            para = doc.add_paragraph()
            para.add_run("    ".join(content))
            continue

        if line_type == "table_sep":
            continue

        if line_type == "text":
            para = doc.add_paragraph()
            for text, is_bold in segments:
                text = text.replace("**", "")
                run = para.add_run(text)
                run.bold = is_bold

    if b and b.get("footer_text"):
        footer_par = doc.sections[0].footer.paragraphs[0]
        footer_par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        footer_par.add_run(_latin(b["footer_text"])).font.size = Pt(8)

    buffer = io.BytesIO()
    doc.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()
