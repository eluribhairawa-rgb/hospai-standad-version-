"""Real, per-patient chronological journey (registration through discharge/
disposition) with an itemized financial summary, payments list, and document
availability -- assembled from the hospital's real transactional tables
(admissions, appointments, encounters, diag_orders/items, pharmacy_sales,
bed_allocations, invoices, invoice_payments). Nothing here is sample data:
an event, a charge, or a document only appears if a real row backs it.
"""
from datetime import datetime, timedelta

from database import IST_TIMEZONE
from legacy_sql import get_connection


def _iso(value):
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _split_dt(value):
    """('2026-09-20', '08:45') from a date/datetime, or (None, None)."""
    iso = _iso(value)
    if not iso:
        return None, None
    return iso[:10], (iso[11:16] if len(iso) > 10 else "00:00")


ADMISSION_NOTE_FIELDS = {
    "admission type": "admission_type", "department": "department", "consulting doctor": "consulting_doctor",
    "triage acuity": "triage", "reason": "reason", "expected stay": "expected_stay", "allocated bed": "bed",
}


def parse_admission_notes(notes):
    """The admission form stores its answers as 'Key: value | Key: value' in
    admissions.notes -- turn that into a dict of the fields the journey can show."""
    out = {}
    for part in str(notes or "").split("|"):
        key, sep, value = part.partition(":")
        field = ADMISSION_NOTE_FIELDS.get(key.strip().lower())
        if sep and field and value.strip():
            out[field] = " ".join(value.split())
    return out


def _dr(name):
    """'Dr. Name' without doubling a prefix the stored name already has."""
    n = str(name or "").strip()
    return n if not n or n.lower().startswith("dr") and n[2:3] in (".", " ") else f"Dr. {n}"


def _rate(b):
    return float(b.get("amount_per_day") or b.get("daily_charge") or 0)


def _parse_dt(value):
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=None)
    except Exception:
        return None


def _bed_days(b, now):
    """Days billed on one bed: started-day rounded up, like the discharge bill (at least 1)."""
    start = _parse_dt(b.get("allocated_at"))
    if not start:
        return int(b.get("total_days") or 1)
    end = _parse_dt(b.get("released_at")) or now
    return max(1, int(-(-(end - start).total_seconds() // 86400)))


def _bed_label(b):
    return " · ".join(p for p in [b.get("ward"), b.get("room_no"), f"Bed {b['bed_no']}" if b.get("bed_no") else ""] if p)


def _all(cursor):
    return [dict(r) for r in cursor.fetchall()]


def _ip_stay_events(cursor, patient_id, admission_id, admission, beds, window_start, window_end):
    """Everything that happened during an inpatient stay: each bed the patient
    occupied, doctor rounds, vitals, observation notes, medication orders and surgeries."""
    events = []
    for b in beds:
        d, t = _split_dt(b.get("allocated_at"))
        events.append({"date": d, "time": t, "type": "bed_allocated", "title": "Bed allotted" if b is beds[0] else "Bed transfer",
                        "subtitle": " · ".join(p for p in [
                            _bed_label(b), b.get("bed_type") or "",
                            f"₹{_rate(b):,.0f}/day" if _rate(b) else "",
                            _dr(b.get("assigned_doctor")),
                        ] if p), "charge": None, "received": None})
        if b.get("released_at"):
            d, t = _split_dt(b["released_at"])
            events.append({"date": d, "time": t, "type": "bed_released", "title": "Bed released", "subtitle": _bed_label(b),
                            "charge": None, "received": None})

    d0, d1 = (window_start or "")[:10] or "0001-01-01", (window_end or "")[:10] or "9999-12-31"

    cursor.execute("SELECT * FROM doctor_rounds WHERE patient_id = ? AND round_date >= ? AND round_date <= ? ORDER BY round_date, round_time",
                   (patient_id, d0, d1))
    for r in _all(cursor):
        parts = [_dr(r["doctor_name"]),
                 f"Diagnosis: {r['diagnosis']}" if r["diagnosis"] else "",
                 f"Assessment: {r['assessment']}" if r["assessment"] else "",
                 f"Condition: {r['patient_condition']}" if r["patient_condition"] else "",
                 f"Notes: {r['progress_notes']}" if r["progress_notes"] else ""]
        events.append({"date": _iso(r["round_date"])[:10], "time": (r["round_time"] or "00:00")[:5], "type": "doctor_round",
                        "title": "Doctor round", "subtitle": " · ".join(p for p in parts if p), "charge": None, "received": None})

    cursor.execute("SELECT * FROM doctor_patient_transfers WHERE admission_id = ? ORDER BY created_at, id", (admission_id,))
    for t in _all(cursor):
        d, t_ = _split_dt(t["created_at"])
        events.append({"date": d, "time": t_, "type": "doctor_transfer", "title": "Transferred to another doctor",
                        "subtitle": " · ".join(x for x in [f"{_dr(t['from_doctor'])} ({t['from_department']})" if t.get("from_doctor") else "",
                                                           f"to {_dr(t['to_doctor'])} ({t['to_department']})", t.get("reason") or ""] if x),
                        "charge": None, "received": None})

    # Attending doctor's clinical notes (Doctor Clinicals module).
    READY = {"not_assessed": "", "not_ready": "Not ready for discharge", "improving": "Improving", "ready_24h": "Ready within 24 h", "ready": "Ready for discharge"}
    cursor.execute("SELECT * FROM doctor_clinical_notes WHERE admission_id = ? ORDER BY created_at, id", (admission_id,))
    for n in _all(cursor):
        d, t = _split_dt(n["created_at"])
        summary = [_dr(n["doctor_name"]) + (f" (entered by nurse {n['created_by']})" if n.get("entered_role") == "nurse" else ""), f"Diagnosis: {n['diagnosis']}" if n["diagnosis"] else "",
                   READY.get(n["discharge_readiness"], ""),
                   (n["objective_analysis"] or n["subjective"] or "")[:140]]
        events.append({"date": d, "time": t, "type": "doctor_note", "title": "Doctor clinical note",
                        "subtitle": " · ".join(x for x in summary if x), "charge": None, "received": None,
                        "clinical_note": {
                            "id": n["id"], "doctor": n["doctor_name"], "subjective": n["subjective"] or "",
                            "objective_analysis": n["objective_analysis"] or "", "diagnosis": n["diagnosis"] or "",
                            "treatment_plan": n["treatment_plan"] or "", "prognosis": n["prognosis"] or "",
                            "presenting_complaints": n.get("presenting_complaints") or "", "clinical_course": n.get("clinical_course") or "",
                            "key_investigations": n.get("key_investigations") or "", "procedures": n.get("procedures") or "",
                            "treatment_given": n.get("treatment_given") or "", "condition_at_discharge": n.get("condition_at_discharge") or "",
                            "advice": n.get("advice") or "", "follow_up": n.get("follow_up") or "",
                            "discharge_readiness": READY.get(n["discharge_readiness"], "") or "Not assessed",
                        }})

    cursor.execute("SELECT * FROM patient_vitals WHERE patient_id = ? AND admission_id = ? ORDER BY COALESCE(recorded_at, record_time, created_at)",
                   (patient_id, admission_id))
    for v in _all(cursor):
        d, t = _split_dt(v["recorded_at"] or v["record_time"] or v["created_at"])
        vals = [f"BP {v['bp']}" if v["bp"] else "", f"Pulse {v['pulse']}" if v["pulse"] else "",
                f"Temp {v['temperature']} °C" if v["temperature"] else "", f"SpO2 {v['spo2']}%" if v["spo2"] else "",
                f"RR {v['respiratory_rate']}" if v.get("respiratory_rate") else "", f"Sugar {v['blood_sugar']}" if v.get("blood_sugar") else ""]
        events.append({"date": d, "time": t, "type": "vitals", "title": "Vitals recorded",
                        "subtitle": " · ".join(x for x in vals if x) or "Vitals recorded", "charge": None, "received": None})

    cursor.execute("SELECT * FROM observation_notes WHERE patient_id = ? AND admission_id = ? ORDER BY created_at", (patient_id, admission_id))
    for n in _all(cursor):
        d, t = _split_dt(n["created_at"])
        events.append({"date": d, "time": t, "type": "observation_note", "title": "Doctor observation note",
                        "subtitle": " · ".join(p for p in [_dr(n["doctor_name"]), n["note"] or "",
                                                           f"Plan: {n['treatment_plan']}" if n["treatment_plan"] else ""] if p),
                        "charge": None, "received": None})

    cursor.execute("SELECT * FROM ward_indents WHERE patient_id = ? AND admission_id = ? ORDER BY created_at", (patient_id, admission_id))
    for ind in _all(cursor):
        cursor.execute("SELECT medicine_name, dose, frequency, route FROM ward_indent_items WHERE indent_id = ? AND COALESCE(status, '') <> 'cancelled' ORDER BY id",
                       (ind["id"],))
        meds = [" ".join(str(x) for x in (m["medicine_name"], m["dose"], m["frequency"]) if x) for m in _all(cursor)]
        d, t = _split_dt(ind["created_at"])
        events.append({"date": d, "time": t, "type": "medication_order", "title": "Ward medication order",
                        "subtitle": " · ".join(p for p in [ind["indent_no"], (ind["status"] or "").title(),
                                                           _dr(ind["doctor_name"]),
                                                           ", ".join(meds)] if p), "charge": None, "received": None})

    cursor.execute("SELECT * FROM ot_surgeries WHERE patient_id = ? AND scheduled_start >= ? AND scheduled_start <= ? ORDER BY scheduled_start",
                   (patient_id, f"{d0} 00:00:00", f"{d1} 23:59:59"))
    for sg in _all(cursor):
        d, t = _split_dt(sg["scheduled_start"])
        events.append({"date": d, "time": t, "type": "surgery", "title": f"Surgery · {sg['procedure_name']}",
                        "subtitle": " · ".join(p for p in [_dr(sg["surgeon_name"]), (sg["status"] or "").replace("_", " ").title(), sg["notes"] or ""] if p),
                        "charge": None, "received": None})
    return events


def _patient_name(row):
    return " ".join(p for p in [row.get("name"), row.get("last_name")] if p).strip() or row.get("patient_id")


def list_patient_journey_encounters(db, patient_id):
    """Every real visit for this patient (OP appointment, IPD admission,
    Emergency encounter), newest first -- powers the encounter selector."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        encounters = []

        cursor.execute(
            """
            SELECT a.id, a.admission_date, a.discharge_date,
                   ba.ward, ba.bed_no
            FROM admissions a
            LEFT JOIN LATERAL (
                SELECT ward, bed_no FROM bed_allocations
                WHERE admission_id = a.id ORDER BY allocated_at DESC LIMIT 1
            ) ba ON TRUE
            WHERE a.patient_id = ? AND COALESCE(a.notes, '') != 'Initial registration'
            ORDER BY a.admission_date DESC
            """,
            (patient_id,),
        )
        for row in cursor.fetchall():
            encounters.append({
                "key": f"IP:{row['id']}",
                "encounter_type": "IP",
                "encounter_id": row["id"],
                "label": f"IPD · ADM-{row['id']}",
                "start": _iso(row["admission_date"]),
                "end": _iso(row["discharge_date"]),
                "status": "Discharged" if row["discharge_date"] else "Active",
                "ward": row["ward"],
                "bed_no": row["bed_no"],
            })

        cursor.execute(
            """
            SELECT id, appointment_date, status, department, doctor_name
            FROM appointments
            WHERE patient_id = ? AND LOWER(COALESCE(visit_type, '')) != 'emergency'
            ORDER BY appointment_date DESC
            """,
            (patient_id,),
        )
        for row in cursor.fetchall():
            encounters.append({
                "key": f"OP:{row['id']}",
                "encounter_type": "OP",
                "encounter_id": row["id"],
                "label": f"OP · APT-{row['id']}",
                "start": _iso(row["appointment_date"]),
                "end": _iso(row["appointment_date"]),
                "status": (row["status"] or "scheduled").replace("_", " ").title(),
                "ward": None,
                "bed_no": None,
            })

        cursor.execute(
            """
            SELECT id, arrival_at, disposition, disposition_at
            FROM encounters WHERE patient_id = ? AND encounter_type = 'EMERGENCY'
            ORDER BY arrival_at DESC
            """,
            (patient_id,),
        )
        for row in cursor.fetchall():
            encounters.append({
                "key": f"ER:{row['id']}",
                "encounter_type": "EMERGENCY",
                "encounter_id": row["id"],
                "label": f"Emergency · ENC-{row['id']}",
                "start": _iso(row["arrival_at"]),
                "end": _iso(row["disposition_at"]),
                "status": (row["disposition"] or "Active").replace("_", " ").title(),
                "ward": None,
                "bed_no": None,
            })

        encounters.sort(key=lambda e: e["start"] or "", reverse=True)

        # If no formal admission or appointment exists, check for standalone outpatient pharmacy sales, lab orders, or invoices
        cursor.execute(
            """
            SELECT MIN(sold_at) AS first_sale, MAX(sold_at) AS last_sale, COUNT(*) AS cnt
            FROM pharmacy_sales WHERE patient_id = ? AND admission_id IS NULL
            """,
            (patient_id,),
        )
        pharm_enc = cursor.fetchone()

        cursor.execute(
            """
            SELECT MIN(created_at) AS first_ord, MAX(created_at) AS last_ord, COUNT(*) AS cnt
            FROM diag_orders WHERE patient_id = ? AND admission_id IS NULL
            """,
            (patient_id,),
        )
        diag_enc = cursor.fetchone()

        cursor.execute(
            """
            SELECT MIN(created_at) AS first_inv, MAX(created_at) AS last_inv, COUNT(*) AS cnt
            FROM invoices WHERE patient_id = ? AND UPPER(COALESCE(module, '')) = 'OP'
            """,
            (patient_id,),
        )
        inv_enc = cursor.fetchone()

        has_op = any(e["encounter_type"] == "OP" for e in encounters)
        if not has_op and ((pharm_enc and pharm_enc["cnt"] > 0) or (diag_enc and diag_enc["cnt"] > 0) or (inv_enc and inv_enc["cnt"] > 0)):
            start_dt = _iso((pharm_enc or {}).get("first_sale") or (diag_enc or {}).get("first_ord") or (inv_enc or {}).get("first_inv"))
            end_dt = _iso((pharm_enc or {}).get("last_sale") or (diag_enc or {}).get("last_ord") or (inv_enc or {}).get("last_inv"))
            encounters.append({
                "key": "OP:0",
                "encounter_type": "OP",
                "encounter_id": 0,
                "label": "Outpatient Services",
                "start": start_dt,
                "end": end_dt,
                "status": "Active",
                "ward": None,
                "bed_no": None,
            })

        if not encounters:
            # A registered patient with no visit yet (e.g. vitals captured at registration) still gets a journey.
            cursor.execute("SELECT created_at FROM patients WHERE patient_id = ?", (patient_id,))
            reg = cursor.fetchone()
            if reg:
                encounters.append({
                    "key": "OP:0",
                    "encounter_type": "OP",
                    "encounter_id": 0,
                    "label": "Registration",
                    "start": _iso(reg["created_at"]),
                    "end": _iso(reg["created_at"]),
                    "status": "Registered",
                    "ward": None,
                    "bed_no": None,
                })

        return encounters


def _first_ever(encounters, key):
    """True if `key` (e.g. 'IP:96') is the chronologically earliest real
    visit this patient has -- the only case 'Patient registered' belongs in
    this encounter's own timeline, rather than repeating it on every visit."""
    dated = [e for e in encounters if e["start"]]
    if not dated:
        return True
    earliest = min(dated, key=lambda e: e["start"])
    return earliest["key"] == key


def _prescription_event(cursor, column, value):
    """The doctor's prescription for this visit (latest non-superseded save) as a timeline event."""
    cursor.execute(
        f"SELECT * FROM prescriptions WHERE {column} = ? AND COALESCE(dispense_status, '') <> 'superseded' ORDER BY id DESC LIMIT 1",
        (value,),
    )
    rx = cursor.fetchone()
    if not rx:
        return None, None
    cursor.execute(
        "SELECT medicine_name, dosage, frequency, duration, instructions FROM prescription_medicines WHERE prescription_id = ? ORDER BY id",
        (rx["id"],),
    )
    medicines = [
        {"name": m["medicine_name"], "dosage": m["dosage"] or "", "frequency": m["frequency"] or "",
         "duration": m["duration"] or "", "instructions": m["instructions"] or ""}
        for m in cursor.fetchall()
    ]
    d, t = _split_dt(rx["created_at"])
    subtitle = " · ".join(p for p in [
        _dr(rx["doctor_name"]),
        rx["department"] or "",
        f"Diagnosis: {rx['diagnosis']}" if rx["diagnosis"] else "",
        f"{len(medicines)} medicine(s)",
    ] if p)
    event = {
        "date": d, "time": t, "type": "prescription", "title": "Prescription issued", "subtitle": subtitle,
        "charge": None, "received": None,
        "prescription": {
            "id": rx["id"], "medicines": medicines, "diagnosis": rx["diagnosis"] or "",
            "lab_tests": rx["lab_tests"] or "", "advice": rx["advice"] or "",
            "follow_up_date": _iso(rx["follow_up_date"])[:10] if rx["follow_up_date"] else "",
        },
    }
    return event, rx


def _pharmacy_bill_events(cursor, pharmacy_rows, title="Pharmacy bill"):
    """One event per pharmacy bill (invoice), listing the medicines sold."""
    grouped = {}
    for r in pharmacy_rows:
        key = f"inv:{r['invoice_id']}" if r.get("invoice_id") else f"at:{_iso(r['sold_at'])}"
        grouped.setdefault(key, []).append(r)
    events = []
    for lines in grouped.values():
        invoice_id = lines[0].get("invoice_id")
        invoice_no = None
        gst_amount = 0.0
        invoice_total = None
        if invoice_id:
            cursor.execute("SELECT invoice_no, tax, total_amount FROM invoices WHERE id = ?", (invoice_id,))
            row = cursor.fetchone()
            if row:
                invoice_no = row["invoice_no"]
                gst_amount = float(row["tax"] or 0)
                if row["total_amount"] is not None:
                    invoice_total = float(row["total_amount"])
        d, t = _split_dt(lines[0]["sold_at"])
        subtotal = sum(float(l["amount"] or 0) for l in lines)
        final_charge = invoice_total if invoice_total is not None else round(subtotal + gst_amount, 2)
        events.append({
            "date": d, "time": t, "type": "pharmacy_issued", "title": title,
            "subtitle": " · ".join(p for p in [invoice_no or "", f"{len(lines)} item(s)"] if p),
            # Invoiced sales get their own "Payment received" events; only un-invoiced cash sales are shown as paid here.
            "charge": final_charge, "received": None if invoice_id else final_charge,
            "invoice_no": invoice_no,
            "subtotal": subtotal,
            "gst": gst_amount,
            "items": [{"name": l["medicine_name"], "quantity": l["quantity"], "unit_price": float(l["unit_price"] or 0),
                       "amount": float(l["amount"] or 0)} for l in lines],
        })
    return events


def _lab_bill_events(cursor, diag_items):
    """One event per confirmed lab/diagnostics order bill, listing the tests billed."""
    orders = {}
    for it in diag_items:
        orders.setdefault(it["order_id"], []).append(it)
    events = []
    for order_id, items in orders.items():
        invoice_id = items[0]["discharge_invoice_id"]
        invoice = None
        if invoice_id:
            cursor.execute("SELECT invoice_no, total_amount, paid_amount, created_at FROM invoices WHERE id = ?", (invoice_id,))
            invoice = cursor.fetchone()
        cursor.execute("SELECT order_no FROM diag_orders WHERE id = ?", (order_id,))
        order = cursor.fetchone()
        d, t = _split_dt((invoice["created_at"] if invoice else None) or items[0]["confirmed_at"])
        total = float(invoice["total_amount"] or 0) if invoice else sum(float(i["amount"] or 0) for i in items)
        events.append({
            "date": d, "time": t, "type": "lab_bill", "title": "Lab & diagnostics bill",
            "subtitle": " · ".join(p for p in [
                invoice["invoice_no"] if invoice else "", f"Order {order['order_no']}" if order and order["order_no"] else "",
                f"{len(items)} test(s)",
            ] if p),
            "charge": total, "received": None,
            "invoice_no": invoice["invoice_no"] if invoice else None,
            "items": [{"name": i["service_name"], "quantity": 1, "unit_price": float(i["amount"] or 0), "amount": float(i["amount"] or 0)} for i in items],
        })
    return events


def _diag_scope_rows(cursor, encounter_type, appointment_id, admission_id, patient_id=None):
    if encounter_type == "IP":
        cursor.execute(
            """
            SELECT oi.id AS item_id, oi.service_name, oi.department_type, oi.amount, oi.discharge_invoice_id,
                   o.id AS order_id, o.confirmed_at
            FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
            WHERE (o.admission_id = ? OR (o.patient_id = ? AND o.encounter_type = 'IP'))
              AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
            """,
            (admission_id, patient_id),
        )
    else:
        if appointment_id and appointment_id != 0:
            cursor.execute(
                """
                SELECT oi.id AS item_id, oi.service_name, oi.department_type, oi.amount, o.invoice_id AS discharge_invoice_id,
                       o.id AS order_id, o.confirmed_at, o.created_at AS ordered_at, o.appointment_id
                FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
                WHERE (o.appointment_id = ?
                       OR (o.patient_id = ? AND o.appointment_id IS NULL AND o.admission_id IS NULL AND o.encounter_type = 'OP'))
                  AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
                """,
                (appointment_id, patient_id),
            )
        else:
            cursor.execute(
                """
                SELECT oi.id AS item_id, oi.service_name, oi.department_type, oi.amount, o.invoice_id AS discharge_invoice_id,
                       o.id AS order_id, o.confirmed_at, o.created_at AS ordered_at, o.appointment_id
                FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
                WHERE o.patient_id = ? AND o.admission_id IS NULL AND o.appointment_id IS NULL
                  AND o.encounter_type <> 'EMERGENCY' AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
                """,
                (patient_id,),
            )
    return cursor.fetchall()


def get_patient_journey(db, patient_id, encounter_type=None, encounter_id=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,))
        patient_row = cursor.fetchone()
        if not patient_row:
            return None
        patient = dict(patient_row)

        encounters = list_patient_journey_encounters(db, patient_id)
        if not encounters:
            return {
                "patient": {
                    "patient_id": patient_id, "name": _patient_name(patient),
                    "age": patient.get("age"), "gender": patient.get("gender"),
                    "phone": patient.get("phone"), "phone_country_code": patient.get("phone_country_code"),
                    "address": patient.get("address"), "email": patient.get("email"),
                },
                "encounters": [], "selected": None, "events": [],
                "financial_summary": {"categories": [], "total_charges": 0, "payments_received": 0, "outstanding": 0, "status": "N/A"},
                "payments": [], "documents": [],
            }

        selected = None
        if encounter_type and encounter_id:
            selected = next((e for e in encounters if e["encounter_type"] == encounter_type and str(e["encounter_id"]) == str(encounter_id)), None)
        if not selected:
            selected = encounters[0]

        etype = selected["encounter_type"]
        eid = selected["encounter_id"]
        is_first = _first_ever(encounters, selected["key"])

        events = []
        stay = None
        bill = None
        appt = {}
        visit_end = None
        invoice_ids = set()
        doctor_name = None
        admission_id = None
        appointment_id = None

        if etype == "IP":
            admission_id = eid
            cursor.execute("SELECT * FROM admissions WHERE id = ?", (admission_id,))
            admission = dict(cursor.fetchone() or {})
            cursor.execute(
                "SELECT * FROM bed_allocations WHERE admission_id = ? ORDER BY allocated_at DESC LIMIT 1",
                (admission_id,),
            )
            bed = cursor.fetchone()
            bed = dict(bed) if bed else None
            cursor.execute("SELECT * FROM bed_allocations WHERE admission_id = ? ORDER BY allocated_at, id", (admission_id,))
            all_beds = [dict(b) for b in cursor.fetchall()]
            adm_info = parse_admission_notes(admission.get("notes"))
            cursor.execute("SELECT to_doctor, to_department FROM doctor_patient_transfers WHERE admission_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", (admission_id,))
            moved = cursor.fetchone()
            if moved:
                adm_info["department"] = moved["to_department"] or adm_info.get("department")
            doctor_name = (moved["to_doctor"] if moved else None) or (bed or {}).get("assigned_doctor") or adm_info.get("consulting_doctor")
            stay_start = _parse_dt(admission.get("admission_date"))
            stay_end = _parse_dt(admission.get("discharge_date")) if admission.get("discharge_date") and len(str(admission.get("discharge_date"))) > 10 else None
            now_dt = datetime.now(IST_TIMEZONE).replace(tzinfo=None)
            if admission.get("discharge_date") and not stay_end:
                stay_end = _parse_dt((bed or {}).get("released_at")) or _parse_dt(admission.get("discharge_date"))
            elapsed = max(0.0, ((stay_end or now_dt) - stay_start).total_seconds()) if stay_start else 0.0
            stay = {
                "admitted_at": _iso(admission.get("admission_date")),
                "discharged": bool(admission.get("discharge_date")),
                "days_completed": int(elapsed // 86400), "hours_extra": int((elapsed % 86400) // 3600),
                "current_day": int(elapsed // 86400) + 1,
                "reason": adm_info.get("reason"), "department": adm_info.get("department"),
                "consulting_doctor": doctor_name, "admission_type": adm_info.get("admission_type"),
                "triage": adm_info.get("triage"), "expected_stay": adm_info.get("expected_stay"),
                "payer_type": admission.get("payer_type"),
                "bed": ({"ward": bed.get("ward"), "room_no": bed.get("room_no"), "bed_no": bed.get("bed_no"),
                         "bed_type": bed.get("bed_type"), "daily_charge": _rate(bed),
                         "since": _iso(bed.get("allocated_at")), "status": bed.get("status")} if bed else None),
                "bed_history": [{"label": _bed_label(b), "from": _iso(b.get("allocated_at")), "to": _iso(b.get("released_at")),
                                 "rate": _rate(b), "days": _bed_days(b, now_dt), "amount": round(_rate(b) * _bed_days(b, now_dt), 2)} for b in all_beds],
            }

            adm_date, adm_time = _split_dt(admission.get("admission_date"))
            if is_first:
                reg_date, reg_time = _split_dt(patient.get("created_at"))
                events.append({"date": reg_date, "time": reg_time, "type": "registration",
                                "title": "Patient registered", "subtitle": f"Registration completed · {patient_id}",
                                "charge": None, "received": None})
            events.append({
                "date": adm_date, "time": adm_time, "type": "admission", "title": "Inpatient admission",
                "subtitle": " · ".join(p for p in [
                    f"ADM-{admission_id}", stay["admission_type"] or "", f"Reason: {stay['reason']}" if stay["reason"] else "",
                    f"Triage: {stay['triage']}" if stay["triage"] else "", f"Expected stay: {stay['expected_stay']}" if stay["expected_stay"] else "",
                ] if p),
                "charge": None, "received": None,
            })
            # The admission-time doctor/department (a later transfer is its own event).
            orig_doctor = parse_admission_notes(admission.get("notes")).get("consulting_doctor") if moved else None
            orig_department = parse_admission_notes(admission.get("notes")).get("department") if moved else stay["department"]
            if doctor_name:
                events.append({"date": adm_date, "time": adm_time, "type": "consultation",
                                "title": "Doctor consultation", "subtitle": " · ".join(p for p in [f"Attending: {_dr(orig_doctor or doctor_name)}", orig_department or ""] if p),
                                "charge": None, "received": None})
            events.extend(_ip_stay_events(cursor, patient_id, admission_id, admission, all_beds,
                                          _iso(admission.get("admission_date")), _iso(admission.get("discharge_date")) or _iso(datetime.now())))

            items = _diag_scope_rows(cursor, "IP", None, admission_id)
            for it in items:
                dept = (it["department_type"] or "").upper()
                cursor.execute("SELECT * FROM diag_specimens WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                specimen = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_imaging_exams WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                exam = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_reports WHERE order_item_id = ? ORDER BY version DESC LIMIT 1", (it["item_id"],))
                report = cursor.fetchone()

                if dept == "LAB" and specimen and specimen["collected_at"]:
                    d, t = _split_dt(specimen["collected_at"])
                    events.append({"date": d, "time": t, "type": "lab_collected", "title": "Laboratory sample collected",
                                    "subtitle": f"{it['service_name']} · {specimen['specimen_no']}", "charge": float(it["amount"] or 0), "received": None})
                if dept == "IMAGING" and exam and exam["completed_at"]:
                    d, t = _split_dt(exam["completed_at"])
                    events.append({"date": d, "time": t, "type": "imaging_completed", "title": "Imaging examination completed",
                                    "subtitle": it["service_name"], "charge": float(it["amount"] or 0), "received": None})
                if report and report["status"] == "released" and report["released_at"]:
                    d, t = _split_dt(report["released_at"])
                    label = "Laboratory report released" if dept == "LAB" else "Imaging report released"
                    events.append({"date": d, "time": t, "type": "report_released", "title": label,
                                    "subtitle": f"{it['service_name']} · Authorized report", "charge": None, "received": None,
                                    "report_id": report["id"]})
                if it["discharge_invoice_id"]:
                    invoice_ids.add(it["discharge_invoice_id"])

            cursor.execute(
                "SELECT * FROM pharmacy_sales WHERE admission_id = ? ORDER BY sold_at",
                (admission_id,),
            )
            pharmacy_rows = [dict(r) for r in cursor.fetchall()]
            grouped = {}
            for r in pharmacy_rows:
                key = _iso(r["sold_at"])
                grouped.setdefault(key, []).append(r)
                if r.get("invoice_id"):
                    invoice_ids.add(r["invoice_id"])
            for sold_at, lines in grouped.items():
                d, t = _split_dt(sold_at)
                total = sum(float(l["amount"] or 0) for l in lines)
                events.append({
                    "date": d, "time": t, "type": "pharmacy_issued", "title": "Pharmacy medicines issued",
                    "subtitle": f"Billed to admission · {len(lines)} item(s)", "charge": total, "received": None,
                    "items": [{"name": l["medicine_name"], "quantity": l["quantity"], "unit_price": float(l["unit_price"] or 0), "amount": float(l["amount"] or 0)} for l in lines],
                })

            if admission_id:
                rx_event, _ = _prescription_event(cursor, "admission_id", admission_id)
                if rx_event:
                    events.append(rx_event)

            bed_total = float(bed["total_amount"] or 0) if bed and bed.get("status") == "released" else 0.0
            discharge_date = admission.get("discharge_date")
            bill = None
            if not discharge_date:
                # Still admitted: the same live figures the Discharge & Settle Bill screen shows (days so far x daily rate).
                try:
                    import legacy_queries as lq
                    live = lq.get_discharge_bill_preview(db, admission_id=admission_id)
                    bill = {
                        "live": True, "as_of": live["discharge_date"], "since": live["admission_date"],
                        "days_stayed": live["days_stayed"], "hours_stayed": live["hours_stayed"], "rate_per_day": live["rate_per_day"],
                        "bed_total": live["bed_total"], "pharmacy_count": len(live["pharmacy_items"]), "pharmacy_total": live["pharmacy_total"],
                        "diag_count": len(live["diag_items"]), "diag_total": live["diag_total"], "grand_total": live["grand_total"],
                    }
                    bed_total = float(live["bed_total"] or 0)
                except Exception:
                    bill = None
            elif bed:
                bill = {
                    "live": False, "as_of": _iso(bed.get("released_at") or discharge_date), "since": _iso(all_beds[0].get("allocated_at")) if all_beds else None,
                    "days_stayed": sum(int(b.get("total_days") or 0) for b in all_beds) or int(bed.get("total_days") or 0),
                    "hours_stayed": None, "rate_per_day": float(bed.get("amount_per_day") or 0), "bed_total": bed_total,
                    "pharmacy_count": len(pharmacy_rows), "pharmacy_total": round(sum(float(r["amount"] or 0) for r in pharmacy_rows), 2),
                    "diag_count": len(items), "diag_total": round(sum(float(it["amount"] or 0) for it in items), 2), "grand_total": None,
                }
                bill["grand_total"] = round(bill["bed_total"] + bill["pharmacy_total"] + bill["diag_total"], 2)
            if discharge_date and bed:
                d, t = _split_dt(bed.get("released_at") or discharge_date)
                if bed_total:
                    events.append({"date": d, "time": t, "type": "room_charges", "title": "Room & nursing charges posted",
                                    "subtitle": f"{bed['ward']} · {bed.get('total_days') or ''} day(s)", "charge": bed_total, "received": None})

            cursor.execute(
                "SELECT id, invoice_no, total_amount, paid_amount, due_amount, created_at FROM invoices "
                "WHERE patient_id = ? AND module = 'IP' AND (id = ANY(?) OR (admission_id = ? AND ? IS NOT NULL))",
                (patient_id, list(invoice_ids) or [-1], admission_id, discharge_date),
            )
            for inv in cursor.fetchall():
                invoice_ids.add(inv["id"])

            discharge_invoice = None
            for iid in list(invoice_ids):
                cursor.execute("SELECT * FROM invoices WHERE id = ?", (iid,))
                inv = cursor.fetchone()
                if inv and inv["module"] == "IP" and inv["admission_id"] == admission_id:
                    discharge_invoice = dict(inv)

            if discharge_invoice:
                cursor.execute("SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at", (discharge_invoice["id"],))
                for pay in cursor.fetchall():
                    d, t = _split_dt(pay["created_at"])
                    events.append({"date": d, "time": t, "type": "payment", "title": "Final payment received",
                                    "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']}",
                                    "charge": None, "received": float(pay["amount"] or 0)})
                if discharge_date:
                    d, t = _split_dt(discharge_invoice.get("created_at"))
                    events.append({"date": d, "time": t, "type": "discharge", "title": "Discharged home",
                                    "subtitle": "Discharge summary available · Bed released", "charge": None, "received": None})

            for iid in invoice_ids:
                if discharge_invoice and iid == discharge_invoice["id"]:
                    continue
                cursor.execute("SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at", (iid,))
                for pay in cursor.fetchall():
                    d, t = _split_dt(pay["created_at"])
                    events.append({"date": d, "time": t, "type": "payment", "title": "Deposit received",
                                    "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']}",
                                    "charge": None, "received": float(pay["amount"] or 0)})

            lab_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "LAB")
            imaging_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "IMAGING")
            pharmacy_total = sum(float(r["amount"] or 0) for r in pharmacy_rows)
            categories = [c for c in [
                ("Laboratory", lab_total), ("Imaging", imaging_total),
                ("Pharmacy", pharmacy_total), ("Room & nursing", bed_total),
            ] if c[1] > 0]

            cursor.execute("SELECT * FROM prescriptions WHERE admission_id = ? LIMIT 1", (admission_id,))
            prescription = cursor.fetchone()
            documents = [
                {"type": "prescription", "label": "Prescription", "available": bool(prescription), "ref": prescription["id"] if prescription else None},
                {"type": "lab_report", "label": "Lab report", "available": any(e["type"] == "report_released" and "Laboratory" in e["title"] for e in events), "ref": None},
                {"type": "imaging_report", "label": "Imaging report", "available": any(e["type"] == "report_released" and "Imaging" in e["title"] for e in events), "ref": None},
                {"type": "pharmacy_slip", "label": "Pharmacy issue slip", "available": len(pharmacy_rows) > 0, "ref": None},
                {"type": "final_bill", "label": "Final bill", "available": discharge_invoice is not None, "ref": discharge_invoice["id"] if discharge_invoice else None},
                {"type": "discharge_summary", "label": "Discharge summary", "available": bool(discharge_date), "ref": admission_id},
            ]

        elif etype == "OP":
            appointment_id = eid
            appt = {}
            if appointment_id and appointment_id != 0:
                cursor.execute("SELECT * FROM appointments WHERE id = ?", (appointment_id,))
                appt = dict(cursor.fetchone() or {})
            doctor_name = appt.get("doctor_name")
            appt_date, appt_time = _split_dt(appt.get("created_at") or appt.get("appointment_date") or patient.get("created_at"))
            appt_day = (appt.get("appointment_date") or "")[:10] if isinstance(appt.get("appointment_date"), str) else _iso(appt.get("appointment_date"))[:10] if appt.get("appointment_date") else ""

            if not appt_day and not appointment_id:
                # No appointment: anchor the visit at registration so vitals and bills since then are shown.
                appt_day = (_iso(patient.get("created_at")) or "")[:10]

            if is_first:
                reg_date, reg_time = _split_dt(patient.get("created_at"))
                events.append({"date": reg_date, "time": reg_time, "type": "registration",
                                "title": "Patient registered", "subtitle": f"Registration completed · {patient_id}",
                                "charge": None, "received": None})

            consultation_fee = 0.0
            consultation_invoice = None
            if appt_day:
                if appointment_id:
                    cursor.execute("SELECT * FROM invoices WHERE patient_id = ? AND module = 'OP' AND appointment_id = ? ORDER BY created_at LIMIT 1",
                                   (patient_id, appointment_id))
                    consultation_invoice = cursor.fetchone()
                if not consultation_invoice:
                    cursor.execute(
                        "SELECT * FROM invoices WHERE patient_id = ? AND module = 'OP' AND appointment_id IS NULL AND admission_id IS NULL "
                        "AND DATE(created_at) = ? ORDER BY created_at LIMIT 1",
                        (patient_id, appt_day),
                    )
                    consultation_invoice = cursor.fetchone()
                consultation_fee = float(consultation_invoice["total_amount"] or 0) if consultation_invoice else float(appt.get("consultation_fee") or 0)
                if consultation_invoice:
                    invoice_ids.add(consultation_invoice["id"])

            if appointment_id and appointment_id != 0:
                started_d, started_t = _split_dt(appt.get("consultation_started_at"))
                done_d, done_t = _split_dt(appt.get("consultation_completed_at"))
                events.append({"date": appt_date, "time": appt_time, "type": "consultation", "title": "Doctor consultation",
                                "subtitle": f"{appt.get('department') or 'General'} · {doctor_name or 'Duty doctor'}"
                                + (f" · Token {appt['token_no']}" if appt.get("token_no") else "")
                                + (f" · Booked for {_split_dt(appt.get('appointment_date'))[1]}" if appt.get("appointment_date") else ""),
                                "charge": consultation_fee or None, "received": None})
                if started_d:
                    events.append({"date": started_d, "time": started_t, "type": "consultation", "title": "Consultation started",
                                    "subtitle": f"{_dr(doctor_name)}" if doctor_name else "", "charge": None, "received": None})
                if done_d:
                    events.append({"date": done_d, "time": done_t, "type": "consultation", "title": "Consultation completed",
                                    "subtitle": f"{_dr(doctor_name)}" if doctor_name else "", "charge": None, "received": None})

            # This visit runs from its appointment day until the patient's next OP visit; pharmacy and
            # lab bills outside that window belong to other visits.
            visit_end = None
            if appt_day:
                cursor.execute(
                    "SELECT MIN(DATE(appointment_date)) AS next_day FROM appointments "
                    "WHERE patient_id = ? AND DATE(appointment_date) > DATE(?) AND status <> 'cancelled'",
                    (patient_id, appt_day),
                )
                next_row = cursor.fetchone()
                visit_end = _iso(next_row["next_day"])[:10] if next_row and next_row["next_day"] else None

            def in_visit(value):
                day = (_iso(value) or "")[:10]
                if not appt_day or not day:
                    return True
                return day >= appt_day and (visit_end is None or day < visit_end)

            if appt_day:
                cursor.execute(
                    "SELECT * FROM patient_vitals WHERE patient_id = ? AND admission_id IS NULL AND encounter_id IS NULL "
                    "AND DATE(COALESCE(recorded_at, record_time, created_at)) >= DATE(?) ORDER BY COALESCE(recorded_at, record_time, created_at)",
                    (patient_id, appt_day),
                )
                for v in _all(cursor):
                    if not in_visit(v["recorded_at"] or v["record_time"] or v["created_at"]):
                        continue
                    vd, vt = _split_dt(v["recorded_at"] or v["record_time"] or v["created_at"])
                    vals = [f"BP {v['bp']}" if v["bp"] else "", f"Pulse {v['pulse']}" if v["pulse"] else "",
                            f"Temp {v['temperature']} °C" if v["temperature"] else "", f"SpO2 {v['spo2']}%" if v["spo2"] else "",
                            f"Weight {v['weight']} kg" if v.get("weight") else "", f"Height {v['height']} cm" if v.get("height") else ""]
                    events.append({"date": vd, "time": vt, "type": "vitals", "title": "Vitals recorded",
                                    "subtitle": " · ".join(x for x in vals if x) or "Vitals recorded", "charge": None, "received": None})

            if appointment_id and appointment_id != 0:
                rx_event, _ = _prescription_event(cursor, "appointment_id", appointment_id)
                if rx_event:
                    events.append(rx_event)

            items = [
                it for it in _diag_scope_rows(cursor, "OP", appointment_id, None, patient_id=patient_id)
                if (appointment_id and it["appointment_id"] == appointment_id) or in_visit(it["confirmed_at"] or it["ordered_at"])
            ]
            events.extend(_lab_bill_events(cursor, items))
            for it in items:
                dept = (it["department_type"] or "").upper()
                cursor.execute("SELECT * FROM diag_specimens WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                specimen = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_imaging_exams WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                exam = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_reports WHERE order_item_id = ? ORDER BY version DESC LIMIT 1", (it["item_id"],))
                report = cursor.fetchone()
                if dept == "LAB" and specimen and specimen["collected_at"]:
                    d, t = _split_dt(specimen["collected_at"])
                    events.append({"date": d, "time": t, "type": "lab_collected", "title": "Laboratory sample collected",
                                    "subtitle": f"{it['service_name']} · {specimen['specimen_no']}", "charge": None, "received": None})
                if dept == "IMAGING" and exam and exam["completed_at"]:
                    d, t = _split_dt(exam["completed_at"])
                    events.append({"date": d, "time": t, "type": "imaging_completed", "title": "Imaging examination completed",
                                    "subtitle": it["service_name"], "charge": None, "received": None})
                if report and report["status"] == "released" and report["released_at"]:
                    d, t = _split_dt(report["released_at"])
                    label = "Laboratory report released" if dept == "LAB" else "Imaging report released"
                    events.append({"date": d, "time": t, "type": "report_released", "title": label,
                                    "subtitle": f"{it['service_name']} · Authorized report", "charge": None, "received": None,
                                    "report_id": report["id"]})
                if it["discharge_invoice_id"]:
                    invoice_ids.add(it["discharge_invoice_id"])

            # Query all pharmacy sales for this outpatient visit
            cursor.execute(
                "SELECT * FROM pharmacy_sales WHERE patient_id = ? AND admission_id IS NULL "
                "AND billing_type NOT IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE') ORDER BY sold_at ASC",
                (patient_id,),
            )
            pharmacy_rows = [dict(r) for r in cursor.fetchall() if in_visit(r["sold_at"])]
            for r in pharmacy_rows:
                if r.get("invoice_id"):
                    invoice_ids.add(r["invoice_id"])
            events.extend(_pharmacy_bill_events(cursor, pharmacy_rows))

            # Check invoices associated with patient across modules (lab, pharmacy, appointments)
            cursor.execute(
                """
                SELECT id, invoice_no, total_amount, paid_amount, module, created_at
                FROM invoices
                WHERE patient_id = ? AND admission_id IS NULL AND (appointment_id IS NULL OR appointment_id = ?) AND (
                    UPPER(COALESCE(module, '')) IN ('OP', 'LAB', 'DIAGNOSTICS', 'PHARMACY', 'RADIOLOGY')
                    OR invoice_no ILIKE 'INV-LAB-%'
                    OR invoice_no ILIKE 'INV-DIAG-%'
                    OR invoice_no ILIKE 'INV-PHARM-%'
                )
                """,
                (patient_id, appointment_id or -1),
            )
            for inv in cursor.fetchall():
                if not in_visit(inv.get("created_at")):
                    continue
                invoice_ids.add(inv["id"])
                inv_mod = (inv.get("module") or "").upper()
                inv_no = inv.get("invoice_no") or f"INV-{inv['id']}"
                d, t = _split_dt(inv.get("created_at"))
                if ("LAB" in inv_mod or "DIAG" in inv_mod or "INV-LAB" in inv_no) and not any(e.get("type") in ("lab_bill", "lab_collected", "report_released") for e in events):
                    events.append({
                        "date": d, "time": t, "type": "lab_collected", "title": "Diagnostic laboratory service",
                        "subtitle": f"Bill {inv_no}", "charge": float(inv["total_amount"] or 0),
                        "received": float(inv["paid_amount"] or 0),
                    })

            consult_inv_id = consultation_invoice["id"] if (appointment_id and consultation_invoice) else None
            consult_paid = 0.0
            for iid in list(invoice_ids):
                cursor.execute("SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at", (iid,))
                for pay in cursor.fetchall():
                    d, t = _split_dt(pay["created_at"])
                    amount = float(pay["amount"] or 0)
                    if iid == consult_inv_id:
                        # The consultation fee: shown as Received on the consultation row itself (charge and received side by side).
                        consult_paid += amount
                        events.append({"date": d, "time": t, "type": "payment", "title": "Payment received",
                                        "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']} · ₹{amount:,.2f} against the consultation fee",
                                        "charge": None, "received": None})
                        continue
                    events.append({"date": d, "time": t, "type": "payment", "title": "Payment received",
                                    "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']}",
                                    "charge": None, "received": amount})
            if consult_inv_id:
                if consult_paid <= 0:
                    consult_paid = float(consultation_invoice["paid_amount"] or 0)
                for e in events:
                    if e.get("type") == "consultation" and e.get("title") == "Doctor consultation" and e.get("charge"):
                        e["received"] = round(min(consult_paid, float(e["charge"])), 2) or None
                        break

            lab_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "LAB")
            imaging_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "IMAGING")
            pharmacy_total = sum(float(r["amount"] or 0) for r in pharmacy_rows)
            for iid in list(invoice_ids):
                cursor.execute("SELECT tax FROM invoices WHERE id = ? AND (UPPER(COALESCE(module, '')) = 'PHARMACY' OR invoice_no ILIKE 'INV-PHM-%' OR invoice_no ILIKE 'INV-PHARM-%')", (iid,))
                inv_tax_row = cursor.fetchone()
                if inv_tax_row and inv_tax_row["tax"]:
                    pharmacy_total += float(inv_tax_row["tax"])
            pharmacy_total = round(pharmacy_total, 2)
            if lab_total == 0 or pharmacy_total == 0:
                cursor.execute(
                    "SELECT total_amount, module, invoice_no, created_at FROM invoices WHERE id = ANY(?)",
                    (list(invoice_ids) or [-1],),
                )
                visit_invoices = cursor.fetchall()
                if lab_total == 0:
                    lab_total = sum(float(i["total_amount"] or 0) for i in visit_invoices
                                    if (i["module"] or "").upper() in ("LAB", "DIAGNOSTICS") or (i["invoice_no"] or "").upper().startswith("INV-LAB-"))
                if pharmacy_total == 0:
                    pharmacy_total = sum(float(i["total_amount"] or 0) for i in visit_invoices
                                         if (i["module"] or "").upper() == "PHARMACY" or (i["invoice_no"] or "").upper().startswith("INV-PHARM-"))

            categories = [c for c in [
                ("Consultation", consultation_fee),
                ("Laboratory", lab_total), ("Imaging", imaging_total), ("Pharmacy", pharmacy_total),
            ] if c[1] > 0]

            prescription = None
            if appointment_id and appointment_id != 0:
                cursor.execute("SELECT * FROM prescriptions WHERE appointment_id = ? AND COALESCE(dispense_status, '') <> 'superseded' ORDER BY id DESC LIMIT 1", (appointment_id,))
                prescription = cursor.fetchone()
            documents = [
                {"type": "prescription", "label": "Prescription", "available": bool(prescription), "ref": prescription["id"] if prescription else None},
                {"type": "lab_report", "label": "Lab report", "available": (lab_total > 0 or any(e["type"] in ("report_released", "lab_collected") for e in events)), "ref": None},
                {"type": "imaging_report", "label": "Imaging report", "available": (imaging_total > 0 or any(e["type"] == "report_released" and "Imaging" in e["title"] for e in events)), "ref": None},
                {"type": "pharmacy_slip", "label": "Pharmacy issue slip", "available": (len(pharmacy_rows) > 0 or pharmacy_total > 0), "ref": None},
                {"type": "final_bill", "label": "Final bill", "available": len(invoice_ids) > 0, "ref": None},
            ]

        else:  # EMERGENCY
            cursor.execute("SELECT * FROM encounters WHERE id = ?", (eid,))
            enc = dict(cursor.fetchone() or {})
            appointment_id = enc.get("appointment_id")
            doctor_name = enc.get("attending_doctor")
            arr_date, arr_time = _split_dt(enc.get("arrival_at"))

            if is_first:
                reg_date, reg_time = _split_dt(patient.get("created_at"))
                events.append({"date": reg_date, "time": reg_time, "type": "registration",
                                "title": "Patient registered", "subtitle": f"Registration completed · {patient_id}",
                                "charge": None, "received": None})
            events.append({"date": arr_date, "time": arr_time, "type": "emergency_registration", "title": "Emergency registration",
                            "subtitle": f"{enc.get('triage_priority') or 'Unclassified'} · {enc.get('chief_complaint') or '-'}",
                            "charge": None, "received": None})

            cursor.execute("SELECT * FROM patient_vitals WHERE encounter_id = ? ORDER BY id", (eid,))
            for v in cursor.fetchall():
                d, t = _split_dt(v["recorded_at"])
                if not d:
                    d, t = arr_date, arr_time
                events.append({"date": d, "time": t, "type": "vitals", "title": "Vitals recorded",
                                "subtitle": f"BP {v['bp'] or '-'} · Pulse {v['pulse'] or '-'} · SpO2 {v['spo2'] or '-'}%",
                                "charge": None, "received": None})

            items = _diag_scope_rows(cursor, "OP", appointment_id, None) if appointment_id else []
            for it in items:
                dept = (it["department_type"] or "").upper()
                cursor.execute("SELECT * FROM diag_specimens WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                specimen = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_imaging_exams WHERE order_item_id = ? ORDER BY id LIMIT 1", (it["item_id"],))
                exam = cursor.fetchone()
                cursor.execute("SELECT * FROM diag_reports WHERE order_item_id = ? ORDER BY version DESC LIMIT 1", (it["item_id"],))
                report = cursor.fetchone()
                if dept == "LAB" and specimen and specimen["collected_at"]:
                    d, t = _split_dt(specimen["collected_at"])
                    events.append({"date": d, "time": t, "type": "lab_collected", "title": "STAT laboratory sample collected",
                                    "subtitle": f"{it['service_name']} · {specimen['specimen_no']}", "charge": float(it["amount"] or 0), "received": None})
                if dept == "IMAGING" and exam and exam["completed_at"]:
                    d, t = _split_dt(exam["completed_at"])
                    events.append({"date": d, "time": t, "type": "imaging_completed", "title": "STAT imaging completed",
                                    "subtitle": it["service_name"], "charge": float(it["amount"] or 0), "received": None})
                if report and report["status"] == "released" and report["released_at"]:
                    d, t = _split_dt(report["released_at"])
                    label = "Laboratory report released" if dept == "LAB" else "Imaging report released"
                    events.append({"date": d, "time": t, "type": "report_released", "title": label,
                                    "subtitle": f"{it['service_name']} · Authorized report", "charge": None, "received": None,
                                    "report_id": report["id"]})
                cursor.execute(
                    "SELECT * FROM diag_critical_alerts WHERE order_item_id = ? ORDER BY raised_at",
                    (it["item_id"],),
                )
                for alert in cursor.fetchall():
                    d, t = _split_dt(alert["raised_at"])
                    events.append({"date": d, "time": t, "type": "critical_alert", "title": "Critical result flagged",
                                    "subtitle": alert["notes"] or "Critical value", "charge": None, "received": None})
                    if alert["resolved_at"]:
                        d2, t2 = _split_dt(alert["resolved_at"])
                        events.append({"date": d2, "time": t2, "type": "critical_ack", "title": "Critical result acknowledged",
                                        "subtitle": f"Contacted: {alert['contacted_person'] or '-'}", "charge": None, "received": None})
                if it["discharge_invoice_id"]:
                    invoice_ids.add(it["discharge_invoice_id"])

            cursor.execute(
                "SELECT * FROM pharmacy_sales WHERE patient_id = ? AND billing_type IN ('EMERGENCY', 'EMERGENCY_ACCOUNT', 'EMERGENCY_IMMEDIATE')"
                " AND sold_at >= ? AND sold_at <= ?",
                (patient_id, enc.get("arrival_at"), enc.get("disposition_at") or datetime.now()),
            )
            pharmacy_rows = [dict(r) for r in cursor.fetchall()]
            grouped = {}
            for r in pharmacy_rows:
                key = _iso(r["sold_at"])
                grouped.setdefault(key, []).append(r)
                if r.get("invoice_id"):
                    invoice_ids.add(r["invoice_id"])
            for sold_at, lines in grouped.items():
                d, t = _split_dt(sold_at)
                total = sum(float(l["amount"] or 0) for l in lines)
                events.append({
                    "date": d, "time": t, "type": "pharmacy_issued", "title": "Emergency pharmacy issued",
                    "subtitle": f"{len(lines)} item(s)", "charge": total, "received": total,
                    "items": [{"name": l["medicine_name"], "quantity": l["quantity"], "unit_price": float(l["unit_price"] or 0), "amount": float(l["amount"] or 0)} for l in lines],
                })

            if appointment_id:
                cursor.execute(
                    "SELECT id FROM invoices WHERE patient_id = ? AND UPPER(COALESCE(module, '')) = 'OP'",
                    (patient_id,),
                )
                for inv in cursor.fetchall():
                    invoice_ids.add(inv["id"])
            for iid in list(invoice_ids):
                cursor.execute("SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at", (iid,))
                for pay in cursor.fetchall():
                    d, t = _split_dt(pay["created_at"])
                    events.append({"date": d, "time": t, "type": "payment", "title": "Payment received",
                                    "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']}",
                                    "charge": None, "received": float(pay["amount"] or 0)})

            if enc.get("disposition"):
                d, t = _split_dt(enc.get("disposition_at"))
                events.append({"date": d, "time": t, "type": "disposition", "title": "Disposition recorded",
                                "subtitle": f"{enc['disposition'].title()}" + (f" · {enc['disposition_notes']}" if enc.get("disposition_notes") else ""),
                                "charge": None, "received": None})

            lab_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "LAB")
            imaging_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "IMAGING")
            pharmacy_total = sum(float(r["amount"] or 0) for r in pharmacy_rows)
            categories = [c for c in [("Laboratory", lab_total), ("Imaging", imaging_total), ("Pharmacy", pharmacy_total)] if c[1] > 0]

            documents = [
                {"type": "lab_report", "label": "Lab report", "available": any(e["type"] == "report_released" and "Laboratory" in e["title"] for e in events), "ref": None},
                {"type": "imaging_report", "label": "Imaging report", "available": any(e["type"] == "report_released" and "Imaging" in e["title"] for e in events), "ref": None},
                {"type": "pharmacy_slip", "label": "Pharmacy issue slip", "available": len(pharmacy_rows) > 0, "ref": None},
                {"type": "final_bill", "label": "Final bill", "available": len(invoice_ids) > 0, "ref": None},
            ]

        total_charges = payments_received = outstanding = 0.0
        for iid in invoice_ids:
            cursor.execute("SELECT total_amount, paid_amount, due_amount FROM invoices WHERE id = ?", (iid,))
            inv = cursor.fetchone()
            if inv:
                total_charges += float(inv["total_amount"] or 0)
                payments_received += float(inv["paid_amount"] or 0)
                outstanding += float(inv["due_amount"] or 0)

        due_invoices = []
        for iid in invoice_ids:
            cursor.execute("SELECT id, invoice_no, module, total_amount, paid_amount, due_amount FROM invoices WHERE id = ?", (iid,))
            inv = cursor.fetchone()
            if inv and float(inv["due_amount"] or 0) > 0:
                due_invoices.append({"id": inv["id"], "invoice_no": inv["invoice_no"], "module": inv["module"],
                                      "total": float(inv["total_amount"] or 0), "paid": float(inv["paid_amount"] or 0),
                                      "due": round(float(inv["due_amount"] or 0), 2)})

        categories_sum = sum(amount for _, amount in categories)
        if categories_sum > total_charges:
            unaccounted = categories_sum - total_charges
            total_charges += unaccounted
            pharm_paid = sum(float(r.get("amount") or 0) for r in pharmacy_rows if not r.get("invoice_id"))
            payments_received += min(unaccounted, pharm_paid)
            outstanding = max(0.0, total_charges - payments_received)

        cursor.execute(
            "SELECT ip.id, ip.invoice_id, ip.amount, ip.payment_mode, ip.created_at, i.invoice_no "
            "FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE ip.invoice_id = ANY(?) ORDER BY ip.created_at",
            (list(invoice_ids) or [-1],),
        )
        payments = [
            {"date": _split_dt(p["created_at"])[0], "time": _split_dt(p["created_at"])[1],
             "mode": (p["payment_mode"] or "cash").title(), "reference": f"PMT-{p['id']}",
             "invoice_no": p["invoice_no"], "amount": float(p["amount"] or 0)}
            for p in cursor.fetchall()
        ]

        # Advance deposits (Billing > Advances & Refunds): linked to this admission, or unlinked and taken
        # during this visit's dates. Their own events + payment rows; the bill totals above are not changed
        # (an advance is applied to the bill as an allocation, not as extra revenue).
        advance_summary = None
        win_start = _parse_dt(selected.get("start"))
        win_end_raw = selected.get("end")
        win_end = _parse_dt(win_end_raw)
        if win_end and len(str(win_end_raw)) <= 10:
            win_end += timedelta(days=1)
        if etype == "OP" and win_start:
            win_start = datetime.combine(win_start.date(), datetime.min.time())
            win_end = (_parse_dt(visit_end) if visit_end else None) or (win_start + timedelta(days=1))
        win_end = win_end or datetime.now(IST_TIMEZONE).replace(tzinfo=None) + timedelta(days=1)
        cursor.execute(
            "SELECT * FROM patient_advances WHERE patient_id = ? AND ((? IS NOT NULL AND admission_id = ?) "
            "OR (admission_id IS NULL AND created_at >= ? AND created_at < ?)) ORDER BY created_at",
            (patient_id, admission_id, admission_id, win_start or datetime.min, win_end),
        )
        adv_rows = _all(cursor)
        if adv_rows:
            adv_ids = [a["id"] for a in adv_rows]
            for a in adv_rows:
                d, t = _split_dt(a["created_at"])
                amount = float(a["amount"] or 0)
                events.append({"date": d, "time": t, "type": "advance", "title": "Advance deposit received",
                                "subtitle": " · ".join(x for x in [a["advance_no"], (a["payment_mode"] or "cash").upper(),
                                                                   a["transaction_ref"] or "", a["notes"] or ""] if x),
                                "charge": None, "received": amount})
                payments.append({"date": d, "time": t, "mode": (a["payment_mode"] or "cash").title(), "reference": a["advance_no"],
                                  "invoice_no": "Advance deposit", "amount": amount})
            cursor.execute("SELECT aa.*, pa.advance_no, inv.invoice_no FROM advance_allocations aa JOIN patient_advances pa ON pa.id = aa.advance_id "
                           "LEFT JOIN invoices inv ON inv.id = aa.invoice_id WHERE aa.advance_id = ANY(?) ORDER BY aa.created_at", (adv_ids,))
            for al in _all(cursor):
                d, t = _split_dt(al["created_at"])
                events.append({"date": d, "time": t, "type": "advance", "title": "Advance applied to bill",
                                "subtitle": " · ".join(x for x in [al["advance_no"], al.get("invoice_no") or "", f"₹{float(al['amount'] or 0):,.2f}"] if x),
                                "charge": None, "received": None})
            cursor.execute("SELECT * FROM refund_requests WHERE advance_id = ANY(?) ORDER BY created_at", (adv_ids,))
            for rf in _all(cursor):
                d, t = _split_dt(rf["paid_at"] or rf["created_at"])
                events.append({"date": d, "time": t, "type": "advance",
                                "title": "Advance refunded" if rf["status"] == "paid" else f"Advance refund {(rf['status'] or 'requested').replace('_', ' ')}",
                                "subtitle": " · ".join(x for x in [rf["refund_no"], f"₹{float(rf['amount'] or 0):,.2f}", (rf["refund_method"] or "").upper(), rf["reason"] or ""] if x),
                                "charge": None, "received": None})
            total_adv = sum(float(a["amount"] or 0) for a in adv_rows)
            applied = sum(float(a["allocated_amount"] or 0) for a in adv_rows)
            refunded = sum(float(a["refunded_amount"] or 0) for a in adv_rows)
            reserved = sum(float(a["reserved_refund_amount"] or 0) for a in adv_rows)
            advance_summary = {"total": round(total_adv, 2), "applied": round(applied, 2), "refunded": round(refunded, 2),
                               "available": round(max(0.0, total_adv - applied - refunded - reserved), 2), "count": len(adv_rows)}

        # Advance deposits still unapplied count against what is owed, so the summary agrees with the Payments
        # list and Billing > Advances (applied advances are already inside the invoices' paid amounts).
        if advance_summary and outstanding > 0 and advance_summary["available"] > 0:
            offset = min(outstanding, advance_summary["available"])
            payments_received += offset
            outstanding -= offset
            advance_summary["offset_against_bill"] = round(offset, 2)

        # Nursing Station shift notes -- inpatient ward activity, shown for
        # the admission currently selected in the encounter picker (notes
        # never explicitly linked to an admission still show, since they're
        # this patient's care record regardless of which stay they're
        # viewing).
        if admission_id:
            cursor.execute(
                "SELECT * FROM nursing_care_logs WHERE patient_id = ? AND (admission_id = ? OR admission_id IS NULL) ORDER BY id",
                (patient_id, admission_id),
            )
        else:
            cursor.execute(
                "SELECT * FROM nursing_care_logs WHERE patient_id = ? AND admission_id IS NULL ORDER BY id",
                (patient_id,),
            )
        for note in cursor.fetchall():
            nd, nt = _split_dt(note["created_at"]) if note["created_at"] else (_iso(note["log_date"]), note["log_time"])
            events.append({
                "date": nd, "time": nt, "type": "nursing_note",
                "title": f"Nursing note · {note['activity'] or 'Shift update'}",
                "subtitle": f"{note['nurse_name'] or 'Nurse'}" + (f" — {note['remarks']}" if note["remarks"] else ""),
                "charge": None, "received": None,
            })

        # Prescriptions, pharmacy bills and lab/diagnostics bills & results are part of the journey.
        events = [e for e in events if e.get("date")]
        events.sort(key=lambda e: (e["date"], e.get("time") or ""))

        return {
            "patient": {
                "patient_id": patient_id, "name": _patient_name(patient),
                "age": patient.get("age"), "gender": patient.get("gender"),
                "phone": patient.get("phone"), "phone_country_code": patient.get("phone_country_code"),
                "address": patient.get("address"), "email": patient.get("email"),
            },
            "encounters": encounters,
            "selected": selected,
            "doctor_name": doctor_name,
            "stay": stay if etype == "IP" else None,
            "bill": bill if etype == "IP" else None,
            "advances": advance_summary,
            "department": (stay or {}).get("department") if etype == "IP" else (appt.get("department") if etype == "OP" else None),
            "events": events,
            "financial_summary": {
                "categories": [{"label": label, "amount": amount} for label, amount in categories],
                "total_charges": round(total_charges, 2),
                "payments_received": round(payments_received, 2),
                "outstanding": round(outstanding, 2),
                "status": "Settled" if outstanding <= 0 and total_charges > 0 else ("Pending" if total_charges > 0 else "No charges"),
            },
            "payments": payments,
            "due_invoices": due_invoices,
            "documents": documents,
        }
