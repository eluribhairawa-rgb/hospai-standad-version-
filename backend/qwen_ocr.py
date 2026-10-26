"""Structured OCR through the Qwen3-VL model served by vLLM (OpenAI-compatible API)."""
import base64
import io
import json
import os
import re
import urllib.error
import urllib.request

try:
    from PIL import Image, ImageOps
except Exception:  # pragma: no cover - dependency guard
    Image = None
    ImageOps = None


QWEN_OCR_URL = (os.getenv("QWEN_OCR_URL") or "http://host.docker.internal:8700/v1").rstrip("/")
QWEN_OCR_MODEL = os.getenv("QWEN_OCR_MODEL") or "qwen3-vl-8b"
# Must stay below nginx's proxy_read_timeout (120s).
QWEN_OCR_TIMEOUT = float(os.getenv("QWEN_OCR_TIMEOUT") or 110)
# Long edge in pixels; larger images are downscaled before being sent to the model.
MAX_IMAGE_SIDE = 2048


def _image_to_data_url(file_bytes):
    """Normalise any Pillow-readable image (JPG, PNG, WEBP, TIFF, BMP, GIF, ...) to a PNG data URL."""
    if Image is None:
        raise RuntimeError("Image support requires Pillow.")
    try:
        img = Image.open(io.BytesIO(file_bytes))
        img.seek(0)  # first frame of animated GIF / multi-page TIFF
        img = ImageOps.exif_transpose(img)
    except Exception as exc:
        raise ValueError("Could not read the image. Upload a JPG, PNG, WEBP, TIFF, BMP or GIF file.") from exc
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _chat(prompt, image_data_url=None, max_tokens=2048, temperature=0):
    content = [{"type": "text", "text": prompt}]
    if image_data_url:
        content.insert(0, {"type": "image_url", "image_url": {"url": image_data_url}})
    body = json.dumps({
        "model": QWEN_OCR_MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{QWEN_OCR_URL}/chat/completions", data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=QWEN_OCR_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"OCR model returned HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Could not reach the OCR model at {QWEN_OCR_URL}: {exc}") from exc
    return ((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()


def _parse_json_object(raw_text):
    text = (raw_text or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


PRESCRIPTION_PROMPT = """You are reading a doctor's prescription / OP consultation sheet (printed or handwritten).

Read all the text and return ONLY a JSON object with exactly these keys:
{
  "patient_name": "",
  "patient_age": "",
  "patient_gender": "",
  "symptoms": "",
  "diagnosis": "",
  "vitals": {"bp": "", "pulse": "", "temperature": "", "weight": "", "spo2": ""},
  "labs": {"fbs": "", "ppbs": "", "hba1c": "", "total_cholesterol": "", "ldl": "", "tgl": "", "vitamin_d": ""},
  "medicines": [
    {"medicine_name": "", "dosage": "", "frequency": "", "duration": "", "instructions": ""}
  ],
  "lab_tests": "",
  "advice": "",
  "follow_up_date": ""
}

Rules:
- Use "" (or [] for medicines) for anything not clearly present. Never invent values.
- symptoms: chief complaints (C/O) as one comma-separated line.
- diagnosis: provisional / final diagnosis (Dx, Imp).
- vitals: numbers only, e.g. bp "120/80", pulse "72", temperature "98.6", weight "68", spo2 "98".
- labs: result values only as numbers, for the listed tests only.
- medicines: one entry per drug. medicine_name includes form and strength as written (e.g. "Tab Paracetamol 650mg").
  dosage is the per-dose amount (e.g. "650 mg", "1 tab", "10 ml").
  frequency as morning-afternoon-night like "1-0-1"; convert OD="1-0-0", BD="1-0-1", TDS="1-1-1", HS="0-0-1", QID="1-1-1-1"; keep "SOS"/"Stat" as is.
  duration like "5 Days". instructions like "After Food".
- lab_tests: investigations advised, comma separated.
- advice: diet / lifestyle / other instructions.
- follow_up_date: YYYY-MM-DD only if an actual date is written, else "".
- patient_gender: exactly "Male", "Female" or "Other", or "".
- No code fences, no commentary, only the JSON object."""

_VITAL_KEYS = ("bp", "pulse", "temperature", "weight", "spo2")
_LAB_KEYS = ("fbs", "ppbs", "hba1c", "total_cholesterol", "ldl", "tgl", "vitamin_d")
_MED_KEYS = ("medicine_name", "dosage", "frequency", "duration", "instructions")


def _s(value):
    return str(value if value is not None else "").strip()


def _clean_prescription(raw):
    vitals = raw.get("vitals") if isinstance(raw.get("vitals"), dict) else {}
    labs = raw.get("labs") if isinstance(raw.get("labs"), dict) else {}
    meds = raw.get("medicines") if isinstance(raw.get("medicines"), list) else []
    gender = _s(raw.get("patient_gender")).lower()
    follow_up = _s(raw.get("follow_up_date"))
    return {
        "patient_name": _s(raw.get("patient_name")),
        "patient_age": re.sub(r"\D", "", _s(raw.get("patient_age")))[:3],
        "patient_gender": {"m": "Male", "male": "Male", "f": "Female", "female": "Female", "other": "Other"}.get(gender, ""),
        "symptoms": _s(raw.get("symptoms")),
        "diagnosis": _s(raw.get("diagnosis")),
        "vitals": {k: _s(vitals.get(k)) for k in _VITAL_KEYS},
        "labs": {k: _s(labs.get(k)) for k in _LAB_KEYS},
        "medicines": [
            {k: _s(m.get(k)) for k in _MED_KEYS}
            for m in meds
            if isinstance(m, dict) and _s(m.get("medicine_name"))
        ],
        "lab_tests": _s(raw.get("lab_tests")),
        "advice": _s(raw.get("advice")),
        "follow_up_date": follow_up if re.fullmatch(r"\d{4}-\d{2}-\d{2}", follow_up) else "",
    }


def extract_prescription_fields(file_bytes):
    """OCR a prescription image and return the consultation fields it contains."""
    result = _chat(PRESCRIPTION_PROMPT, _image_to_data_url(file_bytes), max_tokens=3072)
    parsed = _parse_json_object(result)
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable fields. Try a clearer image.")
    return _clean_prescription(parsed)


SUPPLIER_INVOICE_PROMPT = """You are reading a pharmaceutical supplier / distributor invoice (tax invoice, bill or delivery challan) for medicines received by a hospital pharmacy.

Read every line item in the table and return ONLY a JSON object with exactly these keys:
{
  "supplier_name": "",
  "supplier_gstin": "",
  "invoice_no": "",
  "invoice_date": "",
  "items": [
    {
      "medicine_name": "",
      "manufacturer": "",
      "hsn_code": "",
      "pack_size": "",
      "unit_type": "",
      "batch_no": "",
      "mfg_date": "",
      "expiry_date": "",
      "quantity": "",
      "free_qty": "",
      "unit_cost": "",
      "mrp": "",
      "discount_pct": "",
      "gst_rate": ""
    }
  ]
}

Rules:
- Use "" for anything not clearly present. Never guess or invent values.
- supplier_name is the seller (who issued the invoice), not the buyer / hospital.
- invoice_date, mfg_date, expiry_date: format YYYY-MM-DD. If only month and year are printed (e.g. "08/27" or "AUG-2027"), use the LAST day of that month for expiry_date and the FIRST day for mfg_date.
- medicine_name: product name with strength as printed (e.g. "Dolo 650 Tablet").
- pack_size: as printed, e.g. "10x10", "1x15", "100ml".
- unit_type: one of Tablet, Capsule, Syrup / Bottle, Injection / Vial, Syringe, Ampoule, Drops, Ointment / Tube, Inhaler, Strip, Box, IV Fluid Bottle, Other.
- quantity / free_qty: billed and free quantities, digits only.
- unit_cost: purchase rate per unit before tax (the "Rate" column), number only. mrp: number only.
- discount_pct and gst_rate: percentage numbers only (e.g. "12"). If CGST and SGST are listed separately, gst_rate is their sum.
- No code fences, no commentary, only the JSON object."""

INVOICE_ITEM_KEYS = (
    "medicine_name", "manufacturer", "hsn_code", "pack_size", "unit_type", "batch_no", "mfg_date", "expiry_date",
    "quantity", "free_qty", "unit_cost", "mrp", "discount_pct", "gst_rate",
)


def _number(value, integer=False):
    text = re.sub(r"[^0-9.]", "", str(value or ""))
    if not text or text.count(".") > 1:
        return ""
    if integer:
        return str(int(float(text)))
    return text.rstrip("0").rstrip(".") if "." in text else text


def _iso_date(value):
    text = _s(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    m = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})", text)
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else ""


def _clean_invoice(raw):
    items = []
    for it in raw.get("items") if isinstance(raw.get("items"), list) else []:
        if not isinstance(it, dict) or not _s(it.get("medicine_name")):
            continue
        row = {k: _s(it.get(k)) for k in INVOICE_ITEM_KEYS}
        # HSN codes are 4-8 digits; drop anything the model ran in from the neighbouring column.
        row["hsn_code"] = re.sub(r"\D", "", row["hsn_code"])[:8]
        row["quantity"] = _number(row["quantity"], integer=True)
        row["free_qty"] = _number(row["free_qty"], integer=True)
        for k in ("unit_cost", "mrp", "discount_pct", "gst_rate"):
            row[k] = _number(row[k])
        row["mfg_date"] = _iso_date(row["mfg_date"])
        row["expiry_date"] = _iso_date(row["expiry_date"])
        items.append(row)
    return {
        "supplier_name": _s(raw.get("supplier_name")),
        "supplier_gstin": re.sub(r"\s", "", _s(raw.get("supplier_gstin"))).upper(),
        "invoice_no": _s(raw.get("invoice_no")),
        "invoice_date": _iso_date(raw.get("invoice_date")),
        "items": items,
    }


def extract_supplier_invoice_fields(file_bytes):
    """OCR a supplier medicine invoice image and return GRN header fields and line items."""
    result = _chat(SUPPLIER_INVOICE_PROMPT, _image_to_data_url(file_bytes), max_tokens=6144)
    parsed = _parse_json_object(result)
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable invoice data. Try a clearer image.")
    return _clean_invoice(parsed)


LAB_RESULTS_PROMPT = """You are reading a laboratory result printout (analyzer print, lab report or handwritten result sheet).

The test being reported is: {service_name}
These are the ONLY parameters to fill, with their id, expected unit and type:
{parameters}

Return ONLY a JSON object with exactly these keys:
{{
  "results": [{{"parameter_id": 0, "value": ""}}],
  "equipment": "",
  "patient_name": "",
  "sample_id": ""
}}

Rules:
- One entry per parameter that has a result printed in the image. Skip parameters that are not present. Never invent values.
- Match parameters by meaning, including common abbreviations (e.g. Hb = Haemoglobin, TLC/WBC = Total Leucocyte Count, PLT = Platelet Count, SGPT = ALT, SGOT = AST, FBS = Fasting Blood Sugar).
- numeric parameters: the number only, no units, flags or symbols (e.g. "13.4", not "13.4 g/dL H"). If the printed unit differs from the expected unit, still copy the printed number as is.
- text / qualitative parameters: the result word or phrase as printed (e.g. "Positive", "Non-reactive", "Pale yellow").
- equipment: analyzer / instrument name if printed, else "".
- patient_name and sample_id: as printed, else "".
- No code fences, no commentary, only the JSON object."""


def extract_lab_results(file_bytes, parameters, service_name=""):
    """OCR a lab result image and map the printed values onto the test's configured parameters."""
    param_lines = "\n".join(
        f'- id {p["id"]}: {p["name"]} ({p.get("data_type") or "numeric"}{", " + p["unit"] if p.get("unit") else ""})'
        for p in parameters
    )
    prompt = LAB_RESULTS_PROMPT.format(service_name=service_name or "Laboratory test", parameters=param_lines)
    parsed = _parse_json_object(_chat(prompt, _image_to_data_url(file_bytes), max_tokens=3072))
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable results. Try a clearer image.")
    by_id = {int(p["id"]): p for p in parameters}
    values = {}
    for r in parsed.get("results") if isinstance(parsed.get("results"), list) else []:
        if not isinstance(r, dict):
            continue
        try:
            pid = int(r.get("parameter_id"))
        except (TypeError, ValueError):
            continue
        param = by_id.get(pid)
        value = _s(r.get("value"))
        if not param or not value:
            continue
        if (param.get("data_type") or "numeric") == "numeric":
            match = re.search(r"-?\d+(?:\.\d+)?", value.replace(",", ""))
            if not match:
                continue
            value = match.group(0)
        values[pid] = value
    return {
        "values": [{"parameter_id": pid, "value": v} for pid, v in values.items()],
        "equipment": _s(parsed.get("equipment")),
        "patient_name": _s(parsed.get("patient_name")),
        "sample_id": _s(parsed.get("sample_id")),
    }
