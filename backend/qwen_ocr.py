"""Structured OCR through the Qwen3-VL model served by vLLM (OpenAI-compatible API)."""
import base64
from difflib import SequenceMatcher
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
  "patient_uhid": "",
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
- patient_uhid: the patient's UHID / Patient ID / registration number exactly as printed (it looks like PAT-20261111-0055). Never use a phone number, token number, bill number or age here.
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
        "patient_uhid": _s(raw.get("patient_uhid")),
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


_NAME_TITLES = {"mr", "mrs", "ms", "miss", "dr", "master", "baby", "smt", "shri", "sri", "shree", "late", "sir"}


def _identity_name_tokens(name):
    return [t for t in re.findall(r"[a-z]+", (name or "").lower()) if len(t) >= 2 and t not in _NAME_TITLES]


def _token_equal(a, b):
    """Same word, allowing one small OCR slip in words long enough for that to be safe."""
    if a == b:
        return True
    if min(len(a), len(b)) < 5:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.85


def prescription_name_matches(printed_name, expected_name):
    """True / False, or None when either name has nothing to compare.
    Every word of the shorter name must appear in the other one (in any order), so
    "Ravi Kumar" is not accepted for "Suresh Kumar" just because the surname is shared,
    while "Srinidhi S" still matches "S Srinidhi" and "Ravi" matches "Ravi Kumar"."""
    a, b = _identity_name_tokens(printed_name), _identity_name_tokens(expected_name)
    if not a or not b:
        return None
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return all(any(_token_equal(s, t) for t in long_) for s in short)


def _uhid_key(value):
    """Letters/digits only, upper-case, with the usual OCR look-alikes folded (O->0, I/L->1).
    Real UHIDs only have digits after their prefix, so this cannot make two UHIDs equal."""
    key = re.sub(r"[^A-Z0-9]", "", _s(value).upper())
    return key.translate(str.maketrans("OIL", "011"))


def prescription_uhid_matches(printed_uhid, expected_uhid):
    """True / False, or None when no UHID is printed on the sheet. Exact match only: UHIDs
    are sequential, so a one-character 'fuzzy' match would accept the next patient."""
    printed = _uhid_key(printed_uhid)
    if len(printed) < 4:
        return None
    return printed == _uhid_key(expected_uhid)


def prescription_identity_check(extracted, expected_uhid, expected_name):
    """Does the scanned prescription belong to the selected patient?
    Returns {ok, message, verified_by, printed_uhid, printed_name}."""
    extracted = extracted or {}
    printed_uhid = _s(extracted.get("patient_uhid"))
    printed_name = _s(extracted.get("patient_name"))
    uhid_ok = prescription_uhid_matches(printed_uhid, expected_uhid)
    name_ok = prescription_name_matches(printed_name, expected_name)
    result = {"ok": False, "message": None, "verified_by": None, "printed_uhid": printed_uhid, "printed_name": printed_name}
    shown = f"{expected_name} ({expected_uhid})"

    if uhid_ok is False and name_ok is False:
        result["message"] = (f"UHID and patient name don't match. The prescription is for {printed_name} ({printed_uhid}), "
                             f"but the selected patient is {shown}.")
    elif uhid_ok is False:
        result["message"] = f"UHID doesn't match. The prescription shows {printed_uhid}, but the selected patient's UHID is {expected_uhid}."
    elif name_ok is False:
        result["message"] = (f'Patient name doesn\'t match. The prescription is for "{printed_name}", '
                             f"but the selected patient is {expected_name}.")
    elif uhid_ok is None and name_ok is None:
        result["message"] = (f"Couldn't read a UHID or patient name on this prescription, so it can't be confirmed as {shown}. "
                             "Upload a clearer image that shows the patient's name or UHID.")
    else:
        result["ok"] = True
        result["verified_by"] = "UHID and name" if (uhid_ok and name_ok) else ("UHID" if uhid_ok else "name")
    return result


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


# Keeps prompt + output inside the model's context window (~4 chars per token).
MAX_INVOICE_TEXT_CHARS = 16000


def extract_supplier_invoice_from_text(text):
    """Structure the text layer of a digital (non-scanned) PDF invoice into GRN fields.
    Same prompt and cleaning as the image path, so both return identical shapes."""
    body = (text or "").strip()[:MAX_INVOICE_TEXT_CHARS]
    if not body:
        raise ValueError("The PDF has no readable text.")
    prompt = (
        SUPPLIER_INVOICE_PROMPT.replace("You are reading", "You are reading the extracted text of", 1)
        + "\n\nThe invoice text follows. It was extracted from a PDF, so table columns may be run together "
          "or misaligned; use the column headings to work out which value is which.\n<<<\n" + body + "\n>>>"
    )
    parsed = _parse_json_object(_chat(prompt, None, max_tokens=6144))
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable invoice data from the PDF text.")
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


def _lab_numeric(value):
    """First number in an OCR'd result. Commas are thousands separators ("2,50,000"),
    except a single comma followed by one or two digits, which is a decimal comma ("13,4")."""
    text = _s(value)
    if re.fullmatch(r"\D*-?\d+,\d{1,2}\D*", text):
        text = text.replace(",", ".")
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    return match.group(0) if match else None


def _name_tokens(name):
    return {t for t in re.findall(r"[a-z]+", (name or "").lower()) if len(t) >= 2}


def lab_identity_warnings(extracted, patient_name="", specimen_nos=()):
    """Cross-checks the patient name / sample id printed on the scanned sheet against the
    test being resulted, so a printout for a different patient is not entered silently.
    Sample ids are only compared when they use this hospital's own SPC- numbering, since
    external laboratories print their own accession numbers."""
    warnings = []
    printed_name = _s((extracted or {}).get("patient_name"))
    expected = _name_tokens(patient_name)
    if printed_name and expected and not (_name_tokens(printed_name) & expected):
        warnings.append(f'The sheet is for "{printed_name}", not {patient_name}.')
    printed_sample = re.sub(r"[^A-Z0-9]", "", _s((extracted or {}).get("sample_id")).upper())
    ours = {re.sub(r"[^A-Z0-9]", "", str(n).upper()) for n in specimen_nos if n}
    if printed_sample.startswith("SPC") and ours and printed_sample not in ours:
        warnings.append(f'The sheet\'s sample id {_s(extracted.get("sample_id"))} does not match this test\'s specimen.')
    return warnings


def _lab_prompt(parameters, service_name):
    param_lines = "\n".join(
        f'- id {p["id"]}: {p["name"]} ({p.get("data_type") or "numeric"}{", " + p["unit"] if p.get("unit") else ""})'
        for p in parameters
    )
    return LAB_RESULTS_PROMPT.format(service_name=service_name or "Laboratory test", parameters=param_lines)


def extract_lab_results(file_bytes, parameters, service_name=""):
    """OCR a lab result image and map the printed values onto the test's configured parameters."""
    parsed = _parse_json_object(_chat(_lab_prompt(parameters, service_name), _image_to_data_url(file_bytes), max_tokens=3072))
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable results. Try a clearer image.")
    return map_lab_results(parsed, parameters)


def extract_lab_results_from_text(text, parameters, service_name=""):
    """Same as extract_lab_results, for the text layer of a digital (non-scanned) PDF report."""
    body = (text or "").strip()[:MAX_INVOICE_TEXT_CHARS]
    if not body:
        raise ValueError("The PDF has no readable text.")
    prompt = (
        _lab_prompt(parameters, service_name).replace("You are reading a laboratory result printout", "You are reading the extracted text of a laboratory report", 1)
        + "\n\nThe report text follows. It was extracted from a PDF, so table columns may be run together; "
          "use the column headings (Test / Result / Unit / Reference range) to tell values apart.\n<<<\n" + body + "\n>>>"
    )
    parsed = _parse_json_object(_chat(prompt, None, max_tokens=3072))
    if parsed is None:
        raise RuntimeError("The OCR model did not return readable results from the PDF text.")
    return map_lab_results(parsed, parameters)


def map_lab_results(parsed, parameters):
    """Model output -> values for the test's configured parameters (shared by image and PDF text)."""
    by_id = {int(p["id"]): p for p in parameters}
    values = {}
    skipped = []
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
            # "<0.5" / ">1000" are censored results; filling just the number would
            # report a definite value (and a wrong flag), so staff must enter these.
            if re.match(r"\s*[<>\u2264\u2265]", value):
                skipped.append({"parameter_id": pid, "parameter_name": param.get("name"), "value": value,
                                "reason": "printed with a < / > qualifier"})
                continue
            value = _lab_numeric(value)
            if value is None:
                continue
        values[pid] = value
    return {
        "values": [{"parameter_id": pid, "value": v} for pid, v in values.items()],
        "skipped": skipped,
        "equipment": _s(parsed.get("equipment")),
        "patient_name": _s(parsed.get("patient_name")),
        "sample_id": _s(parsed.get("sample_id")),
    }
