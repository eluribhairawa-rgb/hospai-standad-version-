"""Inactivity timeout and single-login behaviour against a real PostgreSQL database.

Requests go through the real FastAPI app (middleware, cookies, dependencies and the
sessions table) via a minimal in-process ASGI client, so nothing listens on a port.

Covers: active use sliding the expiry, background polling not extending it, idle
expiry enforced by the server, activity unable to revive an expired session, login
on another device revoking the previous session, and concurrent requests/logins.

Skipped unless TEST_DATABASE_URL is set, and refuses to run unless the database name
contains "test", so it can never touch the live hospital database.

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \\
        .venv/bin/python -m unittest tests.test_session_timeout_pg -v
"""
import asyncio
import json
import os
import sys
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _test_db_guard():
    if not TEST_DATABASE_URL:
        return "TEST_DATABASE_URL is not set"
    import database
    name = database.engine.url.database or ""
    if "test" not in name.lower():
        return f"refusing to run against database '{name}' (name must contain 'test')"
    return None


SKIP_REASON = _test_db_guard()

if not SKIP_REASON:
    from sqlalchemy import text

    import database
    import schema_setup
    import security
    from main import app

PASSWORD = "Passw0rd!x"
PROTECTED = "/api/insurance-providers"  # any route behind get_current_user


def call(method, path, token=None, headers=None, body=None):
    """Run one request through the ASGI app; returns (status, headers, json, set_cookie)."""
    raw_headers = [(b"host", b"testserver")]
    for key, value in (headers or {}).items():
        raw_headers.append((key.lower().encode(), value.encode()))
    if token:
        raw_headers.append((b"cookie", f"{security.SESSION_COOKIE_NAME}={token}".encode()))
    payload = json.dumps(body).encode() if body is not None else b""
    if body is not None:
        raw_headers.append((b"content-type", b"application/json"))
    path_only, _, query = path.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
        "scheme": "http", "path": path_only, "raw_path": path_only.encode(), "query_string": query.encode(),
        "headers": raw_headers, "client": ("127.0.0.1", 50000), "server": ("testserver", 80), "root_path": "",
    }
    messages, sent = [], {"done": False}

    async def receive():
        if not sent["done"]:
            sent["done"] = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await asyncio.sleep(3600)

    async def send(message):
        messages.append(message)

    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    resp_headers = {}
    cookies = []
    for key, value in start["headers"]:
        k, v = key.decode().lower(), value.decode()
        if k == "set-cookie":
            cookies.append(v)
        resp_headers[k] = v
    data = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    try:
        parsed = json.loads(data) if data else None
    except ValueError:
        parsed = None
    return start["status"], resp_headers, parsed, cookies


def naive_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class SessionTimeoutPgTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        db = database.SessionLocal()
        try:
            cls.hospital_id = security.resolve_hospital_id(db)
            cls.username = f"sessiontest_{uuid.uuid4().hex[:8]}"
            res = security.signup_employee(db, {
                "username": cls.username, "password": PASSWORD, "full_name": "Session Test",
                "job_role": "Nurse", "user_type": "normal", "module_access": ["dashboard", "patients"],
            }, hospital_id=cls.hospital_id)
            assert res["success"], res
            cls.user_id = db.execute(text("SELECT id FROM users WHERE username = :u"), {"u": cls.username}).scalar()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        with database.engine.begin() as conn:
            conn.execute(text("DELETE FROM sessions WHERE user_id = :u"), {"u": cls.user_id})
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": cls.user_id})

    # ------------------------------------------------------------ helpers --

    def login(self):
        status, headers, data, cookies = call("POST", "/api/auth/login", body={"username": self.username, "password": PASSWORD})
        self.assertEqual(status, 200, data)
        cookie = SimpleCookie()
        cookie.load(cookies[0])
        morsel = cookie[security.SESSION_COOKIE_NAME]
        return morsel.value, morsel, headers, data

    def expires_at(self):
        with database.engine.connect() as conn:
            return conn.execute(text("SELECT expires_at FROM sessions WHERE user_id = :u"), {"u": self.user_id}).scalar()

    def session_count(self):
        with database.engine.connect() as conn:
            return conn.execute(text("SELECT COUNT(*) FROM sessions WHERE user_id = :u"), {"u": self.user_id}).scalar()

    def set_expiry(self, delta):
        with database.engine.begin() as conn:
            conn.execute(text("UPDATE sessions SET expires_at = :e WHERE user_id = :u"),
                         {"e": naive_utc_now() + delta, "u": self.user_id})

    # -------------------------------------------------------------- tests --

    def test_login_uses_idle_timeout_not_fixed_cookie_lifetime(self):
        token, morsel, headers, data = self.login()
        self.assertFalse(morsel["max-age"], "cookie must not carry a fixed lifetime; the server enforces idle expiry")
        self.assertTrue(morsel["httponly"])
        self.assertEqual(headers.get("x-session-refreshed"), "1")
        self.assertEqual(data["user"]["session_ttl_seconds"], security.SESSION_TTL_SECONDS)
        remaining = (self.expires_at() - naive_utc_now()).total_seconds()
        self.assertAlmostEqual(remaining, security.SESSION_TTL_SECONDS, delta=5)

    def test_active_use_slides_expiry_indefinitely(self):
        token, *_ = self.login()
        # Simulate a session that has been in use well past the TTL and is near expiry.
        for _ in range(3):
            self.set_expiry(timedelta(seconds=30))
            status, headers, data, _ = call("GET", PROTECTED, token=token)
            self.assertEqual(status, 200, data)
            self.assertEqual(headers.get("x-session-refreshed"), "1")
            remaining = (self.expires_at() - naive_utc_now()).total_seconds()
            self.assertAlmostEqual(remaining, security.SESSION_TTL_SECONDS, delta=5)

    def test_background_polling_does_not_extend_session(self):
        token, *_ = self.login()
        self.set_expiry(timedelta(seconds=60))
        before = self.expires_at()
        status, headers, data, _ = call("GET", PROTECTED, token=token, headers={"X-Background-Refresh": "1"})
        self.assertEqual(status, 200, data)  # still authorised...
        self.assertNotIn("x-session-refreshed", headers)
        self.assertEqual(self.expires_at(), before)  # ...but the idle clock keeps running

    def test_idle_session_is_rejected_by_server(self):
        token, *_ = self.login()
        self.set_expiry(timedelta(seconds=-1))  # 20 minutes passed with no activity
        status, _, _, _ = call("GET", PROTECTED, token=token)
        self.assertEqual(status, 401)
        self.assertEqual(self.session_count(), 0, "expired session row must be removed")

    def test_activity_cannot_revive_expired_session(self):
        token, *_ = self.login()
        self.set_expiry(timedelta(seconds=-1))
        # The frontend keep-alive and a background poll both arrive after expiry.
        status, _, data, _ = call("GET", "/api/auth/session", token=token)
        self.assertEqual(status, 200)
        self.assertIsNone(data["user"])
        status, _, _, _ = call("GET", PROTECTED, token=token, headers={"X-Background-Refresh": "1"})
        self.assertEqual(status, 401)

    def test_keepalive_extends_session(self):
        token, *_ = self.login()
        self.set_expiry(timedelta(seconds=90))  # warning is showing; user clicks "Continue session"
        status, headers, data, _ = call("GET", "/api/auth/session", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["username"], self.username)
        self.assertEqual(headers.get("x-session-refreshed"), "1")
        remaining = (self.expires_at() - naive_utc_now()).total_seconds()
        self.assertAlmostEqual(remaining, security.SESSION_TTL_SECONDS, delta=5)

    def test_login_on_another_device_invalidates_previous_session(self):
        first, *_ = self.login()
        second, *_ = self.login()
        self.assertNotEqual(first, second)
        self.assertEqual(call("GET", PROTECTED, token=first)[0], 401)
        self.assertEqual(call("GET", PROTECTED, token=second)[0], 200)
        self.assertEqual(self.session_count(), 1)

    def test_logout_revokes_session(self):
        token, *_ = self.login()
        self.assertEqual(call("POST", "/api/auth/logout", token=token)[0], 200)
        self.assertEqual(call("GET", PROTECTED, token=token)[0], 401)

    def test_concurrent_requests_on_valid_session(self):
        token, *_ = self.login()
        statuses, errors = [], []

        def worker():
            try:
                statuses.append(call("GET", PROTECTED, token=token)[0])
            except Exception as exc:  # pragma: no cover - surfaced by the assertion below
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker) for _ in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors, errors)
        self.assertEqual(statuses, [200] * 16)
        self.assertEqual(self.session_count(), 1)

    def test_concurrent_requests_while_signing_in_elsewhere(self):
        """Requests racing a login on another device get 200 or 401, never a 500."""
        old_token, *_ = self.login()
        statuses, errors = [], []

        def request_worker():
            try:
                for _ in range(5):
                    statuses.append(call("GET", PROTECTED, token=old_token)[0])
            except Exception as exc:  # pragma: no cover
                errors.append(repr(exc))

        threads = [threading.Thread(target=request_worker) for _ in range(8)]
        for t in threads:
            t.start()
        new_token, *_ = self.login()
        for t in threads:
            t.join()
        self.assertFalse(errors, errors)
        self.assertTrue(set(statuses) <= {200, 401}, statuses)
        self.assertEqual(call("GET", PROTECTED, token=old_token)[0], 401)
        self.assertEqual(call("GET", PROTECTED, token=new_token)[0], 200)

    def test_concurrent_requests_at_expiry(self):
        token, *_ = self.login()
        self.set_expiry(timedelta(milliseconds=300))
        stop_at = time.monotonic() + 0.8  # workers keep polling across the expiry instant
        statuses, errors = [], []

        def worker():
            try:
                while time.monotonic() < stop_at:
                    statuses.append(call("GET", PROTECTED, token=token, headers={"X-Background-Refresh": "1"})[0])
            except Exception as exc:  # pragma: no cover
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors, errors)
        self.assertTrue(set(statuses) <= {200, 401}, statuses)
        self.assertEqual(call("GET", PROTECTED, token=token)[0], 401)

    def test_simultaneous_logins_leave_exactly_one_session(self):
        tokens, errors = [], []

        def worker():
            try:
                tokens.append(self.login()[0])
            except Exception as exc:  # pragma: no cover
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors, errors)
        self.assertEqual(self.session_count(), 1)
        valid = [t for t in tokens if call("GET", PROTECTED, token=t)[0] == 200]
        self.assertEqual(len(valid), 1)


if __name__ == "__main__":
    unittest.main()
