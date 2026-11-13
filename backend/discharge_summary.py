"""Patient discharge summary.

1. gather_patient_records: the patient's real records for ONE encounter (OP
   appointment, IP admission or Emergency encounter). Every clinical query is
   scoped to that encounter (admission id, appointment id, ER encounter id, or
   the encounter's own time window) so nothing from another visit leaks in.
2. generate_discharge_summary: asks the Qwen model for the narrative sections
   only, from a scoped, de-identified subset of those records. Sentences that
   mention a number/date or a drug not present in the records are removed and
   reported as warnings, and sections with no supporting data are forced to
   "Not recorded". Discharge medications are never written by the AI: they come
   from the doctor's prescription for the encounter (build_discharge_medications).
3. Persistence: one saved summary per encounter (discharge_summaries) moving
   DRAFT -> PENDING_REVIEW -> APPROVED -> FINALIZED, with every change kept in
   discharge_summary_versions. Tables: migrations/migrations_discharge_summaries.sql.
"""
import json
import re
from datetime import date, datetime, timedelta

from sqlalchemy import text

import patient_journey
from database import IST_TIMEZONE
from legacy_sql import get_connection
from qwen_ocr import QWEN_OCR_MODEL, _chat, _parse_json_object

MAX_ROWS = 15
MAX_TEXT = 400
ENCOUNTER_TYPES = ("IP", "OP", "EMERGENCY")
NOT_RECORDED = "Not recorded"


class EncounterNotFound(LookupError):
    pass


def _iso(value):
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _clip(value, limit=MAX_TEXT):
    text_ = " ".join(str(value or "").split())
    return text_ if len(text_) <= limit else text_[: limit - 1] + "…"


def _compact(row, keys):
    """Keep only non-empty values for the given keys, clipped for the prompt."""
    out = {}
    for k in keys:
        v = row.get(k)
        if v is None or v == "":
            continue
        out[k] = _iso(v) if hasattr(v, "isoformat") else (_clip(v) if isinstance(v, str) else v)
    return out


def _report_text(content):
    if isinstance(content, dict):
        return _clip("; ".join(f"{k}: {v}" for k, v in content.items() if v not in (None, "")), 600)
    if isinstance(content, str):
        try:
            return _report_text(json.loads(content))
        except Exception:
            return _clip(content, 600)
    return ""


def _now():
    return datetime.now(IST_TIMEZONE).replace(tzinfo=None)


def _to_dt(value, end_of_day=False):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, date):
        return datetime.combine(value, datetime.max.time() if end_of_day else datetime.min.time())
    s = str(value)
    try:
        parsed = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if len(s) <= 10 and end_of_day:
        parsed = datetime.combine(parsed.date(), datetime.max.time())
    return parsed.replace(tzinfo=None)


def normalize_encounter_type(value):
    if value in (None, ""):
        return None
    v = str(value).strip().upper()
    v = {"ER": "EMERGENCY", "IPD": "IP", "OPD": "OP"}.get(v, v)
    if v not in ENCOUNTER_TYPES:
        raise ValueError("encounter_type must be IP, OP or EMERGENCY.")
    return v


def resolve_encounter(db, patient_id, encounter_type=None, encounter_id=None):
    """The patient's encounter to summarise. An explicitly requested encounter
    must belong to this patient -- it never silently falls back to another visit."""
    etype = normalize_encounter_type(encounter_type)
    encounters = patient_journey.list_patient_journey_encounters(db, patient_id)
    if etype or encounter_id not in (None, ""):
        if not etype or encounter_id in (None, ""):
            raise ValueError("Both encounter_type and encounter_id are required to select a visit.")
        try:
            eid = int(encounter_id)
        except (TypeError, ValueError):
            raise ValueError("encounter_id must be a number.")
        match = next((e for e in encounters if e["encounter_type"] == etype and int(e["encounter_id"]) == eid), None)
        if not match:
            raise EncounterNotFound(f"{etype} encounter {eid} was not found for patient {patient_id}.")
        return match, encounters
    return (encounters[0] if encounters else None), encounters


ADMISSION_NOTE_FIELDS = {
    "admission type": "admission_type", "department": "department", "consulting doctor": "consulting_doctor",
    "triage acuity": "triage", "reason": "reason", "expected stay": "expected_stay", "allocated bed": "bed",
}


def parse_admission_notes(notes):
    """The admission form stores its answers as 'Key: value | Key: value' in
    admissions.notes -- turn that into a dict of the fields the summary can use."""
    out = {}
    for part in str(notes or "").split("|"):
        key, sep, value = part.partition(":")
        field = ADMISSION_NOTE_FIELDS.get(key.strip().lower())
        if sep and field and value.strip():
            out[field] = _clip(value)
    return out


def _fetch(cursor, sql, params=()):
    cursor.execute(sql, tuple(params))
    return [dict(r) for r in cursor.fetchall()]


def gather_patient_records(db, patient_id, encounter_type=None, encounter_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,))
        row = cursor.fetchone()
        if not row:
            return None
        patient = dict(row)

    selected, encounters = resolve_encounter(db, patient_id, encounter_type, encounter_id)
    journey = patient_journey.get_patient_journey(db, patient_id, selected["encounter_type"], selected["encounter_id"]) if selected else None

    etype = selected["encounter_type"] if selected else None
    eid = int(selected["encounter_id"]) if selected else None
    win_start = _to_dt(selected.get("start")) if selected else None
    win_end = (_to_dt(selected.get("end"), end_of_day=True) if selected and selected.get("end") else None) or _now()
    if etype == "OP" and win_start:
        # An OP visit is one day: the appointment date.
        win_start = datetime.combine(win_start.date(), datetime.min.time())
        win_end = datetime.combine(win_start.date(), datetime.max.time())

    vitals, prescriptions, rounds, observations, nursing, round_meds, procedures = [], [], [], [], [], [], []
    surgeries, reports, medication_orders, pharmacy_items, emergency = [], [], [], [], None
    admission = None
    attending_doctor = (journey or {}).get("doctor_name")

    if selected:
        with get_connection(db) as conn:
            cursor = conn.cursor()
            er_row = None
            if etype == "EMERGENCY":
                cursor.execute("SELECT * FROM encounters WHERE id = ? AND patient_id = ?", (eid, patient_id))
                er = cursor.fetchone()
                er_row = dict(er) if er else {}
                emergency = _compact(er_row, ["arrival_at", "chief_complaint", "triage_priority", "attending_doctor",
                                              "disposition", "disposition_notes", "disposition_at"]) or None
                attending_doctor = attending_doctor or er_row.get("attending_doctor")
            er_appointment = (er_row or {}).get("appointment_id")

            if etype == "IP":
                cursor.execute("SELECT notes FROM admissions WHERE id = ? AND patient_id = ?", (eid, patient_id))
                adm = cursor.fetchone()
                admission = parse_admission_notes(adm["notes"]) if adm else None
                attending_doctor = attending_doctor or (admission or {}).get("consulting_doctor")

            # ---- vitals
            vital_ts = "COALESCE(recorded_at, record_time, created_at)"
            if etype == "IP":
                rows = _fetch(cursor, f"SELECT * FROM patient_vitals WHERE patient_id = ? AND admission_id = ? ORDER BY {vital_ts}", (patient_id, eid))
            elif etype == "EMERGENCY":
                rows = _fetch(cursor, f"SELECT * FROM patient_vitals WHERE patient_id = ? AND encounter_id = ? ORDER BY {vital_ts}", (patient_id, eid))
            else:
                rows = _fetch(
                    cursor,
                    f"SELECT * FROM patient_vitals WHERE patient_id = ? AND admission_id IS NULL AND encounter_id IS NULL "
                    f"AND {vital_ts} >= ? AND {vital_ts} <= ? ORDER BY {vital_ts}",
                    (patient_id, win_start, win_end),
                ) if win_start else []
            vital_keys = ["recorded_at", "bp", "pulse", "temperature", "spo2", "respiratory_rate", "blood_sugar", "weight", "pain_score", "gcs"]
            vitals = [_compact(v, vital_keys) for v in (rows[:1] + rows[-1:] if len(rows) > 1 else rows)]

            # ---- prescriptions written for this encounter
            if etype == "IP":
                rx_rows = _fetch(
                    cursor,
                    "SELECT * FROM prescriptions WHERE patient_id = ? AND COALESCE(dispense_status, '') <> 'superseded' "
                    "AND (admission_id = ? OR id IN (SELECT prescription_id FROM ward_indents WHERE admission_id = ? AND prescription_id IS NOT NULL)) "
                    "ORDER BY id DESC LIMIT ?",
                    (patient_id, eid, eid, MAX_ROWS),
                )
            elif etype == "OP" and eid:
                rx_rows = _fetch(cursor, "SELECT * FROM prescriptions WHERE patient_id = ? AND appointment_id = ? "
                                         "AND COALESCE(dispense_status, '') <> 'superseded' ORDER BY id DESC LIMIT ?", (patient_id, eid, MAX_ROWS))
            elif etype == "EMERGENCY" and er_appointment:
                rx_rows = _fetch(cursor, "SELECT * FROM prescriptions WHERE patient_id = ? AND appointment_id = ? "
                                         "AND COALESCE(dispense_status, '') <> 'superseded' ORDER BY id DESC LIMIT ?", (patient_id, er_appointment, MAX_ROWS))
            else:
                rx_rows = []
            for rx in rx_rows:
                meds = _fetch(cursor, "SELECT medicine_name, dosage, frequency, duration, instructions FROM prescription_medicines "
                                      "WHERE prescription_id = ? ORDER BY id", (rx["id"],))
                entry = _compact(rx, ["created_at", "doctor_name", "department", "diagnosis", "lab_tests", "advice", "follow_up_date"])
                entry["id"] = rx["id"]
                entry["medicines"] = [_compact(m, ["medicine_name", "dosage", "frequency", "duration", "instructions"]) for m in meds]
                prescriptions.append(entry)

            # ---- inpatient stay: rounds, notes, nursing, orders
            if etype == "IP":
                w0, w1 = win_start.date() if win_start else date.min, win_end.date()
                rounds = [_compact(r, ["round_date", "doctor_name", "patient_complaints", "clinical_findings", "assessment",
                                       "diagnosis", "progress_notes", "patient_condition"])
                          for r in _fetch(cursor, "SELECT * FROM doctor_rounds WHERE patient_id = ? AND round_date >= ? AND round_date <= ? "
                                                  "ORDER BY round_date, round_time LIMIT ?", (patient_id, w0, w1, MAX_ROWS))]
                round_meds = [_compact(r, ["medicine_name", "strength", "dosage", "frequency", "route", "status"])
                              for r in _fetch(cursor, "SELECT m.* FROM doctor_round_medications m JOIN doctor_rounds r ON r.id = m.round_id "
                                                      "WHERE m.patient_id = ? AND r.round_date >= ? AND r.round_date <= ? ORDER BY m.id LIMIT ?",
                                              (patient_id, w0, w1, MAX_ROWS * 2))]
                procedures = [_compact(r, ["procedure_name", "status", "remarks"])
                              for r in _fetch(cursor, "SELECT p.* FROM doctor_round_procedures p JOIN doctor_rounds r ON r.id = p.round_id "
                                                      "WHERE p.patient_id = ? AND r.round_date >= ? AND r.round_date <= ? ORDER BY p.id LIMIT ?",
                                              (patient_id, w0, w1, MAX_ROWS))]
                observations = [_compact(r, ["created_at", "doctor_name", "note", "treatment_plan"])
                                for r in _fetch(cursor, "SELECT * FROM observation_notes WHERE patient_id = ? AND admission_id = ? "
                                                        "ORDER BY created_at LIMIT ?", (patient_id, eid, MAX_ROWS))]
                nursing = [_compact(r, ["log_date", "activity", "remarks", "status"])
                           for r in _fetch(cursor, "SELECT * FROM nursing_care_logs WHERE patient_id = ? AND admission_id = ? "
                                                   "ORDER BY log_date DESC, log_time DESC LIMIT ?", (patient_id, eid, MAX_ROWS))]
                orders = _fetch(
                    cursor,
                    "SELECT wii.medicine_name, wii.dose, wii.frequency, wii.route, wii.status, wii.is_prn, "
                    "(SELECT COUNT(*) FROM emar_records e WHERE e.indent_item_id = wii.id AND e.status = 'given') AS doses_given "
                    "FROM ward_indent_items wii JOIN ward_indents wi ON wi.id = wii.indent_id "
                    "WHERE wi.patient_id = ? AND wi.admission_id = ? AND COALESCE(wii.status, '') <> 'cancelled' ORDER BY wii.id LIMIT ?",
                    (patient_id, eid, MAX_ROWS * 2),
                )
                medication_orders = [_compact(o, ["medicine_name", "dose", "frequency", "route", "status", "doses_given"]) for o in orders]

            # ---- surgeries in the encounter window (not OP)
            if etype in ("IP", "EMERGENCY") and win_start:
                surgeries = [_compact(r, ["scheduled_start", "procedure_name", "surgeon_name", "status", "notes"])
                             for r in _fetch(cursor, "SELECT * FROM ot_surgeries WHERE patient_id = ? AND scheduled_start >= ? AND scheduled_start <= ? "
                                                     "ORDER BY scheduled_start LIMIT ?", (patient_id, win_start, win_end, MAX_ROWS))]

            # ---- released diagnostic reports ordered in this encounter
            base = ("SELECT oi.service_name, oi.department_type, r.content, r.released_at FROM diag_reports r "
                    "JOIN diag_order_items oi ON oi.id = r.order_item_id JOIN diag_orders o ON o.id = oi.order_id "
                    "WHERE o.patient_id = ? AND r.status = 'released' AND ")
            if etype == "IP":
                scope, params = ("(o.admission_id = ? OR (o.admission_id IS NULL AND o.encounter_type = 'IP' AND o.created_at >= ? AND o.created_at <= ?))",
                                 (eid, win_start or datetime.min, win_end))
            elif etype == "OP" and eid:
                scope, params = "o.appointment_id = ?", (eid,)
            elif etype == "OP":
                scope, params = "o.appointment_id IS NULL AND o.admission_id IS NULL AND o.created_at >= ? AND o.created_at <= ?", (win_start or datetime.min, win_end)
            elif er_appointment:
                scope, params = "o.appointment_id = ?", (er_appointment,)
            else:
                scope, params = ("o.admission_id IS NULL AND o.encounter_type = 'EMERGENCY' AND o.created_at >= ? AND o.created_at <= ?",
                                 (win_start or datetime.min, win_end))
            reports = [
                {"test": r["service_name"], "type": r["department_type"], "released_at": _iso(r["released_at"]), "result": _report_text(r["content"])}
                for r in _fetch(cursor, base + scope + " ORDER BY r.released_at LIMIT ?", (patient_id, *params, MAX_ROWS))
            ]

            # ---- pharmacy issued in this encounter
            if etype == "IP":
                sales = _fetch(cursor, "SELECT medicine_name, quantity FROM pharmacy_sales WHERE patient_id = ? AND admission_id = ? ORDER BY sold_at", (patient_id, eid))
            elif etype == "EMERGENCY":
                sales = _fetch(cursor, "SELECT medicine_name, quantity FROM pharmacy_sales WHERE patient_id = ? AND admission_id IS NULL "
                                       "AND billing_type IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') AND sold_at >= ? AND sold_at <= ? ORDER BY sold_at",
                               (patient_id, win_start or datetime.min, win_end))
            else:
                rx_ids = [str(rx["id"]) for rx in rx_rows] or ["-"]
                sales = _fetch(
                    cursor,
                    "SELECT medicine_name, quantity FROM pharmacy_sales WHERE patient_id = ? AND admission_id IS NULL "
                    "AND COALESCE(billing_type, '') NOT IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') "
                    "AND (prescription_ref = ANY(?) OR (sold_at >= ? AND sold_at <= ?)) ORDER BY sold_at",
                    (patient_id, rx_ids, win_start or datetime.min, win_end),
                ) if win_start else []
            pharmacy_items = [f"{s['medicine_name']} x{s['quantity']}" for s in sales][: MAX_ROWS * 2]

    def _in_window(ev):
        d = _to_dt(ev.get("date"))
        if not d or not win_start:
            return True
        return win_start.date() <= d.date() <= win_end.date()

    # The journey's lab/imaging events are not encounter-scoped (its OP query takes
    # every order without an admission), so they are replaced by this encounter's
    # own released reports.
    diag_event_types = ("lab_collected", "imaging_completed", "report_released", "lab_bill", "critical_alert", "critical_ack")
    events = [e for e in (journey or {}).get("events", []) if e.get("type") not in diag_event_types]
    events += [{"date": (r["released_at"] or "")[:10], "title": "Report released", "subtitle": r["test"], "type": "report_released"} for r in reports]
    events.sort(key=lambda e: str(e.get("date") or ""))
    return {
        "patient": _compact(patient, ["patient_id", "name", "middle_name", "last_name", "age", "gender", "dob", "blood_group",
                                      "allergies", "allergy_status", "medical_history", "current_medication", "symptoms",
                                      "phone", "address", "insurance_provider"]),
        "encounter": {
            "type": etype, "id": eid, "label": selected.get("label"), "start": selected.get("start"), "end": selected.get("end"),
            "status": selected.get("status"), "ward": selected.get("ward"), "bed_no": selected.get("bed_no"),
            "attending_doctor": attending_doctor,
        } if selected else None,
        "emergency": emergency,
        "admission": admission or None,
        "vitals": vitals,
        "prescriptions": prescriptions,
        "doctor_rounds": rounds,
        "observation_notes": observations,
        "inpatient_medications": round_meds,
        "medication_orders": medication_orders,
        "procedures": procedures,
        "surgeries": surgeries,
        "nursing": nursing,
        "diagnostic_reports": reports,
        "pharmacy_issued": pharmacy_items,
        # Display only (never sent to the AI): journey events limited to this encounter's dates.
        "timeline": [_compact(e, ["date", "title", "subtitle"]) for e in events
                     if e.get("type") not in ("payment",) and _in_window(e)][: MAX_ROWS * 3],
        "billing": (journey or {}).get("financial_summary"),
        "encounters": [{"label": e["label"], "start": e["start"], "status": e["status"]} for e in encounters],
    }


# ------------------------------------------------------------ medications --

def build_discharge_medications(records):
    """Discharge medications come only from the doctor's saved prescription for
    this encounter (the latest non-superseded one), never from the AI."""
    rx = (records.get("prescriptions") or [None])[0]
    if not rx:
        return [], None
    source = f"Prescription #{rx['id']}" + (f" · Dr. {rx['doctor_name']}" if rx.get("doctor_name") else "") + \
             (f" · {str(rx.get('created_at'))[:10]}" if rx.get("created_at") else "")
    meds = [{
        "medicine": m.get("medicine_name", ""),
        "dosage": m.get("dosage", ""),
        "frequency": m.get("frequency", ""),
        "duration": m.get("duration", ""),
        "instructions": m.get("instructions", ""),
        "source": source,
        "prescription_id": rx["id"],
    } for m in rx.get("medicines") or [] if m.get("medicine_name")]
    return meds, {"prescription_id": rx["id"], "label": source}


# --------------------------------------------------------------- AI + grounding --

SUMMARY_PROMPT = """You are a hospital physician drafting a discharge summary for ONE patient visit.
Use ONLY facts stated in the visit records JSON below. Never add diagnoses, test results, values,
drugs, doses, procedures or dates that are not written there, and do not infer or estimate them.
If the records have nothing for a section, write exactly "Not recorded".

Return ONLY a JSON object with exactly these keys (strings):
{
  "summary": "3-4 sentences: reason for visit, key findings/diagnosis, treatment given, condition/outcome",
  "presenting_complaints": "",
  "diagnosis": "",
  "clinical_course": "",
  "key_investigations": "",
  "procedures": "",
  "treatment_given": "",
  "condition_at_discharge": "",
  "advice": "",
  "follow_up": ""
}

Rules:
- Plain prose, 1-3 sentences per section, no bullet points, no code fences, no commentary.
- Copy numbers (vitals, results, doses, dates) exactly as written in the records.
- Do not list discharge medications; they are taken from the doctor's prescription separately.

Visit records JSON:
"""

REPORT_KEYS = ("summary", "presenting_complaints", "diagnosis", "clinical_course", "key_investigations", "procedures",
               "treatment_given", "condition_at_discharge", "advice", "follow_up")
MED_KEYS = ("medicine", "dosage", "frequency", "duration", "instructions")

COMMON_DRUGS = (
    "paracetamol", "acetaminophen", "amoxicillin", "augmentin", "ceftriaxone", "cefixime", "cefuroxime", "azithromycin",
    "ciprofloxacin", "levofloxacin", "metronidazole", "doxycycline", "vancomycin", "meropenem", "piperacillin", "metformin",
    "glimepiride", "insulin", "pantoprazole", "omeprazole", "ranitidine", "ondansetron", "domperidone", "ibuprofen",
    "diclofenac", "aspirin", "clopidogrel", "atorvastatin", "rosuvastatin", "amlodipine", "losartan", "telmisartan",
    "metoprolol", "furosemide", "heparin", "enoxaparin", "warfarin", "dexamethasone", "prednisolone", "hydrocortisone",
    "salbutamol", "budesonide", "montelukast", "cetirizine", "levocetirizine", "tramadol", "morphine", "ketorolac",
    "dolo", "calpol", "crocin", "azee", "pan", "zofer", "emeset",
)


def _ai_input(records):
    """The scoped clinical subset sent to the model: no billing, timeline,
    contact details or other visits."""
    p = records.get("patient") or {}
    return {
        "patient": {k: p[k] for k in ("age", "gender", "blood_group", "allergies", "allergy_status", "medical_history",
                                      "current_medication", "symptoms") if k in p},
        "encounter": {k: v for k, v in (records.get("encounter") or {}).items() if k in ("type", "label", "start", "end", "status", "ward", "attending_doctor")},
        **{k: records.get(k) for k in ("emergency", "admission", "vitals", "prescriptions", "doctor_rounds", "observation_notes", "inpatient_medications",
                                        "medication_orders", "procedures", "surgeries", "nursing", "diagnostic_reports") if records.get(k)},
    }


def _num_norm(token):
    t = token.strip(".")
    if re.fullmatch(r"\d+\.\d+", t):
        t = t.rstrip("0").rstrip(".")
    return t


def _number_tokens(text_):
    return {_num_norm(t) for t in re.findall(r"\d+(?:[./:-]\d+)*", text_ or "")}


def _source_numbers(blob):
    nums = set()
    for tok in re.findall(r"\d+(?:[./:-]\d+)*", blob):
        nums.add(_num_norm(tok))
        nums.update(_num_norm(part) for part in re.split(r"[./:-]", tok) if part)
    return nums


def _section_has_data(records):
    rx = records.get("prescriptions") or []
    rounds = records.get("doctor_rounds") or []
    er = records.get("emergency") or {}
    p = records.get("patient") or {}
    adm = records.get("admission") or {}
    any_rx = lambda key: any(r.get(key) for r in rx)
    return {
        "presenting_complaints": bool(p.get("symptoms") or er.get("chief_complaint") or adm.get("reason")
                                      or any(r.get("patient_complaints") for r in rounds)),
        "diagnosis": bool(any_rx("diagnosis") or any(r.get("diagnosis") or r.get("assessment") for r in rounds)),
        "clinical_course": bool(rounds or records.get("observation_notes") or records.get("nursing") or er or rx or adm),
        "key_investigations": bool(records.get("diagnostic_reports")),
        "procedures": bool(records.get("procedures") or records.get("surgeries")),
        "treatment_given": bool(any(r.get("medicines") for r in rx) or records.get("medication_orders") or records.get("inpatient_medications")
                                or records.get("pharmacy_issued") or records.get("procedures") or records.get("surgeries")),
        "condition_at_discharge": bool(any(r.get("patient_condition") for r in rounds) or er.get("disposition") or records.get("vitals")),
        "advice": bool(any_rx("advice")),
        "follow_up": bool(any_rx("follow_up_date")),
    }


def ground_report(report, records, catalogue_drugs=()):
    """Remove AI sentences that state a number/date or a drug that is not in
    the encounter's records, and force sections with no supporting data to
    "Not recorded". Returns (clean_report, warnings)."""
    source = json.dumps(_ai_input(records), default=str, ensure_ascii=False)
    source_lower = source.lower()
    allowed_numbers = _source_numbers(source) | {str(n) for n in range(0, 13)}
    enc = records.get("encounter") or {}
    s, e = _to_dt(enc.get("start")), _to_dt(enc.get("end")) or _now()
    if s:
        allowed_numbers.add(str(max((e.date() - s.date()).days, 0)))
        allowed_numbers.add(str(max((e.date() - s.date()).days, 0) + 1))
    drugs = {d.lower() for d in COMMON_DRUGS} | {d.lower() for d in catalogue_drugs if d and len(d) >= 4}
    has_data = _section_has_data(records)
    warnings = []
    clean = {}
    for key in REPORT_KEYS:
        value = " ".join(str(report.get(key) or "").split())
        if not value or value.lower().startswith("not recorded"):
            clean[key] = NOT_RECORDED
            continue
        if key != "summary" and not has_data.get(key, True):
            warnings.append({"section": key, "removed": value, "reasons": ["no supporting data in this visit's records"]})
            clean[key] = NOT_RECORDED
            continue
        kept = []
        for sentence in re.split(r"(?<=[.!?])\s+", value):
            reasons = []
            bad_nums = sorted(n for n in _number_tokens(sentence) if n not in allowed_numbers)
            if bad_nums:
                reasons.append("values not in records: " + ", ".join(bad_nums))
            words = set(re.findall(r"[a-z][a-z\-]{2,}", sentence.lower()))
            bad_drugs = sorted(d for d in drugs if (d in words or (" " in d and d in sentence.lower())) and d not in source_lower)
            if bad_drugs:
                reasons.append("medicines not in records: " + ", ".join(bad_drugs))
            if reasons:
                warnings.append({"section": key, "removed": sentence, "reasons": reasons})
            else:
                kept.append(sentence)
        clean[key] = " ".join(kept).strip() or NOT_RECORDED
    return clean, warnings


def catalogue_drug_words(db):
    """First distinctive word of every medicine the hospital knows (catalogue,
    stock, prescriptions) -- used to spot AI-mentioned drugs."""
    words = set()
    with get_connection(db) as conn:
        cursor = conn.cursor()
        for sql in ("SELECT DISTINCT name AS n FROM medicines", "SELECT DISTINCT medicine_name AS n FROM pharmacy_inventory",
                    "SELECT DISTINCT medicine_name AS n FROM prescription_medicines"):
            try:
                cursor.execute(sql + " LIMIT 5000")
                rows = cursor.fetchall()
            except Exception:
                continue
            for r in rows:
                for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}", str(r["n"] or "")):
                    if w.lower() not in ("tablet", "tablets", "capsule", "capsules", "syrup", "injection", "cream", "drops", "oral", "suspension"):
                        words.add(w.lower())
                        break
    return words


def generate_discharge_summary(records, catalogue_drugs=()):
    prompt = SUMMARY_PROMPT + json.dumps(_ai_input(records), default=str, ensure_ascii=False)
    try:
        raw = _chat(prompt, max_tokens=2048)
    except RuntimeError:
        raise
    except Exception as exc:  # network/parse errors from the model client
        raise RuntimeError(f"The AI model could not be reached: {exc}") from exc
    parsed = _parse_json_object(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("The AI model did not return a readable summary. Please try again.")
    report, warnings = ground_report(parsed, records, catalogue_drugs)
    meds, med_source = build_discharge_medications(records)
    report["discharge_medications"] = meds
    return {
        "report": report,
        "warnings": warnings,
        "medication_source": med_source,
        "generated_at": _now().isoformat(timespec="seconds"),
        "model": QWEN_OCR_MODEL,
    }


# ------------------------------------------------------------ persistence --

STATUSES = ("DRAFT", "PENDING_REVIEW", "APPROVED", "FINALIZED")


class ConflictError(Exception):
    pass
MAX_FIELD = 5000
MAX_MEDS = 60


def _rows(db, sql, params=None):
    return [dict(r) for r in db.execute(text(sql), params or {}).mappings().all()]


def _row(db, sql, params=None):
    found = _rows(db, sql, params)
    return found[0] if found else None


def normalize_content(content, medications):
    if not isinstance(content, dict):
        raise ValueError("Summary content must be an object with the report sections.")
    clean = {}
    for key in REPORT_KEYS:
        value = content.get(key)
        if value is not None and not isinstance(value, (str, int, float)):
            raise ValueError(f"'{key}' must be text.")
        value = str(value or "").strip()
        if len(value) > MAX_FIELD:
            raise ValueError(f"'{key}' is longer than {MAX_FIELD} characters.")
        clean[key] = value
    if medications is None:
        medications = []
    if not isinstance(medications, list):
        raise ValueError("discharge_medications must be a list.")
    if len(medications) > MAX_MEDS:
        raise ValueError(f"At most {MAX_MEDS} discharge medications are allowed.")
    meds = []
    for i, m in enumerate(medications, start=1):
        if not isinstance(m, dict):
            raise ValueError(f"Medication {i} is invalid.")
        row = {k: str(m.get(k) or "").strip()[:300] for k in MED_KEYS}
        if not row["medicine"]:
            if any(row.values()):
                raise ValueError(f"Medication {i}: medicine name is required.")
            continue
        row["source"] = str(m.get("source") or "Added by doctor").strip()[:200]
        pid = m.get("prescription_id")
        row["prescription_id"] = int(pid) if isinstance(pid, (int, float)) or (isinstance(pid, str) and pid.isdigit()) else None
        meds.append(row)
    return clean, meds


def finalization_errors(content, meds):
    errors = []
    for key, label in (("diagnosis", "Diagnosis"), ("condition_at_discharge", "Condition at discharge"), ("follow_up", "Follow-up")):
        v = (content.get(key) or "").strip()
        if not v or v.lower() == NOT_RECORDED.lower():
            errors.append(f"{label} is required before finalising.")
    for i, m in enumerate(meds, start=1):
        if not m.get("dosage") or not m.get("frequency"):
            errors.append(f"Medication {i} ({m.get('medicine')}): dosage and frequency are required.")
    return errors


def _summary_row(db, hospital_id, summary_id, lock=False):
    return _row(db, "SELECT * FROM discharge_summaries WHERE id = :id AND hospital_id = :hid" + (" FOR UPDATE" if lock else ""),
                {"id": summary_id, "hid": hospital_id})


def _serialize(row):
    if not row:
        return None
    out = dict(row)
    for k in ("content", "medications", "ai_warnings", "records_snapshot"):
        if isinstance(out.get(k), str):
            out[k] = json.loads(out[k])
    # The frozen source records are kept for the audit trail, not sent to the page.
    out["has_records_snapshot"] = out.pop("records_snapshot", None) is not None
    return out


def get_summary_for_encounter(db, hospital_id, patient_id, encounter_type, encounter_id):
    return _serialize(_row(db, """
        SELECT * FROM discharge_summaries
        WHERE hospital_id = :hid AND patient_id = :pid AND encounter_type = :et AND encounter_id = :eid
    """, {"hid": hospital_id, "pid": patient_id, "et": encounter_type, "eid": encounter_id}))


def get_summary(db, hospital_id, summary_id, include_versions=True):
    row = _serialize(_summary_row(db, hospital_id, summary_id))
    if row and include_versions:
        row["versions"] = _rows(db, """
            SELECT version, status, change_type, change_note, changed_by, changed_at
            FROM discharge_summary_versions WHERE summary_id = :id ORDER BY version DESC
        """, {"id": summary_id})
    return row


def get_summary_version(db, hospital_id, summary_id, version):
    if not _summary_row(db, hospital_id, summary_id):
        return None
    row = _row(db, "SELECT * FROM discharge_summary_versions WHERE summary_id = :id AND version = :v", {"id": summary_id, "v": version})
    if row:
        for k in ("content", "medications"):
            if isinstance(row.get(k), str):
                row[k] = json.loads(row[k])
    return row


def list_summaries(db, hospital_id, patient_id):
    return _rows(db, """
        SELECT id, patient_id, encounter_type, encounter_id, encounter_label, status, current_version, ai_generated,
               created_by, created_at, updated_by, updated_at, approved_by, approved_at, finalized_by, finalized_at
        FROM discharge_summaries WHERE hospital_id = :hid AND patient_id = :pid ORDER BY updated_at DESC
    """, {"hid": hospital_id, "pid": patient_id})


def _add_version(db, summary_id, version, status, content, meds, change_type, note, username):
    db.execute(text("""
        INSERT INTO discharge_summary_versions (summary_id, version, status, content, medications, change_type, change_note, changed_by, changed_at)
        VALUES (:sid, :v, :st, CAST(:c AS JSONB), CAST(:m AS JSONB), :ct, :note, :user, :at)
    """), {"sid": summary_id, "v": version, "st": status, "c": json.dumps(content), "m": json.dumps(meds), "ct": change_type,
           "note": note, "user": username, "at": _now()})


def save_draft(db, hospital_id, patient_id, encounter, payload, username):
    """Create or update the encounter's summary as a DRAFT. `expected_version`
    guards against overwriting someone else's newer save."""
    content, meds = normalize_content(payload.get("content") or {}, payload.get("discharge_medications"))
    warnings = payload.get("ai_warnings") if isinstance(payload.get("ai_warnings"), list) else []
    ai_generated = bool(payload.get("ai_generated"))
    existing = _row(db, """
        SELECT * FROM discharge_summaries WHERE hospital_id = :hid AND patient_id = :pid AND encounter_type = :et AND encounter_id = :eid FOR UPDATE
    """, {"hid": hospital_id, "pid": patient_id, "et": encounter["type"], "eid": encounter["id"]})
    now = _now()
    if not existing:
        summary_id = db.execute(text("""
            INSERT INTO discharge_summaries (hospital_id, patient_id, encounter_type, encounter_id, encounter_label, status, current_version,
                content, medications, ai_generated, ai_model, ai_warnings, created_by, created_at, updated_by, updated_at)
            VALUES (:hid, :pid, :et, :eid, :label, 'DRAFT', 1, CAST(:c AS JSONB), CAST(:m AS JSONB), :ai, :model, CAST(:w AS JSONB), :user, :now, :user, :now)
            RETURNING id
        """), {"hid": hospital_id, "pid": patient_id, "et": encounter["type"], "eid": encounter["id"], "label": encounter.get("label"),
               "c": json.dumps(content), "m": json.dumps(meds), "ai": ai_generated, "model": payload.get("ai_model") if ai_generated else None,
               "w": json.dumps(warnings[:100]), "user": username, "now": now}).scalar_one()
        _add_version(db, summary_id, 1, "DRAFT", content, meds, "created", payload.get("change_note"), username)
        db.commit()
        return get_summary(db, hospital_id, summary_id)

    if existing["status"] == "FINALIZED":
        raise PermissionError("This summary is finalised. Start an amendment to change it.")
    expected = payload.get("expected_version")
    if expected is not None and int(expected) != int(existing["current_version"]):
        raise ConflictError(f"This summary was changed by {existing['updated_by'] or 'someone else'} (now version {existing['current_version']}). Reload before saving.")
    old_content = existing["content"] if isinstance(existing["content"], dict) else json.loads(existing["content"])
    old_meds = existing["medications"] if isinstance(existing["medications"], list) else json.loads(existing["medications"])
    if old_content == content and old_meds == meds and existing["status"] == "DRAFT":
        return get_summary(db, hospital_id, existing["id"])
    version = existing["current_version"] + 1
    note = payload.get("change_note") or ("Edited after review; back to draft" if existing["status"] != "DRAFT" else None)
    db.execute(text("""
        UPDATE discharge_summaries SET content = CAST(:c AS JSONB), medications = CAST(:m AS JSONB), status = 'DRAFT', current_version = :v,
               ai_generated = ai_generated OR :ai, ai_model = COALESCE(:model, ai_model),
               ai_warnings = CASE WHEN :ai THEN CAST(:w AS JSONB) ELSE ai_warnings END,
               approved_by = NULL, approved_at = NULL, approval_note = NULL, updated_by = :user, updated_at = :now
        WHERE id = :id
    """), {"c": json.dumps(content), "m": json.dumps(meds), "v": version, "ai": ai_generated,
           "model": payload.get("ai_model") if ai_generated else None, "w": json.dumps(warnings[:100]), "user": username, "now": now, "id": existing["id"]})
    _add_version(db, existing["id"], version, "DRAFT", content, meds, "ai_regenerated" if ai_generated else "saved", note, username)
    db.commit()
    return get_summary(db, hospital_id, existing["id"])


TRANSITIONS = {
    # action: (allowed from, to, change_type)
    "submit": (("DRAFT",), "PENDING_REVIEW", "submitted"),
    "approve": (("DRAFT", "PENDING_REVIEW"), "APPROVED", "approved"),
    "return": (("PENDING_REVIEW", "APPROVED"), "DRAFT", "returned"),
    "finalize": (("APPROVED",), "FINALIZED", "finalized"),
    "amend": (("FINALIZED",), "DRAFT", "amendment_started"),
}


def transition(db, hospital_id, summary_id, action, username, note=None, expected_version=None, records_snapshot=None):
    if action not in TRANSITIONS:
        raise ValueError("Unknown action.")
    allowed, target, change_type = TRANSITIONS[action]
    row = _summary_row(db, hospital_id, summary_id, lock=True)
    if not row:
        return None
    if row["status"] not in allowed:
        raise PermissionError(f"Cannot {action} a summary that is {row['status'].replace('_', ' ').lower()}.")
    if expected_version is not None and int(expected_version) != int(row["current_version"]):
        raise ConflictError(f"This summary is now version {row['current_version']}. Reload before continuing.")
    note = (note or "").strip()[:1000] or None
    if action in ("return", "amend") and not note:
        raise ValueError("A reason is required.")
    content = row["content"] if isinstance(row["content"], dict) else json.loads(row["content"])
    meds = row["medications"] if isinstance(row["medications"], list) else json.loads(row["medications"])
    if action in ("approve", "finalize"):
        errors = finalization_errors(content, meds)
        if errors:
            raise ValueError(" ".join(errors))
    now = _now()
    version = row["current_version"] + 1
    sets = {"submit": "submitted_by = :user, submitted_at = :now",
            "approve": "approved_by = :user, approved_at = :now, approval_note = :note",
            "return": "approved_by = NULL, approved_at = NULL, approval_note = :note",
            "finalize": "finalized_by = :user, finalized_at = :now, records_snapshot = CAST(:snap AS JSONB)",
            "amend": "approved_by = NULL, approved_at = NULL, finalized_by = NULL, finalized_at = NULL, amendment_count = amendment_count + 1"}[action]
    db.execute(text(f"""
        UPDATE discharge_summaries SET status = :st, current_version = :v, {sets}, updated_by = :user, updated_at = :now WHERE id = :id
    """), {"st": target, "v": version, "user": username, "now": now, "note": note, "id": summary_id,
           "snap": json.dumps(records_snapshot, default=str) if records_snapshot is not None else None})
    _add_version(db, summary_id, version, target, content, meds, change_type, note, username)
    db.commit()
    return get_summary(db, hospital_id, summary_id)
