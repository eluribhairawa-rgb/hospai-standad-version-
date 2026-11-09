"""Shared plumbing for "one upload button" imports (GRN invoices, lab results).

Routes an upload by type and provides the format-level helpers; what the columns or
OCR fields *mean* stays in the caller (grn_import.py, lab_result_import.py):

- CSV   -> decoded and split into rows with the header row found dynamically (no OCR).
- PDF   -> text layer if it has one; scanned PDFs yield their page images for OCR.
- Image -> passed to the caller's OCR function.
"""
import csv
import io
import os
import re
import time

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - dependency guard
    PdfReader = None


MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# A PDF with less text than this is treated as a scan (text layer missing or just a stamp/footer).
MIN_PDF_TEXT_CHARS = 120
# Each OCR call can take up to a minute and nginx gives up at 120s, so a scanned PDF
# reads at most this many pages, and starts another page only within the time budget.
MAX_PDF_SCAN_PAGES = 3
PDF_SCAN_BUDGET_SECONDS = 30
HEADER_SCAN_ROWS = 15

CSV_EXTENSIONS = {".csv"}
PDF_EXTENSIONS = {".pdf"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".heic", ".heif"}


class FileImportError(Exception):
    """A user-facing import failure with the HTTP status the API should return."""

    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ---------------------------------------------------------------------------
# Upload checks and type detection
# ---------------------------------------------------------------------------

def check_upload(content, max_bytes=MAX_UPLOAD_BYTES):
    if not content:
        raise FileImportError(400, "The uploaded file is empty.")
    if len(content) > max_bytes:
        raise FileImportError(413, f"The file is larger than {max_bytes // (1024 * 1024)} MB.")


def detect_file_type(filename, content):
    ext = os.path.splitext((filename or "").strip())[1].lower()
    if ext in CSV_EXTENSIONS:
        return "csv"
    if ext in PDF_EXTENSIONS:
        return "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    # No / unknown extension (e.g. camera uploads): fall back to magic bytes.
    head = content[:12]
    if head.startswith(b"%PDF-"):
        return "pdf"
    if (head.startswith((b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"BM", b"II*\x00", b"MM\x00*"))
            or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")):
        return "image"
    raise FileImportError(
        415, f'Unsupported file type "{ext or filename or "unknown"}". Upload a CSV, a PDF or an image (JPG, PNG, WEBP, TIFF...).'
    )


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def decode_text(content):
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("latin-1")


def unique_headers(raw):
    """Blank headers become column_N; repeats get " (2)", " (3)" so every column keeps its own key."""
    headers, seen = [], {}
    for i, h in enumerate(raw, start=1):
        name = str(h or "").strip() or f"column_{i}"
        if name in seen:
            seen[name] += 1
            name = f"{name} ({seen[name]})"
        else:
            seen[name] = 1
        headers.append(name)
    return headers


def find_header_row(rows, is_header):
    """Exports often put a title/address block above the table. Take the first row (within
    the first HEADER_SCAN_ROWS) that is_header() accepts, else the first non-empty row."""
    first_non_empty = None
    for i, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        if not any(c.strip() for c in row):
            continue
        if first_non_empty is None:
            first_non_empty = i
        if is_header(row):
            return i
    return first_non_empty


def read_csv_rows(text, is_header, score_header):
    """Parse with each candidate delimiter and keep the one whose header row scores best.
    csv.Sniffer alone is unreliable when an address block sits above the table.
    Returns (rows, header_index)."""
    try:
        sniffed = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
    except csv.Error:
        sniffed = ","
    best, best_score, last_error = None, -1, None
    for delimiter in dict.fromkeys([sniffed, ",", ";", "\t", "|"]):
        try:
            rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
        except csv.Error as exc:
            last_error = exc
            continue
        idx = find_header_row(rows, is_header)
        if idx is None:
            continue
        score = score_header(rows[idx])
        if score > best_score:
            best, best_score = (rows, idx), score
    if best is None:
        if last_error:
            raise FileImportError(400, f"The CSV file could not be read: {last_error}")
        raise FileImportError(400, "The CSV file has no header row.")
    return best


def rows_as_dicts(all_rows, header_idx, headers, max_rows, skip_row=None):
    """Data rows under the header as {header: value}. Returns (rows, ragged_count, truncated)."""
    rows, ragged, truncated = [], 0, False
    for raw in all_rows[header_idx + 1:]:
        if not any(c.strip() for c in raw):
            continue
        if len(raw) != len(headers):
            ragged += 1
            raw = (raw + [""] * len(headers))[:len(headers)]
        row = {h: c.strip() for h, c in zip(headers, raw)}
        if skip_row and skip_row(raw, row):
            continue
        rows.append(row)
        if len(rows) >= max_rows:
            truncated = True
            break
    return rows, ragged, truncated


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

def open_pdf(content):
    if PdfReader is None:
        raise FileImportError(503, "PDF support is not installed on the server (missing pypdf). Upload an image or CSV instead.")
    if not content.lstrip()[:5] == b"%PDF-":
        raise FileImportError(400, "The file has a .pdf extension but is not a valid PDF.")
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(""):
            raise FileImportError(400, "The PDF is password-protected. Remove the password and upload it again.")
        pages = list(reader.pages)
    except FileImportError:
        raise
    except Exception as exc:
        raise FileImportError(400, f"The PDF could not be read: {exc}") from exc
    if not pages:
        raise FileImportError(400, "The PDF has no pages.")
    return pages


def pdf_text(pages):
    texts = []
    for page in pages:
        try:
            texts.append((page.extract_text() or "").strip())
        except Exception:
            texts.append("")
    return "\n\n".join(t for t in texts if t)


def has_text_layer(text):
    return len(re.sub(r"\s", "", text or "")) >= MIN_PDF_TEXT_CHARS


def page_image_bytes(page):
    """The largest embedded image on a scanned PDF page, as PNG bytes."""
    try:
        images = list(page.images)
    except Exception:
        return None
    best = None
    for img in images:
        try:
            pil = img.image
        except Exception:
            continue
        if pil is None:
            continue
        if best is None or pil.width * pil.height > best.width * best.height:
            best = pil
    if best is None or best.width * best.height < 200 * 200:  # logos / signatures, not a page scan
        return None
    buf = io.BytesIO()
    (best if best.mode in ("RGB", "L") else best.convert("RGB")).save(buf, format="PNG")
    return buf.getvalue()


def ocr_scanned_pages(pages, ocr_page, what="document"):
    """OCR each page's scan image within the time budget. Returns (parts, warnings)."""
    started, parts, read_pages = time.monotonic(), [], 0
    for index, page in enumerate(pages[:MAX_PDF_SCAN_PAGES]):
        if index and time.monotonic() - started > PDF_SCAN_BUDGET_SECONDS:
            break
        image = page_image_bytes(page)
        if image is None:
            continue
        parts.append(ocr_page(image))
        read_pages = index + 1
    if not parts:
        raise FileImportError(422, "The PDF has no text layer and no scanned page image could be found in it. "
                                   f"Upload a photo or image of the {what} instead.")
    warnings = []
    if read_pages < len(pages):
        warnings.append(f"Scanned PDF: only the first {read_pages} of {len(pages)} pages were read. "
                        "Upload the remaining pages as separate files.")
    return parts, warnings


def call_ocr(fn, *args, **kwargs):
    """Model errors -> HTTP-ready import errors (bad input 400, model unreachable 502)."""
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise FileImportError(400, str(exc)) from exc
    except RuntimeError as exc:
        raise FileImportError(502, str(exc)) from exc
