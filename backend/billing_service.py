from typing import Any, Optional, Union, List, Dict
import hashlib
import json
import math
import re
from datetime import datetime, date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy.orm import Session
from fastapi import HTTPException

from database import IST_TIMEZONE
import legacy_sql
from legacy_queries import resolve_hospital_id, current_ist_datetime

D_ZERO = Decimal("0.00")


def to_decimal(val) -> Decimal:
    if val is None or val == "":
        return D_ZERO
    try:
        return Decimal(str(val)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except Exception:
        return D_ZERO


def quantize_dec(val) -> Decimal:
    if val is None or val == "":
        return D_ZERO
    if not isinstance(val, Decimal):
        val = to_decimal(val)
    return val.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def sanitize_csv_cell(val) -> str:
    """Protects against spreadsheet formula injection."""
    s = str(val if val is not None else "")
    if s.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + s
    return s


# ==============================================================================
# 1. CASHIER SESSION MANAGEMENT
# ==============================================================================


def get_or_create_active_cashier_session(db: Session, user: dict, counter_name: str = "Main Billing Counter"):
    username = user.get("username") or "system"
    full_name = user.get("full_name") or user.get("name") or username

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM cashier_sessions
            WHERE cashier_username = ? AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1
            """,
            (username,)
        )
        row = cursor.fetchone()
        if row:
            return dict(row)

        # Generate new session code e.g. CS-0028
        cursor.execute("SELECT COUNT(*) FROM cashier_sessions")
        count = cursor.fetchone()[0] + 1
        code = f"CS-{count:04d}"

        cursor.execute(
            """
            INSERT INTO cashier_sessions (session_code, cashier_username, cashier_name, counter_name, opening_float, status)
            VALUES (?, ?, ?, ?, 2000.00, 'open')
            RETURNING *
            """,
            (code, username, full_name, counter_name)
        )
        new_row = cursor.fetchone()
        conn.commit()
        return dict(new_row)


def open_cashier_session(db: Session, payload: dict, user: dict):
    """
    Explicitly opens a new cashier session with a specified opening float and counter.
    Rejects if a session is already open for this cashier.
    """
    username = user.get("username") or "system"
    full_name = user.get("full_name") or user.get("name") or username
    counter_name = str(payload.get("counter_name") or "Main Billing Counter").strip()
    opening_float = to_decimal(payload.get("opening_float") or 0)
    notes = str(payload.get("notes") or "").strip()

    if opening_float < D_ZERO:
        raise HTTPException(status_code=400, detail="Opening float cannot be negative.")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, session_code FROM cashier_sessions
            WHERE cashier_username = ? AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1
            """,
            (username,)
        )
        existing = cursor.fetchone()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Session {existing['session_code']} is already open for {username}. Close it before opening a new one."
            )

        cursor.execute("SELECT COUNT(*) FROM cashier_sessions")
        count = cursor.fetchone()[0] + 1
        code = f"CS-{count:04d}"

        cursor.execute(
            """
            INSERT INTO cashier_sessions (session_code, cashier_username, cashier_name, counter_name, opening_float, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, 'open')
            RETURNING *
            """,
            (code, username, full_name, counter_name, float(opening_float), notes)
        )
        new_row = cursor.fetchone()
        conn.commit()
        sess = dict(new_row)
        sess["expected_cash"] = float(opening_float)
        return sess



def get_cashier_session_summary(db: Session, session_id: int):

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM cashier_sessions WHERE id = ?", (session_id,))
        session = cursor.fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Cashier session not found.")
        s = dict(session)

        # Expected drawer cash = opening_float + cash_received - cash_refunded - cash_handover + cash_movements - cash_doctor_payouts
        opening = to_decimal(s.get("opening_float"))
        received = to_decimal(s.get("cash_received"))
        refunded = to_decimal(s.get("cash_refunded"))
        handover = to_decimal(s.get("cash_handover"))
        movements = to_decimal(s.get("cash_movements"))
        payouts = to_decimal(s.get("cash_doctor_payouts"))

        expected = quantize_dec(opening + received - refunded - handover + movements - payouts)
        s["expected_cash"] = float(expected)
        return s


def close_cashier_session(db: Session, session_id: int, counted_cash: float, notes: str, user: dict):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM cashier_sessions WHERE id = ? FOR UPDATE", (session_id,))
        session = cursor.fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found.")
        if session["status"] == "closed":
            raise HTTPException(status_code=409, detail="Session is already closed.")

        s = dict(session)
        opening = to_decimal(s.get("opening_float"))
        received = to_decimal(s.get("cash_received"))
        refunded = to_decimal(s.get("cash_refunded"))
        handover = to_decimal(s.get("cash_handover"))
        movements = to_decimal(s.get("cash_movements"))
        payouts = to_decimal(s.get("cash_doctor_payouts"))

        expected = quantize_dec(opening + received - refunded - handover + movements - payouts)
        counted = to_decimal(counted_cash)
        variance = quantize_dec(counted - expected)

        cursor.execute(
            """
            UPDATE cashier_sessions
            SET status = 'closed', closed_at = CURRENT_TIMESTAMP, expected_cash = ?, counted_cash = ?,
                variance = ?, notes = ?, closed_by = ?
            WHERE id = ?
            RETURNING *
            """,
            (float(expected), float(counted), float(variance), notes, user.get("username"), session_id)
        )
        updated = cursor.fetchone()
        conn.commit()
        return dict(updated)


# ==============================================================================
# 2. MULTI-BILL COLLECTION & ALLOCATION (Check A)
# ==============================================================================

def record_multi_bill_payment(db: Session, payload: dict, user: dict, idempotency_key: str = None):
    """
    Settles one or multiple bills with one receipt.
    Validates explicit invoice IDs, locks rows in ascending order, records payment lines (supports split payment),
    creates explicit allocations, and updates legacy invoice_payments for backwards compatibility.
    """
    patient_id = payload.get("patient_id")
    if not patient_id:
        raise HTTPException(status_code=400, detail="patient_id is required.")

    allocations = payload.get("allocations") or []
    payments = payload.get("payments") or []
    notes = payload.get("notes") or ""

    if not allocations:
        raise HTTPException(status_code=400, detail="At least one bill allocation is required.")
    if not payments:
        raise HTTPException(status_code=400, detail="At least one payment tender is required.")

    # Validate idempotency if provided
    if idempotency_key:
        payload_hash = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with legacy_sql.get_connection(db) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT response_status, response_body, payload_hash FROM financial_idempotency_log WHERE idempotency_key = ?",
                (idempotency_key,)
            )
            existing_key = cursor.fetchone()
            if existing_key:
                if existing_key[2] != payload_hash:
                    raise HTTPException(status_code=409, detail="Idempotency key collision with different request payload.")
                return json.loads(existing_key[1])

    # Validate amounts and duplicates
    total_allocated = D_ZERO
    invoice_ids = []
    seen_invoices = set()
    for item in allocations:
        inv_id = item.get("invoice_id")
        amt = to_decimal(item.get("amount"))
        if not inv_id:
            raise HTTPException(status_code=400, detail="Every allocation requires an invoice_id.")
        if inv_id in seen_invoices:
            raise HTTPException(status_code=400, detail=f"Duplicate allocation for invoice {inv_id} in payload.")
        if amt <= D_ZERO:
            raise HTTPException(status_code=400, detail=f"Allocation amount for invoice {inv_id} must be greater than zero.")
        seen_invoices.add(inv_id)
        invoice_ids.append(int(inv_id))
        total_allocated += amt

    total_tendered = D_ZERO
    clean_payments = []
    has_cash = False
    cash_amount = D_ZERO
    valid_modes = {"cash", "card", "upi", "bank_transfer", "net_banking", "cheque", "advance_allocation"}
    for p in payments:
        mode = str(p.get("payment_mode") or "cash").strip().lower()
        if mode not in valid_modes:
            mode = "cash"
        amt = to_decimal(p.get("amount"))
        if amt <= D_ZERO:
            raise HTTPException(status_code=400, detail="Payment tender amount must be greater than zero.")
        ref = p.get("transaction_ref") or ""
        total_tendered += amt
        clean_payments.append({"mode": mode, "amount": amt, "ref": ref})
        if mode == "cash":
            has_cash = True
            cash_amount += amt

    if total_allocated != total_tendered:
        raise HTTPException(
            status_code=400,
            detail=f"Total allocated (₹{total_allocated}) does not match total payment tendered (₹{total_tendered})."
        )

    # Begin database transaction with explicit row locks
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # Lock active cashier session
        active_session = get_or_create_active_cashier_session(db, user)
        session_id = active_session["id"]
        cursor.execute("SELECT id, status FROM cashier_sessions WHERE id = ? FOR UPDATE", (session_id,))
        s_row = cursor.fetchone()
        if not s_row or s_row["status"] != "open":
            raise HTTPException(status_code=409, detail="Active cashier session is closed. Please open a session.")

        # Lock invoices strictly in ascending order (prevent deadlocks)
        sorted_inv_ids = sorted(invoice_ids)
        placeholders = ",".join(["?"] * len(sorted_inv_ids))
        cursor.execute(
            f"SELECT * FROM invoices WHERE id IN ({placeholders}) ORDER BY id ASC FOR UPDATE",
            tuple(sorted_inv_ids)
        )
        invoice_rows = cursor.fetchall()
        if len(invoice_rows) != len(sorted_inv_ids):
            raise HTTPException(status_code=404, detail="One or more invoices were not found.")

        # Map by id (never zip())
        inv_map = {row["id"]: dict(row) for row in invoice_rows}

        # Verify ownership and remaining due balances under lock
        for item in allocations:
            inv_id = int(item["invoice_id"])
            inv = inv_map[inv_id]
            if inv.get("patient_id") and inv.get("patient_id") != patient_id:
                raise HTTPException(status_code=400, detail=f"Invoice {inv['invoice_no']} belongs to patient {inv.get('patient_id')}, not {patient_id}.")
            tot = to_decimal(inv.get("total_amount"))
            paid = to_decimal(inv.get("paid_amount"))
            due = quantize_dec(tot - paid)
            alloc_amt = to_decimal(item["amount"])
            if alloc_amt > due:
                raise HTTPException(
                    status_code=409,
                    detail=f"Allocated ₹{alloc_amt} exceeds current due balance of ₹{due} on bill {inv['invoice_no']}."
                )

        # Generate unique receipt number e.g. RCP-0271
        now_ist = current_ist_datetime()
        ts_str = now_ist.strftime("%y%m%d%H%M%S")
        cursor.execute("SELECT COUNT(*) FROM financial_receipts")
        rcp_seq = cursor.fetchone()[0] + 1
        receipt_no = f"RCP-{ts_str}-{rcp_seq:04d}"

        cursor.execute(
            """
            INSERT INTO financial_receipts (receipt_no, receipt_type, patient_id, total_amount, cashier_session_id, notes, created_by)
            VALUES (?, 'bill_payment', ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (receipt_no, patient_id, float(total_allocated), session_id, notes, user.get("username") or "Cashier")
        )
        receipt_id = cursor.fetchone()[0]

        # Insert receipt payment lines
        for p in clean_payments:
            cursor.execute(
                """
                INSERT INTO receipt_payment_lines (receipt_id, payment_mode, amount, transaction_ref)
                VALUES (?, ?, ?, ?)
                """,
                (receipt_id, p["mode"], float(p["amount"]), p["ref"])
            )

        # Insert receipt invoice allocations and update each invoice
        updated_invoices = []
        for item in allocations:
            inv_id = int(item["invoice_id"])
            inv = inv_map[inv_id]
            alloc_amt = to_decimal(item["amount"])

            cursor.execute(
                """
                INSERT INTO receipt_invoice_allocations (receipt_id, invoice_id, allocated_amount)
                VALUES (?, ?, ?)
                RETURNING id
                """,
                (receipt_id, inv_id, float(alloc_amt))
            )
            alloc_id = cursor.fetchone()[0]

            tot = to_decimal(inv.get("total_amount"))
            old_paid = to_decimal(inv.get("paid_amount"))
            new_paid = quantize_dec(old_paid + alloc_amt)
            new_due = quantize_dec(max(D_ZERO, tot - new_paid))
            new_status = "paid" if new_due <= D_ZERO else "partial"

            cursor.execute(
                """
                UPDATE invoices
                SET paid_amount = ?, due_amount = ?, payment_status = ?
                WHERE id = ?
                """,
                (float(new_paid), float(new_due), new_status, inv_id)
            )

            # Insert compatibility row into invoice_payments with canonical links
            primary_mode = clean_payments[0]["mode"] if clean_payments else "cash"
            primary_ref = clean_payments[0]["ref"] if clean_payments else ""
            cursor.execute(
                """
                INSERT INTO invoice_payments (invoice_id, amount, payment_mode, gateway_ref, canonical_receipt_id, canonical_allocation_id, receipt_no)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (inv_id, float(alloc_amt), primary_mode, primary_ref, receipt_id, alloc_id, receipt_no)
            )

            updated_invoices.append({
                "invoice_id": inv_id,
                "invoice_no": inv["invoice_no"],
                "allocated": float(alloc_amt),
                "total_amount": float(tot),
                "paid_amount": float(new_paid),
                "due_amount": float(new_due),
                "payment_status": new_status,
            })

        # Update cashier session drawer cash if cash was received
        if has_cash and cash_amount > D_ZERO:
            cursor.execute(
                "UPDATE cashier_sessions SET cash_received = cash_received + ? WHERE id = ?",
                (float(cash_amount), session_id)
            )

        result_payload = {
            "success": True,
            "receipt_id": receipt_id,
            "receipt_no": receipt_no,
            "patient_id": patient_id,
            "total_amount": float(total_allocated),
            "payment_modes": [p["mode"] for p in clean_payments],
            "updated_invoices": updated_invoices,
            "receipt_date": now_ist.strftime("%d-%b-%Y %I:%M %p"),
        }

        # Record idempotency log if provided
        if idempotency_key:
            cursor.execute(
                """
                INSERT INTO financial_idempotency_log (hospital_id, idempotency_key, request_path, payload_hash, response_status, response_body)
                VALUES (?, ?, '/api/billing/collect-multi', ?, 200, ?)
                """,
                (1, idempotency_key, payload_hash, json.dumps(result_payload))
            )

        conn.commit()
        return result_payload


# ==============================================================================
# 3. PATIENT ADVANCES & REFUNDS WITH RESERVATION (Check C)
# ==============================================================================

def record_patient_advance(db: Session, payload: dict, user: dict):
    patient_id = payload.get("patient_id")
    admission_id = payload.get("admission_id")
    amt = to_decimal(payload.get("amount"))
    mode = str(payload.get("payment_mode") or "cash").strip().lower()
    ref = payload.get("transaction_ref") or ""
    notes = payload.get("notes") or ""

    if not patient_id:
        raise HTTPException(status_code=400, detail="patient_id is required.")
    if amt <= D_ZERO:
        raise HTTPException(status_code=400, detail="Advance amount must be greater than zero.")

    now_ist = current_ist_datetime()
    ts_str = now_ist.strftime("%y%m%d%H%M%S")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # A mistyped UHID must not silently create an orphan advance that
        # can never be found again -- catch it here, before any money moves.
        cursor.execute("SELECT 1 FROM patients WHERE patient_id = ?", (patient_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail=f"No patient found with UHID '{patient_id}'.")

        active_session = get_or_create_active_cashier_session(db, user)
        session_id = active_session["id"]

        # Generate advance no e.g. ADV-0091
        cursor.execute("SELECT COUNT(*) FROM patient_advances")
        adv_seq = cursor.fetchone()[0] + 1
        advance_no = f"ADV-{adv_seq:04d}"

        # Generate receipt
        cursor.execute("SELECT COUNT(*) FROM financial_receipts")
        rcp_seq = cursor.fetchone()[0] + 1
        receipt_no = f"RCP-{ts_str}-{rcp_seq:04d}"

        cursor.execute(
            """
            INSERT INTO financial_receipts (receipt_no, receipt_type, patient_id, admission_id, total_amount, cashier_session_id, notes, created_by)
            VALUES (?, 'advance', ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (receipt_no, patient_id, admission_id, float(amt), session_id, notes or f"Advance deposit {advance_no}", user.get("username") or "Cashier")
        )
        receipt_id = cursor.fetchone()[0]

        cursor.execute(
            """
            INSERT INTO receipt_payment_lines (receipt_id, payment_mode, amount, transaction_ref)
            VALUES (?, ?, ?, ?)
            """,
            (receipt_id, mode, float(amt), ref)
        )

        cursor.execute(
            """
            INSERT INTO patient_advances (advance_no, patient_id, admission_id, amount, payment_mode, transaction_ref, notes, receipt_id, cashier_session_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (advance_no, patient_id, admission_id, float(amt), mode, ref, notes, receipt_id, session_id, user.get("username") or "Cashier")
        )
        advance_id = cursor.fetchone()[0]

        if mode == "cash":
            cursor.execute("UPDATE cashier_sessions SET cash_received = cash_received + ? WHERE id = ?", (float(amt), session_id))

        conn.commit()
        return {
            "success": True,
            "advance_id": advance_id,
            "advance_no": advance_no,
            "receipt_no": receipt_no,
            "amount": float(amt),
            "available": float(amt),
            "patient_id": patient_id,
            "date": now_ist.strftime("%d-%b-%Y %I:%M %p")
        }


def request_advance_refund(db: Session, payload: dict, user: dict):
    """
    Submits a refund request. Atomically reserves the requested amount on the advance
    so concurrent requests cannot spend or allocate the same balance (Check C).
    """
    advance_id = payload.get("advance_id")
    refund_amount = to_decimal(payload.get("amount"))
    reason = str(payload.get("reason") or "Excess advance").strip()
    refund_method = str(payload.get("refund_method") or "Original payment method").strip()
    notes = payload.get("notes") or ""

    if not advance_id:
        raise HTTPException(status_code=400, detail="advance_id is required.")
    if refund_amount <= D_ZERO:
        raise HTTPException(status_code=400, detail="Refund amount must be greater than zero.")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM patient_advances WHERE id = ? FOR UPDATE", (advance_id,))
        adv = cursor.fetchone()
        if not adv:
            raise HTTPException(status_code=404, detail="Advance record not found.")

        tot = to_decimal(adv["amount"])
        alloc = to_decimal(adv["allocated_amount"])
        ref = to_decimal(adv["refunded_amount"])
        reserved = to_decimal(adv["reserved_refund_amount"])

        # Available for new use = Total - Allocated - Refunded - Reserved
        available = quantize_dec(tot - alloc - ref - reserved)
        if refund_amount > available:
            raise HTTPException(
                status_code=409,
                detail=f"Requested refund ₹{refund_amount} exceeds currently available balance of ₹{available} (Reserved: ₹{reserved})."
            )

        # Reserve the amount
        new_reserved = quantize_dec(reserved + refund_amount)
        cursor.execute(
            "UPDATE patient_advances SET reserved_refund_amount = ? WHERE id = ?",
            (float(new_reserved), advance_id)
        )

        cursor.execute("SELECT COUNT(*) FROM refund_requests")
        rf_seq = cursor.fetchone()[0] + 1
        refund_no = f"RF-{rf_seq:04d}"

        cursor.execute(
            """
            INSERT INTO refund_requests (refund_no, patient_id, admission_id, advance_id, original_receipt_id, amount, reason, refund_method, notes, status, requested_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?)
            RETURNING id
            """,
            (refund_no, adv["patient_id"], adv["admission_id"], advance_id, adv["receipt_id"], float(refund_amount), reason, refund_method, notes, user.get("username") or "Cashier")
        )
        req_id = cursor.fetchone()[0]
        conn.commit()

        remaining_available = quantize_dec(available - refund_amount)
        return {
            "success": True,
            "refund_id": req_id,
            "refund_no": refund_no,
            "amount": float(refund_amount),
            "reserved_refund": float(new_reserved),
            "available_advance": float(remaining_available),
            "status": "awaiting_approval"
        }


def reject_refund_request(db: Session, refund_id: int, reason: str, user: dict):
    """
    Rejects a refund request and releases the reserved balance back to available (Check C).
    """
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM refund_requests WHERE id = ? FOR UPDATE", (refund_id,))
        req = cursor.fetchone()
        if not req:
            raise HTTPException(status_code=404, detail="Refund request not found.")
        if req["status"] != "awaiting_approval":
            raise HTTPException(status_code=409, detail=f"Cannot reject request in status '{req['status']}'.")

        amt = to_decimal(req["amount"])
        adv_id = req["advance_id"]

        if adv_id:
            cursor.execute("SELECT * FROM patient_advances WHERE id = ? FOR UPDATE", (adv_id,))
            adv = cursor.fetchone()
            if adv:
                old_res = to_decimal(adv["reserved_refund_amount"])
                new_res = quantize_dec(max(D_ZERO, old_res - amt))
                cursor.execute("UPDATE patient_advances SET reserved_refund_amount = ? WHERE id = ?", (float(new_res), adv_id))

        cursor.execute(
            """
            UPDATE refund_requests
            SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ?
            WHERE id = ?
            """,
            (user.get("username"), reason, refund_id)
        )
        conn.commit()
        return {"success": True, "status": "rejected", "released_amount": float(amt)}


def approve_refund_request(db: Session, refund_id: int, user: dict):
    """
    Approves refund. Does NOT mark as paid. Keeps the reservation active until paid.
    """
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM refund_requests WHERE id = ? FOR UPDATE", (refund_id,))
        req = cursor.fetchone()
        if not req:
            raise HTTPException(status_code=404, detail="Refund request not found.")
        if req["status"] != "awaiting_approval":
            raise HTTPException(status_code=409, detail=f"Cannot approve request in status '{req['status']}'.")

        cursor.execute(
            "UPDATE refund_requests SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?",
            (user.get("username"), refund_id)
        )
        conn.commit()
        return {"success": True, "status": "approved"}


def pay_approved_refund(db: Session, refund_id: int, payment_ref: str, user: dict):
    """
    Executes actual payout of an approved refund.
    Releases reservation, increments refunded_amount, creates refund voucher receipt, and deducts cashier drawer if cash.
    """
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        active_session = get_or_create_active_cashier_session(db, user)
        session_id = active_session["id"]

        cursor.execute("SELECT * FROM refund_requests WHERE id = ? FOR UPDATE", (refund_id,))
        req = cursor.fetchone()
        if not req:
            raise HTTPException(status_code=404, detail="Refund request not found.")
        if req["status"] != "approved":
            raise HTTPException(status_code=409, detail=f"Refund request is in status '{req['status']}', expected 'approved'.")

        amt = to_decimal(req["amount"])
        adv_id = req["advance_id"]

        now_ist = current_ist_datetime()
        ts_str = now_ist.strftime("%y%m%d%H%M%S")
        cursor.execute("SELECT COUNT(*) FROM financial_receipts")
        rcp_seq = cursor.fetchone()[0] + 1
        voucher_no = f"VCH-{ts_str}-{rcp_seq:04d}"

        # Insert refund voucher receipt
        cursor.execute(
            """
            INSERT INTO financial_receipts (receipt_no, receipt_type, patient_id, admission_id, total_amount, cashier_session_id, notes, created_by)
            VALUES (?, 'refund_voucher', ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (voucher_no, req["patient_id"], req["admission_id"], float(amt), session_id, f"Refund payout for {req['refund_no']}", user.get("username"))
        )
        voucher_id = cursor.fetchone()[0]

        # Insert receipt payment line for the refund voucher
        is_cash = "cash" in str(req["refund_method"]).lower()
        rf_mode = "cash" if is_cash else ("upi" if "upi" in str(req["refund_method"]).lower() else ("card" if "card" in str(req["refund_method"]).lower() else "bank_transfer"))
        cursor.execute(
            """
            INSERT INTO receipt_payment_lines (receipt_id, payment_mode, amount, transaction_ref)
            VALUES (?, ?, ?, ?)
            """,
            (voucher_id, rf_mode, float(amt), payment_ref or "")
        )

        # Update advance record: release reservation, increment refunded_amount
        if adv_id:
            cursor.execute("SELECT * FROM patient_advances WHERE id = ? FOR UPDATE", (adv_id,))
            adv = cursor.fetchone()
            if adv:
                old_res = to_decimal(adv["reserved_refund_amount"])
                old_ref = to_decimal(adv["refunded_amount"])
                new_res = quantize_dec(max(D_ZERO, old_res - amt))
                new_ref = quantize_dec(old_ref + amt)
                cursor.execute(
                    "UPDATE patient_advances SET reserved_refund_amount = ?, refunded_amount = ? WHERE id = ?",
                    (float(new_res), float(new_ref), adv_id)
                )

        # Deduct from cashier drawer if cash
        is_cash = "cash" in str(req["refund_method"]).lower()
        if is_cash:
            cursor.execute(
                "UPDATE cashier_sessions SET cash_refunded = cash_refunded + ? WHERE id = ?",
                (float(amt), session_id)
            )

        cursor.execute(
            """
            UPDATE refund_requests
            SET status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP, payment_ref = ?, voucher_receipt_id = ?, cashier_session_id = ?
            WHERE id = ?
            """,
            (user.get("username"), payment_ref, voucher_id, session_id, refund_id)
        )
        conn.commit()
        return {
            "success": True,
            "status": "paid",
            "voucher_no": voucher_no,
            "amount": float(amt),
            "date": now_ist.strftime("%d-%b-%Y %I:%M %p")
        }


# ==============================================================================
# 4. IP DISCHARGE BILLING (Check B)
# ==============================================================================

def _admission_pharmacy_charges(cursor, admission_id, patient_id, adm_date):
    """(patient pharmacy charges, insurance-billed pharmacy) for an admission.
    Insurance-billed issues sit on their own Due pharmacy invoice / claim, so
    they are never charged to the patient on the discharge bill."""
    cursor.execute(
        """
        SELECT COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(payment_mode, '')) <> 'insurance'), 0),
               COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(payment_mode, '')) = 'insurance'), 0)
        FROM pharmacy_sales
        WHERE admission_id = ?
           OR (patient_id = ? AND billing_type = 'IPD_RUNNING')
           OR (patient_id = ? AND sold_at >= ? AND admission_id IS NULL)
        """,
        (admission_id, patient_id, patient_id, adm_date),
    )
    row = cursor.fetchone()
    pharm_gross = to_decimal(row[0])
    pharmacy_insurance = quantize_dec(to_decimal(row[1]))
    cursor.execute(
        """
        SELECT COALESCE(SUM(pr.quantity * ps.unit_price), 0)
        FROM pharmacy_returns pr
        JOIN pharmacy_sales ps ON ps.id = pr.original_sale_id
        WHERE (ps.admission_id = ?
               OR (ps.patient_id = ? AND ps.billing_type = 'IPD_RUNNING')
               OR (ps.patient_id = ? AND ps.sold_at >= ? AND ps.admission_id IS NULL))
          AND pr.status = 'released'
          AND LOWER(COALESCE(ps.payment_mode, '')) <> 'insurance'
        """,
        (admission_id, patient_id, patient_id, adm_date),
    )
    pharm_returns = to_decimal(cursor.fetchone()[0])
    return quantize_dec(max(D_ZERO, pharm_gross - pharm_returns)), pharmacy_insurance


def _admission_settlement(cursor, admission_id):
    """What has really been billed and paid for a discharged admission, from its discharge
    invoice(s). Two screens can settle a discharge and they name the invoice differently:
    Inpatient Patients > Discharge makes INV-DIS-* (linked by admission_id) and billing's own
    settlement makes INV-IP-nnnn, so both are looked for. Returns None when there is no invoice.

    advance_applied is whatever settled the bill that was not collected as a payment row, so the
    figure is right whether an invoice's paid_amount includes the advance (billing) or not (the
    inpatient discharge screen)."""
    inv_no = f"INV-IP-{int(admission_id):04d}"
    cursor.execute(
        """
        SELECT i.id, i.invoice_no, i.total_amount, i.subtotal, i.discount, i.paid_amount, i.due_amount,
               i.payment_status, i.created_at
        FROM invoices i
        WHERE i.module = 'IP'
          AND (i.admission_id = ? OR i.invoice_no = ?
               OR i.id IN (SELECT oi.discharge_invoice_id FROM diag_order_items oi
                           JOIN diag_orders o ON o.id = oi.order_id
                           WHERE o.admission_id = ? AND oi.discharge_invoice_id IS NOT NULL))
        ORDER BY i.id
        """,
        (admission_id, inv_no, admission_id),
    )
    invoices = [dict(r) for r in cursor.fetchall()]
    if not invoices:
        return None
    ids = [i["id"] for i in invoices]
    cursor.execute(
        """
        SELECT id, invoice_id, amount, payment_mode, gateway_ref, created_at, receipt_no, canonical_receipt_id
        FROM invoice_payments WHERE invoice_id = ANY(?) ORDER BY created_at, id
        """,
        (ids,),
    )
    payments = [dict(r) for r in cursor.fetchall()]
    total = quantize_dec(sum((to_decimal(i["total_amount"]) for i in invoices), D_ZERO))
    due = quantize_dec(sum((to_decimal(i["due_amount"]) for i in invoices), D_ZERO))
    collected = quantize_dec(sum((to_decimal(p["amount"]) for p in payments), D_ZERO))
    discount = quantize_dec(sum((to_decimal(i["discount"]) for i in invoices), D_ZERO))
    billed_gross = quantize_dec(sum(
        (to_decimal(i["subtotal"]) if to_decimal(i["subtotal"]) > D_ZERO else to_decimal(i["total_amount"]) + to_decimal(i["discount"]))
        for i in invoices
    ))
    advance = quantize_dec(max(D_ZERO, total - due - collected))
    return {"invoices": invoices, "payments": payments, "total": total, "due": due, "collected": collected,
            "discount": discount, "billed_gross": billed_gross, "advance_applied": advance}


def _release_admission_beds(cursor, admission_id):
    """Free the bed(s) of a discharged admission so Bed Management and Inpatient Patients agree with it,
    and stop the bed charge from running on."""
    now_dt = current_ist_datetime()
    cursor.execute(
        "SELECT id, ward, bed_no, allocated_at, amount_per_day FROM bed_allocations WHERE admission_id = ? AND status = 'active'",
        (admission_id,),
    )
    for b in cursor.fetchall():
        try:
            start = datetime.fromisoformat(str(b["allocated_at"]).replace("Z", ""))
            days = max(1, math.ceil((now_dt - start).total_seconds() / 86400.0))
        except Exception:
            days = 1
        total = quantize_dec(Decimal(days) * to_decimal(b["amount_per_day"] or 1000))
        cursor.execute(
            "UPDATE bed_allocations SET status = 'released', released_at = CURRENT_TIMESTAMP, total_days = ?, total_amount = ? WHERE id = ?",
            (days, float(total), b["id"]),
        )
        if b["ward"] and b["bed_no"]:
            cursor.execute(
                "UPDATE hospital_beds SET status = 'available' WHERE LOWER(ward) = LOWER(?) AND LOWER(bed_no) = LOWER(?)",
                (str(b["ward"]).strip(), str(b["bed_no"]).strip()),
            )


def get_ip_discharge_details(db: Session, admission_id: Any):
    """
    Consolidates admission charges without creating duplicate bills (Check B).
    Returns Gross charges, Approved discount, Net bill, Advance applied, Balance to collect.
    """
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        adm = None
        # 1. Try finding by numeric admission ID
        clean_str = str(admission_id or "").strip()
        num_match = re.search(r"\d+", clean_str)
        if num_match:
            try:
                cursor.execute("SELECT * FROM admissions WHERE id = ?", (int(num_match.group(0)),))
                adm = cursor.fetchone()
            except Exception:
                pass

        # 2. Try by patient_id
        if not adm:
            cursor.execute("SELECT * FROM admissions WHERE LOWER(patient_id) = LOWER(?) ORDER BY id DESC LIMIT 1", (clean_str,))
            adm = cursor.fetchone()

        # 3. Try by patient name
        if not adm and clean_str:
            cursor.execute(
                """
                SELECT a.* FROM admissions a
                JOIN patients p ON p.patient_id = a.patient_id
                WHERE LOWER(p.name) LIKE ? OR LOWER(p.patient_id) LIKE ?
                ORDER BY a.id DESC LIMIT 1
                """,
                (f"%{clean_str.lower()}%", f"%{clean_str.lower()}%")
            )
            adm = cursor.fetchone()

        if not adm:
            raise HTTPException(status_code=404, detail="Admission not found.")

        admission_id = adm["id"]
        patient_id = adm["patient_id"]
        cursor.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,))
        patient = dict(cursor.fetchone() or {})

        # Bed & nursing stay charges
        cursor.execute(
            """
            SELECT * FROM bed_allocations 
            WHERE admission_id = ? 
            ORDER BY allocated_at ASC
            """,
            (admission_id,)
        )
        beds = [dict(b) for b in cursor.fetchall()]
        bed_charges = D_ZERO
        now_dt = current_ist_datetime()
        for b in beds:
            alloc_time = b.get("allocated_at") or adm["admission_date"]
            rel_time = b.get("released_at") or now_dt
            try:
                dt_start = datetime.fromisoformat(str(alloc_time).replace("Z", ""))
                dt_end = datetime.fromisoformat(str(rel_time).replace("Z", ""))
                stay_days = max(1, math.ceil((dt_end - dt_start).total_seconds() / 86400.0))
            except Exception:
                stay_days = max(1, int(b.get("total_days") or 1))
            rate = to_decimal(b.get("amount_per_day") or 1000)
            bed_charges += quantize_dec(Decimal(stay_days) * rate)

        # Pharmacy issues minus accepted returns (insurance-billed issues kept separate)
        adm_date = adm["admission_date"]
        pharmacy_net, pharmacy_insurance = _admission_pharmacy_charges(cursor, admission_id, patient_id, adm_date)
        # Balance of rejected / short-closed pharmacy insurance claims: now the patient's to pay
        # on the pharmacy invoice itself (shown here so the discharge desk collects it).
        cursor.execute(
            """
            SELECT COALESCE(SUM(i.due_amount), 0) FROM invoices i
            WHERE i.id IN (SELECT DISTINCT ps.invoice_id FROM pharmacy_sales ps WHERE ps.admission_id = ? AND ps.invoice_id IS NOT NULL)
              AND EXISTS (SELECT 1 FROM insurance_claims c WHERE c.invoice_id = i.id AND c.claim_status IN ('rejected', 'closed'))
            """,
            (admission_id,),
        )
        insurance_shortfall_due = quantize_dec(to_decimal(cursor.fetchone()[0]))

        # Diagnostics & Imaging
        cursor.execute(
            """
            SELECT oi.department_type, COALESCE(SUM(oi.amount), 0)
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
            GROUP BY oi.department_type
            """,
            (admission_id,)
        )
        diag_rows = cursor.fetchall()
        lab_charges = D_ZERO
        imaging_charges = D_ZERO
        for d in diag_rows:
            if d[0] == "IMAGING":
                imaging_charges += to_decimal(d[1])
            else:
                lab_charges += to_decimal(d[1])

        # Consultations: sum appointment consultation_fee for this patient within admission date range
        adm_date = str(adm["admission_date"])[:10] if adm["admission_date"] else None
        if adm_date:
            cursor.execute(
                """
                SELECT COALESCE(SUM(a.consultation_fee), 0)
                FROM appointments a
                WHERE a.patient_id = ?
                  AND DATE(a.appointment_date) >= DATE(?)
                  AND (a.status IN ('completed', 'confirmed'))
                """,
                (patient_id, adm_date)
            )
        else:
            cursor.execute("SELECT 0")
        consultation_charges = to_decimal(cursor.fetchone()[0])

        # Procedures from OT if available (zero if table not present)
        procedure_charges = D_ZERO
        try:
            cursor.execute("SELECT to_regclass('public.ot_records')")
            reg = cursor.fetchone()
            if reg and reg[0]:
                cursor.execute(
                    """
                    SELECT COALESCE(SUM(procedure_cost), 0)
                    FROM ot_records
                    WHERE admission_id = ? AND status != 'cancelled'
                    """,
                    (admission_id,)
                )
                procedure_charges = to_decimal(cursor.fetchone()[0])
        except Exception:
            procedure_charges = D_ZERO

        gross_charges = quantize_dec(bed_charges + pharmacy_net + lab_charges + imaging_charges + consultation_charges + procedure_charges)

        # Approved discount from admission record (field: discount_amount), default 0
        adm_discount = to_decimal(adm.get("discount_amount") if hasattr(adm, 'get') else (dict(adm).get("discount_amount") if adm else 0))
        approved_discount = quantize_dec(min(gross_charges, adm_discount))

        # Advances applied or available
        cursor.execute(
            """
            SELECT * FROM patient_advances
            WHERE (admission_id = ? OR patient_id = ?) AND status = 'active'
            """,
            (admission_id, patient_id)
        )
        advances = [dict(a) for a in cursor.fetchall()]
        advance_total = sum(to_decimal(a["amount"]) for a in advances)
        advance_applied = sum(to_decimal(a["allocated_amount"]) for a in advances)
        if advance_applied == D_ZERO and advance_total > D_ZERO:
            advance_applied = advance_total  # ready to be applied on settlement

        net_bill = quantize_dec(max(D_ZERO, gross_charges - approved_discount))
        balance_to_collect = quantize_dec(max(D_ZERO, net_bill - advance_applied))

        # Collect detailed line items for UI breakdown
        bed_items = []
        for b in beds:
            alloc_time = b.get("allocated_at") or adm["admission_date"]
            rel_time = b.get("released_at") or now_dt
            try:
                dt_start = datetime.fromisoformat(str(alloc_time).replace("Z", ""))
                dt_end = datetime.fromisoformat(str(rel_time).replace("Z", ""))
                stay_days = max(1, math.ceil((dt_end - dt_start).total_seconds() / 86400.0))
            except Exception:
                stay_days = max(1, int(b.get("total_days") or 1))
            rate = to_decimal(b.get("amount_per_day") or 1000)
            b_total = quantize_dec(Decimal(stay_days) * rate)
            bed_items.append({
                "id": b.get("id"),
                "ward": b.get("ward") or "General Ward",
                "room_no": b.get("room_no") or "-",
                "bed_no": b.get("bed_no") or "Pending",
                "days": stay_days,
                "daily_rate": float(rate),
                "total": float(b_total),
                "allocated_at": str(b.get("allocated_at"))[:19] if b.get("allocated_at") else None,
                "released_at": str(b.get("released_at"))[:19] if b.get("released_at") else "Current",
                "status": b.get("status") or "active"
            })

        # Pharmacy items
        cursor.execute(
            """
            SELECT ps.id, ps.sold_at AS sale_date, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount,
                   ps.payment_mode, (LOWER(COALESCE(ps.payment_mode, '')) = 'insurance') AS insurance_billed,
                   COALESCE(STRING_AGG(DISTINCT pi.batch_no, ', '), '') AS batch_number
            FROM pharmacy_sales ps
            LEFT JOIN stock_movements sm ON sm.ref_table = 'pharmacy_sales' AND sm.ref_id = ps.id
            LEFT JOIN pharmacy_inventory pi ON pi.id = sm.pharmacy_inventory_id
            WHERE ps.admission_id = ?
               OR (ps.patient_id = ? AND ps.billing_type = 'IPD_RUNNING')
               OR (ps.patient_id = ? AND ps.sold_at >= ? AND ps.admission_id IS NULL)
            GROUP BY ps.id, ps.sold_at, ps.medicine_name, ps.quantity, ps.unit_price, ps.amount, ps.payment_mode
            ORDER BY ps.sold_at DESC LIMIT 100
            """,
            (admission_id, patient_id, patient_id, adm_date)
        )
        pharmacy_items = [dict(p) for p in cursor.fetchall()]
        for p in pharmacy_items:
            if p.get("sale_date"):
                p["sale_date"] = str(p["sale_date"])

        # Lab items
        cursor.execute(
            """
            SELECT oi.id, oi.service_name AS item_name, oi.amount, o.order_no, o.created_at AS order_date, oi.progress_status AS status, oi.department_type
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND oi.department_type != 'IMAGING' AND oi.cancelled_at IS NULL
            ORDER BY o.created_at DESC LIMIT 50
            """,
            (admission_id,)
        )
        lab_items = [dict(l) for l in cursor.fetchall()]

        # Imaging items
        cursor.execute(
            """
            SELECT oi.id, oi.service_name AS item_name, oi.amount, o.order_no, o.created_at AS order_date, oi.progress_status AS status, oi.department_type
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND oi.department_type = 'IMAGING' AND oi.cancelled_at IS NULL
            ORDER BY o.created_at DESC LIMIT 50
            """,
            (admission_id,)
        )
        imaging_items = [dict(im) for im in cursor.fetchall()]

        # Consultation items
        if adm_date:
            cursor.execute(
                """
                SELECT a.id, a.doctor_name, a.appointment_date, a.consultation_fee, a.status, a.notes AS reason
                FROM appointments a
                WHERE a.patient_id = ? AND DATE(a.appointment_date) >= DATE(?) AND a.status IN ('completed', 'confirmed')
                ORDER BY a.appointment_date DESC LIMIT 50
                """,
                (patient_id, adm_date)
            )
            consultation_items = [dict(c) for c in cursor.fetchall()]
        else:
            consultation_items = []

        # Payment records linked to this admission or patient
        cursor.execute(
            """
            SELECT fr.id, fr.receipt_no, fr.receipt_type, fr.total_amount, fr.created_at, fr.notes, rpl.payment_mode
            FROM financial_receipts fr
            LEFT JOIN receipt_payment_lines rpl ON rpl.receipt_id = fr.id
            WHERE (fr.admission_id = ? OR fr.patient_id = ?) AND fr.is_reversed = FALSE
            ORDER BY fr.created_at DESC LIMIT 30
            """,
            (admission_id, patient_id)
        )
        payment_items = [dict(py) for py in cursor.fetchall()]

        # Once the stay is discharged, what matters is what was actually billed and paid on its
        # discharge invoice(s), not a fresh recalculation that knows nothing about the payment.
        settlement = _admission_settlement(cursor, admission_id) if adm["discharge_date"] else None
        settled_summary = {"settled": False, "amount_paid": 0.0}
        if settlement:
            receipt_ids = {py["id"] for py in payment_items}
            inv_by_id = {i["id"]: i for i in settlement["invoices"]}
            for pay in settlement["payments"]:
                if pay.get("canonical_receipt_id") in receipt_ids:
                    continue  # already listed as a receipt
                payment_items.append({
                    "id": f"inv-pay-{pay['id']}",
                    "receipt_no": pay.get("receipt_no") or inv_by_id[pay["invoice_id"]]["invoice_no"],
                    "receipt_type": "Discharge bill",
                    "total_amount": float(to_decimal(pay["amount"])),
                    "created_at": pay.get("created_at"),
                    "notes": f"Recorded with discharge invoice {inv_by_id[pay['invoice_id']]['invoice_no']}",
                    "payment_mode": pay.get("payment_mode"),
                })
            payment_items.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            net_bill = settlement["total"]
            advance_applied = settlement["advance_applied"]
            balance_to_collect = settlement["due"]
            settled_summary = {
                "settled": True,
                "amount_paid": float(settlement["collected"]),
                "billed_gross": float(settlement["billed_gross"]),
                "billed_discount": float(settlement["discount"]),
                # >0: charges on record now exceed what was billed; <0: the invoice(s) billed more than that.
                "billed_vs_charges_difference": float(quantize_dec(gross_charges - settlement["billed_gross"])),
                "invoice_count": len(settlement["invoices"]),
                "settlement_invoices": [
                    {"id": i["id"], "invoice_no": i["invoice_no"], "total": float(to_decimal(i["total_amount"])),
                     "paid": float(to_decimal(i["paid_amount"])), "due": float(to_decimal(i["due_amount"])),
                     "status": i["payment_status"]}
                    for i in settlement["invoices"]
                ],
            }

        # Create charges_version hash
        version_str = f"{admission_id}:{gross_charges}:{net_bill}:{len(beds)}:{pharmacy_net}"
        charges_version = hashlib.md5(version_str.encode()).hexdigest()

        return {
            "admission": dict(adm),
            "patient": patient,
            "charges_summary": {
                "bed_nursing": float(bed_charges),
                "consultations": float(consultation_charges),
                "pharmacy": float(pharmacy_net),
                "pharmacy_insurance": float(pharmacy_insurance),
                "insurance_shortfall_due": float(insurance_shortfall_due),
                "laboratory": float(lab_charges),
                "imaging": float(imaging_charges),
                "procedures": float(procedure_charges),
                "gross_charges": float(gross_charges),
                "approved_discount": float(approved_discount),
                "net_bill": float(net_bill),
                "advance_applied": float(advance_applied),
                "balance_to_collect": float(balance_to_collect),
                **settled_summary,
            },
            "itemised": {
                "beds": bed_items,
                "pharmacy": pharmacy_items,
                "laboratory": lab_items,
                "imaging": imaging_items,
                "consultations": consultation_items,
            },
            "payments": payment_items,
            "advances": advances,
            "charges_version": charges_version,
            "status": "financial_review" if not adm["discharge_date"] else "finalised"
        }


def finalise_ip_discharge_settlement(db: Session, payload: dict, user: dict):
    """
    Atomically validates and finalises IP discharge settlement under database row locks.
    Applies patient advances, registers split-tender final collection payment,
    creates/updates consolidated IP invoice and receipts without double-counting.
    Leaves accurate remaining balance if partially settled.
    """
    admission_id = int(payload.get("admission_id"))
    payments = payload.get("payments") or []
    discount_input = to_decimal(payload.get("discount_amount") or 0)

    notes = payload.get("notes") or "Discharge billing clearance"

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # 1. Lock admission atomically
        cursor.execute("SELECT * FROM admissions WHERE id = ? FOR UPDATE", (admission_id,))
        adm = cursor.fetchone()
        if not adm:
            raise HTTPException(status_code=404, detail="Admission record not found.")

        patient_id = adm["patient_id"]

        # Already settled (by this screen or by Inpatient Patients > Discharge): settling again would
        # raise a second invoice and collect the same bill twice.
        if adm["discharge_date"]:
            already = _admission_settlement(cursor, admission_id)
            if already and already["due"] <= D_ZERO:
                nos = ", ".join(i["invoice_no"] for i in already["invoices"])
                raise HTTPException(
                    status_code=409,
                    detail=f"This admission is already settled (invoice {nos}, ₹{already['collected']} collected). Nothing is left to collect.",
                )

        # 2. Re-compute charges atomically under lock
        cursor.execute("SELECT * FROM bed_allocations WHERE admission_id = ? ORDER BY allocated_at ASC", (admission_id,))
        beds = cursor.fetchall()
        bed_charges = D_ZERO
        now_dt = current_ist_datetime()
        for b in beds:
            alloc_time = b["allocated_at"]
            rel_time = b.get("released_at") or now_dt
            try:
                dt_start = datetime.fromisoformat(str(alloc_time).replace("Z", ""))
                dt_end = datetime.fromisoformat(str(rel_time).replace("Z", ""))
                stay_days = max(1, math.ceil((dt_end - dt_start).total_seconds() / 86400.0))
            except Exception:
                stay_days = max(1, int(b.get("total_days") or 1))
            rate = to_decimal(b.get("amount_per_day") or 1000)
            bed_charges += quantize_dec(Decimal(stay_days) * rate)

        # Pharmacy net -- same rule as the discharge preview, so the finalised bill matches it
        pharmacy_net, _pharmacy_insurance = _admission_pharmacy_charges(cursor, admission_id, adm["patient_id"], adm["admission_date"])

        # Diagnostics & Imaging
        cursor.execute(
            """
            SELECT oi.department_type, COALESCE(SUM(oi.amount), 0)
            FROM diag_order_items oi
            JOIN diag_orders o ON o.id = oi.order_id
            WHERE o.admission_id = ? AND o.status = 'confirmed' AND oi.cancelled_at IS NULL
            GROUP BY oi.department_type
            """,
            (admission_id,)
        )
        diag_rows = cursor.fetchall()
        lab_charges = D_ZERO
        imaging_charges = D_ZERO
        for d in diag_rows:
            if d[0] == "IMAGING":
                imaging_charges += to_decimal(d[1])
            else:
                lab_charges += to_decimal(d[1])

        # Consultations: sum appointment consultation_fee for this patient since admission date
        adm_date = str(adm["admission_date"])[:10] if adm["admission_date"] else None
        if adm_date:
            cursor.execute(
                """
                SELECT COALESCE(SUM(a.consultation_fee), 0)
                FROM appointments a
                WHERE a.patient_id = ?
                  AND DATE(a.appointment_date) >= DATE(?)
                  AND (a.status IN ('completed', 'confirmed'))
                """,
                (patient_id, adm_date)
            )
        else:
            cursor.execute("SELECT 0")
        consultation_charges = to_decimal(cursor.fetchone()[0])

        # Procedures from OT records if available
        procedure_charges = D_ZERO
        try:
            cursor.execute("SELECT to_regclass('public.ot_records')")
            reg = cursor.fetchone()
            if reg and reg[0]:
                cursor.execute(
                    """
                    SELECT COALESCE(SUM(procedure_cost), 0)
                    FROM ot_records
                    WHERE admission_id = ? AND status != 'cancelled'
                    """,
                    (admission_id,)
                )
                procedure_charges = to_decimal(cursor.fetchone()[0])
        except Exception:
            procedure_charges = D_ZERO

        gross_charges = quantize_dec(bed_charges + pharmacy_net + lab_charges + imaging_charges + consultation_charges + procedure_charges)

        # Discount: prefer explicit payload discount_amount; fall back to admission.discount_amount
        adm_discount_field = D_ZERO
        try:
            adm_dict = dict(adm)
            adm_discount_field = to_decimal(adm_dict.get("discount_amount") or 0)
        except Exception:
            adm_discount_field = D_ZERO
        effective_discount_input = discount_input if discount_input > D_ZERO else adm_discount_field
        approved_discount = quantize_dec(min(gross_charges, effective_discount_input))
        net_bill = quantize_dec(max(D_ZERO, gross_charges - approved_discount))

        # 3. Apply available advances under lock
        cursor.execute(
            """
            SELECT * FROM patient_advances
            WHERE (admission_id = ? OR patient_id = ?) AND status = 'active'
            ORDER BY id ASC FOR UPDATE
            """,
            (admission_id, patient_id)
        )
        adv_rows = cursor.fetchall()
        needed_from_advance = net_bill
        total_advance_applied = D_ZERO

        for adv in adv_rows:
            if needed_from_advance <= D_ZERO:
                break
            adv_tot = to_decimal(adv["amount"])
            adv_alloc = to_decimal(adv["allocated_amount"])
            adv_ref = to_decimal(adv["refunded_amount"])
            adv_res = to_decimal(adv["reserved_refund_amount"])
            adv_avail = quantize_dec(adv_tot - adv_alloc - adv_ref - adv_res)

            if adv_avail > D_ZERO:
                alloc_chunk = min(adv_avail, needed_from_advance)
                new_alloc = quantize_dec(adv_alloc + alloc_chunk)
                cursor.execute(
                    "UPDATE patient_advances SET allocated_amount = ? WHERE id = ?",
                    (float(new_alloc), adv["id"])
                )
                total_advance_applied += alloc_chunk
                needed_from_advance -= alloc_chunk

        balance_to_collect = quantize_dec(max(D_ZERO, net_bill - total_advance_applied))

        # 4. Process final discharge collection payment if tendered
        total_tendered = D_ZERO
        clean_payments = []
        has_cash = False
        cash_amount = D_ZERO
        for p in payments:
            amt = to_decimal(p.get("amount"))
            if amt > D_ZERO:
                mode = str(p.get("payment_mode") or "cash").strip().lower()
                ref = p.get("transaction_ref") or ""
                total_tendered += amt
                clean_payments.append({"mode": mode, "amount": amt, "ref": ref})
                if mode == "cash":
                    has_cash = True
                    cash_amount += amt

        # Validate not overpaid
        if total_tendered > balance_to_collect:
            raise HTTPException(
                status_code=400,
                detail=f"Tendered amount ₹{total_tendered} exceeds balance to collect ₹{balance_to_collect}."
            )

        remaining_due = quantize_dec(balance_to_collect - total_tendered)
        settlement_status = "paid" if remaining_due <= D_ZERO else "partial"

        # 5. Create or update consolidated IP invoice
        inv_no = f"INV-IP-{admission_id:04d}"
        cursor.execute("SELECT id FROM invoices WHERE invoice_no = ?", (inv_no,))
        existing_inv = cursor.fetchone()
        now_ist = current_ist_datetime()

        if existing_inv:
            inv_id = existing_inv[0]
            cursor.execute(
                """
                UPDATE invoices
                SET total_amount = ?, paid_amount = ?, due_amount = ?, payment_status = ?
                WHERE id = ?
                """,
                (float(net_bill), float(total_advance_applied + total_tendered), float(remaining_due), settlement_status, inv_id)
            )
        else:
            cursor.execute(
                """
                INSERT INTO invoices (invoice_no, patient_id, module, total_amount, paid_amount, due_amount, payment_status, created_by)
                VALUES (?, ?, 'IP', ?, ?, ?, ?, ?)
                RETURNING id
                """,
                (inv_no, patient_id, float(net_bill), float(total_advance_applied + total_tendered), float(remaining_due), settlement_status, user.get("username") or "Cashier")
            )
            inv_id = cursor.fetchone()[0]

        receipt_no = None
        receipt_id = None
        if total_tendered > D_ZERO:
            active_session = get_or_create_active_cashier_session(db, user)
            session_id = active_session["id"]

            ts_str = now_ist.strftime("%y%m%d%H%M%S")
            cursor.execute("SELECT COUNT(*) FROM financial_receipts")
            rcp_seq = cursor.fetchone()[0] + 1
            receipt_no = f"RCP-{ts_str}-{rcp_seq:04d}"

            cursor.execute(
                """
                INSERT INTO financial_receipts (receipt_no, receipt_type, patient_id, admission_id, total_amount, cashier_session_id, notes, created_by)
                VALUES (?, 'bill_payment', ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                (receipt_no, patient_id, admission_id, float(total_tendered), session_id, f"Discharge settlement IP-{admission_id:04d}", user.get("username") or "Cashier")
            )
            receipt_id = cursor.fetchone()[0]

            for cp in clean_payments:
                cursor.execute(
                    """
                    INSERT INTO receipt_payment_lines (receipt_id, payment_mode, amount, transaction_ref)
                    VALUES (?, ?, ?, ?)
                    """,
                    (receipt_id, cp["mode"], float(cp["amount"]), cp["ref"])
                )

            cursor.execute(
                """
                INSERT INTO receipt_invoice_allocations (receipt_id, invoice_id, allocated_amount)
                VALUES (?, ?, ?)
                RETURNING id
                """,
                (receipt_id, inv_id, float(total_tendered))
            )
            alloc_id = cursor.fetchone()[0]

            # Compatibility row in invoice_payments
            cursor.execute(
                """
                INSERT INTO invoice_payments (invoice_id, amount, payment_mode, gateway_ref, canonical_receipt_id, canonical_allocation_id, receipt_no)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (inv_id, float(total_tendered), clean_payments[0]["mode"], clean_payments[0]["ref"], receipt_id, alloc_id, receipt_no)
            )

            if has_cash and cash_amount > D_ZERO:
                cursor.execute(
                    """
                    UPDATE cashier_sessions
                    SET cash_received = cash_received + ?
                    WHERE id = ?
                    """,
                    (float(cash_amount), session_id)
                )

        # 6. Finalise admission
        cursor.execute(
            """
            UPDATE admissions
            SET discharge_date = COALESCE(discharge_date, CURRENT_TIMESTAMP),
                notes = COALESCE(notes, '') || ' | Discharge Billed & Cleared by ' || ?
            WHERE id = ?
            """,
            (user.get("username") or "Cashier", admission_id)
        )
        _release_admission_beds(cursor, admission_id)

        conn.commit()

        return {
            "success": True,
            "admission_id": admission_id,
            "invoice_id": inv_id,
            "invoice_no": inv_no,
            "receipt_no": receipt_no,
            "gross_charges": float(gross_charges),
            "approved_discount": float(approved_discount),
            "net_bill": float(net_bill),
            "advance_applied": float(total_advance_applied),
            "amount_paid": float(total_tendered),
            "remaining_due": float(remaining_due),
            "settlement_status": settlement_status,
            "status": "finalised"
        }


# ==============================================================================
# 5. DOCTOR PAYOUTS & AGREEMENTS (Check D)
# ==============================================================================

def _doctor_key(name) -> str:
    """Doctor names are matched ignoring case, spacing and a leading "Dr." (appointments, schedules
    and logins are typed separately, so the same doctor appears as "hari", "Dr. Hari" ...)."""
    return re.sub(r"^dr\.?\s+", "", str(name or "").strip(), flags=re.IGNORECASE).strip().lower()


def _next_month_start(period_month: str) -> str:
    year, month = int(period_month[:4]), int(period_month[5:7])
    return f"{year + (month == 12)}-{1 if month == 12 else month + 1:02d}-01"


def get_doctor_payout_summary_and_statements(db: Session, period_month: str = None, department: str = None,
                                             search: str = None, hospital_id: int = None):
    """Doctor fee statements for one month.

    Every doctor in Doctor Scheduling (plus any doctor login, plus anyone with completed paid
    consultations that month) gets a line, with the fees earned from their completed consultations.
    Departments offered for filtering are the department list plus the departments doctors are
    scheduled under. A statement is only stored once the doctor has fees to pay; open statements
    follow the month's consultations until approved.
    """
    now_month = current_ist_datetime().strftime("%Y-%m")
    period_month = (period_month or now_month).strip()
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period_month):
        raise HTTPException(status_code=400, detail="Month must be in YYYY-MM format.")
    scoped_hospital_id = hospital_id or resolve_hospital_id(db)
    dept_filter = (department or "").strip()
    dept_filter = "" if dept_filter.lower() == "all departments" else dept_filter.lower()

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # 1. Doctors: the scheduling directory first (latest department per doctor) ...
        doctors: Dict[str, dict] = {}
        cursor.execute(
            """
            SELECT s.doctor_name, s.department
            FROM doctor_schedules s
            JOIN (SELECT LOWER(TRIM(doctor_name)) AS k, MAX(id) AS mid FROM doctor_schedules GROUP BY 1) m ON m.mid = s.id
            WHERE TRIM(COALESCE(s.doctor_name, '')) <> ''
            """
        )
        for r in cursor.fetchall():
            doctors[_doctor_key(r["doctor_name"])] = {
                "name": str(r["doctor_name"]).strip(), "department": (r["department"] or "").strip(), "user_id": None,
            }
        # ... linked to their login when they have one (and logins of doctors who are not scheduled).
        cursor.execute(
            """
            SELECT id, doctor_name, full_name, username, department FROM users
            WHERE hospital_id = ? AND (TRIM(COALESCE(doctor_name, '')) <> '' OR LOWER(COALESCE(job_role, '')) = 'doctor')
            """,
            (scoped_hospital_id,),
        )
        for u in cursor.fetchall():
            name = (u["doctor_name"] or u["full_name"] or u["username"] or "").strip()
            key = _doctor_key(name)
            if not key:
                continue
            entry = doctors.setdefault(key, {"name": name, "department": (u["department"] or "").strip(), "user_id": None})
            entry["user_id"] = entry["user_id"] or u["id"]
            entry["department"] = entry["department"] or (u["department"] or "").strip()

        # 2. Fees earned that month: completed consultations, per doctor.
        cursor.execute(
            """
            SELECT doctor_name, consultation_fee FROM appointments
            WHERE status = 'completed' AND TRIM(COALESCE(doctor_name, '')) <> ''
              AND appointment_date >= CAST(? AS date) AND appointment_date < CAST(? AS date)
            """,
            (period_month + "-01", _next_month_start(period_month)),
        )
        earned: Dict[str, dict] = {}
        for r in cursor.fetchall():
            e = earned.setdefault(_doctor_key(r["doctor_name"]), {"name": str(r["doctor_name"]).strip(), "fees": D_ZERO, "count": 0})
            e["fees"] += to_decimal(r["consultation_fee"])
            e["count"] += 1
        # Someone paid for consultations but is not in the directory: still shown (pseudo-doctors with no fees are not).
        for key, e in earned.items():
            if key not in doctors and e["fees"] > D_ZERO:
                doctors[key] = {"name": e["name"], "department": "", "user_id": None}

        # 3. Departments to offer in the filter.
        cursor.execute("SELECT department_name FROM department_master WHERE hospital_id = ?", (scoped_hospital_id,))
        dept_rows = cursor.fetchall()
        if not dept_rows:
            cursor.execute("SELECT department_name FROM department_master")
            dept_rows = cursor.fetchall()
        dept_names = {str(r["department_name"]).strip() for r in dept_rows if str(r["department_name"] or "").strip()}
        for d in doctors.values():
            if d["department"] and d["department"].lower() not in {n.lower() for n in dept_names}:
                dept_names.add(d["department"])

        # 4. One statement line per doctor.
        total_fees = total_adj = total_paid = D_ZERO
        statements = []
        for key in sorted(doctors, key=lambda k: doctors[k]["name"].lower()):
            doc = doctors[key]
            if dept_filter and doc["department"].lower() != dept_filter:
                continue
            fees = earned.get(key, {}).get("fees", D_ZERO)
            count = earned.get(key, {}).get("count", 0)

            cursor.execute(
                "SELECT * FROM doctor_statements WHERE LOWER(TRIM(doctor_name)) = ? AND period_month = ?",
                (key, period_month),
            )
            stmt = cursor.fetchone()
            if not stmt and fees > D_ZERO and period_month <= now_month:
                cursor.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM doctor_statements")
                stmt_no = f"ST-{cursor.fetchone()[0]:04d}"
                cursor.execute(
                    """
                    INSERT INTO doctor_statements (statement_no, doctor_id, doctor_name, department, period_month, fees_earned,
                                                   adjustments, net_payable, paid_amount, remaining_payable, status, payment_status)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 'ready_for_review', 'unpaid')
                    RETURNING *
                    """,
                    (stmt_no, doc["user_id"], doc["name"], doc["department"] or None, period_month,
                     float(fees), float(fees), float(fees)),
                )
                stmt = cursor.fetchone()
            elif stmt and stmt["status"] != "approved":
                # An open statement follows the month's consultations; an approved one is frozen.
                adj = to_decimal(stmt["adjustments"])
                paid = to_decimal(stmt["paid_amount"])
                net = quantize_dec(max(D_ZERO, fees + adj))
                due = quantize_dec(max(D_ZERO, net - paid))
                pay_status = "paid" if (due <= D_ZERO and net > D_ZERO) else ("partially_paid" if paid > D_ZERO else "unpaid")
                if (to_decimal(stmt["fees_earned"]), to_decimal(stmt["net_payable"]), to_decimal(stmt["remaining_payable"])) != (fees, net, due) \
                        or (stmt["department"] or "") != (doc["department"] or stmt["department"] or ""):
                    cursor.execute(
                        """
                        UPDATE doctor_statements
                        SET fees_earned = ?, net_payable = ?, remaining_payable = ?, payment_status = ?,
                            department = COALESCE(NULLIF(?, ''), department), updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (float(fees), float(net), float(due), pay_status, doc["department"], stmt["id"]),
                    )
                    cursor.execute("SELECT * FROM doctor_statements WHERE id = ?", (stmt["id"],))
                    stmt = cursor.fetchone()

            if stmt:
                row = dict(stmt)
            else:
                row = {"id": None, "statement_no": None, "doctor_name": doc["name"], "department": doc["department"],
                       "period_month": period_month, "fees_earned": 0, "adjustments": 0, "net_payable": 0,
                       "paid_amount": 0, "remaining_payable": 0, "status": "no_fees", "payment_status": "unpaid"}
            row["department"] = row.get("department") or doc["department"]
            row["consultations"] = count
            total_fees += to_decimal(row["fees_earned"])
            total_adj += to_decimal(row["adjustments"])
            total_paid += to_decimal(row["paid_amount"])
            if not search or search.strip().lower() in doc["name"].lower():
                statements.append(row)
        conn.commit()

        total_payable = quantize_dec(total_fees + total_adj - total_paid)

        # Payments made for this month's statements (same doctors as listed above).
        shown = {_doctor_key(s["doctor_name"]) for s in statements}
        cursor.execute(
            """
            SELECT dpp.id, dpp.amount, dpp.paid_date, dpp.payment_mode, dp.doctor_name, st.statement_no
            FROM doctor_payout_payments dpp
            JOIN doctor_payouts dp ON dp.id = dpp.payout_id
            LEFT JOIN doctor_statements st ON LOWER(TRIM(st.doctor_name)) = LOWER(TRIM(dp.doctor_name)) AND st.period_month = dp.payout_month
            WHERE dp.payout_month = ?
            ORDER BY dpp.paid_date DESC, dpp.id DESC LIMIT 100
            """,
            (period_month,),
        )
        payout_history = []
        for r in cursor.fetchall():
            if _doctor_key(r["doctor_name"]) not in shown:
                continue
            h = dict(r)
            h["payout_no"] = f"PAY-{h['id']:04d}"
            h["paid_date"] = str(h["paid_date"])[:10] if h.get("paid_date") else None
            payout_history.append(h)

        return {
            "period_month": period_month,
            "departments": sorted(dept_names, key=str.lower),
            "summary": {
                "fees_earned": float(total_fees),
                "adjustments": float(total_adj),
                "paid": float(total_paid),
                "payable": float(total_payable),
            },
            "statements": statements,
            "payout_history": payout_history,
        }


def record_doctor_statement_payout(db: Session, statement_id: int, payload: dict, user: dict):
    payout_amt = to_decimal(payload.get("amount"))
    mode = str(payload.get("payment_mode") or "bank_transfer").strip().lower()
    ref = payload.get("reference") or ""
    p_date = payload.get("payment_date") or current_ist_datetime().strftime("%Y-%m-%d")

    if payout_amt <= D_ZERO:
        raise HTTPException(status_code=400, detail="Payout amount must be greater than zero.")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        active_session = get_or_create_active_cashier_session(db, user)
        session_id = active_session["id"]

        cursor.execute("SELECT * FROM doctor_statements WHERE id = ? FOR UPDATE", (statement_id,))
        stmt = cursor.fetchone()
        if not stmt:
            raise HTTPException(status_code=404, detail="Doctor statement not found.")

        due = to_decimal(stmt["remaining_payable"])
        if payout_amt > due:
            raise HTTPException(status_code=409, detail=f"Payout amount ₹{payout_amt} exceeds remaining payable ₹{due}.")

        paid_old = to_decimal(stmt["paid_amount"])
        new_paid = quantize_dec(paid_old + payout_amt)
        new_due = quantize_dec(max(D_ZERO, due - payout_amt))
        new_status = "paid" if new_due <= D_ZERO else "partially_paid"
        dp_status = "paid" if new_due <= D_ZERO else "partial"

        cursor.execute(
            """
            UPDATE doctor_statements
            SET paid_amount = ?, remaining_payable = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (float(new_paid), float(new_due), new_status, statement_id)
        )

        # Record in doctor_payouts / doctor_payout_payments for historical compatibility
        cursor.execute(
            "SELECT id FROM doctor_payouts WHERE doctor_name = ? AND payout_month = ? LIMIT 1",
            (stmt["doctor_name"], stmt["period_month"])
        )
        dp_row = cursor.fetchone()
        if dp_row:
            payout_id = dp_row[0]
            cursor.execute(
                "UPDATE doctor_payouts SET paid_amount = paid_amount + ?, due_amount = ?, status = ? WHERE id = ?",
                (float(payout_amt), float(new_due), dp_status, payout_id)
            )
        else:
            cursor.execute(
                """
                INSERT INTO doctor_payouts (doctor_name, payout_month, amount, paid_amount, due_amount, status)
                VALUES (?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                (stmt["doctor_name"], stmt["period_month"], float(stmt["fees_earned"]), float(payout_amt), float(new_due), dp_status)
            )
            payout_id = cursor.fetchone()[0]

        cursor.execute(
            """
            INSERT INTO doctor_payout_payments (payout_id, amount, paid_date, payment_mode, transaction_ref, notes, cashier_session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (payout_id, float(payout_amt), p_date, mode, ref, f"Payout against {stmt['statement_no']}", session_id)
        )
        pay_rec_id = cursor.fetchone()[0]

        # If paid in cash, record in cashier drawer session
        if mode == "cash":
            cursor.execute(
                "UPDATE cashier_sessions SET cash_doctor_payouts = cash_doctor_payouts + ? WHERE id = ?",
                (float(payout_amt), session_id)
            )

        conn.commit()
        return {
            "success": True,
            "payout_no": f"PAY-{pay_rec_id:04d}",
            "amount": float(payout_amt),
            "remaining_payable": float(new_due),
            "status": new_status,
        }


# ==============================================================================
# 6. OVERVIEW, WORKLIST & REPORTING QUERIES
# ==============================================================================

OVERVIEW_CARDS = ("net_billed", "receipts", "refunds", "dues")
_IST_DAY = "DATE(timezone('Asia/Kolkata', CAST({col} AS timestamptz))) = DATE(?)"
_PATIENT = "COALESCE(NULLIF(TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.last_name, '')), ''), {fallback})"


def get_billing_overview_entries(db: Session, target_date: str, card: str):
    """Rows behind one Billing Overview card for the day (dues: all dates).

    net_billed: bills raised that day (any module).
    receipts:   every payment taken against a bill that day -- OP registration, lab, pharmacy,
                discharge and Billing's own receipts all write invoice_payments -- plus advance
                deposits (receipts not yet tied to a bill). Refund rows are excluded.
    refunds:    refunds paid that day: negative invoice payments (cancelled services) plus
                refund vouchers (advances returned).
    dues:       bills with a balance outstanding, all dates.
    """
    if card not in OVERVIEW_CARDS:
        raise HTTPException(status_code=400, detail="Unknown overview card.")
    paid_day = _IST_DAY.format(col="ip.created_at")
    receipt_day = _IST_DAY.format(col="fr.created_at")
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()
        if card == "net_billed":
            cursor.execute(
                f"""
                SELECT i.created_at AS at, i.patient_id, {_PATIENT.format(fallback="i.patient_name")} AS patient_name,
                       i.invoice_no AS reference, i.module AS detail,
                       COALESCE(NULLIF(TRIM(i.payment_mode), ''), NULLIF(TRIM(pm.mode), ''), CASE WHEN i.due_amount > 0 AND (i.paid_amount IS NULL OR i.paid_amount = 0) THEN 'Due' ELSE '-' END) AS payment_mode,
                       i.total_amount AS amount
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, STRING_AGG(DISTINCT payment_mode, ', ') AS mode
                    FROM invoice_payments
                    WHERE payment_mode IS NOT NULL AND TRIM(payment_mode) <> ''
                    GROUP BY invoice_id
                ) pm ON pm.invoice_id = i.id
                LEFT JOIN patients p ON p.patient_id = i.patient_id
                WHERE {_IST_DAY.format(col="i.created_at")}
                ORDER BY i.created_at DESC
                """, (target_date,))
        elif card in ("receipts", "refunds"):
            sign = ">" if card == "receipts" else "<"
            receipt_types = "('advance')" if card == "receipts" else "('refund_voucher')"
            cursor.execute(
                f"""
                SELECT ip.created_at AS at, i.patient_id, {_PATIENT.format(fallback="i.patient_name")} AS patient_name,
                       COALESCE(ip.receipt_no, i.invoice_no) AS reference,
                       i.module AS detail,
                       COALESCE(NULLIF(TRIM(ip.payment_mode), ''), '-') AS payment_mode,
                       ABS(ip.amount) AS amount
                FROM invoice_payments ip
                JOIN invoices i ON i.id = ip.invoice_id
                LEFT JOIN financial_receipts fr ON fr.id = ip.canonical_receipt_id
                LEFT JOIN patients p ON p.patient_id = i.patient_id
                WHERE {paid_day} AND ip.amount {sign} 0 AND COALESCE(fr.is_reversed, FALSE) = FALSE
                UNION ALL
                SELECT fr.created_at, fr.patient_id, {_PATIENT.format(fallback="fr.patient_id")},
                       fr.receipt_no,
                       CASE WHEN fr.receipt_type = 'advance' THEN 'Advance deposit' ELSE 'Refund voucher' END AS detail,
                       COALESCE(NULLIF(TRIM(rpl.mode), ''), '-') AS payment_mode,
                       fr.total_amount AS amount
                FROM financial_receipts fr
                LEFT JOIN (
                    SELECT receipt_id, STRING_AGG(DISTINCT payment_mode, ', ') AS mode
                    FROM receipt_payment_lines
                    WHERE payment_mode IS NOT NULL AND TRIM(payment_mode) <> ''
                    GROUP BY receipt_id
                ) rpl ON rpl.receipt_id = fr.id
                LEFT JOIN patients p ON p.patient_id = fr.patient_id
                WHERE {receipt_day} AND fr.receipt_type IN {receipt_types} AND fr.is_reversed = FALSE
                ORDER BY at DESC
                """, (target_date, target_date))
        else:
            cursor.execute(
                f"""
                SELECT i.created_at AS at, i.patient_id, {_PATIENT.format(fallback="i.patient_name")} AS patient_name,
                       i.invoice_no AS reference, i.module AS detail,
                       'Due' AS payment_mode,
                       i.due_amount AS amount
                FROM invoices i LEFT JOIN patients p ON p.patient_id = i.patient_id
                WHERE i.due_amount > 0
                ORDER BY i.created_at DESC
                """)
        rows = []
        for r in cursor.fetchall():
            r = dict(r)
            at = r.get("at")
            rows.append({
                "at": at.isoformat(sep=" ", timespec="minutes") if hasattr(at, "isoformat") else (str(at) if at else None),
                "patient_id": r.get("patient_id"),
                "patient_name": r.get("patient_name") or r.get("patient_id") or "Walk-in",
                "reference": r.get("reference"),
                "detail": r.get("detail"),
                "payment_mode": r.get("payment_mode") or "-",
                "amount": float(quantize_dec(to_decimal(r.get("amount")))),
            })
        return rows


def get_billing_overview_stats(db: Session, target_date: str = None, cashier: str = None, counter: str = None):
    if not target_date:
        target_date = current_ist_datetime().strftime("%Y-%m-%d")
    totals = {}
    for card in OVERVIEW_CARDS:
        totals[card] = sum((to_decimal(r["amount"]) for r in get_billing_overview_entries(db, target_date, card)), D_ZERO)
    return {
        "target_date": target_date,
        "net_billed": float(quantize_dec(totals["net_billed"])),
        "receipts_today": float(quantize_dec(totals["receipts"])),
        "refunds_today": float(quantize_dec(totals["refunds"])),
        "net_collections": float(quantize_dec(totals["receipts"] - totals["refunds"])),
        "outstanding_dues": float(quantize_dec(totals["dues"])),
    }


def get_billing_worklist(db: Session, tab: str = "pending_payments", department: str = None, visit_type: str = None, q: str = None):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # 1. Pending Payments Worklist
        pending_query = """
            SELECT i.id, i.invoice_no, i.patient_id, i.module, i.total_amount, i.paid_amount, i.due_amount,
                   i.payment_status, i.created_at, TRIM(p.name || ' ' || COALESCE(p.last_name, '')) as patient_name
            FROM invoices i
            LEFT JOIN patients p ON p.patient_id = i.patient_id
            WHERE i.due_amount > 0
        """
        params = []
        if department and department.lower() != "all departments":
            pending_query += " AND LOWER(i.module) = LOWER(?)"
            params.append(department)
        if q:
            pending_query += " AND (LOWER(p.name) LIKE ? OR LOWER(i.patient_id) LIKE ? OR LOWER(i.invoice_no) LIKE ?)"
            term = f"%{q.lower()}%"
            params.extend([term, term, term])

        pending_query += " ORDER BY i.created_at DESC LIMIT 50"
        cursor.execute(pending_query, tuple(params))
        pending_rows = cursor.fetchall()

        pending_payments = [{
            "id": r["id"],
            "invoice_no": r["invoice_no"],
            "patient_id": r["patient_id"],
            "patient_name": r["patient_name"] or r["patient_id"],
            "module": r["module"] or "OP",
            "service_desc": f"{r['module']} · Bill {r['invoice_no']}",
            "net_bill": float(to_decimal(r["total_amount"])),
            "applied": float(to_decimal(r["paid_amount"])),
            "balance": float(to_decimal(r["due_amount"])),
            "date": str(r["created_at"])[:16],
        } for r in pending_rows]

        # 2. Discharge Review Worklist (active admitted patients)
        cursor.execute(
            """
            SELECT a.id as admission_id, a.patient_id, a.admission_date, a.notes,
                   TRIM(p.name || ' ' || COALESCE(p.last_name, '')) as patient_name,
                   b.ward, b.room_no, b.bed_no
            FROM admissions a
            JOIN patients p ON p.patient_id = a.patient_id
            LEFT JOIN bed_allocations b ON b.admission_id = a.id AND b.status = 'active'
            WHERE a.discharge_date IS NULL
            ORDER BY a.admission_date DESC LIMIT 150
            """
        )
        discharge_rows = cursor.fetchall()
        discharge_review = [{
            "admission_id": f"IP-{r['admission_id']:04d}",
            "raw_id": r["admission_id"],
            "patient_id": r["patient_id"],
            "patient_name": r["patient_name"],
            "ward": r["ward"] or "General Ward",
            "bed_no": r["bed_no"] or "GW-01",
            "admission_date": str(r["admission_date"])[:16] if r["admission_date"] else None,
        } for r in discharge_rows]

        # 3. Recent Receipts
        cursor.execute(
            """
            SELECT fr.id, fr.receipt_no, fr.receipt_type, fr.total_amount, fr.created_at, fr.patient_id,
                   TRIM(p.name || ' ' || COALESCE(p.last_name, '')) as patient_name,
                   rpl.payment_mode
            FROM financial_receipts fr
            LEFT JOIN patients p ON p.patient_id = fr.patient_id
            LEFT JOIN receipt_payment_lines rpl ON rpl.receipt_id = fr.id
            ORDER BY fr.created_at DESC LIMIT 25
            """
        )
        rcp_rows = cursor.fetchall()
        recent_receipts = [{
            "id": r["id"],
            "receipt_no": r["receipt_no"],
            "time": datetime.fromisoformat(str(r["created_at"]).replace("Z", "")).strftime("%I:%M %p") if r["created_at"] else "-",
            "date": str(r["created_at"])[:10] if r["created_at"] else "-",
            "mode": (r["payment_mode"] or "Cash").upper(),
            "amount": float(to_decimal(r["total_amount"])),
            "patient_id": r["patient_id"],
            "patient_name": r["patient_name"] or r["patient_id"],
            "type": r["receipt_type"],
        } for r in rcp_rows]

        return {
            "pending_payments": pending_payments,
            "discharge_review": discharge_review,
            "recent_receipts": recent_receipts,
        }


def get_patient_bills_and_history(db: Session, patient_id_or_q: str):
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        q = patient_id_or_q.strip()
        like = f"%{q.lower()}%"

        # Find patient -- matches the full or a trailing-digits UHID (staff
        # often key in just what's printed on a receipt/wristband), first or
        # last name individually, the combined full name, or phone. An exact
        # UHID match always wins over a fuzzy one if both are present.
        cursor.execute(
            """
            SELECT * FROM patients
            WHERE LOWER(patient_id) = LOWER(?)
               OR patient_id LIKE ?
               OR LOWER(name) LIKE ?
               OR LOWER(COALESCE(last_name, '')) LIKE ?
               OR LOWER(TRIM(COALESCE(name, '') || ' ' || COALESCE(last_name, ''))) LIKE ?
               OR phone LIKE ?
            ORDER BY CASE WHEN LOWER(patient_id) = LOWER(?) THEN 0 ELSE 1 END, created_at DESC
            LIMIT 1
            """,
            (q, f"%{q}", like, like, like, f"%{q}%", q)
        )
        p_row = cursor.fetchone()

        if not p_row:
            # Not a patient match -- try it as a bill/invoice number instead,
            # since that's an explicitly supported search identifier here.
            cursor.execute(
                "SELECT patient_id FROM invoices WHERE invoice_no = ? OR invoice_no ILIKE ? ORDER BY created_at DESC LIMIT 1",
                (q, f"%{q}%")
            )
            inv_row = cursor.fetchone()
            if inv_row:
                cursor.execute("SELECT * FROM patients WHERE patient_id = ?", (inv_row["patient_id"],))
                p_row = cursor.fetchone()

        if not p_row:
            raise HTTPException(status_code=404, detail="Patient not found.")
        patient = dict(p_row)
        pid = patient["patient_id"]

        # Fetch all bills for patient
        cursor.execute(
            """
            SELECT * FROM invoices
            WHERE patient_id = ?
            ORDER BY created_at DESC
            """,
            (pid,)
        )
        invoices = [dict(i) for i in cursor.fetchall()]

        bills_list = []
        for inv in invoices:
            inv_id = inv["id"]
            tot = to_decimal(inv.get("total_amount"))
            paid = to_decimal(inv.get("paid_amount"))
            due = to_decimal(inv.get("due_amount"))

            # Fetch line items if pharmacy or lab
            items = []
            if inv.get("module") == "PHARMACY":
                cursor.execute(
                    "SELECT medicine_name as name, quantity, amount FROM pharmacy_sales WHERE invoice_id = ?",
                    (inv_id,)
                )
                items = [dict(r) for r in cursor.fetchall()]
            elif inv.get("module") in ("LAB", "DIAGNOSTICS", "RADIOLOGY"):
                cursor.execute(
                    "SELECT service_name as name, quantity, amount FROM diag_order_items WHERE discharge_invoice_id = ?",
                    (inv_id,)
                )
                items = [dict(r) for r in cursor.fetchall()]

            bills_list.append({
                "id": inv_id,
                "invoice_id": inv_id,
                "invoice_no": inv["invoice_no"],
                "module": inv.get("module") or "OP",
                "service_desc": f"{inv.get('module')} · {inv.get('invoice_no')}",
                "net_bill": float(tot),
                "total_amount": float(tot),
                "applied": float(paid),
                "paid_amount": float(paid),
                "balance": float(due),
                "due_amount": float(due),
                "status": inv.get("payment_status") or ("paid" if due <= 0 else "due"),
                "payment_status": inv.get("payment_status") or ("paid" if due <= 0 else "due"),
                "date": str(inv.get("created_at"))[:10],
                "items": items,
            })

        # Fetch recent payments for this patient
        cursor.execute(
            """
            SELECT fr.receipt_no, fr.created_at, fr.total_amount, rpl.payment_mode,
                   ria.invoice_id, i.invoice_no, i.module
            FROM financial_receipts fr
            LEFT JOIN receipt_payment_lines rpl ON rpl.receipt_id = fr.id
            LEFT JOIN receipt_invoice_allocations ria ON ria.receipt_id = fr.id
            LEFT JOIN invoices i ON i.id = ria.invoice_id
            WHERE fr.patient_id = ?
            ORDER BY fr.created_at DESC LIMIT 15
            """,
            (pid,)
        )
        recent_payments = []
        for r in cursor.fetchall():
            dt_str = str(r["created_at"])[:16] if r["created_at"] else "-"
            recent_payments.append({
                "receipt_no": r["receipt_no"],
                "date_time": dt_str,
                "service": f"{r['module'] or 'Bill'} ({r['invoice_no'] or 'Payment'})",
                "mode": (r["payment_mode"] or "Cash").upper(),
                "amount": float(to_decimal(r["total_amount"])),
            })

        return {
            "patient": {
                "patient_id": pid,
                "name": f"{patient.get('name', '')} {patient.get('last_name', '')}".strip() or pid,
                "uhid": pid,
                "phone": patient.get("phone"),
                "age": patient.get("age"),
                "gender": patient.get("gender"),
                "visit_date": current_ist_datetime().strftime("%d %b %Y"),
            },
            "bills": bills_list,
            "recent_payments": recent_payments,
        }


def get_reports_day_close_data(db: Session, target_date: str = None, cashier: str = None, counter: str = None):
    if not target_date:
        target_date = current_ist_datetime().strftime("%Y-%m-%d")

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        # Collections by payment method (Receipts, Refunds, Net)
        cursor.execute(
            """
            SELECT rpl.payment_mode, 
                   COALESCE(SUM(CASE WHEN fr.receipt_type IN ('bill_payment', 'advance') THEN rpl.amount ELSE 0 END), 0) as receipts,
                   COALESCE(SUM(CASE WHEN fr.receipt_type = 'refund_voucher' THEN rpl.amount ELSE 0 END), 0) as refunds
            FROM receipt_payment_lines rpl
            JOIN financial_receipts fr ON fr.id = rpl.receipt_id
            WHERE DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) = DATE(?)
              AND fr.is_reversed = FALSE
            GROUP BY rpl.payment_mode
            """,
            (target_date,)
        )
        mode_rows = cursor.fetchall()
        modes_map = {
            "cash": {"receipts": D_ZERO, "refunds": D_ZERO},
            "upi": {"receipts": D_ZERO, "refunds": D_ZERO},
            "card": {"receipts": D_ZERO, "refunds": D_ZERO},
        }
        for r in mode_rows:
            m = str(r[0] or "").lower()
            key = "cash" if "cash" in m else ("upi" if "upi" in m else ("card" if "card" in m else "other"))
            if key not in modes_map:
                modes_map[key] = {"receipts": D_ZERO, "refunds": D_ZERO}
            modes_map[key]["receipts"] += to_decimal(r[1])
            modes_map[key]["refunds"] += to_decimal(r[2])

        # Lab & Diagnostic collections don't flow through financial_receipts
        # at all -- diag invoices are paid via the older, separate
        # record_invoice_payment()/invoice_payments path, so without this
        # they were invisible to Day Close even though real cash/UPI/card
        # was collected for them. canonical_receipt_id IS NULL excludes the
        # compatibility rows billing-v2 (advances/discharge) already writes
        # into invoice_payments for its OWN receipts, which are already
        # counted above via financial_receipts -- without that filter this
        # would double-count those.
        cursor.execute(
            """
            SELECT ip.payment_mode, ip.amount
            FROM invoice_payments ip
            JOIN invoices i ON i.id = ip.invoice_id
            WHERE i.module IN ('LAB', 'RADIOLOGY', 'DIAGNOSTICS')
              AND ip.canonical_receipt_id IS NULL
              AND DATE(timezone('Asia/Kolkata', CAST(ip.created_at AS timestamptz))) = DATE(?)
            """,
            (target_date,)
        )
        lab_diag_receipts = D_ZERO
        lab_diag_refunds = D_ZERO
        for r in cursor.fetchall():
            m = str(r[0] or "").lower()
            key = "cash" if "cash" in m else ("upi" if "upi" in m else ("card" if "card" in m else "other"))
            if key not in modes_map:
                modes_map[key] = {"receipts": D_ZERO, "refunds": D_ZERO}
            amt = to_decimal(r[1])
            if amt >= D_ZERO:
                modes_map[key]["receipts"] += amt
                lab_diag_receipts += amt
            else:
                modes_map[key]["refunds"] += -amt
                lab_diag_refunds += -amt

        tot_receipts = sum(v["receipts"] for v in modes_map.values())
        tot_refunds = sum(v["refunds"] for v in modes_map.values())
        net_collections = quantize_dec(tot_receipts - tot_refunds)
        lab_diagnostic_net = quantize_dec(lab_diag_receipts - lab_diag_refunds)

        collections_breakdown = [
            {
                "method": "Cash",
                "receipts": float(modes_map["cash"]["receipts"]),
                "refunds": float(modes_map["cash"]["refunds"]),
                "net": float(quantize_dec(modes_map["cash"]["receipts"] - modes_map["cash"]["refunds"]))
            },
            {
                "method": "UPI",
                "receipts": float(modes_map["upi"]["receipts"]),
                "refunds": float(modes_map["upi"]["refunds"]),
                "net": float(quantize_dec(modes_map["upi"]["receipts"] - modes_map["upi"]["refunds"]))
            },
            {
                "method": "Card",
                "receipts": float(modes_map["card"]["receipts"]),
                "refunds": float(modes_map["card"]["refunds"]),
                "net": float(quantize_dec(modes_map["card"]["receipts"] - modes_map["card"]["refunds"]))
            },
        ]

        # Receipt Register
        cursor.execute(
            """
            SELECT fr.id, fr.receipt_no, fr.created_at, fr.total_amount, rpl.payment_mode
            FROM financial_receipts fr
            LEFT JOIN receipt_payment_lines rpl ON rpl.receipt_id = fr.id
            WHERE DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) = DATE(?)
            ORDER BY fr.created_at DESC LIMIT 30
            """,
            (target_date,)
        )
        receipt_register = []
        for r in cursor.fetchall():
            time_str = datetime.fromisoformat(str(r["created_at"]).replace("Z", "")).strftime("%I:%M %p") if r["created_at"] else "-"
            receipt_register.append({
                "receipt_no": r["receipt_no"],
                "time": time_str,
                "payment_mode": (r["payment_mode"] or "Cash").upper(),
                "amount": float(to_decimal(r["total_amount"])),
            })

        # Latest cashier session
        cursor.execute("SELECT * FROM cashier_sessions ORDER BY opened_at DESC LIMIT 1")
        latest_session = cursor.fetchone()
        session_data = None
        if latest_session:
            session_data = get_cashier_session_summary(db, latest_session["id"])

        return {
            "target_date": target_date,
            "kpis": {
                "receipts": float(tot_receipts),
                "refunds": float(tot_refunds),
                "net_collections": float(net_collections),
                "lab_diagnostic_collections": float(lab_diagnostic_net),
            },
            "collections_breakdown": collections_breakdown,
            "receipt_register": receipt_register,
            "session": session_data,
        }


# ==============================================================================
# 7. EXTENDED REPORT FUNCTIONS
# ==============================================================================

def get_monthly_summary(db: Session, period_month: str = None):
    """
    Daily breakdown of collections for a calendar month.
    period_month: 'YYYY-MM' string. Defaults to current month.
    Returns array of {date, receipts, refunds, net_collections, transactions}.
    """
    if not period_month:
        period_month = current_ist_datetime().strftime("%Y-%m")

    # Validate format
    try:
        month_start = date.fromisoformat(period_month + "-01")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid period_month. Expected YYYY-MM.")

    # Last day of month
    if month_start.month == 12:
        month_end = month_start.replace(year=month_start.year + 1, month=1, day=1) - timedelta(days=1)
    else:
        month_end = month_start.replace(month=month_start.month + 1, day=1) - timedelta(days=1)

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) AS day,
                COALESCE(SUM(CASE WHEN fr.receipt_type IN ('bill_payment','advance') THEN fr.total_amount ELSE 0 END), 0) AS receipts,
                COALESCE(SUM(CASE WHEN fr.receipt_type = 'refund_voucher' THEN fr.total_amount ELSE 0 END), 0) AS refunds,
                COUNT(fr.id) AS transactions
            FROM financial_receipts fr
            WHERE fr.is_reversed = FALSE
              AND DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) >= DATE(?)
              AND DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) <= DATE(?)
            GROUP BY 1
            ORDER BY 1 ASC
            """,
            (str(month_start), str(month_end))
        )
        rows = cursor.fetchall()

        total_receipts = D_ZERO
        total_refunds = D_ZERO
        daily_data = []
        for r in rows:
            rec = to_decimal(r[1])
            ref = to_decimal(r[2])
            net = quantize_dec(rec - ref)
            total_receipts += rec
            total_refunds += ref
            daily_data.append({
                "date": str(r[0]),
                "receipts": float(rec),
                "refunds": float(ref),
                "net_collections": float(net),
                "transactions": int(r[3]),
            })

        # Month-to-date totals from invoices
        cursor.execute(
            """
            SELECT COALESCE(SUM(total_amount), 0)
            FROM invoices
            WHERE DATE(timezone('Asia/Kolkata', CAST(created_at AS timestamptz))) >= DATE(?)
              AND DATE(timezone('Asia/Kolkata', CAST(created_at AS timestamptz))) <= DATE(?)
            """,
            (str(month_start), str(month_end))
        )
        net_billed = to_decimal(cursor.fetchone()[0])

        return {
            "period_month": period_month,
            "month_start": str(month_start),
            "month_end": str(month_end),
            "totals": {
                "net_billed": float(net_billed),
                "receipts": float(total_receipts),
                "refunds": float(total_refunds),
                "net_collections": float(quantize_dec(total_receipts - total_refunds)),
            },
            "daily_breakdown": daily_data,
        }


def get_department_report(db: Session, target_date: str = None, end_date: str = None):
    """
    Receipts and collections grouped by invoice module (department) for a date range.
    """
    if not target_date:
        target_date = current_ist_datetime().strftime("%Y-%m-%d")
    if not end_date:
        end_date = target_date

    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                COALESCE(i.module, 'OP') AS department,
                COALESCE(SUM(ria.allocated_amount), 0) AS collected,
                COUNT(DISTINCT i.id) AS invoice_count,
                COALESCE(SUM(i.due_amount), 0) AS outstanding
            FROM invoices i
            LEFT JOIN receipt_invoice_allocations ria ON ria.invoice_id = i.id
            LEFT JOIN financial_receipts fr ON fr.id = ria.receipt_id
              AND fr.is_reversed = FALSE
              AND DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) >= DATE(?)
              AND DATE(timezone('Asia/Kolkata', CAST(fr.created_at AS timestamptz))) <= DATE(?)
            WHERE DATE(timezone('Asia/Kolkata', CAST(i.created_at AS timestamptz))) >= DATE(?)
              AND DATE(timezone('Asia/Kolkata', CAST(i.created_at AS timestamptz))) <= DATE(?)
            GROUP BY 1
            ORDER BY collected DESC
            """,
            (target_date, end_date, target_date, end_date)
        )
        rows = cursor.fetchall()

        departments = []
        total_collected = D_ZERO
        total_outstanding = D_ZERO
        for r in rows:
            col = to_decimal(r[1])
            out = to_decimal(r[3])
            total_collected += col
            total_outstanding += out
            departments.append({
                "department": str(r[0]),
                "collected": float(col),
                "invoice_count": int(r[2]),
                "outstanding": float(out),
            })

        return {
            "date_range": {"from": target_date, "to": end_date},
            "totals": {
                "collected": float(total_collected),
                "outstanding": float(total_outstanding),
            },
            "by_department": departments,
        }


def get_day_close_history(db: Session, limit: int = 30):
    """
    List of completed cashier sessions with full drawer reconciliation for historical review.
    """
    with legacy_sql.get_connection(db) as conn:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT *
            FROM cashier_sessions
            ORDER BY opened_at DESC
            LIMIT ?
            """,
            (limit,)
        )
        sessions = [dict(s) for s in cursor.fetchall()]

        result = []
        for s in sessions:
            opening = to_decimal(s.get("opening_float"))
            received = to_decimal(s.get("cash_received"))
            refunded = to_decimal(s.get("cash_refunded"))
            handover = to_decimal(s.get("cash_handover"))
            movements = to_decimal(s.get("cash_movements"))
            payouts = to_decimal(s.get("cash_doctor_payouts"))
            expected = quantize_dec(opening + received - refunded - handover + movements - payouts)
            counted = to_decimal(s.get("counted_cash"))
            variance = to_decimal(s.get("variance")) if s.get("variance") is not None else (quantize_dec(counted - expected) if s.get("status") == "closed" else None)

            result.append({
                "id": s["id"],
                "session_code": s.get("session_code"),
                "cashier_name": s.get("cashier_name"),
                "counter_name": s.get("counter_name"),
                "status": s.get("status"),
                "opened_at": str(s.get("opened_at", ""))[:16],
                "closed_at": str(s.get("closed_at", ""))[:16] if s.get("closed_at") else None,
                "opening_float": float(opening),
                "cash_received": float(received),
                "cash_refunded": float(refunded),
                "cash_handover": float(handover),
                "cash_movements": float(movements),
                "cash_doctor_payouts": float(payouts),
                "expected_cash": float(expected),
                "counted_cash": float(counted) if s.get("counted_cash") is not None else None,
                "variance": float(variance) if variance is not None else None,
                "notes": s.get("notes") or s.get("close_notes") or "",
            })

        return {"sessions": result}


