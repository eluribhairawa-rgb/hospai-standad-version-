"""Lab order service types and home-visit sample routing.

Service types (diag_orders.service_type):
  IN_HOUSE    - registered patient (UHID), existing Internal Sale flow
  EXTERNAL    - walk-in, no UHID, existing External Sale flow
  OUTSOURCING - tests sent to a partner laboratory (lab_vendors)
  HOME_VISIT  - sample collected at the patient's address, then routed per test

Routing (diag_order_items.routing) is decided when a sample reaches the lab:
  OUTSOURCING -> the order's/test's partner lab
  HOME_VISIT  -> in-house if a machine linked to the test (diag_service_equipment) is
                 'ready' with no open QC hold; otherwise the test's preferred partner lab
                 (or 'pending_vendor' until staff pick one). Tests with no linked
                 equipment stay in-house, so unmapped tests behave as before.
Every test stays one diag_order_items row on one order: an outsourced test gets a
diag_external_referrals row and its results/report go through the normal flow, so the
patient's lab history has one record per test whichever lab ran it.

Tables/columns: migrations/migrations_diag_service_types.sql.
"""
from legacy_sql import get_connection

SERVICE_TYPES = ("IN_HOUSE", "EXTERNAL", "OUTSOURCING", "HOME_VISIT")
ROUTED_SERVICE_TYPES = ("OUTSOURCING", "HOME_VISIT")

IN_HOUSE, OUTSOURCED, PENDING_VENDOR = "in_house", "outsourced", "pending_vendor"

SETTINGS_DEFAULTS = {"home_visit_fee": "0"}
MAX_HOME_VISIT_FEE = 100000

_STATUS_LABELS = {"qc_hold": "on QC hold", "maintenance": "under maintenance", "down": "down"}


# ---------------------------------------------------------------------------
# Routing decision (pure; no database)
# ---------------------------------------------------------------------------

def equipment_problem(eq):
    """Why a machine can't run the test right now, or None if it can."""
    status = eq.get("operational_status") or "ready"
    if status != "ready":
        return _STATUS_LABELS.get(status, status)
    if eq.get("open_hold_scope") == "equipment":
        return "on QC hold"
    if eq.get("open_hold_scope") == "assay":
        return "on QC hold for this test"
    return None


def decide_routing(service_type, department_type, equipment=(), preferred_vendor_id=None, vendor_id=None):
    """Returns (routing, reason, vendor_id) for one test, or (None, None, None) when the
    test is not routed (in-house/external orders, imaging and other non-lab services).

    equipment: machines linked to the test, each {name, operational_status, open_hold_scope}
               where open_hold_scope is None, 'equipment' or 'assay'.
    vendor_id: the partner lab chosen on an OUTSOURCING order (per test or per order).
    """
    if department_type != "LAB" or service_type not in ROUTED_SERVICE_TYPES:
        return None, None, None

    if service_type == "OUTSOURCING":
        if vendor_id:
            return OUTSOURCED, "Outsourcing order", vendor_id
        return PENDING_VENDOR, "Outsourcing order: no partner lab selected", None

    # HOME_VISIT
    equipment = list(equipment or [])
    if not equipment:
        return IN_HOUSE, "No equipment linked to this test; processed in-house", None
    problems = []
    for eq in equipment:
        problem = equipment_problem(eq)
        if problem is None:
            return IN_HOUSE, f"{eq.get('name') or 'Equipment'} available", None
        problems.append(f"{eq.get('name') or 'Equipment'} {problem}")
    reason = "In-house equipment unavailable (" + "; ".join(problems) + ")"
    if preferred_vendor_id:
        return OUTSOURCED, reason, preferred_vendor_id
    return PENDING_VENDOR, reason + ": select a partner lab", None


# ---------------------------------------------------------------------------
# Routing against the database (runs inside the caller's transaction)
# ---------------------------------------------------------------------------

def load_service_equipment(cursor, service_id):
    cursor.execute(
        """
        SELECT e.id, e.name, e.asset_id, e.operational_status,
               (SELECT h.scope FROM diag_qc_holds h
                 WHERE h.status != 'released' AND h.equipment_id = e.id
                   AND (h.scope = 'equipment' OR (h.scope = 'assay' AND h.service_id = ?))
                 ORDER BY h.scope = 'equipment' DESC LIMIT 1) AS open_hold_scope
        FROM diag_service_equipment se JOIN diag_equipment e ON e.id = se.equipment_id
        WHERE se.service_id = ?
        ORDER BY e.name
        """,
        (service_id, service_id),
    )
    return [dict(r) for r in cursor.fetchall()]


def _vendor_name(cursor, vendor_id):
    if not vendor_id:
        return None
    cursor.execute("SELECT vendor_name FROM lab_vendors WHERE id = ?", (vendor_id,))
    row = cursor.fetchone()
    return row["vendor_name"] if row else None


def dispatch_to_vendor(cursor, order_item_id, vendor_id, username=None, notes=None):
    """Open a diag_external_referrals row for the test unless one is already open."""
    cursor.execute(
        "SELECT id FROM diag_external_referrals WHERE order_item_id = ? AND received_report_at IS NULL LIMIT 1",
        (order_item_id,),
    )
    existing = cursor.fetchone()
    if existing:
        return existing["id"]
    cursor.execute(
        """
        INSERT INTO diag_external_referrals (order_item_id, vendor_id, dispatched_at, dispatched_by, notes)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
        """,
        (order_item_id, vendor_id, username, notes),
    )
    return cursor.lastrowid


def route_item(cursor, item_id, username=None):
    """Decide and record where one test is processed. Idempotent: a test that has
    already been routed is returned unchanged. Returns the outcome dict, or None
    when the test isn't routed."""
    cursor.execute(
        """
        SELECT oi.id, oi.service_id, oi.service_name, oi.department_type, oi.cancelled_at,
               oi.routing, oi.routing_reason, oi.routing_vendor_id,
               o.service_type, o.outsource_vendor_id, s.preferred_vendor_id
        FROM diag_order_items oi
        JOIN diag_orders o ON o.id = oi.order_id
        LEFT JOIN diag_services s ON s.id = oi.service_id
        WHERE oi.id = ?
        """,
        (item_id,),
    )
    item = cursor.fetchone()
    if not item or item["cancelled_at"]:
        return None
    if item["routing"] in (IN_HOUSE, OUTSOURCED):
        return _outcome(cursor, item, item["routing"], item["routing_reason"], item["routing_vendor_id"])

    equipment = load_service_equipment(cursor, item["service_id"]) if item["service_type"] == "HOME_VISIT" else []
    routing, reason, vendor_id = decide_routing(
        item["service_type"], item["department_type"], equipment,
        preferred_vendor_id=item["preferred_vendor_id"],
        vendor_id=item["routing_vendor_id"] or item["outsource_vendor_id"],
    )
    if routing is None:
        return None
    cursor.execute(
        "UPDATE diag_order_items SET routing = ?, routing_reason = ?, routing_vendor_id = ?, routed_at = CURRENT_TIMESTAMP WHERE id = ?",
        (routing, reason, vendor_id, item_id),
    )
    if routing == OUTSOURCED:
        dispatch_to_vendor(cursor, item_id, vendor_id, username, reason)
    return _outcome(cursor, item, routing, reason, vendor_id)


def _outcome(cursor, item, routing, reason, vendor_id):
    return {
        "item_id": item["id"], "service_name": item["service_name"], "routing": routing,
        "reason": reason, "vendor_id": vendor_id, "vendor_name": _vendor_name(cursor, vendor_id),
    }


def assign_vendor(db, item_id, vendor_id, username=None):
    """Resolve a 'pending_vendor' test (or change the partner lab before dispatch)."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, routing, cancelled_at, department_type FROM diag_order_items WHERE id = ?", (item_id,))
        item = cursor.fetchone()
        if not item:
            raise ValueError("Order item not found.")
        if item["cancelled_at"]:
            raise ValueError("This test has been cancelled.")
        if item["department_type"] != "LAB":
            raise ValueError("Only laboratory tests can be sent to a partner lab.")
        if item["routing"] in (IN_HOUSE, OUTSOURCED):
            raise ValueError("This test has already been routed. Use the external referral to change it.")
        if not _vendor_name(cursor, vendor_id):
            raise ValueError("Partner laboratory not found.")
        if item["routing"] == PENDING_VENDOR:
            cursor.execute(
                "UPDATE diag_order_items SET routing = ?, routing_vendor_id = ?, routed_at = CURRENT_TIMESTAMP WHERE id = ?",
                (OUTSOURCED, vendor_id, item_id),
            )
            dispatch_to_vendor(cursor, item_id, vendor_id, username, "Partner lab assigned")
        else:
            # Not routed yet (sample not received): remember the choice for when it is.
            cursor.execute("UPDATE diag_order_items SET routing_vendor_id = ? WHERE id = ?", (vendor_id, item_id))
        conn.commit()
        return {"item_id": item_id, "vendor_id": vendor_id, "routing": OUTSOURCED if item["routing"] == PENDING_VENDOR else None}


def list_pending_vendor_items(db):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT oi.id AS item_id, oi.service_id, oi.service_name, oi.routing_reason, oi.routed_at,
                   o.id AS order_id, o.order_no, o.service_type, o.patient_id,
                   COALESCE(TRIM(p.name || ' ' || COALESCE(p.last_name, '')), o.walkin_name) AS patient_name
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            WHERE oi.routing = 'pending_vendor' AND oi.cancelled_at IS NULL
            ORDER BY oi.routed_at
            """
        )
        return [dict(r) for r in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Catalogue: equipment links and preferred partner lab
# ---------------------------------------------------------------------------

def get_service_routing(db, service_id):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, service_type, preferred_vendor_id FROM diag_services WHERE id = ?", (service_id,))
        svc = cursor.fetchone()
        if not svc:
            return None
        return {
            "service_id": svc["id"], "service_name": svc["name"], "service_type": svc["service_type"],
            "preferred_vendor_id": svc["preferred_vendor_id"],
            "preferred_vendor_name": _vendor_name(cursor, svc["preferred_vendor_id"]),
            "equipment": load_service_equipment(cursor, service_id),
        }


def set_service_routing(db, service_id, equipment_ids, preferred_vendor_id=None):
    try:
        ids = sorted({int(e) for e in (equipment_ids or [])})
    except (TypeError, ValueError):
        raise ValueError("Equipment ids must be numbers.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, service_type FROM diag_services WHERE id = ?", (service_id,))
        svc = cursor.fetchone()
        if not svc:
            raise ValueError("Test not found.")
        if svc["service_type"] != "LAB" and (ids or preferred_vendor_id):
            raise ValueError("Equipment links and partner labs apply to laboratory tests only.")
        if ids:
            cursor.execute("SELECT id FROM diag_equipment WHERE id = ANY(?)", (ids,))
            found = {r["id"] for r in cursor.fetchall()}
            missing = [i for i in ids if i not in found]
            if missing:
                raise ValueError(f"Equipment not found: {', '.join(map(str, missing))}.")
        if preferred_vendor_id and not _vendor_name(cursor, preferred_vendor_id):
            raise ValueError("Partner laboratory not found.")
        cursor.execute("DELETE FROM diag_service_equipment WHERE service_id = ?", (service_id,))
        for eid in ids:
            cursor.execute("INSERT INTO diag_service_equipment (service_id, equipment_id) VALUES (?, ?)", (service_id, eid))
        cursor.execute("UPDATE diag_services SET preferred_vendor_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                       (preferred_vendor_id or None, service_id))
        conn.commit()
    return get_service_routing(db, service_id)


# ---------------------------------------------------------------------------
# Partner-lab cost per test (hospital's cost; never billed to the patient)
# ---------------------------------------------------------------------------

def list_vendor_rates(db, vendor_id=None, service_id=None):
    clauses, params = [], []
    if vendor_id:
        clauses.append("r.vendor_id = ?")
        params.append(vendor_id)
    if service_id:
        clauses.append("r.service_id = ?")
        params.append(service_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT r.id, r.vendor_id, v.vendor_name, r.service_id, s.code AS service_code, s.name AS service_name,
                   s.rate AS patient_rate, r.cost, (s.rate - r.cost) AS margin, r.updated_by, r.updated_at
            FROM diag_vendor_service_rates r
            JOIN diag_services s ON s.id = r.service_id
            LEFT JOIN lab_vendors v ON v.id = r.vendor_id
            {where}
            ORDER BY v.vendor_name, s.name
            """,
            tuple(params),
        )
        return [dict(r) for r in cursor.fetchall()]


def save_vendor_rate(db, vendor_id, service_id, cost, username=None):
    """Upsert a partner-lab cost; cost None/'' removes it."""
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if not _vendor_name(cursor, vendor_id):
            raise ValueError("Partner laboratory not found.")
        cursor.execute("SELECT id FROM diag_services WHERE id = ?", (service_id,))
        if not cursor.fetchone():
            raise ValueError("Test not found.")
        if cost in (None, ""):
            cursor.execute("DELETE FROM diag_vendor_service_rates WHERE vendor_id = ? AND service_id = ?", (vendor_id, service_id))
            conn.commit()
            return None
        try:
            cost = round(float(cost), 2)
        except (TypeError, ValueError):
            raise ValueError("Enter a valid cost.")
        if cost < 0:
            raise ValueError("Cost cannot be negative.")
        cursor.execute(
            """
            INSERT INTO diag_vendor_service_rates (vendor_id, service_id, cost, updated_by, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (vendor_id, service_id) DO UPDATE
                SET cost = EXCLUDED.cost, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
            """,
            (vendor_id, service_id, cost, username),
        )
        conn.commit()
        return cost


# ---------------------------------------------------------------------------
# Lab settings
# ---------------------------------------------------------------------------

def read_settings(cursor):
    cursor.execute("SELECT key, value FROM diag_settings")
    values = dict(SETTINGS_DEFAULTS)
    values.update({r["key"]: r["value"] for r in cursor.fetchall()})
    return {"home_visit_fee": float(values.get("home_visit_fee") or 0)}


def get_settings(db):
    with get_connection(db) as conn:
        return read_settings(conn.cursor())


def parse_fee(value, field="Home visit fee"):
    try:
        fee = round(float(value), 2)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number.")
    if fee < 0 or fee > MAX_HOME_VISIT_FEE:
        raise ValueError(f"{field} must be between 0 and {MAX_HOME_VISIT_FEE}.")
    return fee


def update_settings(db, data, username=None):
    unknown = set(data or {}) - set(SETTINGS_DEFAULTS)
    if unknown:
        raise ValueError(f"Unknown setting(s): {', '.join(sorted(unknown))}.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if "home_visit_fee" in data:
            fee = parse_fee(data["home_visit_fee"])
            cursor.execute(
                """
                INSERT INTO diag_settings (key, value, updated_by, updated_at) VALUES ('home_visit_fee', ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
                """,
                (f"{fee:g}", username),
            )
        conn.commit()
        return read_settings(cursor)


# ---------------------------------------------------------------------------
# Outsourcing / Home Visit orders
# ---------------------------------------------------------------------------

VISIT_TIME_GRACE_MINUTES = 15


def parse_visit_time(value):
    """'YYYY-MM-DDTHH:MM[:SS]' (datetime-local input) -> naive local datetime, not in the past."""
    from datetime import datetime, timedelta
    text = str(value or "").strip().replace(" ", "T")
    if not text:
        raise ValueError("Visit date and time are required.")
    try:
        when = datetime.fromisoformat(text[:19])
    except ValueError:
        raise ValueError("Enter the visit date and time as YYYY-MM-DD HH:MM.")
    if when.tzinfo is not None:
        when = when.replace(tzinfo=None)
    if when < datetime.now() - timedelta(minutes=VISIT_TIME_GRACE_MINUTES):
        raise ValueError("The visit date and time cannot be in the past.")
    return when


def build_order_payload(data):
    """Map an Outsourcing / Home Visit request onto legacy_queries.create_diag_order's
    payload. A registered patient (patient_id) or walk-in details are both accepted;
    both use encounter_type EXTERNAL so no OP visit / admission is needed, and
    confirm_diag_order raises the invoice straight away."""
    service_type = str(data.get("service_type") or "").upper()
    if service_type not in ROUTED_SERVICE_TYPES:
        raise ValueError("service_type must be OUTSOURCING or HOME_VISIT.")
    payload = {
        "items": data.get("items") or [],
        "priority": data.get("priority") or "Routine",
        "referring_clinician": data.get("referring_clinician"),
        "clinical_indication": data.get("clinical_indication"),
        "notes": data.get("notes"),
        "external_source": "Home Visit" if service_type == "HOME_VISIT" else "Outsourcing",
    }
    if data.get("patient_id"):
        payload.update({"patient_id": data["patient_id"], "encounter_type": "EXTERNAL", "sale_type": "INTERNAL"})
    else:
        payload.update({
            "sale_type": "EXTERNAL", "walkin_name": data.get("walkin_name"), "walkin_mobile": data.get("walkin_mobile"),
            "walkin_country_code": data.get("walkin_country_code"),
            "walkin_age": data.get("walkin_age"), "walkin_gender": data.get("walkin_gender"),
        })
    return service_type, payload


def create_service_order(db, data, username=None):
    """Create a draft Outsourcing or Home Visit order. Confirming it (existing
    /diag/orders/{id}/confirm) raises the invoice, including the home-visit fee."""
    import legacy_queries as lq
    service_type, payload = build_order_payload(data)
    items = payload["items"]
    if not items:
        raise ValueError("At least one test must be selected.")

    extra = {"service_type": service_type}
    with get_connection(db) as conn:
        cursor = conn.cursor()
        if service_type == "HOME_VISIT":
            address = (data.get("visit_address") or "").strip()
            if len(address) < 5:
                raise ValueError("Enter the full service address for the home visit.")
            fee = read_settings(cursor)["home_visit_fee"] if data.get("home_visit_fee") in (None, "") \
                else parse_fee(data["home_visit_fee"])
            extra.update({"visit_address": address, "visit_scheduled_at": parse_visit_time(data.get("visit_scheduled_at")),
                          "visit_status": "scheduled", "home_visit_fee": fee})
        else:
            vendor_id = data.get("outsource_vendor_id")
            if not vendor_id or not _vendor_name(cursor, vendor_id):
                raise ValueError("Select the partner laboratory for this outsourcing order.")
            extra["outsource_vendor_id"] = int(vendor_id)
        item_vendors = []
        for it in items:
            vid = it.get("vendor_id") if isinstance(it, dict) else None
            if vid and not _vendor_name(cursor, vid):
                raise ValueError("Partner laboratory not found for one of the tests.")
            item_vendors.append(int(vid) if vid else None)

    order_id = lq.create_diag_order(db, payload, username)

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cols = ", ".join(f"{k} = ?" for k in extra)
        cursor.execute(f"UPDATE diag_orders SET {cols} WHERE id = ?", (*extra.values(), order_id))
        cursor.execute("SELECT id, department_type FROM diag_order_items WHERE order_id = ? ORDER BY id", (order_id,))
        for row, vendor_id in zip(cursor.fetchall(), item_vendors):
            if vendor_id and row["department_type"] == "LAB":
                cursor.execute("UPDATE diag_order_items SET routing_vendor_id = ? WHERE id = ?", (vendor_id, row["id"]))
        conn.commit()
    return order_id


def _home_visit(cursor, order_id):
    cursor.execute("SELECT * FROM diag_orders WHERE id = ?", (order_id,))
    order = cursor.fetchone()
    if not order or order["service_type"] != "HOME_VISIT":
        raise ValueError("Home visit not found.")
    return order


def _active_specimens(cursor, order_id, status):
    cursor.execute(
        """
        SELECT sp.id FROM diag_specimens sp
        JOIN diag_order_items oi ON oi.id = sp.order_item_id
        WHERE oi.order_id = ? AND oi.cancelled_at IS NULL AND sp.status = ?
        ORDER BY sp.id
        """,
        (order_id, status),
    )
    return [r["id"] for r in cursor.fetchall()]


def collect_home_visit(db, order_id, data, username=None):
    """Phlebotomist collected the samples at the patient's address."""
    import legacy_queries as lq
    if not data.get("identity_verified"):
        raise ValueError("Confirm the patient's identity before collecting samples.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        order = _home_visit(cursor, order_id)
        if order["status"] != "confirmed":
            raise ValueError("Confirm and bill the home visit before collecting samples.")
        if order["visit_status"] != "scheduled":
            raise ValueError(f"This home visit is already {order['visit_status']}.")
        specimen_ids = _active_specimens(cursor, order_id, "awaiting_collection")
        if not specimen_ids:
            raise ValueError("No samples are awaiting collection on this home visit.")
    for sid in specimen_ids:
        lq.collect_diag_specimen(db, sid, {
            "identity_verified": True, "collection_location": f"Home visit: {order['visit_address']}",
            "collection_notes": data.get("collection_notes"), "container_type": data.get("container_type"),
        }, username)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE diag_orders SET visit_status = 'collected', visit_collected_by = ?, visit_collected_at = CURRENT_TIMESTAMP WHERE id = ?",
            (username, order_id),
        )
        conn.commit()
    return {"order_id": order_id, "collected_specimens": len(specimen_ids)}


def receive_home_visit(db, order_id, data, username=None):
    """Samples are back at the lab: receive each one, which routes every test
    in-house or to a partner lab (see legacy_queries.receive_diag_specimen)."""
    import legacy_queries as lq
    with get_connection(db) as conn:
        cursor = conn.cursor()
        order = _home_visit(cursor, order_id)
        if order["visit_status"] != "collected":
            raise ValueError("Collect the samples before receiving them at the lab." if order["visit_status"] == "scheduled"
                             else f"This home visit is already {order['visit_status']}.")
        specimen_ids = _active_specimens(cursor, order_id, "collected")
    for sid in specimen_ids:
        lq.receive_diag_specimen(db, sid, {"accept": True, "condition_on_receipt": data.get("condition_on_receipt")}, username)
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE diag_orders SET visit_status = 'received' WHERE id = ?", (order_id,))
        cursor.execute("SELECT id FROM diag_order_items WHERE order_id = ? AND cancelled_at IS NULL ORDER BY id", (order_id,))
        outcomes = [o for o in (route_item(cursor, r["id"], username) for r in cursor.fetchall()) if o]
        conn.commit()
    return {"order_id": order_id, "received_specimens": len(specimen_ids), "routing": outcomes}


def reschedule_home_visit(db, order_id, data, username=None):
    with get_connection(db) as conn:
        cursor = conn.cursor()
        order = _home_visit(cursor, order_id)
        if order["status"] == "cancelled" or order["visit_status"] != "scheduled":
            raise ValueError("Only a scheduled visit can be rescheduled.")
        when = parse_visit_time(data.get("visit_scheduled_at"))
        address = (data.get("visit_address") or order["visit_address"] or "").strip()
        if len(address) < 5:
            raise ValueError("Enter the full service address for the home visit.")
        cursor.execute("UPDATE diag_orders SET visit_scheduled_at = ?, visit_address = ? WHERE id = ?", (when, address, order_id))
        conn.commit()
    return {"order_id": order_id, "visit_scheduled_at": when.isoformat(timespec="minutes"), "visit_address": address}


def cancel_home_visit(db, order_id, reason, username=None, refund_mode=None):
    """Cancel before the samples are collected. Each test is cancelled through
    cancel_diag_order_item so the invoice and any refund are settled line by line;
    the last one also drops the visit fee."""
    import legacy_queries as lq
    if not (reason or "").strip():
        raise ValueError("A cancellation reason is required.")
    with get_connection(db) as conn:
        cursor = conn.cursor()
        order = _home_visit(cursor, order_id)
        status = order["status"]
        if status != "draft" and order["visit_status"] != "scheduled":
            raise ValueError("Samples have already been collected; cancel individual tests instead.")
        cursor.execute("SELECT id FROM diag_order_items WHERE order_id = ? AND cancelled_at IS NULL ORDER BY id", (order_id,))
        item_ids = [r["id"] for r in cursor.fetchall()]
    if status == "draft":
        lq.cancel_diag_draft_order(db, order_id, username)
        refund = 0.0
    else:
        refund = sum(lq.cancel_diag_order_item(db, iid, reason, username, refund_mode)["refund_amount"] for iid in item_ids)
    with get_connection(db) as conn:
        conn.cursor().execute("UPDATE diag_orders SET visit_status = 'cancelled' WHERE id = ?", (order_id,))
        conn.commit()
    return {"order_id": order_id, "refund_amount": round(refund, 2)}


def list_home_visits(db, visit_status=None, date_from=None, date_to=None, search=None):
    clauses, params = ["o.service_type = 'HOME_VISIT'"], []
    if visit_status:
        clauses.append("o.visit_status = ?")
        params.append(visit_status)
    if date_from:
        clauses.append("o.visit_scheduled_at >= ?")
        params.append(f"{date_from} 00:00:00")
    if date_to:
        clauses.append("o.visit_scheduled_at <= ?")
        params.append(f"{date_to} 23:59:59")
    if search:
        like = f"%{search.strip().lower()}%"
        clauses.append("(LOWER(COALESCE(p.name, o.walkin_name, '')) LIKE ? OR LOWER(COALESCE(o.patient_id, '')) LIKE ? "
                       "OR COALESCE(o.walkin_mobile, p.phone, '') LIKE ? OR LOWER(o.order_no) LIKE ?)")
        params.extend([like, like, like, like])
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT o.id, o.order_no, o.status, o.patient_id, o.visit_address, o.visit_scheduled_at, o.visit_status,
                   o.visit_collected_by, o.visit_collected_at, o.home_visit_fee, o.invoice_id, o.created_at,
                   COALESCE(TRIM(p.name || ' ' || COALESCE(p.last_name, '')), o.walkin_name) AS patient_name,
                   COALESCE(p.phone, o.walkin_mobile) AS patient_phone,
                   i.invoice_no, i.total_amount, i.paid_amount, i.due_amount, i.payment_status
            FROM diag_orders o
            LEFT JOIN patients p ON p.patient_id = o.patient_id
            LEFT JOIN invoices i ON i.id = o.invoice_id
            WHERE {' AND '.join(clauses)}
            ORDER BY o.visit_scheduled_at ASC NULLS LAST, o.id ASC
            """,
            tuple(params),
        )
        visits = [dict(r) for r in cursor.fetchall()]
        _attach_items(cursor, visits)
        return visits


def _attach_items(cursor, orders):
    ids = [o["id"] for o in orders]
    if not ids:
        return
    cursor.execute(
        """
        SELECT oi.id, oi.order_id, oi.service_id, oi.service_name, oi.department_type, oi.amount, oi.progress_status,
               oi.cancelled_at, oi.routing, oi.routing_reason, oi.routing_vendor_id, v.vendor_name AS routing_vendor_name
        FROM diag_order_items oi LEFT JOIN lab_vendors v ON v.id = oi.routing_vendor_id
        WHERE oi.order_id = ANY(?) ORDER BY oi.id
        """,
        (ids,),
    )
    by_order = {}
    for r in cursor.fetchall():
        by_order.setdefault(r["order_id"], []).append(dict(r))
    for o in orders:
        o["items"] = by_order.get(o["id"], [])


# ---------------------------------------------------------------------------
# Unified Order History (all four service types)
# ---------------------------------------------------------------------------

HISTORY_PAGE_SIZE_MAX = 200


def list_order_history(db, service_type=None, date_from=None, date_to=None, search=None, status=None,
                       page=1, page_size=50, allowed_patient_ids=None):
    """One row per order with its tests and bill. Counts per service type use the same
    date/search/status filters so the tab badges match what each tab would show.
    allowed_patient_ids: patient scope for doctor-linked logins (None = no restriction);
    applied in SQL so paging and counts stay correct."""
    if service_type and service_type not in SERVICE_TYPES:
        raise ValueError("Unknown service type.")
    page = max(int(page or 1), 1)
    page_size = min(max(int(page_size or 50), 1), HISTORY_PAGE_SIZE_MAX)
    clauses, params = [], []
    if date_from:
        clauses.append("o.created_at >= ?")
        params.append(f"{date_from} 00:00:00")
    if date_to:
        clauses.append("o.created_at <= ?")
        params.append(f"{date_to} 23:59:59")
    if status:
        clauses.append("o.status = ?")
        params.append(status)
    if search:
        like = f"%{search.strip().lower()}%"
        clauses.append(
            "(LOWER(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')) LIKE ? OR LOWER(COALESCE(o.walkin_name, '')) LIKE ? "
            "OR LOWER(COALESCE(o.patient_id, '')) LIKE ? OR COALESCE(o.walkin_mobile, p.phone, '') LIKE ? OR LOWER(o.order_no) LIKE ? "
            "OR EXISTS (SELECT 1 FROM diag_order_items s WHERE s.order_id = o.id AND LOWER(s.service_name) LIKE ?) "
            "OR EXISTS (SELECT 1 FROM invoices iv WHERE iv.id = o.invoice_id AND LOWER(iv.invoice_no) LIKE ?))"
        )
        params.extend([like] * 7)
    if allowed_patient_ids is not None:
        clauses.append("o.patient_id = ANY(?)")
        params.append(sorted(allowed_patient_ids))
    base_from = "FROM diag_orders o LEFT JOIN patients p ON p.patient_id = o.patient_id"
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(f"SELECT o.service_type, COUNT(*) AS n {base_from} {where} GROUP BY o.service_type", tuple(params))
        counts = {t: 0 for t in SERVICE_TYPES}
        counts.update({r["service_type"]: r["n"] for r in cursor.fetchall()})
        counts["ALL"] = sum(counts[t] for t in SERVICE_TYPES)

        row_clauses, row_params = list(clauses), list(params)
        if service_type:
            row_clauses.append("o.service_type = ?")
            row_params.append(service_type)
        row_where = ("WHERE " + " AND ".join(row_clauses)) if row_clauses else ""
        cursor.execute(
            f"""
            SELECT o.id, o.order_no, o.created_at, o.confirmed_at, o.service_type, o.status, o.patient_id,
                   o.visit_status, o.visit_scheduled_at, o.home_visit_fee, o.invoice_id,
                   COALESCE(NULLIF(TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')), ''), o.walkin_name) AS patient_name,
                   COALESCE(p.phone, o.walkin_mobile) AS patient_phone,
                   i.invoice_no, i.total_amount, i.paid_amount, i.due_amount, i.payment_status,
                   (SELECT COALESCE(SUM(oi.amount), 0) FROM diag_order_items oi WHERE oi.order_id = o.id AND oi.cancelled_at IS NULL)
                       + COALESCE(o.home_visit_fee, 0) AS order_amount
            {base_from}
            LEFT JOIN invoices i ON i.id = o.invoice_id
            {row_where}
            ORDER BY o.created_at DESC, o.id DESC
            LIMIT ? OFFSET ?
            """,
            (*row_params, page_size, (page - 1) * page_size),
        )
        orders = [dict(r) for r in cursor.fetchall()]
        _attach_items(cursor, orders)
    for o in orders:
        # Invoiced orders show the invoice total (after cancellations/refunds); IPD orders bill at discharge.
        o["total"] = float(o["total_amount"]) if o.get("total_amount") is not None else float(o["order_amount"] or 0)
        active = [i for i in o["items"] if not i.get("cancelled_at")]
        o["tests"] = ", ".join(i["service_name"] for i in active)
        o["outsourced_count"] = sum(1 for i in active if i.get("routing") == OUTSOURCED)
    total_rows = counts[service_type] if service_type else counts["ALL"]
    return {"orders": orders, "counts": counts, "page": page, "page_size": page_size, "total": total_rows}
