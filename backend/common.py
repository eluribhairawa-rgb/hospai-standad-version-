import base64
import hashlib
import hmac
import json
import os
from urllib import error as urllib_error
from urllib import request as urllib_request

from fastapi import HTTPException
from sqlalchemy.orm import Session

import legacy_queries as lq

RAZORPAY_KEY_ID = (os.getenv("RAZORPAY_KEY_ID") or "").strip()
RAZORPAY_KEY_SECRET = (os.getenv("RAZORPAY_KEY_SECRET") or "").strip()
RAZORPAY_API_BASE = "https://api.razorpay.com/v1"


def row_to_dict(row):
    if row is None:
        return None
    data = dict(row.items()) if hasattr(row, "items") else dict(row)
    module_access = data.get("module_access")
    if isinstance(module_access, str):
        try:
            parsed = json.loads(module_access)
            if isinstance(parsed, list):
                data["module_access"] = parsed
        except json.JSONDecodeError:
            data["module_access"] = []
    return data


def rows_to_dicts(rows):
    return [row_to_dict(row) for row in rows]


def validate_required_fields(payload: dict, fields: list[str]):
    missing = [f for f in fields if payload.get(f) in (None, "")]
    if missing:
        raise HTTPException(status_code=400, detail={"error": "Missing required fields", "missing": missing})


def log_audit_event(db: Session, user: dict | None, request_ip: str | None, action, module_name, entity_key=None, payload=None):
    actor = (user or {}).get("username")
    serialized_payload = None
    if payload is not None:
        try:
            serialized_payload = json.dumps(payload, separators=(",", ":"), default=str)
        except Exception:
            serialized_payload = str(payload)
    lq.add_audit_log(db, {
        "actor_username": actor,
        "action": action,
        "module_name": module_name,
        "entity_key": entity_key,
        "payload": serialized_payload,
        "ip_address": request_ip,
    })


def is_razorpay_configured():
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


def require_razorpay_configured():
    if not is_razorpay_configured():
        raise HTTPException(status_code=503, detail="Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.")


def to_amount_paise(value):
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    if amount <= 0:
        return None
    return int(round(amount * 100))


def _razorpay_auth_header():
    encoded = base64.b64encode(f"{RAZORPAY_KEY_ID}:{RAZORPAY_KEY_SECRET}".encode("utf-8")).decode("ascii")
    return f"Basic {encoded}"


def create_razorpay_order(amount_paise, currency="INR", receipt=None, notes=None):
    payload = {"amount": int(amount_paise), "currency": currency or "INR"}
    if receipt:
        payload["receipt"] = str(receipt)
    if isinstance(notes, dict) and notes:
        payload["notes"] = notes

    req = urllib_request.Request(
        f"{RAZORPAY_API_BASE}/orders",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": _razorpay_auth_header(), "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {}
        message = (
            payload.get("error", {}).get("description")
            or payload.get("error", {}).get("code")
            or body
            or "Razorpay order creation failed."
        )
        raise RuntimeError(message) from exc
    except Exception as exc:
        raise RuntimeError("Unable to reach Razorpay.") from exc


def verify_razorpay_signature(order_id, payment_id, signature):
    signed_payload = f"{order_id}|{payment_id}".encode("utf-8")
    expected = hmac.new(RAZORPAY_KEY_SECRET.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature or ""))


def normalize_payment_mode(value):
    allowed_modes = {"cash", "card", "upi", "bank"}
    mode = (value or "").strip().lower()
    return mode if mode in allowed_modes else "upi"


def normalize_billing_module(value):
    text = str(value or "").strip().lower()
    if "pharm" in text or "medicine" in text:
        return "PHARMACY"
    if "lab" in text or "diagnostic" in text or "test" in text:
        return "LAB"
    if text == "ip" or "ipd" in text or "admission" in text:
        return "IP"
    return "OP"


def normalize_department_name(value):
    normalized = " ".join(str(value or "").strip().split())
    if not normalized:
        raise HTTPException(status_code=400, detail="department_name is required")
    if len(normalized) > 120:
        raise HTTPException(status_code=400, detail="department_name must be at most 120 characters")
    return normalized


def client_ip(request):
    return request.headers.get("X-Forwarded-For") or (request.client.host if request.client else None)
