"""Role-based personal dashboard for non-admin employee logins.

Admins and super admins keep the existing executive dashboard (hospital-summary,
analytics, stats). Every other employee gets a dashboard built for their job:
the same layout, but cards, pending tasks, charts and quick actions that match
their role and only the data they are entitled to.

Access is decided here, on the server:
  * The persona comes from the session profile (job title first, then the
    modules the login has been granted), never from the client.
  * A persona is only chosen when the login holds the permission that module's
    own APIs require (pharmacy.read, diag.read, billing.read ...), so the
    dashboard never shows more than the login could already open elsewhere.
  * A doctor-linked login only sees figures for their own patients
    (security.scoped_doctor_name / access_scope), the same rule every clinical
    list endpoint applies.

The figures reuse the existing summary queries where one exists
(lq.get_patient_stats, lq.get_diag_overview, lq.get_pharmacy_summary,
billing_service.get_billing_overview_stats) so the numbers match the module
overview pages exactly. Read-only: nothing here writes.
"""
from datetime import date as date_cls
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

import billing_service
import legacy_queries as lq
import nurse_assignments
import security

ADMIN_TYPES = ("admin", "super_admin")

PERSONA_LABELS = {
    "doctor": "Doctor",
    "nurse": "Nurse",
    "receptionist": "Front Office / Reception",
    "pharmacist": "Pharmacist",
    "lab_technician": "Lab Technician",
    "billing": "Billing Staff",
    "staff": "Staff",
}


# ------------------------------------------------------------------ persona --

# Job titles offered in Employee Management (frontend/src/lib/jobRoles.ts) and the dashboard
# persona each maps to. Matching is case-insensitive on keywords, so free-text legacy titles
# ("Staff Nurse", "Sr. Pharmacist", "Radiographer") map the same way.
JOB_TITLE_KEYWORDS = [
    ("nurse", ("nurs", "matron", "ward sister")),
    ("pharmacist", ("pharm",)),
    ("lab_technician", ("lab", "patholog", "radiolog", "radiograph", "imaging", "phlebotom", "sonograph")),
    ("billing", ("bill", "cashier", "account", "insurance", "finance")),
    ("receptionist", ("recept", "front office", "front desk", "registration")),
]

FRONT_OFFICE_MODULES = ("patient-registration", "queue-management", "op-management", "follow-up", "doctor-scheduling")


def persona_for_title(job_role: Optional[str]) -> Optional[str]:
    job = (job_role or "").strip().lower()
    if not job:
        return None
    # Only the exact "Doctor" title can be linked to a doctor profile (security.linked_doctor_name),
    # which is what scopes the doctor dashboard to that doctor's own patients.
    if job == "doctor":
        return "doctor"
    for persona, keywords in JOB_TITLE_KEYWORDS:
        if any(k in job for k in keywords):
            return persona
    return None


def _modules(user: dict) -> set:
    return set(user.get("module_access") or [])


def persona_allowed(persona: str, user: dict, perms: set) -> bool:
    """A persona's widgets are only shown when the login already holds that module's access.

    The dashboard never widens access: e.g. a "Pharmacist" title without the Pharmacy module
    gets no pharmacy figures. Doctors only ever see their own patients, so need nothing extra.
    """
    if persona == "doctor":
        return True
    if persona == "nurse":
        return "ip-management" in _modules(user)
    if persona == "pharmacist":
        return "pharmacy.read" in perms
    if persona == "lab_technician":
        return bool(perms & {"diag.read", "lab.read"})
    if persona == "billing":
        return "billing.read" in perms
    if persona == "receptionist":
        return bool(_modules(user) & set(FRONT_OFFICE_MODULES))
    return persona == "staff"


def resolve_persona(user: dict, permissions: Optional[set] = None) -> str:
    """Pick the dashboard persona for a login. 'admin' means the executive dashboard."""
    if not user or user.get("user_type") in ADMIN_TYPES:
        return "admin"
    perms = permissions if permissions is not None else security.resolve_user_permissions(user)

    by_title = persona_for_title(user.get("job_role"))
    if by_title and persona_allowed(by_title, user, perms):
        return by_title

    # Generic titles (Technician, Other, Admin as a job title...) or a title whose module was
    # not granted: use the modules the login actually holds.
    for persona in ("lab_technician", "pharmacist", "billing", "receptionist"):
        if persona_allowed(persona, user, perms):
            return persona
    return "staff"


# ------------------------------------------------------------------ helpers --

def _parse_date(value: Optional[str]) -> str:
    today = lq.current_ist_datetime().date()
    if not value:
        return today.isoformat()
    raw = str(value).split("T")[0].split(" ")[0]
    try:
        return date_cls.fromisoformat(raw).isoformat()
    except ValueError:
        return today.isoformat()


def _scalar(db: Session, sql: str, params: dict) -> float:
    row = db.execute(text(sql), params).fetchone()
    return (row[0] if row and row[0] is not None else 0)


def _rows(db: Session, sql: str, params: dict) -> list[dict]:
    return [dict(r._mapping) for r in db.execute(text(sql), params).fetchall()]


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def kpi(key, label, value, *, sub="", fmt="number", icon="users", accent="indigo", page=None):
    return {"key": key, "label": label, "value": value, "sub": sub, "format": fmt,
            "icon": icon, "accent": accent, "page": page}


def task(key, label, count, *, page=None, severity="normal", icon="•"):
    return {"key": key, "label": label, "count": int(count or 0), "page": page,
            "severity": severity if int(count or 0) > 0 else "normal", "icon": icon}


def _status_breakdown(rows: list[dict], order: list[tuple[str, tuple]]) -> list[dict]:
    """Collapse raw status counts into labelled buckets (in display order)."""
    counts = {str(r.get("status") or "").lower(): int(r.get("c") or 0) for r in rows}
    items = []
    used = set()
    for label, statuses in order:
        total = sum(counts.get(s, 0) for s in statuses)
        used.update(statuses)
        items.append({"label": label, "count": total})
    other = sum(v for k, v in counts.items() if k not in used)
    if other:
        items.append({"label": "Other", "count": other})
    return items


APPOINTMENT_BUCKETS = [
    ("Waiting", ("scheduled", "waiting", "checked_in")),
    ("In Consultation", ("in_consultation", "in-consultation")),
    ("Completed", ("completed",)),
    ("No-show / Cancelled", ("no_show", "cancelled", "skipped")),
]


# ----------------------------------------------------------------- personas --

def _doctor(db: Session, user: dict, day: str, perms: set) -> dict:
    doctor = security.scoped_doctor_name(user)
    if not doctor:
        return {
            "scope_label": "Your login is not linked to a doctor profile",
            "notice": "Ask an administrator to link your login to your doctor profile in Employee Management "
                      "to see your appointments, inpatients and pending results here.",
            "kpis": [], "tasks": [], "breakdown": None, "worklist": None,
        }
    d = doctor.strip().lower()
    p = {"d": d, "day": day}

    appt_rows = _rows(db, """
        SELECT LOWER(COALESCE(status, '')) AS status, COUNT(*) AS c FROM appointments
        WHERE LOWER(TRIM(doctor_name)) = :d AND DATE(appointment_date) = DATE(:day)
        GROUP BY 1
    """, p)
    breakdown = _status_breakdown(appt_rows, APPOINTMENT_BUCKETS)
    total_appts = sum(b["count"] for b in breakdown)
    waiting = breakdown[0]["count"]
    in_consult = breakdown[1]["count"]
    completed = breakdown[2]["count"]

    my_inpatients = _scalar(db, """
        SELECT COUNT(DISTINCT patient_id) FROM bed_allocations
        WHERE status = 'active' AND released_at IS NULL AND LOWER(TRIM(assigned_doctor)) = :d
    """, p)
    follow_ups = _scalar(db, """
        SELECT COUNT(*) FROM appointments
        WHERE LOWER(TRIM(doctor_name)) = :d AND DATE(appointment_date) = DATE(:day)
          AND appointment_kind = 'follow_up'
    """, p)
    prescriptions_day = _scalar(db, """
        SELECT COUNT(*) FROM prescriptions
        WHERE LOWER(TRIM(doctor_name)) = :d AND DATE(COALESCE(consultation_date, created_at)) = DATE(:day)
          AND status <> 'cancelled'
    """, p)
    pending_results = _scalar(db, """
        SELECT COUNT(*) FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
        WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL
          AND oi.progress_status NOT IN ('released', 'cancelled')
          AND LOWER(TRIM(o.referring_clinician)) = :d
    """, p)
    results_released = _scalar(db, """
        SELECT COUNT(*) FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
        WHERE oi.progress_status = 'released' AND oi.cancelled_at IS NULL
          AND LOWER(TRIM(o.referring_clinician)) = :d
          AND o.created_at >= CAST(:day AS date) - INTERVAL '2 days'
    """, p)
    # Discharge summaries of this doctor's current inpatients still awaiting completion.
    pending_discharge = _scalar(db, """
        SELECT COUNT(*) FROM discharge_summaries ds
        WHERE ds.status IN ('DRAFT', 'PENDING_REVIEW') AND ds.patient_id IN (
            SELECT patient_id FROM bed_allocations WHERE LOWER(TRIM(assigned_doctor)) = :d
        )
    """, p)
    er_active = _scalar(db, """
        SELECT COUNT(*) FROM encounters
        WHERE encounter_type = 'EMERGENCY' AND COALESCE(status, 'active') = 'active'
          AND LOWER(TRIM(attending_doctor)) = :d
    """, p)

    queue = _rows(db, """
        SELECT token_no, patient_id, patient_name, status, appointment_kind, department,
               to_char(appointment_date, 'HH24:MI') AS time
        FROM appointments
        WHERE LOWER(TRIM(doctor_name)) = :d AND DATE(appointment_date) = DATE(:day)
          AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'skipped', 'no_show')
        ORDER BY CASE WHEN LOWER(status) IN ('completed') THEN 1 ELSE 0 END, token_no
        LIMIT 8
    """, p)

    return {
        "scope_label": f"Showing only {doctor}'s patients",
        "kpis": [
            kpi("appointments", "My Appointments", total_appts, sub=f"{completed} completed", icon="calendar",
                accent="indigo", page="op-queue-management"),
            kpi("waiting", "Waiting in Queue", waiting + in_consult, sub=f"{in_consult} in consultation",
                icon="clock", accent="amber", page="op-queue-management"),
            kpi("inpatients", "My Inpatients", my_inpatients, sub="Currently admitted under you", icon="bed",
                accent="violet", page="inpatient-patients"),
            kpi("prescriptions", "Prescriptions", prescriptions_day, sub="Written on this day", icon="rx",
                accent="teal", page="doctor-prescription"),
            kpi("pending_results", "Pending Lab Results", pending_results, sub=f"{results_released} released recently",
                icon="flask", accent="blue", page="doctors-history"),
            kpi("follow_ups", "Follow-ups", follow_ups, sub="Follow-up visits booked", icon="repeat",
                accent="green", page="op-queue-management"),
        ],
        "tasks": [
            task("queue", "Patients waiting for consultation", waiting, page="op-queue-management", severity="high", icon="🩺"),
            task("in_consult", "Consultations in progress", in_consult, page="op-queue-management", icon="⏳"),
            task("results", "Lab / imaging results awaited", pending_results, page="doctors-history", icon="🧪"),
            task("discharge", "Discharge summaries to complete", pending_discharge, page="discharge-summary", severity="high", icon="📄"),
            task("er", "Active emergency cases", er_active, page="emergency-worklist", severity="high", icon="🚑"),
        ],
        "breakdown": {"title": "My OP Queue Status", "items": breakdown, "page": "op-queue-management"},
        "worklist": {
            "title": "My Queue",
            "page": "op-queue-management",
            "columns": ["Token", "Patient", "Time", "Status"],
            "rows": [[r.get("token_no"), r.get("patient_name") or r.get("patient_id"), r.get("time") or "-",
                      (r.get("status") or "").replace("_", " ").title()] for r in queue],
            "empty": "No patients in your queue for this day.",
        },
    }


def _nurse(db: Session, user: dict, day: str, perms: set, hospital_id: int) -> dict:
    """Nursing dashboard, limited to the patients assigned to this nurse.

    Every patient-level figure (eMAR doses, indents, discharges, the dose list) is
    filtered to the nurse's active assignments. A nurse with no assignments gets an
    empty assigned-patient list and zero counts, never the whole ward.
    """
    from routers.nursing import can_manage  # same supervisor rule as the Nursing Station API

    me = (user.get("username") or "").strip().lower()
    mine = nurse_assignments.list_active(db, hospital_id, me)
    adm_ids = sorted({int(r["admission_id"]) for r in mine})
    personal = bool(adm_ids)
    supervisor = can_manage(user)
    p = {"day": day, "me": me, "adm": adm_ids}
    # Always scoped: with no assignments, ANY(empty array) matches nothing.
    emar_scope = "AND e.admission_id = ANY(CAST(:adm AS integer[]))"
    indent_scope = "AND w.admission_id = ANY(CAST(:adm AS integer[]))"
    alloc_scope = "AND ba.admission_id = ANY(CAST(:adm AS integer[]))"

    stats = lq.get_patient_stats(db, selected_date=day)
    bed_capacity = int(stats.get("bed_capacity") or 0)
    occupied = int(stats.get("active_beds") or 0)

    emar_rows = _rows(db, f"""
        SELECT LOWER(e.status) AS status, COUNT(*) AS c FROM emar_records e
        WHERE DATE(e.scheduled_time) = DATE(:day) {emar_scope} GROUP BY 1
    """, p)
    emar = {r["status"]: int(r["c"]) for r in emar_rows}
    overdue = _scalar(db, f"""
        SELECT COUNT(*) FROM emar_records e
        WHERE e.status = 'pending' AND e.scheduled_time < (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '30 minutes'
          AND DATE(e.scheduled_time) <= DATE(:day) {emar_scope}
    """, p)
    due_next_hour = _scalar(db, f"""
        SELECT COUNT(*) FROM emar_records e
        WHERE e.status = 'pending'
          AND e.scheduled_time BETWEEN (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '30 minutes'
                                   AND (NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 hour' {emar_scope}
    """, p)
    # Doses this nurse personally charted (their own work, whoever the patient is assigned to).
    given_by_me = _scalar(db, """
        SELECT COUNT(*) FROM emar_records
        WHERE status = 'given' AND LOWER(TRIM(administered_by)) = :me AND DATE(administered_at) = DATE(:day)
    """, p)
    pending_indents = _scalar(db, f"""
        SELECT COUNT(*) FROM ward_indents w
        WHERE w.status IN ('pending', 'processing', 'partially_issued') {indent_scope}
    """, p)
    er_active = _scalar(db, "SELECT COUNT(*) FROM encounters WHERE encounter_type = 'EMERGENCY' AND COALESCE(status, 'active') = 'active'", p)
    discharges_due = _scalar(db, f"""
        SELECT COUNT(*) FROM bed_allocations ba
        WHERE ba.status = 'active' AND ba.released_at IS NULL AND DATE(ba.expected_discharge_date) <= DATE(:day) {alloc_scope}
    """, p)

    upcoming = _rows(db, f"""
        SELECT e.patient_id, e.medicine_name, e.dose, to_char(e.scheduled_time, 'HH24:MI') AS time,
               ba.ward, ba.bed_no
        FROM emar_records e
        LEFT JOIN bed_allocations ba ON ba.admission_id = e.admission_id AND ba.status = 'active'
        WHERE e.status = 'pending' AND DATE(e.scheduled_time) = DATE(:day) {emar_scope}
        ORDER BY e.scheduled_time LIMIT 8
    """, p)

    scheduled_total = sum(emar.values())
    wards = ", ".join(sorted({r["ward"] for r in mine if r.get("ward")}))[:60]
    if personal:
        scope_label = f"Your {len(adm_ids)} assigned patient{'s' if len(adm_ids) != 1 else ''}"
        notice = None
    else:
        scope_label = "No patients assigned to you"
        notice = ("No patients are assigned to you yet, so your patient list is empty. "
                  "A nursing supervisor can assign patients from the Nursing Station.")

    tasks = [
        task("overdue", "Overdue medication doses", overdue, page="nurse-station", severity="high", icon="⚠️"),
        task("due_now", "Doses due within the next hour", due_next_hour, page="nurse-station", severity="high", icon="💊"),
        task("indents", "Ward indents awaiting pharmacy", pending_indents, page="nurse-station", icon="📦"),
        task("discharges", "My patients due for discharge", discharges_due, page="discharge-summary", icon="🏠"),
    ]
    if supervisor:
        # Ward-wide count only for those who can act on it (supervisors assign nurses).
        unassigned = len(nurse_assignments.unassigned_admissions(db, hospital_id))
        tasks.append(task("unassigned", "Admitted patients without a nurse", unassigned, page="nurse-station", icon="🧑‍⚕️"))
    tasks.append(task("er", "Active emergency cases", er_active, page="emergency-worklist", icon="🚑"))

    return {
        "scope_label": scope_label,
        "notice": notice,
        "assigned_patients": [
            {"patient_id": r.get("patient_id"), "patient_name": r.get("patient_name"), "ward": r.get("ward"),
             "bed": r.get("bed"), "shift": r.get("shift")} for r in mine
        ],
        "kpis": [
            kpi("my_patients", "My Patients", len(adm_ids), sub=wards or ("Assigned to you" if personal else "None assigned yet"),
                icon="users", accent="violet", page="nurse-station"),
            kpi("doses_due", "Doses Scheduled", scheduled_total, sub=f"{emar.get('given', 0)} given · my patients", icon="pill",
                accent="teal", page="nurse-station"),
            kpi("overdue", "Overdue Doses", overdue, sub="Pending > 30 min past time", icon="alert",
                accent="red", page="nurse-station"),
            kpi("given_by_me", "Given by Me", given_by_me, sub="Doses you charted", icon="check",
                accent="green", page="nurse-station"),
            kpi("beds", "Bed Occupancy", f"{occupied} / {bed_capacity}", fmt="text",
                sub=f"{max(bed_capacity - occupied, 0)} beds free", icon="bed", accent="indigo", page="bed-management"),
            kpi("indents", "Pending Ward Indents", pending_indents, sub="Awaiting pharmacy · my patients", icon="box",
                accent="amber", page="nurse-station"),
        ],
        "tasks": tasks,
        "breakdown": {
            "title": "My Patients' Medications (eMAR)",
            "items": [
                {"label": "Given", "count": emar.get("given", 0)},
                {"label": "Pending", "count": emar.get("pending", 0)},
                {"label": "Held / Refused", "count": emar.get("held", 0) + emar.get("refused", 0)},
                {"label": "Missed", "count": emar.get("missed", 0)},
            ],
            "page": "nurse-station",
        },
        "worklist": {
            "title": "My Upcoming Doses",
            "page": "nurse-station",
            "columns": ["Time", "Patient", "Medicine", "Ward / Bed"],
            "rows": [[r.get("time"), r.get("patient_id"), f"{r.get('medicine_name')} {r.get('dose') or ''}".strip(),
                      " / ".join(x for x in (r.get("ward"), r.get("bed_no")) if x) or "-"] for r in upcoming],
            "empty": ("No pending doses for your assigned patients on this day." if personal
                      else "No patients are assigned to you, so there are no doses to show."),
        },
    }


def _receptionist(db: Session, user: dict, day: str, perms: set) -> dict:
    p = {"day": day}
    stats = lq.get_patient_stats(db, selected_date=day)
    appt_rows = _rows(db, """
        SELECT LOWER(COALESCE(status, '')) AS status, COUNT(*) AS c FROM appointments
        WHERE DATE(appointment_date) = DATE(:day) GROUP BY 1
    """, p)
    breakdown = _status_breakdown(appt_rows, APPOINTMENT_BUCKETS)
    total_appts = sum(b["count"] for b in breakdown)
    bed_capacity = int(stats.get("bed_capacity") or 0)
    occupied = int(stats.get("active_beds") or 0)
    not_checked_in = _scalar(db, """
        SELECT COUNT(*) FROM appointments WHERE DATE(appointment_date) = DATE(:day) AND status = 'scheduled'
    """, p)
    doctors_available = _scalar(db, """
        SELECT COUNT(DISTINCT doctor_name) FROM doctor_schedules WHERE schedule_date = :day AND status = 'available'
    """, p)
    er_active = _scalar(db, "SELECT COUNT(*) FROM encounters WHERE encounter_type = 'EMERGENCY' AND COALESCE(status, 'active') = 'active'", p)

    recent = _rows(db, """
        SELECT token_no, patient_name, doctor_name, status FROM appointments
        WHERE DATE(appointment_date) = DATE(:day)
        ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 8
    """, p)

    return {
        "scope_label": "Front office activity",
        "kpis": [
            kpi("registrations", "Registrations", int(stats.get("today") or 0), sub="New patients registered",
                icon="users", accent="indigo", page="patients"),
            kpi("appointments", "Appointments", total_appts, sub=f"{breakdown[2]['count']} completed", icon="calendar",
                accent="amber", page="op-queue-management"),
            kpi("revisits", "Re-visits", int(stats.get("revisits") or 0), sub="Returning patients", icon="repeat",
                accent="green", page="readmit"),
            kpi("follow_ups", "Follow-ups", int(stats.get("follow_ups") or 0), sub="Follow-up consultations",
                icon="clipboard", accent="teal", page="readmit"),
            kpi("doctors", "Doctors Available", doctors_available, sub="As per doctor schedule", icon="stethoscope",
                accent="blue", page="op-desk"),
            kpi("beds", "Bed Availability", max(bed_capacity - occupied, 0), sub=f"{occupied} of {bed_capacity} occupied",
                icon="bed", accent="violet", page="bed-management"),
        ],
        "tasks": [
            task("not_checked_in", "Booked patients not yet checked in", not_checked_in, page="op-queue-management", severity="high", icon="📋"),
            task("waiting", "Patients waiting in OP queue", breakdown[0]["count"], page="op-queue-management", icon="🏥"),
            task("er", "Active emergency cases", er_active, page="emergency-worklist", icon="🚑"),
        ],
        "breakdown": {"title": "OP Queue Status", "items": breakdown, "page": "op-queue-management"},
        "worklist": {
            "title": "Latest Appointments",
            "page": "op-queue-management",
            "columns": ["Token", "Patient", "Doctor", "Status"],
            "rows": [[r.get("token_no"), r.get("patient_name"), r.get("doctor_name") or "-",
                      (r.get("status") or "").replace("_", " ").title()] for r in recent],
            "empty": "No appointments booked for this day.",
        },
    }


def _pharmacist(db: Session, user: dict, day: str, perms: set) -> dict:
    p = {"day": day}
    summary = lq.get_pharmacy_summary(db)
    day_sales = _rows(db, """
        SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS cnt FROM pharmacy_sales WHERE DATE(sold_at) = DATE(:day)
    """, p)[0]
    by_type = _rows(db, """
        SELECT CASE
                 WHEN billing_type = 'IPD_RUNNING' THEN 'IP Issues'
                 WHEN billing_type IN ('EMERGENCY', 'EMERGENCY_IMMEDIATE', 'EMERGENCY_ACCOUNT') THEN 'Emergency'
                 ELSE 'OP Counter'
               END AS label, COUNT(*) AS count
        FROM pharmacy_sales WHERE DATE(sold_at) = DATE(:day) GROUP BY 1
    """, p)
    by_type_map = {r["label"]: int(r["count"]) for r in by_type}
    pending_rx = _scalar(db, """
        SELECT COUNT(*) FROM prescriptions
        WHERE status <> 'cancelled' AND dispense_status IN ('sent_to_pharmacy', 'partially_dispensed')
    """, p)
    pending_indents = int(summary.get("pending_ward_indents") or 0)
    partial_indents = int(summary.get("partially_issued_indents") or 0)

    low_items = summary.get("low_stock_items") or []
    return {
        "scope_label": "Dispensing and stock",
        "kpis": [
            kpi("sales", "Pharmacy Sales", _num(day_sales.get("amount")), fmt="currency",
                sub=f"{int(day_sales.get('cnt') or 0)} line items", icon="pill", accent="teal", page="pharmacy-reports"),
            kpi("pending_rx", "Prescriptions to Dispense", pending_rx, sub="Sent to pharmacy", icon="rx",
                accent="amber", page="pharmacy-op-dispense"),
            kpi("indents", "Pending Ward Indents", pending_indents + partial_indents, sub=f"{partial_indents} partially issued",
                icon="box", accent="indigo", page="pharmacy-ip-dispense"),
            kpi("low_stock", "Low Stock", int(summary.get("low_stock_count") or 0),
                sub=f"{int(summary.get('out_of_stock_count') or 0)} out of stock", icon="alert", accent="red",
                page="pharmacy-inventory"),
            kpi("expiring", "Expiring ≤ 1 Month", int(summary.get("expiring_1m") or 0),
                sub=f"{int(summary.get('expired_count') or 0)} already expired", icon="clock", accent="violet",
                page="pharmacy-inventory"),
            kpi("stock_value", "Stock Value", _num(summary.get("total_stock_value")), fmt="currency",
                sub=f"{int(summary.get('total_stock_items') or 0)} items", icon="chart", accent="green",
                page="pharmacy-inventory"),
        ],
        "tasks": [
            task("rx", "OP prescriptions awaiting dispense", pending_rx, page="pharmacy-op-dispense", severity="high", icon="💊"),
            task("indents", "Ward indents to issue", pending_indents, page="pharmacy-ip-dispense", severity="high", icon="📦"),
            task("partial", "Partially issued indents", partial_indents, page="pharmacy-ip-dispense", icon="🧾"),
            task("out", "Medicines out of stock", summary.get("out_of_stock_count") or 0, page="pharmacy-inventory", icon="🚫"),
            task("expired", "Expired batches to remove", summary.get("expired_count") or 0, page="pharmacy-inventory", icon="🗓️"),
        ],
        "breakdown": {
            "title": "Dispensing Mix",
            "items": [{"label": k, "count": by_type_map.get(k, 0)} for k in ("OP Counter", "IP Issues", "Emergency")],
            "page": "pharmacy-reports",
        },
        "worklist": {
            "title": "Low Stock Items",
            "page": "pharmacy-inventory",
            "columns": ["Medicine", "Available", "Reorder Level"],
            "rows": [[i.get("medicine_name"), i.get("current_stock"), i.get("reorder_level")] for i in low_items[:8]],
            "empty": "No medicines below reorder level.",
        },
    }


def _lab(db: Session, user: dict, day: str, perms: set) -> dict:
    p = {"day": day}
    ov = lq.get_diag_overview(db)
    orders_day = _scalar(db, "SELECT COUNT(*) FROM diag_orders WHERE status = 'confirmed' AND DATE(created_at) = DATE(:day)", p)
    released_day = _scalar(db, """
        SELECT COUNT(*) FROM diag_reports WHERE status = 'released' AND DATE(released_at) = DATE(:day)
    """, p)
    stage_rows = _rows(db, """
        SELECT oi.progress_status AS status, COUNT(*) AS c
        FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
        WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL AND DATE(o.created_at) = DATE(:day)
        GROUP BY 1
    """, p)
    stages = _status_breakdown(stage_rows, [
        ("Ordered", ("ordered",)),
        ("Collected / Received", ("collected", "received")),
        ("In Progress", ("in_progress", "exam_completed", "results_entered")),
        ("Authorized / Released", ("authorized", "released")),
    ])
    stat_list = _rows(db, """
        SELECT o.order_no, COALESCE(o.patient_id, o.walkin_name) AS patient, oi.service_name, oi.progress_status
        FROM diag_order_items oi JOIN diag_orders o ON o.id = oi.order_id
        WHERE o.status = 'confirmed' AND oi.cancelled_at IS NULL
          AND oi.progress_status NOT IN ('released', 'cancelled')
        ORDER BY CASE o.priority WHEN 'STAT' THEN 0 WHEN 'Urgent' THEN 1 ELSE 2 END, o.created_at
        LIMIT 8
    """, p)
    qc_holds = _scalar(db, "SELECT COUNT(*) FROM diag_qc_holds WHERE status <> 'released'", p)

    return {
        "scope_label": "Laboratory & diagnostics worklist",
        "kpis": [
            kpi("orders", "Orders", orders_day, sub="Confirmed diagnostic orders", icon="clipboard",
                accent="indigo", page="diag-orders-billing"),
            kpi("collection", "Pending Collection", int(ov.get("pending_collection") or 0), sub="Samples to collect",
                icon="flask", accent="amber", page="diag-laboratory"),
            kpi("processing", "In Processing", int(ov.get("in_processing") or 0), sub="Received / under test",
                icon="clock", accent="blue", page="diag-laboratory"),
            kpi("validation", "Awaiting Validation", int(ov.get("pending_validation") or 0),
                sub=f"{int(ov.get('ready_for_release') or 0)} ready for release", icon="check", accent="violet",
                page="diag-reports-approval"),
            kpi("stat", "STAT Cases", int(ov.get("stat_cases") or 0), sub=f"{int(ov.get('overdue_count') or 0)} past TAT",
                icon="alert", accent="red", page="diag-laboratory"),
            kpi("released", "Reports Released", released_day, sub="Released on this day", icon="doc",
                accent="green", page="diag-reports-history"),
        ],
        "tasks": [
            task("collect", "Samples awaiting collection", ov.get("pending_collection") or 0, page="diag-laboratory", severity="high", icon="🧪"),
            task("validate", "Reports awaiting validation", ov.get("pending_validation") or 0, page="diag-reports-approval", severity="high", icon="✅"),
            task("release", "Authorized reports to release", ov.get("ready_for_release") or 0, page="diag-reports-approval", icon="📤"),
            task("critical", "Open critical value alerts", ov.get("critical_alerts_open") or 0, page="diag-laboratory", severity="high", icon="🚨"),
            task("overdue", "Tests past turnaround time", ov.get("overdue_count") or 0, page="diag-laboratory", severity="high", icon="⏰"),
            task("qc", "QC holds blocking results", qc_holds, page="diag-quality-equipment", icon="🛠️"),
        ],
        "breakdown": {"title": "Test Progress", "items": stages, "page": "diag-laboratory"},
        "worklist": {
            "title": "Priority Worklist",
            "page": "diag-laboratory",
            "columns": ["Order", "Patient", "Test", "Stage"],
            "rows": [[r.get("order_no"), r.get("patient") or "-", r.get("service_name"),
                      (r.get("progress_status") or "").replace("_", " ").title()] for r in stat_list],
            "empty": "No open tests.",
        },
    }


def _billing(db: Session, user: dict, day: str, perms: set) -> dict:
    p = {"day": day}
    ov = billing_service.get_billing_overview_stats(db, target_date=day)
    invoices_day = _rows(db, """
        SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS amount FROM invoices
        WHERE DATE(timezone('Asia/Kolkata', CAST(created_at AS timestamptz))) = DATE(:day)
    """, p)[0]
    pending_count = _scalar(db, "SELECT COUNT(*) FROM invoices WHERE due_amount > 0", p)
    modes = _rows(db, """
        SELECT CASE LOWER(ip.payment_mode)
                 WHEN 'cash' THEN 'Cash' WHEN 'upi' THEN 'UPI' WHEN 'card' THEN 'Card'
                 ELSE 'Other' END AS label,
               COALESCE(SUM(ip.amount), 0) AS count
        FROM invoice_payments ip
        WHERE DATE(timezone('Asia/Kolkata', CAST(ip.created_at AS timestamptz))) = DATE(:day)
        GROUP BY 1
    """, p)
    mode_map = {r["label"]: round(_num(r["count"]), 2) for r in modes}
    pending_discharge = _scalar(db, """
        SELECT COUNT(DISTINCT admission_id) FROM bed_allocations
        WHERE status = 'active' AND released_at IS NULL AND DATE(expected_discharge_date) <= DATE(:day)
    """, p)
    top_dues = _rows(db, """
        SELECT i.invoice_no, COALESCE(i.patient_name, i.patient_id) AS patient, i.module, i.due_amount
        FROM invoices i WHERE i.due_amount > 0
        ORDER BY i.due_amount DESC, i.id DESC LIMIT 8
    """, p)

    return {
        "scope_label": "Billing counter",
        "kpis": [
            kpi("billed", "Net Billed", _num(ov.get("net_billed")), fmt="currency",
                sub=f"{int(invoices_day.get('cnt') or 0)} invoices", icon="doc", accent="indigo", page="billing-invoices"),
            kpi("receipts", "Receipts", _num(ov.get("receipts_today")), fmt="currency", sub="Bill payments + advances",
                icon="wallet", accent="green", page="billing-module-collections"),
            kpi("refunds", "Refunds", _num(ov.get("refunds_today")), fmt="currency", sub="Paid refund vouchers",
                icon="repeat", accent="amber", page="billing-advances-refunds"),
            kpi("net", "Net Collections", _num(ov.get("net_collections")), fmt="currency", sub="Receipts − refunds",
                icon="chart", accent="teal", page="billing-module-collections"),
            kpi("outstanding", "Outstanding Dues", _num(ov.get("outstanding_dues")), fmt="currency",
                sub=f"{int(pending_count)} unpaid invoices", icon="alert", accent="red", page="billing-patient-bills"),
            kpi("discharge", "Discharge Billing Due", pending_discharge, sub="Patients due for discharge",
                icon="bed", accent="violet", page="billing-ip-discharge"),
        ],
        "tasks": [
            task("dues", "Invoices with pending balance", pending_count, page="billing-patient-bills", severity="high", icon="💳"),
            task("discharge", "IP discharge bills to settle", pending_discharge, page="billing-ip-discharge", severity="high", icon="🏥"),
        ],
        "breakdown": {
            "title": "Collections by Payment Mode",
            "items": [{"label": k, "count": mode_map.get(k, 0)} for k in ("Cash", "UPI", "Card", "Other")],
            "format": "currency",
            "page": "billing-module-collections",
        },
        "worklist": {
            "title": "Highest Pending Dues",
            "page": "billing-patient-bills",
            "columns": ["Invoice", "Patient", "Module", "Due"],
            "rows": [[r.get("invoice_no"), r.get("patient") or "-", r.get("module"), {"currency": _num(r.get("due_amount"))}]
                     for r in top_dues],
            "empty": "No pending dues.",
        },
    }


def _staff(db: Session, user: dict, day: str, perms: set) -> dict:
    stats = lq.get_patient_stats(db, selected_date=day)
    return {
        "scope_label": "Your assigned modules",
        "kpis": [
            kpi("registrations", "Registrations", int(stats.get("today") or 0), sub="New patients", icon="users",
                accent="indigo", page="patients"),
            kpi("admissions", "Active Admissions", int(stats.get("active_admissions") or 0), sub="Inpatients",
                icon="bed", accent="violet", page="inpatient-patients"),
            kpi("revisits", "Re-visits", int(stats.get("revisits") or 0), sub="Returning patients", icon="repeat",
                accent="green", page="patients"),
        ],
        "tasks": [], "breakdown": None, "worklist": None,
    }


_BUILDERS = {
    "doctor": _doctor,
    "nurse": _nurse,
    "receptionist": _receptionist,
    "pharmacist": _pharmacist,
    "lab_technician": _lab,
    "billing": _billing,
    "staff": _staff,
}


def build_role_dashboard(db: Session, user: dict, selected_date: Optional[str] = None,
                         hospital_id: Optional[int] = None) -> dict:
    perms = security.resolve_user_permissions(user)
    persona = resolve_persona(user, perms)
    day = _parse_date(selected_date)
    base = {
        "persona": persona,
        "persona_label": PERSONA_LABELS.get(persona, "Administrator"),
        "job_role": user.get("job_role") or "",
        "date": day,
    }
    if persona == "admin":
        # Admins keep the executive dashboard; nothing personalised to return.
        return {**base, "persona_label": "Administrator", "kpis": [], "tasks": [], "breakdown": None, "worklist": None}
    if persona == "nurse":
        data = _nurse(db, user, day, perms, hospital_id or security.resolve_hospital_id(db))
    else:
        data = _BUILDERS[persona](db, user, day, perms)
    return {**base, "notice": None, **data}
