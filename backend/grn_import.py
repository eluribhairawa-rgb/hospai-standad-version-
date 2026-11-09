"""Unified goods-receipt (GRN) import: one upload, routed by file type.

- CSV  -> parsed directly (no OCR). Column headers are detected from the file and
          mapped onto GRN fields by name, so each supplier's own export layout works.
- PDF  -> digital PDFs: the text layer is structured by the LLM.
          Scanned PDFs: the page images go through the vision OCR model.
- Image -> vision OCR model (Qwen3-VL), as before.

Every branch returns the same `fields` shape (see qwen_ocr._clean_invoice) so the
GRN form fills itself the same way whatever was uploaded.
"""
import calendar
import re

import qwen_ocr
import file_import as fi
# Re-exported for callers/tests that used these names from this module.
from file_import import (  # noqa: F401
    CSV_EXTENSIONS, IMAGE_EXTENSIONS, MAX_UPLOAD_BYTES, PDF_EXTENSIONS, PdfReader, detect_file_type,
    FileImportError as GrnImportError,
)

MAX_CSV_ROWS = 2000
PREVIEW_ROWS = 20

INVOICE_HEADER_KEYS = ("supplier_name", "supplier_gstin", "invoice_no", "invoice_date")


# ---------------------------------------------------------------------------
# CSV branch: dynamic header detection
# ---------------------------------------------------------------------------

# Normalised header text -> GRN field. "_cgst"/"_sgst" are summed into gst_rate.
_HEADER_ALIASES = {
    "medicine_name": ["item", "item name", "items", "product", "product name", "product description", "medicine",
                      "medicine name", "drug", "drug name", "description", "item description", "particulars",
                      "name", "brand", "brand name", "sku name"],
    # Bare "Mfg" on Indian pharma bills is usually the company column; "Mfg Date" is matched separately.
    "manufacturer": ["manufacturer", "mfr", "mfg", "mfr name", "mfg name", "manufactured by", "company", "company name",
                     "make", "marketed by", "mkt by"],
    "hsn_code": ["hsn", "hsn code", "hsn sac", "hsn sac code", "sac", "hsn no"],
    "pack_size": ["pack", "pack size", "packing", "pkg", "pack qty", "packsize", "pack type"],
    "unit_type": ["unit", "unit type", "uom", "form", "dosage form", "units"],
    "batch_no": ["batch", "batch no", "batch number", "batch num", "lot", "lot no", "lot number", "b no", "bno"],
    "mfg_date": ["mfg date", "mfg dt", "mfd", "mfd date", "manufacturing date", "date of manufacture",
                 "manufacture date"],
    "expiry_date": ["exp", "expiry", "expiry date", "exp date", "exp dt", "expiry dt", "best before", "use before",
                    "use by", "date of expiry"],
    "quantity": ["qty", "quantity", "billed qty", "bill qty", "received qty", "recd qty", "rec qty", "qty received",
                 "purchase qty", "no of units", "units received", "total qty"],
    "free_qty": ["free", "free qty", "free quantity", "bonus", "bonus qty", "sch qty", "scheme qty", "scheme", "fqty"],
    "unit_cost": ["rate", "unit cost", "unit rate", "purchase rate", "pur rate", "ptr", "cost", "cost price",
                  "unit price", "price", "net rate", "rate per unit", "landing cost"],
    "mrp": ["mrp", "m r p", "max retail price", "mrp per unit"],
    "discount_pct": ["disc", "discount", "disc pct", "discount pct", "discount percent", "disc percent", "cd",
                     "trade discount", "td"],
    "gst_rate": ["gst", "gst rate", "gst pct", "gst percent", "tax", "tax rate", "tax pct", "igst", "igst rate",
                 "igst pct", "gst slab"],
    "_cgst": ["cgst", "cgst rate", "cgst pct"],
    "_sgst": ["sgst", "sgst rate", "sgst pct", "utgst"],
    "supplier_name": ["supplier", "supplier name", "vendor", "vendor name", "distributor", "distributor name",
                      "party", "party name", "seller"],
    "supplier_gstin": ["gstin", "supplier gstin", "vendor gstin", "gst no", "gst number", "gstin no", "gst in"],
    "invoice_no": ["invoice", "invoice no", "invoice number", "inv no", "bill no", "bill number", "invoice num",
                   "voucher no", "challan no"],
    "invoice_date": ["invoice date", "inv date", "bill date", "invoice dt", "voucher date", "date"],
}


def normalize_header(text):
    text = str(text or "").replace("﻿", "").lower()
    text = text.replace("%", " pct ").replace("#", " no ").replace("/", " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\b(number|num)\b", "no", text)
    return re.sub(r"\s+", " ", text).strip()


_ALIAS_LOOKUP = {normalize_header(alias): field for field, aliases in _HEADER_ALIASES.items() for alias in aliases}

# Loose fallbacks for headers no alias matched exactly, e.g. "Batch No./Lot" or "Exp (MM/YY)".
# Checked in order; the first rule whose tokens all appear in the header wins.
_KEYWORD_RULES = [
    ({"batch"}, "batch_no"), ({"lot"}, "batch_no"),
    ({"exp"}, "expiry_date"), ({"expiry"}, "expiry_date"),
    ({"mfg", "date"}, "mfg_date"), ({"mfd"}, "mfg_date"),
    ({"hsn"}, "hsn_code"), ({"mrp"}, "mrp"), ({"cgst"}, "_cgst"), ({"sgst"}, "_sgst"),
    ({"gstin"}, "supplier_gstin"), ({"free"}, "free_qty"), ({"qty"}, "quantity"),
    ({"disc"}, "discount_pct"), ({"gst"}, "gst_rate"), ({"rate"}, "unit_cost"),
    ({"pack"}, "pack_size"), ({"invoice", "date"}, "invoice_date"), ({"invoice"}, "invoice_no"),
    ({"supplier"}, "supplier_name"), ({"vendor"}, "supplier_name"),
    ({"product"}, "medicine_name"), ({"medicine"}, "medicine_name"), ({"item"}, "medicine_name"),
    ({"drug"}, "medicine_name"), ({"manufacturer"}, "manufacturer"),
]


_AMOUNT_TOKENS = {"amt", "amount", "value", "total", "taxable", "net"}


def match_header(header):
    norm = normalize_header(header)
    if not norm:
        return None
    if norm in _ALIAS_LOOKUP:
        return _ALIAS_LOOKUP[norm]
    tokens = set(norm.split())
    # "GST Amt", "Taxable Value", "Total" are money columns, not rates/quantities.
    if tokens & _AMOUNT_TOKENS:
        return None
    for needed, field in _KEYWORD_RULES:
        if needed <= tokens:
            return field
    return None


def map_headers(headers):
    """{header: grn_field or None}. Each GRN field is taken by the first header that claims it."""
    mapping, taken = {}, set()
    for header in headers:
        field = match_header(header)
        if field and field not in taken:
            mapping[header] = field
            taken.add(field)
        else:
            mapping[header] = None
    return mapping


def _is_item_header(row):
    """The item table's heading: names the medicine column plus at least one other GRN field."""
    fields = {match_header(c) for c in row if c.strip()}
    return "medicine_name" in fields and len(fields - {None}) >= 2


def _score_header(row):
    fields = {match_header(c) for c in row} - {None}
    return len(fields) + (100 if "medicine_name" in fields else 0)


_MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}


def _year(text):
    y = int(text)
    return y + 2000 if y < 100 else y


def _month_date(year, month, end_of_month):
    if not 1 <= month <= 12:
        return ""
    day = calendar.monthrange(year, month)[1] if end_of_month else 1
    return f"{year:04d}-{month:02d}-{day:02d}"


def parse_flexible_date(value, end_of_month=False):
    """Dates as suppliers print them: 2027-08-31, 31/08/2027, 31-Aug-2027, 08/27, 08/2027, AUG-27, Aug 2027.
    Month-year only becomes the last day (expiry) or first day (manufacture) of that month."""
    text = str(value or "").strip()
    if not text:
        return ""
    iso = qwen_ocr._iso_date(text)
    if iso:
        return iso
    m = re.fullmatch(r"(\d{1,2})[/.\-\s]([A-Za-z]{3})[A-Za-z]*[/.\-\s](\d{2,4})", text)
    if m and m.group(2).lower() in _MONTHS:
        year, month, day = _year(m.group(3)), _MONTHS[m.group(2).lower()], int(m.group(1))
        if 1 <= day <= calendar.monthrange(year, month)[1]:
            return f"{year:04d}-{month:02d}-{day:02d}"
        return ""
    m = re.fullmatch(r"(\d{1,2})[/.\-](\d{2}|\d{4})", text)
    if m:
        return _month_date(_year(m.group(2)), int(m.group(1)), end_of_month)
    m = re.fullmatch(r"([A-Za-z]{3})[A-Za-z]*[/.\-\s']*(\d{2}|\d{4})", text)
    if m and m.group(1).lower() in _MONTHS:
        return _month_date(_year(m.group(2)), _MONTHS[m.group(1).lower()], end_of_month)
    return ""


def _sum_pct(a, b):
    try:
        total = float(qwen_ocr._number(a) or 0) + float(qwen_ocr._number(b) or 0)
    except ValueError:
        return ""
    return qwen_ocr._number(f"{total:.2f}") if total else ""


def rows_to_invoice(rows, mapping):
    """Map parsed CSV rows onto the GRN invoice shape, then reuse the OCR cleaner so
    numbers/dates/HSN are normalised exactly as for scanned invoices."""
    by_field = {field: header for header, field in mapping.items() if field}
    header_values = {k: "" for k in INVOICE_HEADER_KEYS}
    items = []
    for row in rows:
        get = lambda f: (row.get(by_field[f]) or "").strip() if f in by_field else ""  # noqa: E731
        for k in INVOICE_HEADER_KEYS:
            if not header_values[k] and get(k):
                header_values[k] = get(k)
        item = {k: get(k) for k in qwen_ocr.INVOICE_ITEM_KEYS}
        if not item["gst_rate"] and (get("_cgst") or get("_sgst")):
            item["gst_rate"] = _sum_pct(get("_cgst"), get("_sgst"))
        item["expiry_date"] = parse_flexible_date(item["expiry_date"], end_of_month=True)
        item["mfg_date"] = parse_flexible_date(item["mfg_date"], end_of_month=False)
        items.append(item)
    header_values["invoice_date"] = parse_flexible_date(header_values["invoice_date"])
    return qwen_ocr._clean_invoice({**header_values, "items": items})


_TOTAL_ROW = re.compile(r"^\s*(grand\s+)?(sub\s*)?total\b|^\s*net\s+amount\b", re.IGNORECASE)


def parse_csv(content):
    text = fi.decode_text(content)
    if not text.strip():
        raise GrnImportError(400, "The CSV file is empty.")
    all_rows, header_idx = fi.read_csv_rows(text, _is_item_header, _score_header)
    headers = fi.unique_headers(all_rows[header_idx])
    mapping = map_headers(headers)
    warnings = []

    batch_headers = [h for h, f in mapping.items() if f == "batch_no"]
    # Skip invoice footer lines ("Total", "Grand Total", "Net Amount") that have no batch.
    rows, ragged, truncated = fi.rows_as_dicts(
        all_rows, header_idx, headers, MAX_CSV_ROWS,
        skip_row=lambda raw, row: any(_TOTAL_ROW.match(c) for c in raw[:3]) and not any(row.get(h) for h in batch_headers),
    )
    if truncated:
        warnings.append(f"Only the first {MAX_CSV_ROWS} rows were imported.")

    if not rows:
        raise GrnImportError(400, "The CSV file has a header row but no data rows.")
    if header_idx:
        warnings.append(f"Skipped {header_idx} line(s) above the column headings.")
    if ragged:
        warnings.append(f"{ragged} row(s) had a different number of columns than the header and were padded/trimmed.")

    fields = rows_to_invoice(rows, mapping)
    if "medicine_name" not in mapping.values():
        warnings.append(
            "No medicine/item name column was recognised, so no GRN lines were filled. "
            f"Columns found: {', '.join(headers)}. Rename the item column to e.g. \"Item Name\" or \"Product\"."
        )
    else:
        dropped = len(rows) - len(fields["items"])
        if dropped:
            warnings.append(f"{dropped} row(s) without a medicine name were skipped.")
    missing = [f for f in ("batch_no", "expiry_date", "quantity") if f not in mapping.values()]
    if missing and fields["items"]:
        warnings.append("Columns not found (fill these in manually): " + ", ".join(missing).replace("_", " ") + ".")

    return {
        "processing": "csv_direct",
        "detected_fields": headers,
        "field_mapping": {h: (f if f and not f.startswith("_") else ("gst_rate" if f else None)) for h, f in mapping.items()},
        "row_count": len(rows),
        "preview": rows[:PREVIEW_ROWS],
        "fields": fields,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# OCR branches: images and PDFs
# ---------------------------------------------------------------------------

def _merge_invoices(parts):
    merged = {k: "" for k in INVOICE_HEADER_KEYS}
    merged["items"] = []
    for part in parts:
        for k in INVOICE_HEADER_KEYS:
            merged[k] = merged[k] or part.get(k, "")
        merged["items"].extend(part.get("items") or [])
    return merged


def parse_image(content):
    return {"processing": "ocr_image", "fields": fi.call_ocr(qwen_ocr.extract_supplier_invoice_fields, content), "warnings": []}


def parse_pdf(content):
    pages = fi.open_pdf(content)
    text = fi.pdf_text(pages)
    if fi.has_text_layer(text):
        warnings = []
        if len(text) > qwen_ocr.MAX_INVOICE_TEXT_CHARS:
            warnings.append("The PDF is long; only the first part was read. Check that every line was captured.")
        fields = fi.call_ocr(qwen_ocr.extract_supplier_invoice_from_text, text)
        return {"processing": "pdf_text", "page_count": len(pages), "fields": fields, "warnings": warnings}
    parts, warnings = fi.ocr_scanned_pages(
        pages, lambda image: fi.call_ocr(qwen_ocr.extract_supplier_invoice_fields, image), what="invoice")
    return {"processing": "pdf_scan_ocr", "page_count": len(pages), "fields": _merge_invoices(parts), "warnings": warnings}


def _ocr_summary(result):
    """Detected fields / preview for OCR results, mirroring what the CSV branch reports."""
    fields = result["fields"]
    detected = [k for k in INVOICE_HEADER_KEYS if fields.get(k)]
    detected += [k for k in qwen_ocr.INVOICE_ITEM_KEYS if any(it.get(k) for it in fields["items"])]
    result.setdefault("detected_fields", detected)
    result.setdefault("row_count", len(fields["items"]))
    result.setdefault("preview", fields["items"][:PREVIEW_ROWS])
    if not fields["items"] and not any(fields.get(k) for k in INVOICE_HEADER_KEYS):
        raise GrnImportError(422, "No invoice details could be read from this file. Try a clearer, well-lit, uncropped image.")
    if not fields["items"]:
        result["warnings"].append("Invoice header was read but no medicine lines were found.")
    return result


def import_goods_receipt_file(filename, content):
    """Entry point: route by file type and return a JSON-ready result."""
    fi.check_upload(content)
    file_type = detect_file_type(filename, content)
    if file_type == "csv":
        result = parse_csv(content)
    elif file_type == "pdf":
        result = _ocr_summary(parse_pdf(content))
    else:
        result = _ocr_summary(parse_image(content))
    return {"file_type": file_type, "file_name": filename or "", **result}
