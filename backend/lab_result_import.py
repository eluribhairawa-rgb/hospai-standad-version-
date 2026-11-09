"""Unified lab-result import for one test (order item): CSV, PDF or image.

- CSV   -> parsed directly, no OCR. Two layouts are recognised from the headers:
           long: one row per parameter (Test | Result | Unit | Reference range | Flag ...)
           wide: one row per sample, one column per parameter (analyser exports: HGB | WBC | PLT ...)
           Rows/columns are matched to the test's catalogue parameters by name, including
           common abbreviations (Hb, TLC, SGPT, FBS ...).
- PDF   -> text layer through the LLM (same prompt as image OCR); scanned PDFs page-image OCR.
- Image -> qwen_ocr.extract_lab_results, as before.

Every branch returns the shape of the existing /diag/lab/items/{id}/ocr response
({values, skipped, equipment, patient_name, sample_id, identity_warnings}) plus what was
detected, so the Lab page fills draft results the same way. Nothing is saved here.
"""
import re

import file_import as fi
import qwen_ocr

PREVIEW_ROWS = 20
MAX_CSV_ROWS = 500

# Column roles in a long-format report.
_ROLE_ALIASES = {
    "parameter": ["test", "test name", "tests", "parameter", "parameter name", "parameters", "investigation", "investigations",
                  "analyte", "component", "description", "test description", "name", "item", "observation", "examination"],
    "value": ["result", "results", "value", "result value", "observed value", "observation value", "reading", "finding",
              "your value", "patient value", "test result"],
    "unit": ["unit", "units", "uom", "unit of measure"],
    "ref_range": ["reference range", "ref range", "reference", "normal range", "normal value", "normal values", "range",
                  "reference interval", "biological reference interval", "bio ref interval", "biological ref interval",
                  "ref interval", "expected values"],
    "flag": ["flag", "flags", "h l", "abnormal", "abnormal flag", "status", "interpretation"],
    "patient_name": ["patient", "patient name", "name of patient", "pt name"],
    # Analyser/LIS metadata columns: recognised so they aren't mistaken for unmatched results.
    "ignore": ["date", "time", "date time", "collected on", "reported on", "age", "sex", "gender", "doctor", "ref by",
               "referred by", "remarks", "comments", "comment", "s no", "sl no", "sr no", "serial no", "method", "mode",
               "operator", "instrument", "machine", "department", "rack", "position"],
    "sample_id": ["sample id", "sample no", "sample number", "specimen id", "specimen no", "specimen number", "barcode",
                  "lab id", "lab no", "accession no", "accession number", "sid"],
}

# Synonym groups for parameter names (normalised). A header/row name matches a catalogue
# parameter when any form of one is a form of the other.
_PARAMETER_SYNONYMS = [
    {"hb", "hgb", "haemoglobin", "hemoglobin"},
    {"wbc", "tlc", "total leucocyte count", "total leukocyte count", "white blood cells", "white blood cell count",
     "total wbc count", "leucocyte count", "leukocyte count", "total count"},
    {"rbc", "rbc count", "red blood cells", "red blood cell count", "total rbc count", "erythrocyte count"},
    {"plt", "platelets", "platelet", "platelet count"},
    {"hct", "pcv", "haematocrit", "hematocrit", "packed cell volume"},
    {"mcv", "mean corpuscular volume"},
    {"mch", "mean corpuscular haemoglobin", "mean corpuscular hemoglobin"},
    {"mchc", "mean corpuscular haemoglobin concentration", "mean corpuscular hemoglobin concentration"},
    {"rdw", "rdw cv", "red cell distribution width"},
    {"esr", "erythrocyte sedimentation rate"},
    {"alt", "sgpt", "alanine aminotransferase", "alanine transaminase"},
    {"ast", "sgot", "aspartate aminotransferase", "aspartate transaminase"},
    {"alp", "alkaline phosphatase"},
    {"ggt", "gamma gt", "gamma glutamyl transferase"},
    {"tsh", "thyroid stimulating hormone"},
    {"t3", "total t3", "triiodothyronine"},
    {"t4", "total t4", "thyroxine"},
    {"fbs", "fasting blood sugar", "fasting blood glucose", "fasting glucose", "glucose fasting", "fasting plasma glucose"},
    {"ppbs", "post prandial blood sugar", "postprandial blood sugar", "glucose post prandial", "pp blood sugar", "pp glucose"},
    {"rbs", "random blood sugar", "random blood glucose", "glucose random", "random glucose"},
    {"hba1c", "glycated haemoglobin", "glycated hemoglobin", "glycosylated haemoglobin", "glycosylated hemoglobin"},
    {"tc", "total cholesterol", "cholesterol total", "cholesterol", "serum cholesterol"},
    {"tg", "tgl", "triglycerides", "triglyceride", "serum triglycerides"},
    {"hdl", "hdl cholesterol", "hdl c"},
    {"ldl", "ldl cholesterol", "ldl c"},
    {"vldl", "vldl cholesterol"},
    {"bun", "blood urea nitrogen"},
    {"urea", "blood urea", "serum urea"},
    {"creat", "crea", "creatinine", "serum creatinine", "s creatinine"},
    {"ua", "uric acid", "serum uric acid"},
    {"tbil", "t bil", "total bilirubin", "bilirubin total", "s bilirubin total"},
    {"dbil", "d bil", "direct bilirubin", "bilirubin direct", "conjugated bilirubin"},
    {"na", "sodium", "serum sodium"},
    {"k", "potassium", "serum potassium"},
    {"cl", "chloride", "serum chloride"},
    {"ca", "calcium", "serum calcium", "total calcium"},
    {"vit d", "vitamin d", "25 oh vitamin d", "25 hydroxy vitamin d", "vitamin d 25 hydroxy", "vitamin d3"},
    {"vit b12", "vitamin b12", "cyanocobalamin"},
    {"crp", "c reactive protein"},
]


def normalize(text):
    text = str(text or "").replace("﻿", "").lower()
    text = text.replace("%", " pct ").replace("#", " no ").replace("/", " ").replace("-", " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\b(number|num)\b", "no", text)
    return re.sub(r"\s+", " ", text).strip()


_ROLE_LOOKUP = {normalize(a): role for role, aliases in _ROLE_ALIASES.items() for a in aliases}
_SYNONYM_INDEX = {}
for _group in _PARAMETER_SYNONYMS:
    _forms = {normalize(f) for f in _group}
    for _f in _forms:
        _SYNONYM_INDEX.setdefault(_f, set()).update(_forms)


def name_forms(name):
    """All normalised forms a parameter/header name can match by: the full name, the name
    without bracketed text, the bracketed text (often an abbreviation or the unit), and
    their synonyms."""
    raw = str(name or "")
    forms = {normalize(raw), normalize(re.sub(r"\(.*?\)|\[.*?\]", " ", raw))}
    for groups in re.findall(r"\(([^)]*)\)|\[([^\]]*)\]", raw):
        for inner in groups:
            if inner:
                forms.add(normalize(inner))
    forms.discard("")
    for f in list(forms):
        forms |= _SYNONYM_INDEX.get(f, set())
    return forms


class ParameterMatcher:
    def __init__(self, parameters):
        self.parameters = list(parameters or [])
        self._forms = [(p, name_forms(p.get("name"))) for p in self.parameters]

    def match(self, name):
        """Returns (parameter, None) or (None, reason)."""
        forms = name_forms(name)
        if not forms:
            return None, "blank name"
        exact = normalize(name)
        hits = [p for p, pf in self._forms if forms & pf]
        if len(hits) > 1:
            # Prefer the parameter whose own name is exactly this one.
            exact_hits = [p for p in hits if normalize(p.get("name")) == exact]
            if len(exact_hits) == 1:
                return exact_hits[0], None
            return None, "matches more than one parameter: " + ", ".join(p["name"] for p in hits)
        if hits:
            return hits[0], None
        return None, "no matching parameter on this test"


def _role(header):
    return _ROLE_LOOKUP.get(normalize(header))


def _layout(header_row, matcher):
    roles = {_role(c) for c in header_row if c.strip()}
    if "parameter" in roles and "value" in roles:
        return "long"
    param_cols = sum(1 for c in header_row if c.strip() and not _role(c) and matcher.match(c)[0])
    return "wide" if param_cols >= 1 else None


def _value_for(param, raw_value):
    """(value, None) for a usable result, or (None, reason) to report it as skipped."""
    value = str(raw_value or "").strip()
    if not value or value in ("-", "--", "NA", "N/A", "na", "n/a"):
        return None, None  # not reported: silently ignored, like an absent parameter
    if (param.get("data_type") or "numeric") == "numeric":
        # "<0.5" / ">1000" are censored results; filling the number would report a definite value.
        if re.match(r"\s*[<>≤≥]", value):
            return None, "printed with a < / > qualifier"
        number = qwen_ocr._lab_numeric(value)
        if number is None:
            return None, "not a number"
        return number, None
    return value, None


def parse_csv(content, parameters, specimen_nos=()):
    text = fi.decode_text(content)
    if not text.strip():
        raise fi.FileImportError(400, "The CSV file is empty.")
    matcher = ParameterMatcher(parameters)
    all_rows, header_idx = fi.read_csv_rows(
        text,
        is_header=lambda row: _layout(row, matcher) is not None,
        score_header=lambda row: (100 if _layout(row, matcher) == "long" else 0)
        + sum(1 for c in row if c.strip() and (_role(c) or matcher.match(c)[0])),
    )
    headers = fi.unique_headers(all_rows[header_idx])
    layout = _layout(headers, matcher)
    rows, ragged, truncated = fi.rows_as_dicts(all_rows, header_idx, headers, MAX_CSV_ROWS)
    if not rows:
        raise fi.FileImportError(400, "The CSV file has a header row but no data rows.")

    warnings = []
    if header_idx:
        warnings.append(f"Skipped {header_idx} line(s) above the column headings.")
    if ragged:
        warnings.append(f"{ragged} row(s) had a different number of columns than the header and were padded/trimmed.")
    if truncated:
        warnings.append(f"Only the first {MAX_CSV_ROWS} rows were read.")

    role_of = {h: _role(h) for h in headers}
    col = {}
    for h, r in role_of.items():
        if r and r not in col:
            col[r] = h

    values, skipped, unmatched, mapping = {}, [], [], {}
    patient_name = sample_id = ""

    def take(param, raw_value, source):
        value, reason = _value_for(param, raw_value)
        if reason:
            skipped.append({"parameter_id": param["id"], "parameter_name": param["name"], "value": str(raw_value), "reason": reason})
        elif value is not None:
            if param["id"] in values and values[param["id"]] != value:
                warnings.append(f"{param['name']} appears more than once ({source}); the first value was kept.")
                return
            values.setdefault(param["id"], value)

    if layout == "long":
        mapping = {h: role_of[h] for h in headers}
        for row in rows:
            name = row.get(col["parameter"], "")
            if not name:
                continue
            if col.get("patient_name"):
                patient_name = patient_name or row.get(col["patient_name"], "")
            if col.get("sample_id"):
                sample_id = sample_id or row.get(col["sample_id"], "")
            param, reason = matcher.match(name)
            if param is None:
                # Section headings ("HAEMATOLOGY") have a name but no value: not worth reporting.
                if row.get(col["value"], "").strip():
                    unmatched.append({"name": name, "value": row.get(col["value"], ""), "reason": reason})
                continue
            take(param, row.get(col["value"], ""), f'row "{name}"')
    elif layout == "wide":
        param_cols = {}
        for h in headers:
            if role_of[h]:
                mapping[h] = role_of[h]
                continue
            param, reason = matcher.match(h)
            mapping[h] = f"parameter: {param['name']}" if param else None
            if param:
                param_cols[h] = param
            elif re.search(r"\d", "".join(r.get(h, "") for r in rows[:3])):
                unmatched.append({"name": h, "value": rows[0].get(h, ""), "reason": reason})
        row = rows[0]
        if len(rows) > 1:
            ours = {re.sub(r"[^A-Z0-9]", "", str(n).upper()) for n in specimen_nos if n}
            sid_col = col.get("sample_id")
            mine = [r for r in rows if sid_col and re.sub(r"[^A-Z0-9]", "", r.get(sid_col, "").upper()) in ours] if ours else []
            if len(mine) == 1:
                row = mine[0]
            else:
                warnings.append(f"The file has {len(rows)} sample rows; the first one was used. "
                                "Upload a file with only this patient's sample, or include its specimen number in a Sample ID column.")
        patient_name = row.get(col["patient_name"], "") if col.get("patient_name") else ""
        sample_id = row.get(col["sample_id"], "") if col.get("sample_id") else ""
        for h, param in param_cols.items():
            take(param, row.get(h, ""), f'column "{h}"')
    else:
        mapping = {h: role_of[h] for h in headers}
        warnings.append(
            "Could not recognise the layout: expected Test and Result columns, or columns named after this test's parameters "
            f"({', '.join(p['name'] for p in parameters)}). Columns found: {', '.join(headers)}."
        )

    if unmatched:
        warnings.append(f"{len(unmatched)} result(s) in the file do not match this test's parameters and were not filled: "
                        + ", ".join(u["name"] for u in unmatched[:8]) + ("..." if len(unmatched) > 8 else ""))
    return {
        "processing": "csv_direct",
        "layout": layout,
        "detected_fields": headers,
        "field_mapping": mapping,
        "row_count": len(rows),
        "preview": rows[:PREVIEW_ROWS],
        "values": [{"parameter_id": pid, "value": v} for pid, v in values.items()],
        "skipped": skipped,
        "unmatched": unmatched,
        "equipment": "",
        "patient_name": patient_name,
        "sample_id": sample_id,
        "warnings": warnings,
    }


def _merge_ocr(parts):
    merged = {"values": [], "skipped": [], "equipment": "", "patient_name": "", "sample_id": ""}
    seen = set()
    for part in parts:
        for v in part.get("values") or []:
            if v["parameter_id"] not in seen:
                seen.add(v["parameter_id"])
                merged["values"].append(v)
        merged["skipped"].extend(part.get("skipped") or [])
        for k in ("equipment", "patient_name", "sample_id"):
            merged[k] = merged[k] or part.get(k, "")
    return merged


def parse_pdf(content, parameters, service_name):
    pages = fi.open_pdf(content)
    text = fi.pdf_text(pages)
    if fi.has_text_layer(text):
        result = fi.call_ocr(qwen_ocr.extract_lab_results_from_text, text, parameters, service_name)
        warnings = ["The PDF is long; only the first part was read."] if len(text) > qwen_ocr.MAX_INVOICE_TEXT_CHARS else []
        return {**result, "processing": "pdf_text", "page_count": len(pages), "warnings": warnings}
    parts, warnings = fi.ocr_scanned_pages(
        pages, lambda image: fi.call_ocr(qwen_ocr.extract_lab_results, image, parameters, service_name), what="report")
    return {**_merge_ocr(parts), "processing": "pdf_scan_ocr", "page_count": len(pages), "warnings": warnings}


def _ocr_summary(result, parameters):
    by_id = {p["id"]: p["name"] for p in parameters}
    result.setdefault("warnings", [])
    result["detected_fields"] = [by_id.get(v["parameter_id"], str(v["parameter_id"])) for v in result["values"]]
    result["preview"] = [{"parameter": by_id.get(v["parameter_id"], ""), "value": v["value"]} for v in result["values"]][:PREVIEW_ROWS]
    result["row_count"] = len(result["values"])
    result.setdefault("unmatched", [])
    return result


def import_lab_results(filename, content, parameters, service_name="", patient_name="", specimen_nos=()):
    """Entry point. Raises file_import.FileImportError with an HTTP status on bad input."""
    if not parameters:
        raise fi.FileImportError(400, "No parameters are configured for this test in the catalogue.")
    fi.check_upload(content)
    file_type = fi.detect_file_type(filename, content)
    if file_type == "csv":
        result = parse_csv(content, parameters, specimen_nos)
    elif file_type == "pdf":
        result = _ocr_summary(parse_pdf(content, parameters, service_name), parameters)
    else:
        result = _ocr_summary({**fi.call_ocr(qwen_ocr.extract_lab_results, content, parameters, service_name),
                               "processing": "ocr_image"}, parameters)
    if not result["values"] and not result["skipped"] and file_type != "csv":
        raise fi.FileImportError(422, "No results for this test could be read from the file. Try a clearer, uncropped image.")
    result["identity_warnings"] = qwen_ocr.lab_identity_warnings(result, patient_name, specimen_nos)
    return {"file_type": file_type, "file_name": filename or "", **result}
