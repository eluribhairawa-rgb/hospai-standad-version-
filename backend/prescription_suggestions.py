"""Medicines and lab tests usually prescribed for a diagnosis, learned from this
hospital's own saved prescriptions. Plain frequency counts, no model: the doctor's
own prescriptions are used when there are enough of them, otherwise every doctor's.
"""
import re
from collections import Counter, defaultdict

from legacy_sql import get_connection

MIN_DOCTOR_PRESCRIPTIONS = 3
LOOKBACK_PRESCRIPTIONS = 200
MAX_MEDICINES = 8
MAX_LAB_TESTS = 6
MED_DETAIL_KEYS = ("dosage", "frequency", "duration", "instructions", "is_custom", "freq_custom")


def _norm(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def aggregate(prescriptions, medicines):
    """prescriptions: [{id, lab_tests}], medicines: [{prescription_id, medicine_name, dosage, ...}].
    Counts each medicine / test once per prescription; a medicine's dosage, frequency etc.
    is its most common combination. With 5+ prescriptions, one-off items are left out."""
    total = len(prescriptions)
    min_count = 2 if total >= 5 else 1

    med_rx = defaultdict(set)
    med_names = defaultdict(Counter)
    med_details = defaultdict(Counter)
    for m in medicines:
        key = _norm(m.get("medicine_name"))
        if not key:
            continue
        med_rx[key].add(m.get("prescription_id"))
        med_names[key][str(m.get("medicine_name")).strip()] += 1
        med_details[key][tuple(m.get(k) or ("" if k != "is_custom" else 0) for k in MED_DETAIL_KEYS)] += 1
    meds = []
    for key, rx_ids in sorted(med_rx.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if len(rx_ids) < min_count or len(meds) >= MAX_MEDICINES:
            continue
        detail = dict(zip(MED_DETAIL_KEYS, med_details[key].most_common(1)[0][0]))
        detail["is_custom"] = bool(detail["is_custom"])
        meds.append({"medicine_name": med_names[key].most_common(1)[0][0], **detail, "count": len(rx_ids)})

    test_counts = Counter()
    test_names = defaultdict(Counter)
    for p in prescriptions:
        seen = set()
        for raw in re.split(r"[,;\n]+", p.get("lab_tests") or ""):
            key = _norm(raw)
            if key and key not in seen:
                seen.add(key)
                test_counts[key] += 1
                test_names[key][raw.strip()] += 1
    tests = [
        {"name": test_names[key].most_common(1)[0][0], "count": count}
        for key, count in sorted(test_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        if count >= min_count
    ][:MAX_LAB_TESTS]
    return {"prescription_count": total, "medicines": meds, "lab_tests": tests}


def suggest_for_diagnosis(db, diagnosis, doctor_name=None):
    term = re.sub(r"\s+", " ", re.sub(r"[%_\\]", " ", diagnosis or "")).strip()
    empty = {"source": None, "prescription_count": 0, "medicines": [], "lab_tests": []}
    if len(term) < 3:
        return empty
    with get_connection(db) as conn:
        cursor = conn.cursor()

        def fetch(doctor):
            sql = ("SELECT id, lab_tests FROM prescriptions WHERE diagnosis ILIKE ? "
                   "AND COALESCE(dispense_status, '') <> 'superseded'")
            params = [f"%{term}%"]
            if doctor:
                sql += " AND LOWER(TRIM(doctor_name)) = LOWER(?)"
                params.append(doctor)
            cursor.execute(sql + f" ORDER BY created_at DESC LIMIT {LOOKBACK_PRESCRIPTIONS}", tuple(params))
            return [dict(r) for r in cursor.fetchall()]

        doctor = (doctor_name or "").strip()
        source = "doctor"
        rows = fetch(doctor) if doctor else []
        if len(rows) < MIN_DOCTOR_PRESCRIPTIONS:
            source, rows = "all", fetch(None)
        if not rows:
            return empty
        cursor.execute(
            "SELECT prescription_id, medicine_name, dosage, frequency, duration, instructions, is_custom, freq_custom "
            "FROM prescription_medicines WHERE prescription_id = ANY(?)",
            ([r["id"] for r in rows],),
        )
        medicines = [dict(r) for r in cursor.fetchall()]
    return {"source": source, **aggregate(rows, medicines)}
