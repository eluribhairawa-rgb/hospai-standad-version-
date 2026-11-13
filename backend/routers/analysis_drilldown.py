"""Analysis page drill-down: the records behind a number or chart segment.

Every figure on the Analysis page opens a table of the records it was counted from. Revenue and payment-mode
figures reuse the dashboard's own detail endpoints (revenue_details), so they add up exactly; the kinds below cover the
rest (registrations, gender, admissions, wards, beds, referrals, OP/IP volume, queue, billing, doctor payouts)."""
from datetime import date as date_type, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from deps import current_hospital_id, require_hospital_overview
import legacy_sql
import patient_journey
import revenue_details

router = APIRouter(prefix="/api", tags=["analysis"])

LIMIT = 500


def _day(value):
    v = str(value or "").strip()[:10]
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="A valid date (YYYY-MM-DD) is required.")
    return v


def _range(date_from, date_to):
    """Validated inclusive (from, to) dates; a missing end means a single day."""
    start = _day(date_from)
    end = _day(date_to or start)
    if end < start:
        raise HTTPException(status_code=400, detail="The 'from' date must not be after the 'to' date.")
    if (date_type.fromisoformat(end) - date_type.fromisoformat(start)).days > 3660:
        raise HTTPException(status_code=400, detail="Choose a range of at most 10 years.")
    return start, end


def _label(start, end):
    return start if start == end else f"{start} to {end}"


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat(sep=" ", timespec="minutes")
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _name(alias="p"):
    return f"TRIM(COALESCE({alias}.name, '') || ' ' || COALESCE({alias}.middle_name, '') || ' ' || COALESCE({alias}.last_name, ''))"


def _result(title, columns, rows, note=None):
    return {"title": title, "columns": columns, "rows": [[_fmt(c) for c in r] for r in rows], "count": len(rows), "note": note}


def _fetch(cursor, sql, params=()):
    cursor.execute(sql, tuple(params))
    return [list(r) for r in cursor.fetchall()]


def _admission_rows(cursor, where, params):
    cursor.execute(
        f"""
        SELECT a.id, a.patient_id, {_name()}, a.admission_date, a.discharge_date, ba.ward, ba.bed_no, ba.assigned_doctor, a.notes
        FROM admissions a JOIN patients p ON p.patient_id = a.patient_id
        LEFT JOIN LATERAL (SELECT ward, bed_no, assigned_doctor FROM bed_allocations WHERE admission_id = a.id
                           ORDER BY (status = 'active') DESC, allocated_at DESC LIMIT 1) ba ON TRUE
        WHERE COALESCE(a.notes, '') != 'Initial registration' AND {where}
        ORDER BY a.admission_date DESC LIMIT {LIMIT}
        """, params)
    out = []
    for r in cursor.fetchall():
        doctor = (r[7] or patient_journey.parse_admission_notes(r[8]).get("consulting_doctor") or "")
        out.append([f"ADM-{r[0]}", r[1], r[2], r[3], r[4] or "Admitted", " / ".join(x for x in (r[5], r[6]) if x), doctor])
    return out


ADMISSION_COLUMNS = ["Admission", "UHID", "Patient", "Admitted", "Discharged", "Ward / Bed", "Doctor"]


_ACTIVE_PATIENTS = """SELECT patient_id FROM appointments WHERE DATE(appointment_date) BETWEEN ? AND ?
    UNION SELECT patient_id FROM admissions WHERE COALESCE(notes, '') != 'Initial registration' AND DATE(admission_date) BETWEEN ? AND ?
    UNION SELECT patient_id FROM encounters WHERE DATE(arrival_at) BETWEEN ? AND ?"""


def _buckets(start, end):
    """Trend buckets for the range: days up to a month, weeks up to ~4 months, otherwise calendar months."""
    s0, e0 = date_type.fromisoformat(start), date_type.fromisoformat(end)
    days = (e0 - s0).days + 1
    out = []
    if days <= 31:
        for i in range(days):
            d = s0 + timedelta(days=i)
            out.append({"label": d.strftime("%d %b"), "from": d.isoformat(), "to": d.isoformat()})
    elif days <= 122:
        cur = s0
        while cur <= e0:
            stop = min(cur + timedelta(days=6), e0)
            out.append({"label": f"{cur.strftime('%d %b')}", "from": cur.isoformat(), "to": stop.isoformat()})
            cur = stop + timedelta(days=1)
    else:
        cur = s0
        while cur <= e0:
            nxt = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
            stop = min(nxt - timedelta(days=1), e0)
            out.append({"label": cur.strftime("%b %Y"), "from": cur.isoformat(), "to": stop.isoformat()})
            cur = nxt
    return out


@router.get("/analysis/summary")
def analysis_summary(date_from: str, date_to: str | None = None, db: Session = Depends(get_db),
                     user: dict = Depends(require_hospital_overview("patients.read")),
                     hospital_id: int = Depends(current_hospital_id)):
    """Everything on the Analysis page for the chosen day / week / month / year / custom range (inclusive)."""
    start, end = _range(date_from, date_to)
    entries = revenue_details.collection_entries(db, start, "range", end)
    modules = {c: 0.0 for c in revenue_details.CATEGORY_ORDER}
    modes = {}
    for e in entries:
        modules[e["category"]] = round(modules[e["category"]] + e["amount"], 2)
        m = (e.get("mode") or "cash").strip().lower()
        # Only real payment methods; internal billing tags (ipd_running, recorded on bill ...) are not a way of paying.
        if m not in ("cash", "card", "upi", "cheque", "razorpay", "net_banking", "bank_transfer"):
            continue
        modes[m] = round(modes.get(m, 0.0) + e["amount"], 2)
    dues = revenue_details.due_entries(db, start, end)

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        def one(sql, params=()):
            cursor.execute(sql, tuple(params))
            row = cursor.fetchone()
            return (row[0] if row else 0) or 0

        cursor.execute("SELECT DATE(created_at) AS d, COUNT(*) FROM patients WHERE hospital_id = ? AND DATE(created_at) BETWEEN ? AND ? GROUP BY 1", (hospital_id, start, end))
        per_day = {str(r[0]): r[1] for r in cursor.fetchall()}
        trend = []
        for b in _buckets(start, end):
            count = sum(c for d, c in per_day.items() if b["from"] <= d <= b["to"])
            trend.append({**b, "count": count})

        visits = {
            "op": one("SELECT COUNT(*) FROM appointments WHERE UPPER(visit_type) = 'OP' AND DATE(appointment_date) BETWEEN ? AND ?", (start, end)),
            "ip": one("SELECT COUNT(*) FROM admissions WHERE COALESCE(notes, '') != 'Initial registration' AND hospital_id = ? AND DATE(admission_date) BETWEEN ? AND ?", (hospital_id, start, end)),
            "er": one("SELECT COUNT(*) FROM encounters WHERE UPPER(COALESCE(encounter_type, '')) = 'EMERGENCY' AND DATE(arrival_at) BETWEEN ? AND ?", (start, end)),
        }

        queue_total = one("SELECT COUNT(*) FROM appointments WHERE DATE(COALESCE(appointment_date, created_at)) BETWEEN ? AND ?", (start, end))
        queue_done = one("""SELECT COUNT(*) FROM appointments WHERE DATE(COALESCE(appointment_date, created_at)) BETWEEN ? AND ?
                            AND LOWER(COALESCE(status, '')) IN ('completed', 'finished', 'consulted', 'done')""", (start, end))
        bill_total = one("SELECT COUNT(*) FROM invoices WHERE DATE(created_at) BETWEEN ? AND ?", (start, end))
        bill_done = one("""SELECT COUNT(*) FROM invoices WHERE DATE(created_at) BETWEEN ? AND ?
                           AND (LOWER(COALESCE(payment_status, '')) = 'paid' OR COALESCE(paid_amount, 0) > 0)""", (start, end))

        cursor.execute(f"""SELECT COALESCE(NULLIF(INITCAP(TRIM(p.gender)), ''), 'Unknown'), COUNT(*) FROM patients p
                           WHERE p.hospital_id = ? AND p.patient_id IN ({_ACTIVE_PATIENTS}) GROUP BY 1 ORDER BY 2 DESC""", (hospital_id, start, end, start, end, start, end))
        gender = [{"label": r[0], "count": r[1]} for r in cursor.fetchall()]

        cursor.execute("""SELECT CASE WHEN discharge_date IS NULL THEN 'Active' ELSE 'Discharged' END, COUNT(*) FROM admissions
                          WHERE hospital_id = ? AND COALESCE(notes, '') != 'Initial registration' AND DATE(admission_date) BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC""", (hospital_id, start, end))
        admissions = [{"label": r[0], "count": r[1]} for r in cursor.fetchall()]

        cursor.execute("""SELECT COALESCE(NULLIF(TRIM(referral_source), ''), 'unknown'), COUNT(*) FROM encounters
                          WHERE DATE(arrival_at) BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC""", (start, end))
        referrals = [{"label": r[0], "count": r[1]} for r in cursor.fetchall()]

    return {
        "from": start, "to": end, "days": (date_type.fromisoformat(end) - date_type.fromisoformat(start)).days + 1,
        "revenue": {
            "total": round(sum(modules.values()), 2), "modules": modules, "outstanding": round(sum(e["amount"] for e in dues), 2),
            "payment_modes": [{"label": k, "amount": v} for k, v in sorted(modes.items(), key=lambda kv: -kv[1]) if v > 0],
        },
        "registrations": {"total": sum(t["count"] for t in trend), "trend": trend},
        "visits": visits,
        "operations": {
            "queue": {"count": queue_total, "completed": queue_done},
            "billing": {"count": bill_total, "completed": bill_done},
            "payments": {"count": len(entries) + len(dues), "completed": len(entries)},
        },
        "gender": gender, "admissions": admissions, "referrals": referrals,
    }


@router.get("/analysis/drilldown")
def analysis_drilldown(kind: str, key: str = "", date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db),
                       user: dict = Depends(require_hospital_overview("patients.read")),
                       hospital_id: int = Depends(current_hospital_id)):
    start, end = _range(date_from or datetime.now().strftime("%Y-%m-%d"), date_to)
    span = _label(start, end)
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        if kind == "registrations":
            b_from, _, b_to = key.partition("|")
            b_from, b_to = _range(b_from or start, b_to or b_from or end)
            rows = _fetch(cursor, f"""SELECT p.patient_id, {_name()}, p.age, p.gender, p.phone, p.created_at FROM patients p
                                      WHERE p.hospital_id = ? AND DATE(p.created_at) BETWEEN ? AND ? ORDER BY p.created_at DESC LIMIT {LIMIT}""", (hospital_id, b_from, b_to))
            return _result(f"Patients registered {_label(b_from, b_to)}", ["UHID", "Patient", "Age", "Gender", "Phone", "Registered"], rows)

        if kind == "gender":
            value = key.strip().lower()
            if value not in ("male", "female"):
                raise HTTPException(status_code=400, detail="Unknown gender.")
            rows = _fetch(cursor, f"""SELECT p.patient_id, {_name()}, p.age, p.phone, p.created_at FROM patients p
                                      WHERE p.hospital_id = ? AND LOWER(TRIM(p.gender)) = ? AND p.patient_id IN ({_ACTIVE_PATIENTS})
                                      ORDER BY p.created_at DESC LIMIT {LIMIT}""", (hospital_id, value, start, end) * 1 + (start, end, start, end))
            return _result(f"{value.title()} patients seen {span}", ["UHID", "Patient", "Age", "Phone", "Registered"], rows,
                           note="Patients with an appointment, admission or emergency visit in this period.")

        if kind == "admissions":
            status = key.strip().lower()
            if status not in ("active", "discharged"):
                raise HTTPException(status_code=400, detail="Unknown admission status.")
            where = "a.hospital_id = ? AND DATE(a.admission_date) BETWEEN ? AND ? AND a.discharge_date " + ("IS NULL" if status == "active" else "IS NOT NULL")
            return _result(f"{status.title()} admissions, admitted {span}", ADMISSION_COLUMNS, _admission_rows(cursor, where, (hospital_id, start, end)))

        if kind in ("ward", "beds"):
            ward_clause, params = ("", (hospital_id,)) if kind == "beds" else ("AND LOWER(b.ward) = ?", (hospital_id, key.strip().lower()))
            rows = _fetch(cursor, f"""
                SELECT b.ward, b.room_no, b.bed_no, p.patient_id, {_name()}, b.allocated_at, b.assigned_doctor, b.amount_per_day
                FROM bed_allocations b JOIN patients p ON p.patient_id = b.patient_id JOIN admissions a ON a.id = b.admission_id
                WHERE b.status = 'active' AND a.hospital_id = ? {ward_clause} ORDER BY b.ward, b.bed_no""", params)
            title = "Occupied beds (now)" if kind == "beds" else f"Occupied beds in {key} (now)"
            return _result(title, ["Ward", "Room", "Bed", "UHID", "Patient", "Since", "Doctor", "Rate / day"], rows)

        if kind == "referral":
            source = key.strip().lower()
            rows = _fetch(cursor, f"""
                SELECT e.id, e.patient_id, {_name()}, e.arrival_at, COALESCE(NULLIF(TRIM(e.referral_source), ''), 'unknown'), e.chief_complaint, e.attending_doctor
                FROM encounters e LEFT JOIN patients p ON p.patient_id = e.patient_id
                WHERE DATE(e.arrival_at) BETWEEN ? AND ? AND LOWER(COALESCE(NULLIF(TRIM(e.referral_source), ''), 'unknown')) = ?
                ORDER BY e.arrival_at DESC LIMIT {LIMIT}""", (start, end, source))
            return _result(f"Referrals from {key}, {span}", ["Encounter", "UHID", "Patient", "Arrived", "Source", "Complaint", "Doctor"], rows)

        if kind == "ipop":
            which = key.strip().lower()
            if which == "op":
                rows = _fetch(cursor, f"""SELECT a.token_no, a.patient_id, a.patient_name, a.doctor_name, a.department, a.appointment_date, a.status
                                          FROM appointments a WHERE UPPER(a.visit_type) = 'OP' AND DATE(a.appointment_date) BETWEEN ? AND ?
                                          ORDER BY a.appointment_date DESC LIMIT {LIMIT}""", (start, end))
                return _result(f"OP visits {span}", ["Token", "UHID", "Patient", "Doctor", "Department", "Appointment", "Status"], rows)
            if which == "ip":
                return _result(f"IP admissions {span}", ADMISSION_COLUMNS,
                               _admission_rows(cursor, "a.hospital_id = ? AND DATE(a.admission_date) BETWEEN ? AND ?", (hospital_id, start, end)))
            if which == "er":
                rows = _fetch(cursor, f"""SELECT e.id, e.patient_id, {_name()}, e.arrival_at, e.chief_complaint, e.triage_priority, e.attending_doctor, e.disposition
                                          FROM encounters e LEFT JOIN patients p ON p.patient_id = e.patient_id
                                          WHERE UPPER(COALESCE(e.encounter_type, '')) = 'EMERGENCY' AND DATE(e.arrival_at) BETWEEN ? AND ?
                                          ORDER BY e.arrival_at DESC LIMIT {LIMIT}""", (start, end))
                return _result(f"Emergency visits {span}", ["Encounter", "UHID", "Patient", "Arrived", "Complaint", "Triage", "Doctor", "Disposition"], rows)
            raise HTTPException(status_code=400, detail="Unknown visit type.")

        if kind == "ops":
            which = key.strip().lower()
            if which == "queue":
                rows = _fetch(cursor, f"""SELECT a.token_no, a.patient_id, a.patient_name, a.doctor_name, a.department, a.appointment_date, a.status
                                          FROM appointments a WHERE DATE(COALESCE(a.appointment_date, a.created_at)) BETWEEN ? AND ?
                                          ORDER BY a.appointment_date DESC LIMIT {LIMIT}""", (start, end))
                return _result(f"Consultations {span}", ["Token", "UHID", "Patient", "Doctor", "Department", "Appointment", "Status"], rows,
                               note="Completed = consultation finished; every other status is still pending.")
            if which == "billing":
                rows = _fetch(cursor, f"""SELECT i.invoice_no, i.patient_id, {_name()}, i.module, i.total_amount, i.paid_amount, i.due_amount, i.payment_status, i.created_at
                                          FROM invoices i LEFT JOIN patients p ON p.patient_id = i.patient_id
                                          WHERE DATE(i.created_at) BETWEEN ? AND ? ORDER BY i.created_at DESC LIMIT {LIMIT}""", (start, end))
                return _result(f"Invoices raised {span}", ["Invoice", "UHID", "Patient", "Module", "Total", "Paid", "Due", "Status", "Created"], rows)
            raise HTTPException(status_code=400, detail="Unknown operations figure.")

    raise HTTPException(status_code=400, detail="Unknown drill-down.")
