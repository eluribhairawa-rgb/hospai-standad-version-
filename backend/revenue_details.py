"""Dashboard revenue by module (OP, IP, Pharmacy, Lab) with patient-level drill-down.

Uses exactly the sources behind the dashboard's revenue totals, so the module rows
always add up to the TOTAL shown in the Revenue Details modal:

  today   = RevenueService.get_today_collections: invoice payments made that day, the
            part of a bill's paid amount that has no payment row (bills paid in full at
            creation), legacy diagnostics payments and uninvoiced pharmacy sales.
  monthly = the hospital summary's monthly_revenue: the same sources over the whole
            calendar month of the selected date.

A bill's module decides its row: OP, IP, PHARMACY, LAB/RADIOLOGY/DIAGNOSTICS; anything
else is "Other billing". Pending / Due is shown alongside (it is not part of the total):
dues on bills raised that day, as the dashboard already reports.
"""

from datetime import date as date_type, datetime
from legacy_queries import date_clause
from legacy_sql import get_connection

CATEGORY_LABELS = {
    'op': 'OP / General Billing',
    'ip': 'IP (Inpatient) Billing',
    'pharmacy': 'Pharmacy Sales',
    'lab': 'Lab & Diagnostics',
    'other': 'Other Billing',
    'due': 'Pending / Due',
}

CATEGORY_ORDER = ('op', 'ip', 'pharmacy', 'lab', 'other')
PERIODS = ('today', 'month', 'range')

_MODULE_CASE = """CASE
    WHEN UPPER(COALESCE(i.module, '')) = 'OP' THEN 'op'
    WHEN UPPER(COALESCE(i.module, '')) = 'IP' THEN 'ip'
    WHEN UPPER(COALESCE(i.module, '')) = 'PHARMACY' THEN 'pharmacy'
    WHEN UPPER(COALESCE(i.module, '')) IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS') THEN 'lab'
    ELSE 'other' END"""

_PATIENT_NAME = "COALESCE(NULLIF(TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')), ''), {fallback})"


def _parse_date(value):
    """'YYYY-MM-DD' (blank = today in IST)."""
    if not value:
        from database import IST_TIMEZONE
        return datetime.now(IST_TIMEZONE).date().isoformat()
    try:
        return date_type.fromisoformat(str(value)[:10]).isoformat()
    except (TypeError, ValueError):
        raise ValueError('date must be YYYY-MM-DD.')


def _range_clause(column, period, target, date_to=None):
    """(SQL condition, params) for the selected day, the whole calendar month of it, or a from..to date range."""
    if period == 'today':
        return (f"{date_clause(column)} = DATE(?)", [target])
    if period == 'range':
        return (f"{date_clause(column)} BETWEEN DATE(?) AND DATE(?)", [target, date_to])
    return (f"to_char({column}, 'YYYY-MM') = ?", [target[:7]])


def _range_end(period, date_to):
    if period != 'range':
        return None
    return _parse_date(date_to)


def collection_entries(db, target_date, period='today', date_to=None):
    """Every amount that makes up the period's revenue total, one row per payment / sale."""
    if period not in PERIODS:
        raise ValueError("period must be 'today', 'month' or 'range'.")
    target = _parse_date(target_date)
    end = _range_end(period, date_to)

    pay_cond, pay_params = _range_clause('ip.created_at', period, target, end)
    bill_cond, bill_params = _range_clause('i.created_at', period, target, end)
    diag_cond, diag_params = _range_clause('d.created_at', period, target, end)
    sale_cond, sale_params = _range_clause('ps.sold_at', period, target, end)

    parts = [f"""
        SELECT ip.created_at AS at, {_MODULE_CASE} AS category, i.patient_id,
               {_PATIENT_NAME.format(fallback='i.patient_name')} AS patient_name,
               i.invoice_no AS reference, ip.amount AS amount, ip.payment_mode AS mode, 'payment' AS source
        FROM invoice_payments ip
        JOIN invoices i ON i.id = ip.invoice_id
        LEFT JOIN patients p ON p.patient_id = i.patient_id
        WHERE {pay_cond}
    """]
    params = list(pay_params)

    parts.append(f"""
            SELECT i.created_at AS at, {_MODULE_CASE} AS category, i.patient_id,
                   {_PATIENT_NAME.format(fallback='i.patient_name')} AS patient_name,
                   i.invoice_no AS reference,
                   (i.paid_amount - COALESCE(pt.paid_total, 0)) + i.advance_amount - i.refunded_amount AS amount,
                   COALESCE(i.payment_mode, 'recorded on bill') AS mode, 'bill' AS source
            FROM invoices i
            LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid_total FROM invoice_payments GROUP BY invoice_id) pt ON pt.invoice_id = i.id
            LEFT JOIN patients p ON p.patient_id = i.patient_id
            WHERE {bill_cond}
              AND (i.paid_amount - COALESCE(pt.paid_total, 0)) + i.advance_amount - i.refunded_amount > 0
        """)
    params += bill_params

    parts.append(f"""
        SELECT d.created_at AS at, 'lab' AS category, d.patient_id,
               {_PATIENT_NAME.format(fallback='d.patient_name')} AS patient_name,
               COALESCE(d.test_name, 'Lab test') AS reference, d.paid_amount AS amount, d.payment_mode AS mode, 'legacy_lab' AS source
        FROM diagnostics d
        LEFT JOIN patients p ON p.patient_id = d.patient_id
        WHERE {diag_cond} AND (d.invoice_no IS NULL OR TRIM(d.invoice_no) = '') AND COALESCE(d.paid_amount, 0) <> 0
    """)
    params += diag_params

    parts.append(f"""
        SELECT ps.sold_at AS at, 'pharmacy' AS category, ps.patient_id,
               {_PATIENT_NAME.format(fallback='NULL')} AS patient_name,
               ps.medicine_name AS reference, ps.amount AS amount,
               COALESCE(ps.payment_mode, ps.billing_type) AS mode, 'pharmacy_sale' AS source
        FROM pharmacy_sales ps
        LEFT JOIN patients p ON p.patient_id = ps.patient_id
        WHERE {sale_cond} AND ps.invoice_id IS NULL
    """)
    params += sale_params

    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(' UNION ALL '.join(parts) + ' ORDER BY at DESC', tuple(params))
        return [_entry(r) for r in cursor.fetchall()]


def due_entries(db, target_date, date_to=None):
    """Bills raised on the selected date (or from..to) that still have a balance (the dashboard's Pending / Due)."""
    target = _parse_date(target_date)
    end = _parse_date(date_to) if date_to else target
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(f"""
            SELECT i.created_at AS at, 'due' AS category, i.patient_id,
                   {_PATIENT_NAME.format(fallback='i.patient_name')} AS patient_name,
                   i.invoice_no AS reference, i.due_amount AS amount, i.module AS mode, 'due' AS source
            FROM invoices i LEFT JOIN patients p ON p.patient_id = i.patient_id
            WHERE {date_clause('i.created_at')} BETWEEN DATE(?) AND DATE(?) AND i.due_amount > 0
            UNION ALL
            SELECT d.created_at, 'due', d.patient_id, {_PATIENT_NAME.format(fallback='d.patient_name')},
                   COALESCE(d.test_name, 'Lab test'), d.due_amount, 'LAB', 'due'
            FROM diagnostics d LEFT JOIN patients p ON p.patient_id = d.patient_id
            WHERE {date_clause('d.created_at')} BETWEEN DATE(?) AND DATE(?) AND d.due_amount > 0
              AND (d.invoice_no IS NULL OR TRIM(d.invoice_no) = '')
            ORDER BY at DESC
            """, (target, end, target, end))
        return [_entry(r) for r in cursor.fetchall()]


def _entry(row):
    r = dict(row)
    at = r.get('at')
    return {
        'at': at.isoformat(sep=' ', timespec='minutes') if hasattr(at, 'isoformat') else str(at) if at else None,
        'category': r['category'],
        'patient_id': r.get('patient_id'),
        'patient_name': r.get('patient_name') or r.get('patient_id') or 'Walk-in',
        'reference': r.get('reference'),
        'amount': round(float(r.get('amount') or 0), 2),
        'mode': r.get('mode'),
        'source': r.get('source'),
    }


def revenue_breakdown(db, target_date=None, period='today', date_to=None):
    """Module rows that add up to the period's revenue total, plus Pending / Due."""
    entries = collection_entries(db, target_date, period, date_to)
    sums = {c: 0.0 for c in CATEGORY_ORDER}
    counts = {c: 0 for c in CATEGORY_ORDER}
    for e in entries:
        sums[e['category']] += e['amount']
        counts[e['category']] += 1

    dues = due_entries(db, target_date, date_to if period == 'range' else None)
    rows = [
        {
            'key': c,
            'label': CATEGORY_LABELS[c],
            'amount': round(sums[c], 2),
            'count': counts[c],
        }
        for c in CATEGORY_ORDER
        if c != 'other' or counts[c]
    ]

    total = round(sum(sums.values()), 2)
    due_total = round(sum(e['amount'] for e in dues), 2)
    rows.append({
        'key': 'due',
        'label': CATEGORY_LABELS['due'],
        'amount': due_total,
        'count': len(dues),
    })

    return {
        'date': _parse_date(target_date),
        'period': period,
        'total': total,
        'collected': total,
        'outstanding': due_total,
        'rows': rows,
    }


def revenue_details(db, target_date=None, period='today', category='op', date_to=None):
    """Patient-level entries behind one row of the breakdown."""
    if category not in CATEGORY_LABELS:
        raise ValueError('Unknown revenue category.')
    if category == 'due':
        entries = due_entries(db, target_date, date_to if period == 'range' else None)
    else:
        entries = [e for e in collection_entries(db, target_date, period, date_to) if e['category'] == category]

    return {
        'date': _parse_date(target_date),
        'period': period,
        'category': category,
        'label': CATEGORY_LABELS[category],
        'total': round(sum(e['amount'] for e in entries), 2),
        'entries': entries,
    }


def payment_mode_details(db, target_date=None, period='today', mode=None, date_to=None):
    """Patient-level entries behind a payment mode (Cash, Card, UPI, or all)."""
    all_entries = collection_entries(db, target_date, period, date_to)
    target_mode = (mode or '').strip().lower()

    mode_counts = {}
    mode_totals = {}
    for e in all_entries:
        m = (e.get('mode') or 'cash').strip().lower()
        if m in ('bank', 'bank transfer'):
            continue
        label = 'UPI' if m == 'upi' else m.title()
        mode_counts[label] = mode_counts.get(label, 0) + 1
        mode_totals[label] = round(mode_totals.get(label, 0.0) + e['amount'], 2)

    if target_mode and target_mode != 'all':
        entries = [e for e in all_entries if (e.get('mode') or '').strip().lower() == target_mode]
        label = 'UPI' if target_mode == 'upi' else target_mode.title()
    else:
        entries = all_entries
        label = 'All Payment Methods'

    return {
        'date': _parse_date(target_date),
        'period': period,
        'mode': target_mode or 'all',
        'label': label,
        'total': round(sum(e['amount'] for e in entries), 2),
        'count': len(entries),
        'mode_counts': mode_counts,
        'mode_totals': mode_totals,
        'entries': entries,
    }

