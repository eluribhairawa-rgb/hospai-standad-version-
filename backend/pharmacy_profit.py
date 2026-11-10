"""Pharmacy Profit & Loss (medicine profit) analysis.

Everything here is derived from live tables -- nothing is seeded or
hardcoded:

  * goods_receipt_items / goods_receipts  -> cost price (latest VERIFIED GRN)
  * pharmacy_inventory                    -> what is in stock, current
                                             dispensing rate, near-expiry stock
  * pharmacy_sales                        -> OP / IP dispensations (revenue)
  * pharmacy_returns                      -> refunds and restocked units
  * medicines (master)                    -> manufacturer/category, and the
                                             active flag used to drop
                                             deactivated medicines

Inventory, GRN lines and sales are all keyed by medicine NAME in this schema
(the master `medicines` table is optional and frequently empty), so a
medicine's identity is its normalised name, LOWER(TRIM(medicine_name)).
That key is what guarantees exactly one row per medicine.

Definitions
-----------
cost_price   Effective per-unit cost from the most recent verified GRN line:
             rate x (1 - discount%), spread across free units. Falls back to
             the newest stock batch's purchase price (e.g. opening stock that
             never came through a GRN). None when neither exists -- profit is
             then reported as unknown rather than guessed.
sale_price   Current dispensing rate: the unit price of the batch FEFO would
             dispense next. Falls back to the latest GRN selling price / MRP,
             then the last batch price.
profit       Net revenue (sales - refunds) minus the cost of the units that
             actually left the pharmacy. A rejected return is refunded but the
             unit is destroyed, so its cost is still incurred; a released or
             still-quarantined return puts the unit back on the shelf.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from statistics import median as _median

from legacy_sql import get_connection

NEAR_EXPIRY_DAYS = 90
CHART_SIZE = 8
SORT_FIELDS = {"medicine_name", "cost_price", "sale_price", "unit_margin", "margin_pct",
               "qty_sold", "net_revenue", "profit_earned"}
GROUP_FIELDS = {"manufacturer", "category"}


# --------------------------------------------------------------------------
# Pure helpers (unit-tested without a database)
# --------------------------------------------------------------------------

def medicine_key(name) -> str:
    return " ".join(str(name or "").split()).lower()


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def effective_unit_cost(purchase_price, discount_pct=0, qty_received=0, free_qty=0):
    """Per-unit landed cost of a GRN line. The GRN screen bills
    qty x rate x (1 - discount%); free units arrive at no charge, so the
    billed amount is spread over every unit received."""
    rate = _num(purchase_price)
    if rate <= 0:
        return None
    discount = min(max(_num(discount_pct), 0.0), 100.0)
    cost = rate * (1 - discount / 100)
    received = _num(qty_received)
    free = _num(free_qty)
    if received > 0 and 0 < free < received:
        cost *= (received - free) / received
    return round(cost, 2)


def escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def resolve_period(from_date=None, to_date=None, today: date | None = None):
    """Defaults to month-to-date. Returns (start, end) inclusive dates."""
    today = today or date.today()
    start = _parse_date(from_date) if from_date else today.replace(day=1)
    end = _parse_date(to_date) if to_date else today
    if start > end:
        raise ValueError("'From' date must be on or before the 'To' date.")
    if (end - start).days > 366:
        raise ValueError("Choose a date range of at most one year.")
    return start, end


def _parse_date(value) -> date:
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc


def build_rows(*, inventory, grn, master, sales, returns):
    """Merge per-medicine facts (dicts keyed by medicine_key) into exactly one
    row per medicine. The universe is: medicines currently in stock, plus any
    medicine sold or returned in the period (so the totals always add up even
    after a medicine sells out). Deactivated master medicines are dropped."""
    keys = {k for k, inv in inventory.items() if inv.get("qty_in_stock", 0) > 0}
    keys |= set(sales) | set(returns)
    rows = []
    for key in keys:
        if not key:
            continue
        m = master.get(key) or {}
        if m and not m.get("active"):
            continue
        inv = inventory.get(key) or {}
        g = grn.get(key) or {}
        s = sales.get(key) or {}
        r = returns.get(key) or {}

        cost_price, cost_source = g.get("unit_cost"), ("grn" if g.get("unit_cost") else None)
        if cost_price is None and _num(inv.get("last_batch_cost")) > 0:
            cost_price, cost_source = round(_num(inv["last_batch_cost"]), 2), "batch"

        sale_price, sale_source = None, None
        # The rate dispensing actually charges is the batch unit price, so the
        # last batch price outranks the GRN fields once a medicine sells out.
        for value, source in ((inv.get("current_sale_price"), "stock"),
                              (inv.get("last_sale_price"), "last_batch"),
                              (g.get("selling_price"), "grn"),
                              (g.get("mrp"), "grn_mrp")):
            if _num(value) > 0:
                sale_price, sale_source = round(_num(value), 2), source
                break

        qty_sold = int(_num(s.get("qty_sold")))
        revenue = _num(s.get("revenue"))
        qty_returned = int(_num(r.get("qty_returned")))
        qty_restocked = int(_num(r.get("qty_restocked")))
        refund = _num(r.get("refund"))
        net_revenue = round(revenue - refund, 2)
        cost_qty = qty_sold - qty_restocked

        if cost_price is None:
            cogs = profit = None
        else:
            cogs = round(cost_qty * cost_price, 2)
            profit = round(net_revenue - cogs, 2)

        unit_margin = margin_pct = None
        if cost_price is not None and sale_price is not None:
            unit_margin = round(sale_price - cost_price, 2)
            margin_pct = round(unit_margin / sale_price * 100, 1)

        rows.append({
            "medicine_key": key,
            "medicine_name": m.get("name") or inv.get("display_name") or s.get("display_name") or g.get("display_name") or key,
            "manufacturer": m.get("manufacturer") or g.get("manufacturer") or None,
            "category": m.get("category") or inv.get("category") or None,
            "in_stock_qty": int(_num(inv.get("qty_in_stock"))),
            "cost_price": cost_price,
            "cost_source": cost_source,
            "last_grn_no": g.get("grn_no"),
            "last_grn_date": g.get("received_date"),
            "sale_price": sale_price,
            "sale_price_source": sale_source,
            "unit_margin": unit_margin,
            "margin_pct": margin_pct,
            "below_cost": unit_margin is not None and unit_margin < 0,
            "qty_sold": qty_sold,
            "qty_returned": qty_returned,
            "net_qty": qty_sold - qty_returned,
            "net_revenue": net_revenue,
            "avg_realized_price": round(revenue / qty_sold, 2) if qty_sold else None,
            "cogs": cogs,
            "profit_earned": profit,
        })
    return rows


def median(values):
    return round(_median(values), 1)


def summarize(rows, profit_today, near_expiry):
    """Headline cards. Computed from the unfiltered period rows."""
    priced = [r for r in rows if r["profit_earned"] is not None]
    sold = [r for r in rows if r["qty_sold"] or r["qty_returned"]]
    profit = round(sum(r["profit_earned"] for r in priced), 2)
    net_revenue = round(sum(r["net_revenue"] for r in priced), 2)
    margins = [r["margin_pct"] for r in rows if r["margin_pct"] is not None]
    top = max((r for r in priced if r["profit_earned"] > 0), key=lambda r: r["profit_earned"], default=None)
    return {
        "has_sales": bool(sold),
        "profit_period": profit,
        "profit_today": profit_today,
        "net_revenue_period": net_revenue,
        "gross_margin_pct": round(profit / net_revenue * 100, 1) if net_revenue > 0 else None,
        # Median, not mean: one GRN line keyed in per pack instead of per unit
        # would otherwise swing the catalogue-wide figure by hundreds of %.
        "avg_supplier_margin_pct": median(margins) if margins else None,
        "margin_medicine_count": len(margins),
        "top_medicine": ({"medicine_name": top["medicine_name"], "profit_earned": top["profit_earned"],
                          "qty_sold": top["qty_sold"]} if top else None),
        "near_expiry": near_expiry,
        "missing_cost_count": sum(1 for r in sold if r["cost_price"] is None),
        "below_cost_count": sum(1 for r in rows if r["below_cost"]),
    }


def near_expiry_exposure(batches, rows_by_key, window_days=NEAR_EXPIRY_DAYS):
    """Margin that will be lost if stock expiring within the window is not
    sold, plus the purchase cost tied up in it."""
    margin = cost = 0.0
    count = 0
    for b in batches:
        row = rows_by_key.get(b["mkey"]) or {}
        qty = _num(b["qty_available"])
        unit_cost = _num(b.get("purchase_price")) or _num(row.get("cost_price"))
        unit_sale = _num(b.get("unit_price")) or _num(row.get("sale_price"))
        count += 1
        cost += qty * unit_cost
        if unit_cost and unit_sale:
            margin += qty * max(unit_sale - unit_cost, 0)
    return {"margin_at_risk": round(margin, 2), "cost_at_risk": round(cost, 2),
            "batch_count": count, "window_days": window_days}


def sort_and_page(rows, sort_by="profit_earned", sort_dir="desc", page=1, page_size=25):
    if sort_by not in SORT_FIELDS:
        sort_by = "profit_earned"
    reverse = sort_dir != "asc"
    if sort_by == "medicine_name":
        ordered = sorted(rows, key=lambda r: r["medicine_name"].lower(), reverse=reverse)
    else:
        known = [r for r in rows if r[sort_by] is not None]
        unknown = [r for r in rows if r[sort_by] is None]
        known.sort(key=lambda r: (r[sort_by], r["medicine_name"].lower()), reverse=reverse)
        ordered = known + sorted(unknown, key=lambda r: r["medicine_name"].lower())  # unknowns always last
    page_size = min(max(int(page_size or 25), 1), 100)
    total = len(ordered)
    pages = max(1, -(-total // page_size))
    page = min(max(int(page or 1), 1), pages)
    start = (page - 1) * page_size
    return ordered[start:start + page_size], total, page, page_size, pages


# --------------------------------------------------------------------------
# Database reads
# --------------------------------------------------------------------------

KEY_SQL = "LOWER(TRIM(REGEXP_REPLACE({col}, '\\s+', ' ', 'g')))"


def _key(col):
    return KEY_SQL.format(col=col)


def _search_clause(q):
    """Matches a sale on medicine, patient UHID/name or invoice number."""
    if not q:
        return "", [], ""
    like = f"%{escape_like(q)}%"
    join = (" LEFT JOIN invoices inv ON inv.id = ps.invoice_id"
            " LEFT JOIN patients p ON p.patient_id = ps.patient_id")
    clause = (" AND (ps.medicine_name ILIKE ? OR COALESCE(ps.patient_id, '') ILIKE ?"
              " OR COALESCE(inv.invoice_no, '') ILIKE ?"
              " OR CONCAT_WS(' ', p.name, p.middle_name, p.last_name) ILIKE ?)")
    return clause, [like] * 4, join


def _fetch_sales(cursor, start, end, q=None):
    clause, params, join = _search_clause(q)
    cursor.execute(
        f"""
        SELECT {_key('ps.medicine_name')} AS mkey,
               SUM(ps.quantity) AS qty_sold, SUM(ps.amount) AS revenue,
               (ARRAY_AGG(ps.medicine_name ORDER BY ps.id DESC))[1] AS display_name
        FROM pharmacy_sales ps{join}
        WHERE ps.sold_at >= ? AND ps.sold_at < ?{clause}
        GROUP BY 1
        """,
        (start, end + timedelta(days=1), *params),
    )
    return {r["mkey"]: dict(r.items()) for r in cursor.fetchall()}


def _fetch_returns(cursor, start, end, q=None):
    # Refund per return mirrors create_pharmacy_return: the sale's unit price,
    # or amount/quantity when the unit price was not recorded.
    clause, params, join = _search_clause(q)
    cursor.execute(
        f"""
        SELECT {_key('ps.medicine_name')} AS mkey,
               SUM(r.quantity) AS qty_returned,
               COALESCE(SUM(r.quantity) FILTER (WHERE r.status <> 'rejected'), 0) AS qty_restocked,
               SUM(ROUND(CAST(r.quantity * COALESCE(NULLIF(ps.unit_price, 0), ps.amount / NULLIF(ps.quantity, 0), 0) AS numeric), 2)) AS refund
        FROM pharmacy_returns r
        JOIN pharmacy_sales ps ON ps.id = r.original_sale_id{join}
        WHERE r.created_at >= ? AND r.created_at < ?{clause}
        GROUP BY 1
        """,
        (start, end + timedelta(days=1), *params),
    )
    return {r["mkey"]: dict(r.items()) for r in cursor.fetchall()}


def _fetch_latest_grn(cursor):
    cursor.execute(
        f"""
        SELECT DISTINCT ON ({_key('i.medicine_name')})
               {_key('i.medicine_name')} AS mkey, i.medicine_name AS display_name,
               i.purchase_price, i.discount_pct, i.qty_received, i.free_qty,
               i.selling_price, i.mrp, i.manufacturer, g.grn_no, g.received_date
        FROM goods_receipt_items i
        JOIN goods_receipts g ON g.id = i.grn_id
        WHERE g.status = 'verified' AND COALESCE(i.purchase_price, 0) > 0
        ORDER BY {_key('i.medicine_name')}, g.received_date DESC NULLS LAST, g.created_at DESC, i.id DESC
        """
    )
    out = {}
    for r in cursor.fetchall():
        row = dict(r.items())
        row["unit_cost"] = effective_unit_cost(row["purchase_price"], row["discount_pct"],
                                               row["qty_received"], row["free_qty"])
        row["received_date"] = str(row["received_date"])[:10] if row["received_date"] else None
        out[row["mkey"]] = row
    return out


def _fetch_inventory(cursor):
    cursor.execute(
        f"""
        SELECT {_key('medicine_name')} AS mkey,
               COALESCE(SUM(qty_available) FILTER (WHERE batch_status = 'available'), 0) AS qty_in_stock,
               (ARRAY_AGG(item_category ORDER BY id DESC) FILTER (WHERE item_category IS NOT NULL))[1] AS category,
               (ARRAY_AGG(medicine_name ORDER BY id DESC))[1] AS display_name,
               (ARRAY_AGG(unit_price ORDER BY expiry_date ASC NULLS LAST, id ASC) FILTER (
                    WHERE batch_status = 'available' AND qty_available > 0 AND unit_price > 0
                      AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)))[1] AS current_sale_price,
               (ARRAY_AGG(unit_price ORDER BY id DESC) FILTER (WHERE unit_price > 0))[1] AS last_sale_price,
               (ARRAY_AGG(purchase_price ORDER BY id DESC) FILTER (WHERE purchase_price > 0))[1] AS last_batch_cost
        FROM pharmacy_inventory
        GROUP BY 1
        """
    )
    return {r["mkey"]: dict(r.items()) for r in cursor.fetchall()}


def _fetch_master(cursor):
    """Active rows win when the master holds the same name twice."""
    cursor.execute(f"SELECT {_key('name')} AS mkey, name, active, manufacturer, category FROM medicines ORDER BY active ASC, id ASC")
    return {r["mkey"]: dict(r.items()) for r in cursor.fetchall()}


def _fetch_near_expiry(cursor, window_days=NEAR_EXPIRY_DAYS):
    cursor.execute(
        f"""
        SELECT {_key('medicine_name')} AS mkey, qty_available, unit_price, purchase_price
        FROM pharmacy_inventory
        WHERE batch_status = 'available' AND qty_available > 0
          AND expiry_date >= CURRENT_DATE AND expiry_date <= CURRENT_DATE + ?
        """,
        (int(window_days),),
    )
    return [dict(r.items()) for r in cursor.fetchall()]


def get_profit_analysis(db, *, from_date=None, to_date=None, q=None, group_by=None, group_value=None,
                        sort_by="profit_earned", sort_dir="desc", page=1, page_size=25, today=None):
    today = today or date.today()
    start, end = resolve_period(from_date, to_date, today)
    q = (q or "").strip()[:100] or None
    with get_connection(db) as conn:
        cursor = conn.cursor()
        inventory = _fetch_inventory(cursor)
        grn = _fetch_latest_grn(cursor)
        master = _fetch_master(cursor)
        facts = dict(inventory=inventory, grn=grn, master=master)

        period_rows = build_rows(**facts, sales=_fetch_sales(cursor, start, end),
                                 returns=_fetch_returns(cursor, start, end))
        today_rows = build_rows(**facts, sales=_fetch_sales(cursor, today, today),
                                returns=_fetch_returns(cursor, today, today))
        near_expiry = near_expiry_exposure(_fetch_near_expiry(cursor),
                                           {r["medicine_key"]: r for r in period_rows})

        if q:
            # The search narrows the table and chart, never the headline cards.
            needle = q.lower()
            q_sales, q_returns = _fetch_sales(cursor, start, end, q), _fetch_returns(cursor, start, end, q)
            rows = [r for r in build_rows(**facts, sales=q_sales, returns=q_returns)
                    if needle in r["medicine_name"].lower() or r["medicine_key"] in q_sales or r["medicine_key"] in q_returns]
        else:
            rows = period_rows

    profit_today = round(sum(r["profit_earned"] for r in today_rows if r["profit_earned"] is not None), 2)
    summary = summarize(period_rows, profit_today, near_expiry)

    if group_by in GROUP_FIELDS and group_value:
        rows = [r for r in rows if (r[group_by] or "Unspecified") == group_value]

    chart = sorted((r for r in rows if r["profit_earned"] is not None and r["qty_sold"] > 0),
                   key=lambda r: r["profit_earned"], reverse=True)[:CHART_SIZE]
    page_rows, total, page, page_size, pages = sort_and_page(rows, sort_by, sort_dir, page, page_size)

    def options(field):
        return sorted({r[field] or "Unspecified" for r in period_rows}, key=str.lower)

    return {
        "period": {"from": start.isoformat(), "to": end.isoformat()},
        "summary": summary,
        "rows": page_rows,
        "total_rows": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "filtered_profit": round(sum(r["profit_earned"] for r in rows if r["profit_earned"] is not None), 2),
        "chart": [{"medicine_name": r["medicine_name"], "profit_earned": r["profit_earned"],
                   "qty_sold": r["qty_sold"], "net_revenue": r["net_revenue"]} for r in chart],
        "filters": {"manufacturer": options("manufacturer"), "category": options("category")},
        "near_expiry_window_days": NEAR_EXPIRY_DAYS,
    }
