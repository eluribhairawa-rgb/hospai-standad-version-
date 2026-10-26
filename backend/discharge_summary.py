"""Patient discharge summary: gathers the patient's real records across modules
(registration, OP/IP/ER encounters, prescriptions, vitals, doctor rounds,
nursing, diagnostics reports, surgeries, pharmacy, billing) and asks the Qwen
model to write a short clinical summary and a structured discharge report.
Only facts present in the gathered records are passed to the model.
"""
import json
from datetime import datetime

import patient_journey
from legacy_sql import get_connection
from qwen_ocr import QWEN_OCR_MODEL, _chat, _parse_json_object

MAX_ROWS = 15
MAX_TEXT = 400


def _iso(value):
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _clip(value, limit=MAX_TEXT):
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


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


def gather_patient_records(db, patient_id, encounter_type=None, encounter_id=None):
    journey = patient_journey.get_patient_journey(db, patient_id, encounter_type, encounter_id)
    if journey is None:
        return None
    selected = journey.get("selected") or {}
    etype = selected.get("encounter_type")
    eid = selected.get("encounter_id")
    admission_id = eid if etype == "IP" else None
    start = (selected.get("start") or "")[:10] or None
    end = (selected.get("end") or "")[:10] or None

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,))
        patient = dict(cursor.fetchone())

        if admission_id:
            cursor.execute(
                "SELECT * FROM patient_vitals WHERE admission_id = ? ORDER BY COALESCE(recorded_at, record_time, created_at)",
                (admission_id,),
            )
        else:
            cursor.execute(
                "SELECT * FROM patient_vitals WHERE patient_id = ? ORDER BY COALESCE(recorded_at, record_time, created_at)",
                (patient_id,),
            )
        vitals = [dict(r) for r in cursor.fetchall()]
        vital_keys = ["recorded_at", "bp", "pulse", "temperature", "spo2", "respiratory_rate", "blood_sugar", "weight", "pain_score", "gcs"]
        vitals_scope = [_compact(v, vital_keys) for v in (vitals[:1] + vitals[-1:] if len(vitals) > 1 else vitals)]

        rx_scope, rx_params = "", ()
        if admission_id:
            rx_scope, rx_params = " AND admission_id = ?", (admission_id,)
        elif etype == "OP" and eid:
            rx_scope, rx_params = " AND appointment_id = ?", (eid,)
        cursor.execute(
            "SELECT * FROM prescriptions WHERE patient_id = ? AND COALESCE(dispense_status, '') <> 'superseded'"
            f"{rx_scope} ORDER BY id DESC LIMIT ?",
            (patient_id, *rx_params, MAX_ROWS),
        )
        prescriptions = []
        for rx in cursor.fetchall():
            cursor.execute(
                "SELECT medicine_name, dosage, frequency, duration, instructions FROM prescription_medicines WHERE prescription_id = ? ORDER BY id",
                (rx["id"],),
            )
            meds = [_compact(dict(m), ["medicine_name", "dosage", "frequency", "duration", "instructions"]) for m in cursor.fetchall()]
            entry = _compact(dict(rx), ["created_at", "doctor_name", "department", "diagnosis", "lab_tests", "advice", "follow_up_date"])
            entry["medicines"] = meds
            prescriptions.append(entry)

        date_filter = ""
        date_params = ()
        if start:
            date_filter = " AND round_date >= ?" + (" AND round_date <= ?" if end else "")
            date_params = (start, end) if end else (start,)
        rounds = []
        if etype == "IP":
            cursor.execute(
                f"SELECT * FROM doctor_rounds WHERE patient_id = ?{date_filter} ORDER BY round_date, round_time LIMIT ?",
                (patient_id, *date_params, MAX_ROWS),
            )
            rounds = [_compact(dict(r), ["round_date", "doctor_name", "patient_complaints", "clinical_findings", "assessment",
                                         "diagnosis", "progress_notes", "patient_condition"]) for r in cursor.fetchall()]

        observations, nursing, round_meds, procedures = [], [], [], []
        if admission_id:
            cursor.execute("SELECT * FROM observation_notes WHERE admission_id = ? ORDER BY created_at LIMIT ?", (admission_id, MAX_ROWS))
            observations = [_compact(dict(r), ["created_at", "doctor_name", "note", "treatment_plan"]) for r in cursor.fetchall()]
            cursor.execute("SELECT * FROM nursing_care_logs WHERE admission_id = ? ORDER BY log_date DESC, log_time DESC LIMIT ?", (admission_id, MAX_ROWS))
            nursing = [_compact(dict(r), ["log_date", "activity", "remarks", "status"]) for r in cursor.fetchall()]
        if etype == "IP" and start:
            cursor.execute(
                "SELECT m.* FROM doctor_round_medications m JOIN doctor_rounds r ON r.id = m.round_id "
                f"WHERE m.patient_id = ?{date_filter.replace('round_date', 'r.round_date')} ORDER BY m.id LIMIT ?",
                (patient_id, *date_params, MAX_ROWS * 2),
            )
            round_meds = [_compact(dict(r), ["medicine_name", "strength", "dosage", "frequency", "route", "status"]) for r in cursor.fetchall()]
            cursor.execute(
                "SELECT p.* FROM doctor_round_procedures p JOIN doctor_rounds r ON r.id = p.round_id "
                f"WHERE p.patient_id = ?{date_filter.replace('round_date', 'r.round_date')} ORDER BY p.id LIMIT ?",
                (patient_id, *date_params, MAX_ROWS),
            )
            procedures = [_compact(dict(r), ["procedure_name", "status", "remarks"]) for r in cursor.fetchall()]

        cursor.execute(
            "SELECT * FROM ot_surgeries WHERE patient_id = ?"
            + (" AND CAST(scheduled_start AS DATE) >= ?" if start else "")
            + (" AND CAST(scheduled_start AS DATE) <= ?" if start and end else "")
            + " ORDER BY scheduled_start LIMIT ?",
            (patient_id, *([start] if start else []), *([end] if start and end else []), MAX_ROWS),
        )
        surgeries = [_compact(dict(r), ["scheduled_start", "procedure_name", "surgeon_name", "status", "notes"]) for r in cursor.fetchall()]

        diag_scope = ""
        diag_params = [patient_id]
        if admission_id:
            diag_scope = " AND (o.admission_id = ? OR o.encounter_type = 'IP')"
            diag_params.append(admission_id)
        elif etype == "OP":
            diag_scope = " AND o.admission_id IS NULL"
        cursor.execute(
            "SELECT oi.service_name, oi.department_type, r.content, r.released_at FROM diag_reports r "
            "JOIN diag_order_items oi ON oi.id = r.order_item_id JOIN diag_orders o ON o.id = oi.order_id "
            f"WHERE o.patient_id = ? AND r.status = 'released'{diag_scope} ORDER BY r.released_at LIMIT ?",
            (*diag_params, MAX_ROWS),
        )
        reports = [
            {"test": r["service_name"], "type": r["department_type"], "released_at": _iso(r["released_at"]), "result": _report_text(r["content"])}
            for r in cursor.fetchall()
        ]

        emergency = None
        if etype == "EMERGENCY":
            cursor.execute("SELECT * FROM encounters WHERE id = ?", (eid,))
            row = cursor.fetchone()
            if row:
                emergency = _compact(dict(row), ["arrival_at", "chief_complaint", "triage_priority", "attending_doctor",
                                                 "disposition", "disposition_notes", "disposition_at"])

    pharmacy_items = []
    for e in journey.get("events", []):
        if e.get("type") == "pharmacy_issued":
            pharmacy_items.extend(f"{i['name']} x{i['quantity']}" for i in (e.get("items") or []))

    return {
        "patient": _compact(patient, ["patient_id", "name", "middle_name", "last_name", "age", "gender", "dob", "blood_group",
                                      "allergies", "allergy_status", "medical_history", "current_medication", "symptoms",
                                      "phone", "address", "insurance_provider"]),
        "encounter": {
            "type": etype, "id": eid, "label": selected.get("label"), "start": selected.get("start"), "end": selected.get("end"),
            "status": selected.get("status"), "ward": selected.get("ward"), "bed_no": selected.get("bed_no"),
            "attending_doctor": journey.get("doctor_name"),
        } if selected else None,
        "emergency": emergency,
        "vitals": vitals_scope,
        "prescriptions": prescriptions,
        "doctor_rounds": rounds,
        "observation_notes": observations,
        "inpatient_medications": round_meds,
        "procedures": procedures,
        "surgeries": surgeries,
        "nursing": nursing,
        "diagnostic_reports": reports,
        "pharmacy_issued": pharmacy_items[: MAX_ROWS * 2],
        "timeline": [
            _compact(e, ["date", "title", "subtitle"]) for e in journey.get("events", [])
            if e.get("type") not in ("payment",)
        ][: MAX_ROWS * 3],
        "billing": journey.get("financial_summary"),
        "encounters": [
            {"label": e["label"], "start": e["start"], "status": e["status"]} for e in journey.get("encounters", [])
        ],
    }


SUMMARY_PROMPT = """You are a hospital physician writing a patient discharge summary.
Use ONLY the facts in the patient records JSON below. Do not invent diagnoses, results, drugs, or dates.
If a section has no supporting data, use "Not recorded".

Return ONLY a JSON object with exactly these keys:
{
  "summary": "3-4 sentence clinical summary: who the patient is, why they came, key findings/diagnosis, treatment given, and condition/outcome",
  "presenting_complaints": "",
  "diagnosis": "",
  "clinical_course": "",
  "key_investigations": "",
  "procedures": "",
  "treatment_given": "",
  "condition_at_discharge": "",
  "discharge_medications": [{"medicine": "", "dosage": "", "frequency": "", "duration": "", "instructions": ""}],
  "advice": "",
  "follow_up": ""
}

Rules:
- "summary" must be 3 or 4 sentences of plain prose, no bullet points.
- discharge_medications: from the latest prescription; [] if none.
- Keep each other section concise (1-3 sentences).
- No code fences, no commentary, only the JSON object.

Patient records JSON:
"""

REPORT_KEYS = ("summary", "presenting_complaints", "diagnosis", "clinical_course", "key_investigations", "procedures",
               "treatment_given", "condition_at_discharge", "advice", "follow_up")
MED_KEYS = ("medicine", "dosage", "frequency", "duration", "instructions")


def generate_discharge_summary(records):
    prompt = SUMMARY_PROMPT + json.dumps(records, default=str, ensure_ascii=False)
    raw = _chat(prompt, max_tokens=2048)
    parsed = _parse_json_object(raw)
    if parsed is None:
        raise RuntimeError("The AI model did not return a readable summary. Please try again.")
    report = {k: " ".join(str(parsed.get(k) or "").split()) or "Not recorded" for k in REPORT_KEYS}
    meds = parsed.get("discharge_medications") if isinstance(parsed.get("discharge_medications"), list) else []
    report["discharge_medications"] = [
        {k: str(m.get(k) or "").strip() for k in MED_KEYS} for m in meds if isinstance(m, dict) and m.get("medicine")
    ]
    return {
        "report": report,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": QWEN_OCR_MODEL,
    }
