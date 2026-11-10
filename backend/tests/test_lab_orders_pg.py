"""Lab order service types and home-visit routing against a real PostgreSQL database.

Skipped unless TEST_DATABASE_URL is set, and refuses to run unless the database name
contains "test", so it can never touch the live hospital database.

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest tests.test_lab_orders_pg -v
"""
import os
import sys
import unittest
import uuid
from types import SimpleNamespace

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
    from fastapi import HTTPException
    from sqlalchemy import text

    import database
    import diag_service_types as dst
    import legacy_queries as lq
    import schema_setup
    from legacy_sql import get_connection
    from routers import diagnostics as diag_api
    from routers import lab_orders as api


REQ = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
TECH = {"username": "test_tech"}


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class LabRoutingDbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        cls.tag = uuid.uuid4().hex[:8].upper()
        db = cls.db
        cls.patient_id = f"TLO-{cls.tag}"
        db.execute(text("INSERT INTO patients (patient_id, name, last_name) VALUES (:p, 'Asha', 'Rao')"), {"p": cls.patient_id})
        cls.appointment_id = db.execute(text(
            "INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status) "
            "VALUES (:p, 'Asha Rao', 'OP', CURRENT_TIMESTAMP, 1, 'scheduled') RETURNING id"), {"p": cls.patient_id}).scalar()
        cls.vendor_a = db.execute(text("INSERT INTO lab_vendors (vendor_name) VALUES (:n) RETURNING id"), {"n": f"Partner A {cls.tag}"}).scalar()
        cls.vendor_b = db.execute(text("INSERT INTO lab_vendors (vendor_name) VALUES (:n) RETURNING id"), {"n": f"Partner B {cls.tag}"}).scalar()
        db.commit()
        cls.cbc = lq.create_diag_service(db, {"code": f"CBC-{cls.tag}", "name": "CBC", "service_type": "LAB", "rate": 400})
        cls.vitd = lq.create_diag_service(db, {"code": f"VITD-{cls.tag}", "name": "Vitamin D", "service_type": "LAB", "rate": 1500})
        cls.tsh = lq.create_diag_service(db, {"code": f"TSH-{cls.tag}", "name": "TSH", "service_type": "LAB", "rate": 350})
        cls.xray = lq.create_diag_service(db, {"code": f"XR-{cls.tag}", "name": "Chest X-ray", "service_type": "IMAGING", "rate": 500})
        cls.sysmex = lq.create_diag_equipment(db, {"asset_id": f"SYS-{cls.tag}", "name": f"Sysmex {cls.tag}"})
        cls.cobas = lq.create_diag_equipment(db, {"asset_id": f"COB-{cls.tag}", "name": f"Cobas {cls.tag}"})

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def setUp(self):
        self.db.rollback()

    # ------------------------------------------------------------------ helpers --

    def call(self, fn, *args, **kwargs):
        return fn(*args, db=self.db, **kwargs)

    def assertRejected(self, fn, *args, **kwargs):
        with self.assertRaises((ValueError, HTTPException)) as ctx:
            self.call(fn, *args, **kwargs)
        self.db.rollback()
        return ctx.exception

    def confirmed_order_as(self, service_type, *service_ids, outsource_vendor_id=None):
        """Phase 1: order creation for the new types arrives in phase 2, so create an
        in-house order and switch its type directly."""
        payload = {"patient_id": self.patient_id, "encounter_type": "OP", "appointment_id": self.appointment_id,
                   "items": [{"service_id": s} for s in service_ids]}
        order_id = self.call(diag_api.diag_orders_create, request=REQ, payload=payload, user=TECH)["order_id"]
        self.db.execute(text("UPDATE diag_orders SET service_type = :t, outsource_vendor_id = :v WHERE id = :id"),
                        {"t": service_type, "v": outsource_vendor_id, "id": order_id})
        self.db.commit()
        self.call(diag_api.diag_order_confirm, order_id, request=REQ, user=TECH)
        return {i["service_id"]: i["id"] for i in lq.get_diag_order(self.db, order_id)["items"]}

    def route(self, item_id):
        with get_connection(self.db) as conn:
            outcome = dst.route_item(conn.cursor(), item_id, "test_tech")
            conn.commit()
        return outcome

    def referrals(self, item_id):
        return self.db.execute(text("SELECT vendor_id, received_report_at FROM diag_external_referrals WHERE order_item_id = :i"),
                               {"i": item_id}).fetchall()

    def set_status(self, equipment_id, status):
        self.db.execute(text("UPDATE diag_equipment SET operational_status = :s WHERE id = :id"), {"s": status, "id": equipment_id})
        self.db.commit()

    def open_hold(self, equipment_id, scope, service_id=None):
        run_id = self.db.execute(text(
            "INSERT INTO diag_qc_runs (equipment_id, service_id, outcome) VALUES (:e, :s, 'failed') RETURNING id"),
            {"e": equipment_id, "s": service_id}).scalar()
        hold_id = self.db.execute(text(
            "INSERT INTO diag_qc_holds (qc_run_id, equipment_id, service_id, scope, status) VALUES (:r, :e, :s, :sc, 'open') RETURNING id"),
            {"r": run_id, "e": equipment_id, "s": service_id, "sc": scope}).scalar()
        self.db.commit()
        return hold_id

    def release_hold(self, hold_id):
        self.db.execute(text("UPDATE diag_qc_holds SET status = 'released' WHERE id = :h"), {"h": hold_id})
        self.db.commit()

    # ---------------------------------------------------- catalogue routing setup --

    def test_service_routing_round_trip_and_validation(self):
        out = self.call(api.diag_service_routing_update, self.tsh, request=REQ, user=TECH,
                        payload={"equipment_ids": [self.cobas, self.sysmex, self.cobas], "preferred_vendor_id": self.vendor_a})
        self.assertEqual(sorted(e["id"] for e in out["equipment"]), sorted([self.cobas, self.sysmex]))
        self.assertEqual(out["preferred_vendor_id"], self.vendor_a)
        # Replacing the set removes old links.
        out = self.call(api.diag_service_routing_update, self.tsh, request=REQ, user=TECH,
                        payload={"equipment_ids": [self.sysmex], "preferred_vendor_id": None})
        self.assertEqual([e["id"] for e in out["equipment"]], [self.sysmex])
        self.assertIsNone(out["preferred_vendor_id"])
        self.assertRejected(api.diag_service_routing_update, self.tsh, request=REQ, user=TECH, payload={"equipment_ids": [999999999]})
        self.assertRejected(api.diag_service_routing_update, self.tsh, request=REQ, user=TECH,
                            payload={"equipment_ids": [], "preferred_vendor_id": 999999999})
        self.assertRejected(api.diag_service_routing_update, self.xray, request=REQ, user=TECH, payload={"equipment_ids": [self.sysmex]})
        self.call(api.diag_service_routing_update, self.tsh, request=REQ, user=TECH, payload={"equipment_ids": []})

    # ---------------------------------------------------------------- routing --

    def test_home_visit_routes_by_equipment_availability(self):
        self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": [self.sysmex]})
        self.call(api.diag_service_routing_update, self.vitd, request=REQ, user=TECH,
                  payload={"equipment_ids": [self.cobas], "preferred_vendor_id": self.vendor_a})
        hold = self.open_hold(self.cobas, "assay", self.vitd)
        try:
            items = self.confirmed_order_as("HOME_VISIT", self.cbc, self.vitd, self.tsh, self.xray)
            cbc, vitd, tsh = self.route(items[self.cbc]), self.route(items[self.vitd]), self.route(items[self.tsh])
            self.assertEqual(cbc["routing"], dst.IN_HOUSE)
            self.assertEqual(tsh["routing"], dst.IN_HOUSE)  # no equipment linked -> in-house
            self.assertEqual((vitd["routing"], vitd["vendor_id"]), (dst.OUTSOURCED, self.vendor_a))
            self.assertIn("QC hold for this test", vitd["reason"])
            self.assertIsNone(self.route(items[self.xray]))  # imaging is never routed
            self.assertEqual([r.vendor_id for r in self.referrals(items[self.vitd])], [self.vendor_a])
            self.assertEqual(self.referrals(items[self.cbc]), [])
            # Idempotent: routing again doesn't re-decide or add a second referral, even once the hold clears.
            self.release_hold(hold)
            again = self.route(items[self.vitd])
            self.assertEqual(again["routing"], dst.OUTSOURCED)
            self.assertEqual(len(self.referrals(items[self.vitd])), 1)
        finally:
            self.release_hold(hold)
            self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": []})
            self.call(api.diag_service_routing_update, self.vitd, request=REQ, user=TECH, payload={"equipment_ids": []})

    def test_assay_hold_on_other_test_does_not_block(self):
        self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": [self.cobas]})
        hold = self.open_hold(self.cobas, "assay", self.vitd)  # hold is for Vitamin D, not CBC
        try:
            items = self.confirmed_order_as("HOME_VISIT", self.cbc)
            self.assertEqual(self.route(items[self.cbc])["routing"], dst.IN_HOUSE)
        finally:
            self.release_hold(hold)
            self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": []})

    def test_machine_down_without_preferred_vendor_waits_then_staff_assign(self):
        self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": [self.sysmex]})
        self.set_status(self.sysmex, "down")
        try:
            items = self.confirmed_order_as("HOME_VISIT", self.cbc)
            outcome = self.route(items[self.cbc])
            self.assertEqual(outcome["routing"], dst.PENDING_VENDOR)
            pending = self.call(api.diag_pending_vendor_items, user=TECH)["items"]
            self.assertIn(items[self.cbc], [p["item_id"] for p in pending])
            self.assertEqual(self.referrals(items[self.cbc]), [])
            self.call(api.diag_item_assign_vendor, items[self.cbc], request=REQ, user=TECH, payload={"vendor_id": self.vendor_b})
            self.assertEqual([r.vendor_id for r in self.referrals(items[self.cbc])], [self.vendor_b])
            pending = self.call(api.diag_pending_vendor_items, user=TECH)["items"]
            self.assertNotIn(items[self.cbc], [p["item_id"] for p in pending])
            # Already routed: can't be reassigned through this endpoint.
            self.assertRejected(api.diag_item_assign_vendor, items[self.cbc], request=REQ, user=TECH, payload={"vendor_id": self.vendor_a})
        finally:
            self.set_status(self.sysmex, "ready")
            self.call(api.diag_service_routing_update, self.cbc, request=REQ, user=TECH, payload={"equipment_ids": []})

    def test_outsourcing_order_uses_order_vendor_and_item_override(self):
        items = self.confirmed_order_as("OUTSOURCING", self.cbc, self.tsh, outsource_vendor_id=self.vendor_a)
        # Override one test's partner lab before the sample is received.
        self.call(api.diag_item_assign_vendor, items[self.tsh], request=REQ, user=TECH, payload={"vendor_id": self.vendor_b})
        self.assertEqual(self.route(items[self.cbc])["vendor_id"], self.vendor_a)
        self.assertEqual(self.route(items[self.tsh])["vendor_id"], self.vendor_b)
        self.assertEqual([r.vendor_id for r in self.referrals(items[self.tsh])], [self.vendor_b])

    def test_in_house_orders_are_not_routed(self):
        items = self.confirmed_order_as("IN_HOUSE", self.cbc)
        self.assertIsNone(self.route(items[self.cbc]))
        row = self.db.execute(text("SELECT routing FROM diag_order_items WHERE id = :i"), {"i": items[self.cbc]}).fetchone()
        self.assertIsNone(row.routing)

    # ---------------------------------------------------- vendor costs + settings --

    def test_vendor_rates_upsert_margin_and_delete(self):
        self.call(api.diag_vendor_rate_save, request=REQ, user=TECH, payload={"vendor_id": self.vendor_a, "service_id": self.vitd, "cost": 900})
        self.call(api.diag_vendor_rate_save, request=REQ, user=TECH, payload={"vendor_id": self.vendor_a, "service_id": self.vitd, "cost": "850.5"})
        rates = self.call(api.diag_vendor_rates_list, vendor_id=self.vendor_a, service_id=self.vitd, user=TECH)["rates"]
        self.assertEqual(len(rates), 1)
        self.assertEqual((rates[0]["cost"], rates[0]["patient_rate"], round(rates[0]["margin"], 2)), (850.5, 1500, 649.5))
        self.assertRejected(api.diag_vendor_rate_save, request=REQ, user=TECH, payload={"vendor_id": self.vendor_a, "service_id": self.vitd, "cost": -1})
        self.call(api.diag_vendor_rate_save, request=REQ, user=TECH, payload={"vendor_id": self.vendor_a, "service_id": self.vitd, "cost": ""})
        self.assertEqual(self.call(api.diag_vendor_rates_list, vendor_id=self.vendor_a, service_id=self.vitd, user=TECH)["rates"], [])

    def test_settings_home_visit_fee(self):
        before = self.call(api.diag_settings_get, user=TECH)["home_visit_fee"]
        try:
            self.assertEqual(self.call(api.diag_settings_update, request=REQ, user=TECH, payload={"home_visit_fee": "250"}),
                             {"home_visit_fee": 250.0})
            self.assertEqual(self.call(api.diag_settings_get, user=TECH)["home_visit_fee"], 250.0)
            self.assertRejected(api.diag_settings_update, request=REQ, user=TECH, payload={"home_visit_fee": -5})
            self.assertRejected(api.diag_settings_update, request=REQ, user=TECH, payload={"tax": 5})
        finally:
            self.call(api.diag_settings_update, request=REQ, user=TECH, payload={"home_visit_fee": before})



@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class LabServiceOrderDbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        cls.tag = uuid.uuid4().hex[:8].upper()
        db = cls.db
        cls.patient_id = f"TSO-{cls.tag}"
        db.execute(text("INSERT INTO patients (patient_id, name, last_name, phone) VALUES (:p, 'Meena', 'Iyer', '9800000001')"), {"p": cls.patient_id})
        cls.vendor = db.execute(text("INSERT INTO lab_vendors (vendor_name) VALUES (:n) RETURNING id"), {"n": f"Partner {cls.tag}"}).scalar()
        cls.vendor2 = db.execute(text("INSERT INTO lab_vendors (vendor_name) VALUES (:n) RETURNING id"), {"n": f"Partner2 {cls.tag}"}).scalar()
        db.commit()
        cls.cbc = lq.create_diag_service(db, {"code": f"HCBC-{cls.tag}", "name": "CBC", "service_type": "LAB", "rate": 400})
        cls.vitd = lq.create_diag_service(db, {"code": f"HVD-{cls.tag}", "name": "Vitamin D", "service_type": "LAB", "rate": 1500})
        cls.analyser = lq.create_diag_equipment(db, {"asset_id": f"HAN-{cls.tag}", "name": f"Analyser {cls.tag}"})
        cls.immuno = lq.create_diag_equipment(db, {"asset_id": f"HIM-{cls.tag}", "name": f"Immuno {cls.tag}"})
        dst.set_service_routing(db, cls.cbc, [cls.analyser])
        dst.set_service_routing(db, cls.vitd, [cls.immuno], cls.vendor)
        db.execute(text("UPDATE diag_equipment SET operational_status = 'maintenance' WHERE id = :e"), {"e": cls.immuno})
        db.commit()
        cls.fee_before = dst.get_settings(db)["home_visit_fee"]
        dst.update_settings(db, {"home_visit_fee": 200})

    @classmethod
    def tearDownClass(cls):
        cls.db.rollback()
        dst.update_settings(cls.db, {"home_visit_fee": cls.fee_before})
        cls.db.close()

    def setUp(self):
        self.db.rollback()

    def call(self, fn, *args, **kwargs):
        return fn(*args, db=self.db, **kwargs)

    def assertRejected(self, fn, *args, **kwargs):
        with self.assertRaises((ValueError, HTTPException)) as ctx:
            self.call(fn, *args, **kwargs)
        self.db.rollback()
        return ctx.exception

    @staticmethod
    def later(hours=3):
        from datetime import datetime, timedelta
        return (datetime.now() + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M")

    def home_visit(self, *service_ids, confirm=True, **extra):
        payload = {"service_type": "HOME_VISIT", "walkin_name": "Kiran Das", "walkin_mobile": "98765 43210",
                   "walkin_age": "45", "walkin_gender": "Male", "visit_address": "12, MG Road, Hyderabad",
                   "visit_scheduled_at": self.later(), "items": [{"service_id": s} for s in service_ids], **extra}
        order_id = self.call(api.diag_service_order_create, request=REQ, payload=payload, user=TECH)["order_id"]
        if confirm:
            self.call(diag_api.diag_order_confirm, order_id, request=REQ, user=TECH)
        return lq.get_diag_order(self.db, order_id)

    def invoice(self, order):
        return lq.get_invoice_by_id(self.db, lq.get_diag_order(self.db, order["id"])["invoice_id"])

    def order_count(self):
        return self.db.execute(text("SELECT COUNT(*) FROM diag_orders")).scalar()

    # ------------------------------------------------------------- creation --

    def test_walkin_home_visit_bills_tests_plus_settings_fee(self):
        order = self.home_visit(self.cbc, self.vitd)
        self.assertEqual((order["service_type"], order["visit_status"], order["home_visit_fee"]), ("HOME_VISIT", "scheduled", 200))
        self.assertEqual((order["sale_type"], order["encounter_type"], order["external_source"]), ("EXTERNAL", "EXTERNAL", "Home Visit"))
        inv = self.invoice(order)
        self.assertEqual(float(inv["total_amount"]), 400 + 1500 + 200)
        self.assertEqual(inv["patient_name"], "Kiran Das")

    def test_registered_patient_home_visit_with_fee_override(self):
        order = self.home_visit(self.cbc, patient_id=self.patient_id, home_visit_fee="0")
        self.assertEqual((order["patient_id"], order["sale_type"], order["home_visit_fee"]), (self.patient_id, "INTERNAL", 0))
        self.assertEqual(float(self.invoice(order)["total_amount"]), 400)

    def test_creation_validation(self):
        base = {"service_type": "HOME_VISIT", "walkin_name": "X", "walkin_mobile": "9876543210",
                "visit_address": "12, MG Road", "visit_scheduled_at": self.later(), "items": [{"service_id": self.cbc}]}
        before = self.order_count()
        for bad in ({"visit_scheduled_at": "2020-01-01T10:00"}, {"visit_scheduled_at": ""}, {"visit_address": "x"},
                    {"walkin_mobile": "12"}, {"items": []}, {"home_visit_fee": -10}, {"service_type": "IN_HOUSE"}):
            with self.subTest(bad=bad):
                self.assertRejected(api.diag_service_order_create, request=REQ, user=TECH, payload={**base, **bad})
        self.assertRejected(api.diag_service_order_create, request=REQ, user=TECH, payload={
            "service_type": "OUTSOURCING", "patient_id": self.patient_id, "items": [{"service_id": self.cbc}]})
        self.assertEqual(self.order_count(), before)  # nothing half-created

    def test_existing_external_sale_is_tagged_external(self):
        order_id = self.call(diag_api.diag_orders_create, request=REQ, user=TECH, payload={
            "sale_type": "EXTERNAL", "walkin_name": "Walk In", "walkin_mobile": "9000000000", "items": [{"service_id": self.cbc}]})["order_id"]
        self.assertEqual(lq.get_diag_order(self.db, order_id)["service_type"], "EXTERNAL")

    # ------------------------------------------------------- visit lifecycle --

    def test_collect_receive_routes_each_test_on_the_same_order(self):
        order = self.home_visit(self.cbc, self.vitd)
        before = self.order_count()
        self.assertRejected(api.diag_home_visit_receive, order["id"], request=REQ, user=TECH, payload={})
        self.assertRejected(api.diag_home_visit_collect, order["id"], request=REQ, user=TECH, payload={})  # identity not verified
        self.call(api.diag_home_visit_collect, order["id"], request=REQ, user=TECH, payload={"identity_verified": True})
        out = self.call(api.diag_home_visit_receive, order["id"], request=REQ, user=TECH, payload={})
        by_name = {o["service_name"]: o for o in out["routing"]}
        self.assertEqual(by_name["CBC"]["routing"], dst.IN_HOUSE)
        self.assertEqual((by_name["Vitamin D"]["routing"], by_name["Vitamin D"]["vendor_id"]), (dst.OUTSOURCED, self.vendor))
        self.assertIn("under maintenance", by_name["Vitamin D"]["reason"])
        self.assertEqual(self.order_count(), before)  # no extra orders
        detail = lq.get_diag_order(self.db, order["id"])
        self.assertEqual(detail["visit_status"], "received")
        self.assertTrue(all(i["progress_status"] == "received" for i in detail["items"]))
        vitd_item = next(i for i in detail["items"] if i["service_id"] == self.vitd)
        refs = [r for r in lq.list_diag_external_referrals(self.db, None) if r["order_item_id"] == vitd_item["id"]]
        self.assertEqual(len(refs), 1)
        specimens = self.db.execute(text(
            "SELECT sp.collection_location FROM diag_specimens sp JOIN diag_order_items oi ON oi.id = sp.order_item_id WHERE oi.order_id = :o"),
            {"o": order["id"]}).fetchall()
        self.assertTrue(all(s.collection_location.startswith("Home visit:") for s in specimens))
        visits = self.call(api.diag_home_visits_list, visit_status="received", q=order["order_no"], scope=None, user=TECH)["visits"]
        self.assertEqual([v["id"] for v in visits], [order["id"]])
        self.assertEqual({i["routing"] for i in visits[0]["items"]}, {dst.IN_HOUSE, dst.OUTSOURCED})
        self.assertRejected(api.diag_home_visit_receive, order["id"], request=REQ, user=TECH, payload={})  # already received

    def test_draft_visit_cannot_be_collected(self):
        order = self.home_visit(self.cbc, confirm=False)
        self.assertRejected(api.diag_home_visit_collect, order["id"], request=REQ, user=TECH, payload={"identity_verified": True})

    def test_reschedule(self):
        order = self.home_visit(self.cbc)
        when = self.later(48)
        out = self.call(api.diag_home_visit_reschedule, order["id"], request=REQ, user=TECH,
                        payload={"visit_scheduled_at": when, "visit_address": "22, New Street, Hyderabad"})
        self.assertEqual(out["visit_scheduled_at"], when)
        self.assertRejected(api.diag_home_visit_reschedule, order["id"], request=REQ, user=TECH, payload={"visit_scheduled_at": "2020-01-01T09:00"})

    # --------------------------------------------------------- fee on cancel --

    def test_partial_cancel_keeps_fee_full_cancel_refunds_it(self):
        order = self.home_visit(self.cbc, self.vitd)
        inv = self.invoice(order)
        self.call(diag_api.diag_invoice_record_payment, inv["id"], request=REQ, user=TECH,
                  payload={"amount": float(inv["total_amount"]), "payment_mode": "card"})
        vitd_item = next(i for i in order["items"] if i["service_id"] == self.vitd)
        out = self.call(diag_api.diag_order_item_cancel, vitd_item["id"], request=REQ, user=TECH, payload={"reason": "Patient declined"})
        self.assertEqual(out["refund_amount"], 1500)  # the fee stays: CBC is still being collected
        self.assertEqual(float(self.invoice(order)["total_amount"]), 400 + 200)
        result = self.call(api.diag_home_visit_cancel, order["id"], request=REQ, user=TECH, payload={"reason": "Patient unavailable"})
        self.assertEqual(result["refund_amount"], 400 + 200)
        inv = self.invoice(order)
        self.assertEqual(float(inv["total_amount"]), 0)
        self.assertEqual(lq.get_diag_order(self.db, order["id"])["visit_status"], "cancelled")

    def test_cannot_cancel_visit_after_collection(self):
        order = self.home_visit(self.cbc)
        self.call(api.diag_home_visit_collect, order["id"], request=REQ, user=TECH, payload={"identity_verified": True})
        self.assertRejected(api.diag_home_visit_cancel, order["id"], request=REQ, user=TECH, payload={"reason": "x"})

    def test_cancel_draft_visit(self):
        order = self.home_visit(self.cbc, confirm=False)
        self.call(api.diag_home_visit_cancel, order["id"], request=REQ, user=TECH, payload={"reason": "Booked twice"})
        detail = lq.get_diag_order(self.db, order["id"])
        self.assertEqual((detail["status"], detail["visit_status"]), ("cancelled", "cancelled"))

    # ------------------------------------------------------------ outsourcing --

    def test_outsourcing_order_routes_on_worklist_receive(self):
        order_id = self.call(api.diag_service_order_create, request=REQ, user=TECH, payload={
            "service_type": "OUTSOURCING", "patient_id": self.patient_id, "outsource_vendor_id": self.vendor,
            "items": [{"service_id": self.cbc}, {"service_id": self.vitd, "vendor_id": self.vendor2}]})["order_id"]
        confirm = self.call(diag_api.diag_order_confirm, order_id, request=REQ, user=TECH)
        self.assertEqual(confirm["subtotal"], 1900)  # catalogue rates, no fee
        order = lq.get_diag_order(self.db, order_id)
        self.assertEqual((order["service_type"], order["encounter_type"], order["external_source"]), ("OUTSOURCING", "EXTERNAL", "Outsourcing"))
        for item in order["items"]:
            sp = next(s for s in lq.get_diag_lab_item_detail(self.db, item["id"])["specimens"] if s["status"] != "rejected")
            self.call(diag_api.diag_specimen_collect, sp["id"], request=REQ, payload={"identity_verified": True}, user=TECH)
            self.call(diag_api.diag_specimen_receive, sp["id"], request=REQ, payload={"accept": True}, user=TECH)
        items = {i["service_id"]: i for i in lq.get_diag_order(self.db, order_id)["items"]}
        self.assertEqual((items[self.cbc]["routing"], items[self.cbc]["routing_vendor_id"]), (dst.OUTSOURCED, self.vendor))
        self.assertEqual((items[self.vitd]["routing"], items[self.vitd]["routing_vendor_id"]), (dst.OUTSOURCED, self.vendor2))


    # --------------------------------------------------------- order history --

    def test_order_history_types_counts_search_and_scope(self):
        tag = uuid.uuid4().hex[:6].upper()
        appt = self.db.execute(text(
            "INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status) "
            "VALUES (:p, 'Meena Iyer', 'OP', CURRENT_TIMESTAMP, 1, 'scheduled') RETURNING id"), {"p": self.patient_id}).scalar()
        self.db.commit()
        # One order of each type; walk-ins carry the tag in their name so the search isolates this test's rows.
        inhouse = self.call(diag_api.diag_orders_create, request=REQ, user=TECH, payload={
            "patient_id": self.patient_id, "encounter_type": "OP", "appointment_id": appt, "items": [{"service_id": self.cbc}]})["order_id"]
        external = self.call(diag_api.diag_orders_create, request=REQ, user=TECH, payload={
            "sale_type": "EXTERNAL", "walkin_name": f"Ext {tag}", "walkin_mobile": "9000000001", "items": [{"service_id": self.cbc}]})["order_id"]
        outsourced = self.call(api.diag_service_order_create, request=REQ, user=TECH, payload={
            "service_type": "OUTSOURCING", "walkin_name": f"Out {tag}", "walkin_mobile": "9000000002",
            "outsource_vendor_id": self.vendor, "items": [{"service_id": self.vitd}]})["order_id"]
        visit = self.home_visit(self.cbc, walkin_name=f"Home {tag}")["id"]
        for oid in (inhouse, external, outsourced):
            self.call(diag_api.diag_order_confirm, oid, request=REQ, user=TECH)

        today = __import__("datetime").date.today().isoformat()
        hist = self.call(api.diag_order_history, q=tag, date_from=today, date_to=today, scope=None, user=TECH)
        self.assertEqual({o["id"] for o in hist["orders"]}, {external, outsourced, visit})
        self.assertEqual((hist["counts"]["EXTERNAL"], hist["counts"]["OUTSOURCING"], hist["counts"]["HOME_VISIT"], hist["counts"]["ALL"]), (1, 1, 1, 3))
        row = next(o for o in hist["orders"] if o["id"] == visit)
        self.assertEqual((row["service_type"], row["patient_name"], row["tests"], row["total"]), ("HOME_VISIT", f"Home {tag}", "CBC", 600.0))

        only = self.call(api.diag_order_history, service_type="outsourcing", q=tag, scope=None, user=TECH)
        self.assertEqual([o["id"] for o in only["orders"]], [outsourced])
        self.assertEqual(only["total"], 1)

        by_uhid = self.call(api.diag_order_history, service_type="IN_HOUSE", q=self.patient_id.lower(), scope=None, user=TECH)
        self.assertIn(inhouse, [o["id"] for o in by_uhid["orders"]])
        self.assertEqual(by_uhid["orders"][0]["patient_id"], self.patient_id)

        # Doctor scope: walk-ins (no UHID) and other patients are excluded, and counts follow.
        scoped = self.call(api.diag_order_history, q=tag, scope={self.patient_id}, user=TECH)
        self.assertEqual((scoped["orders"], scoped["counts"]["ALL"]), ([], 0))

        paged = self.call(api.diag_order_history, q=tag, page=2, page_size=2, scope=None, user=TECH)
        self.assertEqual((len(paged["orders"]), paged["total"]), (1, 3))
        inv_no = lq.get_invoice_by_id(self.db, lq.get_diag_order(self.db, visit)["invoice_id"])["invoice_no"]
        by_invoice = self.call(api.diag_order_history, q=inv_no.lower(), scope=None, user=TECH)
        self.assertEqual([o["id"] for o in by_invoice["orders"]], [visit])
        self.assertRejected(api.diag_order_history, date_from="09/11/2026", scope=None, user=TECH)
        self.assertRejected(api.diag_order_history, service_type="WARD", scope=None, user=TECH)


    # ---------------------------------------------------------- result import --

    def test_results_import_csv_on_outsourced_test_fills_drafts_only(self):
        import io as _io
        from fastapi import UploadFile
        lq.replace_diag_service_parameters(self.db, self.vitd, [
            {"name": "25-OH Vitamin D", "data_type": "numeric", "unit": "ng/mL", "ref_low": 30, "ref_high": 100}])
        order = self.home_visit(self.vitd)
        self.call(api.diag_home_visit_collect, order["id"], request=REQ, user=TECH, payload={"identity_verified": True})
        routed = self.call(api.diag_home_visit_receive, order["id"], request=REQ, user=TECH, payload={})["routing"]
        self.assertEqual(routed[0]["routing"], dst.OUTSOURCED)
        item_id = routed[0]["item_id"]
        csv_bytes = b"Partner Lab Report\nTest Name,Result,Unit,Reference Range\nVitamin D,24.5,ng/mL,30-100\nCalcium,9.2,mg/dL,8.5-10.5\n"
        upload = UploadFile(file=_io.BytesIO(csv_bytes), filename="partner.csv")
        out = self.call(api.diag_results_import, item_id, request=REQ, file=upload, user=TECH)
        param_id = lq.list_diag_service_parameters(self.db, self.vitd)[0]["id"]
        self.assertEqual((out["file_type"], out["layout"]), ("csv", "long"))
        self.assertEqual(out["values"], [{"parameter_id": param_id, "value": "24.5"}])
        self.assertEqual([u["name"] for u in out["unmatched"]], ["Calcium"])
        # Import only proposes values: nothing is written to diag_results.
        saved = self.db.execute(text("SELECT COUNT(*) FROM diag_results WHERE order_item_id = :i"), {"i": item_id}).scalar()
        self.assertEqual(saved, 0)
        bad = UploadFile(file=_io.BytesIO(b"PK\x03\x04"), filename="r.xlsx")
        self.assertEqual(self.assertRejected(api.diag_results_import, item_id, request=REQ, file=bad, user=TECH).status_code, 415)


if __name__ == "__main__":
    unittest.main()
