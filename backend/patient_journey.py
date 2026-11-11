"""Real, per-patient chronological journey (registration through discharge/
disposition) with an itemized financial summary, payments list, and document
availability -- assembled from the hospital's real transactional tables
(admissions, appointments, encounters, diag_orders/items, pharmacy_sales,
bed_allocations, invoices, invoice_payments). Nothing here is sample data:
an event, a charge, or a document only appears if a real row backs it.
"""
from datetime import datetime, timedelta

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
        f"Dr. {rx['doctor_name']}" if rx["doctor_name"] else "",
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
        if invoice_id:
            cursor.execute("SELECT invoice_no FROM invoices WHERE id = ?", (invoice_id,))
            row = cursor.fetchone()
            invoice_no = row["invoice_no"] if row else None
        d, t = _split_dt(lines[0]["sold_at"])
        total = sum(float(l["amount"] or 0) for l in lines)
        events.append({
            "date": d, "time": t, "type": "pharmacy_issued", "title": title,
            "subtitle": " · ".join(p for p in [invoice_no or "", f"{len(lines)} item(s)"] if p),
            # Invoiced sales get their own "Payment received" events; only un-invoiced cash sales are shown as paid here.
            "charge": total, "received": None if invoice_id else total,
            "invoice_no": invoice_no,
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
            doctor_name = (bed or {}).get("assigned_doctor")

            adm_date, adm_time = _split_dt(admission.get("admission_date"))
            if is_first:
                reg_date, reg_time = _split_dt(patient.get("created_at"))
                events.append({"date": reg_date, "time": reg_time, "type": "registration",
                                "title": "Patient registered", "subtitle": f"Registration completed · {patient_id}",
                                "charge": None, "received": None})
            events.append({
                "date": adm_date, "time": adm_time, "type": "admission", "title": "Inpatient admission",
                "subtitle": f"ADM-{admission_id}" + (f" · {bed['ward']} · Bed {bed['bed_no']}" if bed else ""),
                "charge": None, "received": None,
            })
            if doctor_name:
                events.append({"date": adm_date, "time": adm_time, "type": "consultation",
                                "title": "Doctor consultation", "subtitle": f"Attending: {doctor_name}",
                                "charge": None, "received": None})

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

            if is_first:
                reg_date, reg_time = _split_dt(patient.get("created_at"))
                events.append({"date": reg_date, "time": reg_time, "type": "registration",
                                "title": "Patient registered", "subtitle": f"Registration completed · {patient_id}",
                                "charge": None, "received": None})

            consultation_fee = 0.0
            if appt_day:
                consultation_invoice = None
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
                events.append({"date": appt_date, "time": appt_time, "type": "consultation", "title": "Doctor consultation",
                                "subtitle": f"{appt.get('department') or 'General'} · {doctor_name or 'Duty doctor'}"
                                + (f" · Token {appt['token_no']}" if appt.get("token_no") else ""),
                                "charge": consultation_fee or None, "received": None})

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

            for iid in list(invoice_ids):
                cursor.execute("SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at", (iid,))
                for pay in cursor.fetchall():
                    d, t = _split_dt(pay["created_at"])
                    events.append({"date": d, "time": t, "type": "payment", "title": "Payment received",
                                    "subtitle": f"{(pay['payment_mode'] or 'cash').upper()} · Receipt PMT-{pay['id']}",
                                    "charge": None, "received": float(pay["amount"] or 0)})

            lab_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "LAB")
            imaging_total = sum(float(it["amount"] or 0) for it in items if (it["department_type"] or "").upper() == "IMAGING")
            pharmacy_total = sum(float(r["amount"] or 0) for r in pharmacy_rows)
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
            },
            "encounters": encounters,
            "selected": selected,
            "doctor_name": doctor_name,
            "events": events,
            "financial_summary": {
                "categories": [{"label": label, "amount": amount} for label, amount in categories],
                "total_charges": round(total_charges, 2),
                "payments_received": round(payments_received, 2),
                "outstanding": round(outstanding, 2),
                "status": "Settled" if outstanding <= 0 and total_charges > 0 else ("Pending" if total_charges > 0 else "No charges"),
            },
            "payments": payments,
            "documents": documents,
        }
