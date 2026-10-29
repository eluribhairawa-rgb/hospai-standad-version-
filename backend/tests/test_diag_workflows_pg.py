"""End-to-end Lab & Diagnostics workflow tests against a real PostgreSQL database.

They drive the FastAPI route handlers in routers/diagnostics.py directly (same code
path as the API, including audit logging) on a disposable database. The suite is
skipped unless TEST_DATABASE_URL is set, and refuses to run unless the database
name contains "test", so it can never touch the live hospital database.

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest discover -s tests -v
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
    from unittest import mock

    from fastapi import HTTPException
    from sqlalchemy import text

    import common

    import database
    import legacy_queries as lq
    import schema_setup
    from routers import diagnostics as api


REQ = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
TECH = {"username": "test_tech"}
PATHOLOGIST = {"username": "test_pathologist"}


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class DiagWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        cls.tag = uuid.uuid4().hex[:8].upper()
        db = cls.db
        cls.patient_id = f"TST-{cls.tag}"
        db.execute(text("INSERT INTO patients (patient_id, name, last_name) VALUES (:p, 'Ravi', 'Kumar')"), {"p": cls.patient_id})
        cls.appointment_id = db.execute(text(
            "INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status) "
            "VALUES (:p, 'Ravi Kumar', 'OP', CURRENT_TIMESTAMP, 1, 'scheduled') RETURNING id"), {"p": cls.patient_id}).scalar()
        cls.vendor_id = db.execute(text("INSERT INTO lab_vendors (vendor_name) VALUES (:n) RETURNING id"), {"n": f"Ref Lab {cls.tag}"}).scalar()
        db.commit()

        cls.cbc = lq.create_diag_service(db, {"code": f"CBC-{cls.tag}", "name": "CBC", "service_type": "LAB", "rate": 400, "turnaround_hours": 4})
        lq.replace_diag_service_parameters(db, cls.cbc, [
            {"name": "Haemoglobin", "data_type": "numeric", "unit": "g/dL", "ref_low": 12, "ref_high": 16, "critical_low": 7, "critical_high": 20},
            {"name": "Comment", "data_type": "text"},
        ])
        cls.lft = lq.create_diag_service(db, {"code": f"LFT-{cls.tag}", "name": "LFT", "service_type": "LAB", "rate": 600})
        lq.replace_diag_service_parameters(db, cls.lft, [{"name": "ALT", "data_type": "numeric", "ref_low": 0, "ref_high": 40}])
        cls.analyzer = lq.create_diag_equipment(db, {"asset_id": f"AN-{cls.tag}", "name": f"Analyzer {cls.tag}"})
        cls.spare = lq.create_diag_equipment(db, {"asset_id": f"SP-{cls.tag}", "name": f"Spare {cls.tag}"})

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    # ------------------------------------------------------------------ helpers --

    def setUp(self):
        self.db.rollback()

    def call(self, fn, *args, **kwargs):
        return fn(*args, db=self.db, **kwargs)

    def assertRejected(self, fn, *args, **kwargs):
        with self.assertRaises((ValueError, HTTPException)) as ctx:
            self.call(fn, *args, **kwargs)
        self.db.rollback()
        return ctx.exception

    def new_confirmed_order(self, *service_ids, **extra):
        payload = {"patient_id": self.patient_id, "encounter_type": "OP", "appointment_id": self.appointment_id,
                   "items": [{"service_id": s} for s in service_ids], **extra}
        order_id = self.call(api.diag_orders_create, request=REQ, payload=payload, user=TECH)["order_id"]
        confirm = self.call(api.diag_order_confirm, order_id, request=REQ, user=TECH)
        return lq.get_diag_order(self.db, order_id), confirm

    def item_detail(self, item_id):
        return self.call(api.diag_lab_item_detail, item_id, user=TECH)

    def active_specimen(self, item_id):
        return next(s for s in self.item_detail(item_id)["specimens"] if s["status"] != "rejected")

    def collect_and_receive(self, item_id):
        sp = self.active_specimen(item_id)
        self.call(api.diag_specimen_collect, sp["id"], request=REQ, payload={"identity_verified": True}, user=TECH)
        self.call(api.diag_specimen_receive, sp["id"], request=REQ, payload={"accept": True}, user=TECH)

    def params(self, service_id):
        return {p["name"]: p["id"] for p in lq.list_diag_service_parameters(self.db, service_id)}

    def finalize_cbc(self, item_id, hb, equipment_id=None):
        p = self.params(self.cbc)
        return self.call(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": False, "results": [
            {"parameter_id": p["Haemoglobin"], "value_numeric": hb, "equipment_id": equipment_id or self.analyzer},
            {"parameter_id": p["Comment"], "value_text": "ok", "equipment_id": equipment_id or self.analyzer},
        ]})

    def release_report(self, report_id, summary="Reviewed"):
        self.call(api.diag_report_save, report_id, request=REQ, payload={"content": {"summary": summary}}, user=TECH)
        self.call(api.diag_report_submit, report_id, request=REQ, user=TECH)
        self.call(api.diag_report_authorize, report_id, request=REQ, payload={"also_release": True}, user=PATHOLOGIST)

    def audit_rows(self, module, entity_key, action):
        return self.db.execute(text(
            "SELECT actor_username, payload FROM audit_logs WHERE module_name = :m AND entity_key = :k AND action = :a"),
            {"m": module, "k": str(entity_key), "a": action}).fetchall()

    # -------------------------------------------------------------------- tests --

    def test_internal_order_confirm_creates_invoice_and_specimens(self):
        order, confirm = self.new_confirmed_order(self.cbc, self.lft)
        self.assertEqual(order["status"], "confirmed")
        self.assertEqual(confirm["subtotal"], 1000.0)
        inv = lq.get_invoice_by_id(self.db, order["invoice_id"])
        self.assertEqual((inv["module"], float(inv["total_amount"])), ("LAB", 1000.0))
        for item in order["items"]:
            self.assertEqual(self.active_specimen(item["id"])["status"], "awaiting_collection")
        self.assertTrue(self.audit_rows("diag_orders", order["id"], "confirm"))

    def test_external_walkin_sale(self):
        payload = {"sale_type": "EXTERNAL", "walkin_name": "Walk In", "walkin_mobile": "9876543210",
                   "items": [{"service_id": self.lft}]}
        order_id = self.call(api.diag_orders_create, request=REQ, payload=payload, user=TECH)["order_id"]
        confirm = self.call(api.diag_order_confirm, order_id, request=REQ, user=TECH)
        inv = lq.get_invoice_by_id(self.db, confirm["invoice_id"])
        self.assertIsNone(inv["patient_id"])
        self.assertEqual((inv["invoice_type"], inv["patient_name"]), ("EXTERNAL_SALE", "Walk In"))
        self.assertRejected(api.diag_orders_create, request=REQ, user=TECH,
                            payload={"sale_type": "EXTERNAL", "walkin_name": "X", "walkin_mobile": "12", "items": [{"service_id": self.lft}]})

    def test_specimen_rejection_and_recollection(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        first = self.active_specimen(item_id)
        self.assertRejected(api.diag_specimen_collect, first["id"], request=REQ, payload={}, user=TECH)  # identity not verified
        self.call(api.diag_specimen_collect, first["id"], request=REQ, payload={"identity_verified": True}, user=TECH)
        self.assertRejected(api.diag_specimen_receive, first["id"], request=REQ, payload={"accept": False}, user=TECH)  # no reason
        self.call(api.diag_specimen_receive, first["id"], request=REQ, payload={"accept": False, "rejection_reason": "Haemolysed"}, user=TECH)

        detail = self.item_detail(item_id)
        self.assertEqual(detail["progress_status"], "ordered")
        replacement = next(s for s in detail["specimens"] if s["status"] == "awaiting_collection")
        self.assertEqual(replacement["replaces_specimen_id"], first["id"])
        rejected = next(s for s in detail["specimens"] if s["id"] == first["id"])
        self.assertEqual((rejected["status"], rejected["rejection_reason"]), ("rejected", "Haemolysed"))
        worklist = lq.list_diag_lab_worklist(self.db, stage="awaiting_collection")
        self.assertIn(replacement["id"], [r["specimen_id"] for r in worklist if r["id"] == item_id])

        self.collect_and_receive(item_id)
        self.assertEqual(self.item_detail(item_id)["progress_status"], "received")
        self.assertTrue(self.audit_rows("diag_specimens", first["id"], "receive"))

    def test_result_entry_validation_and_equipment_gates(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        p = self.params(self.cbc)
        self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH,
                            payload={"is_draft": True, "results": [{"parameter_id": p["Haemoglobin"], "value_numeric": 13}]})  # not received
        self.collect_and_receive(item_id)

        # Final results without an analyzer would bypass QC holds.
        self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH,
                            payload={"is_draft": False, "results": [{"parameter_id": p["Haemoglobin"], "value_numeric": 13}]})
        self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH,
                            payload={"is_draft": True, "results": [{"parameter_id": p["Haemoglobin"], "value_numeric": "13..4"}]})
        other = self.params(self.lft)["ALT"]
        self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH,
                            payload={"is_draft": True, "results": [{"parameter_id": other, "value_numeric": 10}]})

        # Equipment under maintenance cannot be used.
        lq.log_diag_equipment_maintenance(self.db, {"equipment_id": self.spare, "service_type": "PM", "mark_unavailable": True}, "eng")
        exc = self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
            {"parameter_id": p["Haemoglobin"], "value_numeric": 13, "equipment_id": self.spare}]})
        self.assertIn("maintenance", str(exc))
        lq.return_diag_equipment_to_service(self.db, self.spare, "eng")

        # Client-supplied reference ranges are ignored; the catalogue's are copied.
        self.call(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
            {"parameter_id": p["Haemoglobin"], "value_numeric": "17.5", "ref_low": 0, "ref_high": 100, "equipment_id": self.analyzer}]})
        row = next(r for r in self.item_detail(item_id)["results"] if r["parameter_id"] == p["Haemoglobin"])
        self.assertEqual((row["flag"], row["ref_high"], row["is_draft"]), ("high", 16, True))

        out = self.finalize_cbc(item_id, 14)
        self.assertTrue(out["report_id"])
        detail = self.item_detail(item_id)
        self.assertEqual(detail["progress_status"], "results_entered")
        self.assertIsNotNone(next(r for r in detail["results"] if r["parameter_id"] == p["Haemoglobin"])["updated_at"])

    def test_qc_hold_blocks_results_until_passing_repeat(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        run = self.call(api.diag_qc_run_create, request=REQ, user=TECH,
                        payload={"equipment_id": self.spare, "outcome": "failed", "control_material": "L1"})
        hold_id = run["hold_id"]
        self.assertIn(self.spare, [e["id"] for e in lq.list_diag_equipment(self.db, "qc_hold")])
        with self.assertRaises(ValueError):
            self.finalize_cbc(item_id, 14, self.spare)
        self.db.rollback()

        self.assertRejected(api.diag_qc_hold_release, hold_id, request=REQ, payload={}, user=TECH)
        self.assertRejected(api.diag_qc_hold_repeat, hold_id, request=REQ, payload={"outcome": "passed"}, user=TECH)
        self.call(api.diag_qc_hold_corrective_action, hold_id, request=REQ, payload={"corrective_action": "Recalibrated"}, user=TECH)
        self.call(api.diag_qc_hold_repeat, hold_id, request=REQ, payload={"outcome": "failed"}, user=TECH)
        self.assertRejected(api.diag_qc_hold_release, hold_id, request=REQ, payload={}, user=TECH)
        self.call(api.diag_qc_hold_corrective_action, hold_id, request=REQ, payload={"corrective_action": "New control lot"}, user=TECH)
        self.call(api.diag_qc_hold_repeat, hold_id, request=REQ, payload={"outcome": "passed"}, user=TECH)
        self.call(api.diag_qc_hold_release, hold_id, request=REQ, payload={"release_notes": "OK"}, user=TECH)
        status = self.db.execute(text("SELECT operational_status FROM diag_equipment WHERE id = :i"), {"i": self.spare}).scalar()
        self.assertEqual(status, "ready")
        self.finalize_cbc(item_id, 14, self.spare)

    def test_critical_value_alert_gates_authorization_and_release(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        out = self.finalize_cbc(item_id, 5.2)
        self.assertEqual((out["critical_alerts_raised"], out["critical_values"]), (1, 1))
        self.assertEqual(self.finalize_cbc(item_id, 5.0)["critical_alerts_raised"], 0, "no duplicate open alert")
        alert = next(a for a in lq.list_diag_critical_alerts(self.db) if a["order_item_id"] == item_id)

        report_id = out["report_id"]
        self.call(api.diag_report_save, report_id, request=REQ, payload={"content": {"summary": "Severe anaemia"}}, user=TECH)
        self.call(api.diag_report_submit, report_id, request=REQ, user=TECH)
        exc = self.assertRejected(api.diag_report_authorize, report_id, request=REQ, payload={}, user=PATHOLOGIST)
        self.assertIn("critical", str(exc))
        self.assertRejected(api.diag_critical_alert_resolve, alert["id"], request=REQ, user=TECH)  # nobody contacted yet
        self.assertRejected(api.diag_critical_alert_escalate, alert["id"], request=REQ, payload={}, user=TECH)
        self.call(api.diag_critical_alert_escalate, alert["id"], request=REQ, payload={"escalated_to": "Duty CMO"}, user=TECH)
        self.call(api.diag_critical_alert_contact, alert["id"], request=REQ, user=TECH,
                  payload={"contacted_person": "Dr. Rao", "ack_method": "verbal_readback"})
        self.call(api.diag_critical_alert_resolve, alert["id"], request=REQ, user=TECH)
        self.assertRejected(api.diag_critical_alert_resolve, alert["id"], request=REQ, user=TECH)  # already resolved

        self.call(api.diag_report_authorize, report_id, request=REQ, payload={}, user=PATHOLOGIST)
        self.assertEqual(self.item_detail(item_id)["progress_status"], "authorized")
        self.call(api.diag_report_release, report_id, request=REQ, user=PATHOLOGIST)
        report = self.call(api.diag_report_detail, report_id, user=TECH)
        self.assertEqual((report["status"], report["authorized_by"]), ("released", "test_pathologist"))
        self.assertEqual(self.item_detail(item_id)["progress_status"], "released")
        self.assertTrue(self.audit_rows("diag_reports", report_id, "authorize"))
        self.assertTrue(self.audit_rows("diag_reports", report_id, "release"))
        self.assertTrue(self.audit_rows("diag_critical_alerts", alert["id"], "contact"))

    def test_report_state_machine_rejects_out_of_order_actions(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        p = self.params(self.cbc)
        self.call(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
            {"parameter_id": p["Haemoglobin"], "value_numeric": 13, "equipment_id": self.analyzer}]})
        report_id = self.call(api.diag_report_draft_get_or_create, item_id, request=REQ, payload={"report_type": "LAB"}, user=TECH)["id"]
        self.call(api.diag_report_save, report_id, request=REQ, payload={"content": {"summary": "x"}}, user=TECH)
        self.assertRejected(api.diag_report_submit, report_id, request=REQ, user=TECH)  # draft results
        self.assertRejected(api.diag_report_release, report_id, request=REQ, user=PATHOLOGIST)  # not authorized
        self.assertRejected(api.diag_report_authorize, report_id, request=REQ, payload={}, user=PATHOLOGIST)  # not submitted
        self.finalize_cbc(item_id, 13)
        self.call(api.diag_report_submit, report_id, request=REQ, user=TECH)
        self.assertRejected(api.diag_report_return, report_id, request=REQ, payload={}, user=PATHOLOGIST)  # reason needed
        self.call(api.diag_report_return, report_id, request=REQ, payload={"reason": "Check comment"}, user=PATHOLOGIST)
        self.finalize_cbc(item_id, 13.1)  # editable again once returned
        self.call(api.diag_report_submit, report_id, request=REQ, user=TECH)
        self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
            {"parameter_id": p["Haemoglobin"], "value_numeric": 9, "equipment_id": self.analyzer}]})  # locked in review

    def test_amendment_keeps_original_released_values(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        v1 = self.finalize_cbc(item_id, 13.0)["report_id"]
        self.release_report(v1, "Normal")
        with self.assertRaises(ValueError):  # locked after release
            self.finalize_cbc(item_id, 9.0)
        self.db.rollback()
        self.assertRejected(api.diag_report_amend, v1, request=REQ, payload={"content": {}}, user=PATHOLOGIST)  # reason needed

        v1_detail = self.call(api.diag_report_detail, v1, user=TECH)
        self.assertTrue(v1_detail["results_frozen"])
        self.assertNotIn(lq.RESULTS_SNAPSHOT_KEY, v1_detail["content"])
        v2 = self.call(api.diag_report_amend, v1, request=REQ, user=PATHOLOGIST, payload={
            "reason": "Transcription error", "content": {**v1_detail["content"], lq.RESULTS_SNAPSHOT_KEY: [{"forged": True}]}})["report_id"]
        self.assertRejected(api.diag_report_amend, v1, request=REQ, payload={"reason": "again"}, user=PATHOLOGIST)  # v2 exists

        self.finalize_cbc(item_id, 11.0)
        self.release_report(v2, "Mild anaemia")

        hb = lambda rep: next(r["value_numeric"] for r in rep["order_item"]["results"] if r["parameter_name"] == "Haemoglobin")
        v1_after, v2_after = (self.call(api.diag_report_detail, rid, user=TECH) for rid in (v1, v2))
        self.assertEqual(hb(v1_after), 13.0, "original released version keeps its values")
        self.assertEqual(hb(v2_after), 11.0)
        self.assertEqual((v1_after["status"], v2_after["status"], v2_after["version"]), ("released", "amended", 2))
        self.assertEqual([v["version"] for v in v2_after["all_versions"]], [1, 2])
        self.assertTrue(self.audit_rows("diag_reports", v1, "amend"))

        rows = {r["id"]: r for r in lq.list_diag_reports_worklist(self.db, status="released,amended")}
        self.assertIsNone(rows[v2]["tat_status"], "a released amendment has no running TAT clock")

    def test_cancellation_refunds_paid_amount(self):
        order, confirm = self.new_confirmed_order(self.cbc, self.lft)
        invoice_id = confirm["invoice_id"]
        self.call(api.diag_invoice_record_payment, invoice_id, request=REQ, payload={"amount": 1000, "payment_mode": "upi"}, user=TECH)
        lft_item = next(i for i in order["items"] if i["service_id"] == self.lft)
        cbc_item = next(i for i in order["items"] if i["service_id"] == self.cbc)

        out = self.call(api.diag_order_item_cancel, lft_item["id"], request=REQ, payload={"reason": "Doctor changed order"}, user=TECH)
        self.assertEqual(out["refund_amount"], 600.0)
        inv = lq.get_invoice_by_id(self.db, invoice_id)
        self.assertEqual((float(inv["total_amount"]), float(inv["refunded_amount"]), float(inv["due_amount"]), inv["payment_status"]),
                         (400.0, 600.0, 0.0, "paid"))
        refund_row = self.db.execute(text(
            "SELECT amount, payment_mode FROM invoice_payments WHERE invoice_id = :i AND amount < 0"), {"i": invoice_id}).fetchone()
        self.assertEqual((float(refund_row[0]), refund_row[1]), (-600.0, "upi"))
        self.assertIn('"refund_amount":600.0', self.audit_rows("diag_order_items", lft_item["id"], "cancel")[0][1])

        self.assertRejected(api.diag_order_item_cancel, lft_item["id"], request=REQ, payload={"reason": "again"}, user=TECH)
        self.collect_and_receive(cbc_item["id"])
        self.assertRejected(api.diag_order_item_cancel, cbc_item["id"], request=REQ, payload={"reason": "late"}, user=TECH)

    def test_cancellation_of_unpaid_service_reduces_due(self):
        order, confirm = self.new_confirmed_order(self.cbc, self.lft)
        lft_item = next(i for i in order["items"] if i["service_id"] == self.lft)
        out = self.call(api.diag_order_item_cancel, lft_item["id"], request=REQ, payload={"reason": "Not required"}, user=TECH)
        self.assertEqual(out["refund_amount"], 0.0)
        inv = lq.get_invoice_by_id(self.db, confirm["invoice_id"])
        self.assertEqual((float(inv["total_amount"]), float(inv["due_amount"]), inv["payment_status"]), (400.0, 400.0, "due"))

    def test_tat_tracking_on_worklist(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.db.execute(text("UPDATE diag_orders SET created_at = CURRENT_TIMESTAMP - INTERVAL '10 hours' WHERE id = :i"), {"i": order["id"]})
        self.db.commit()
        row = next(r for r in lq.list_diag_lab_worklist(self.db) if r["id"] == item_id)
        self.assertEqual((row["tat_status"], row["tat_target_hours"]), ("overdue", 4.0))
        self.collect_and_receive(item_id)
        row = next(r for r in lq.list_diag_lab_worklist(self.db) if r["id"] == item_id)
        self.assertEqual(row["tat_status"], "on_time", "TAT restarts from lab receipt")

    def test_reagent_lot_expiry_checks(self):
        self.assertRejected(api.diag_reagent_lot_create, request=REQ, user=TECH,
                            payload={"item_name": f"Glucose {self.tag}", "lot_no": "OLD", "expiry_date": "2000-01-01"})
        lot_id = self.call(api.diag_reagent_lot_create, request=REQ, user=TECH,
                           payload={"item_name": f"Glucose {self.tag}", "lot_no": "L1", "expiry_date": "2999-12-31", "quantity": 10})["lot_id"]
        self.db.execute(text("UPDATE diag_reagent_lots SET expiry_date = CURRENT_DATE - 1 WHERE id = :i"), {"i": lot_id})
        self.db.commit()
        lot = next(l for l in self.call(api.diag_reagent_lots_list, user=TECH)["lots"] if l["id"] == lot_id)
        self.assertTrue(lot["is_expired"])
        self.assertGreaterEqual(lq.get_diag_quality_overview(self.db)["expired_lots"], 1)
        self.call(api.diag_reagent_lot_status_update, lot_id, request=REQ, payload={"status": "quarantined"}, user=TECH)
        self.assertRejected(api.diag_reagent_lot_status_update, lot_id, request=REQ, payload={"status": "available"}, user=TECH)
        self.assertRejected(api.diag_reagent_lot_status_update, lot_id, request=REQ, payload={"status": "lost"}, user=TECH)
        self.call(api.diag_reagent_lot_status_update, lot_id, request=REQ, payload={"status": "expired"}, user=TECH)
        moves = self.db.execute(text("SELECT movement_type FROM diag_stock_movements WHERE reagent_lot_id = :i ORDER BY id"), {"i": lot_id}).scalars().all()
        self.assertEqual(moves, ["receipt", "quarantine", "adjustment"])

    def test_external_lab_referral_tracking(self):
        order, _ = self.new_confirmed_order(self.lft)
        item_id = order["items"][0]["id"]
        self.assertRejected(api.diag_external_referral_create, item_id, request=REQ, payload={}, user=TECH)
        self.assertRejected(api.diag_external_referral_create, item_id, request=REQ, payload={"vendor_id": 987654321}, user=TECH)
        ref_id = self.call(api.diag_external_referral_create, item_id, request=REQ, user=TECH,
                           payload={"vendor_id": self.vendor_id, "expected_turnaround": "48 hours"})["referral_id"]
        self.assertRejected(api.diag_external_referral_create, item_id, request=REQ, payload={"vendor_id": self.vendor_id}, user=TECH)
        referral = self.item_detail(item_id)["external_referrals"][0]
        self.assertEqual((referral["vendor_name"], referral["received_report_at"]), (f"Ref Lab {self.tag}", None))
        self.call(api.diag_external_referral_update, ref_id, request=REQ, payload={"report_received": True, "local_review_status": "reviewed"}, user=TECH)
        referral = self.item_detail(item_id)["external_referrals"][0]
        self.assertIsNotNone(referral["received_report_at"])
        self.assertEqual(referral["local_review_status"], "reviewed")
        # External results are entered through the same validated result path.
        self.collect_and_receive(item_id)
        out = self.call(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": False, "results": [
            {"parameter_id": self.params(self.lft)["ALT"], "value_numeric": 55, "equipment_id": self.analyzer}]})
        self.assertTrue(out["report_id"])

    def test_four_eyes_rule_on_lab_sign_off(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        report_id = self.finalize_cbc(item_id, 13.0)["report_id"]
        self.call(api.diag_report_save, report_id, request=REQ, payload={"content": {"summary": "Normal"}}, user=TECH)
        self.call(api.diag_report_submit, report_id, request=REQ, user=TECH)
        exc = self.assertRejected(api.diag_report_authorize, report_id, request=REQ, payload={"also_release": True}, user=TECH)
        self.assertIn("four-eyes", str(exc))
        # A reviewer who only drafted the summary is also excluded.
        self.call(api.diag_report_return, report_id, request=REQ, payload={"reason": "Reword"}, user=PATHOLOGIST)
        self.call(api.diag_report_save, report_id, request=REQ, payload={"content": {"summary": "Reworded"}}, user=PATHOLOGIST)
        self.call(api.diag_report_submit, report_id, request=REQ, user=PATHOLOGIST)
        self.assertRejected(api.diag_report_authorize, report_id, request=REQ, payload={}, user=PATHOLOGIST)
        self.call(api.diag_report_authorize, report_id, request=REQ, payload={"also_release": True}, user={"username": "test_second_signatory"})
        self.assertEqual(self.call(api.diag_report_detail, report_id, user=TECH)["status"], "released")

    def test_calibration_overdue_blocks_results_until_recorded(self):
        eq = lq.create_diag_equipment(self.db, {"asset_id": f"CAL-{self.tag}", "name": f"Cal {self.tag}", "next_calibration_date": "2000-01-01"})
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        with self.assertRaises(ValueError) as ctx:
            self.finalize_cbc(item_id, 13.0, eq)
        self.db.rollback()
        self.assertIn("calibration", str(ctx.exception))
        self.assertGreaterEqual(lq.get_diag_quality_overview(self.db)["calibration_overdue"], 1)
        self.call(api.diag_equipment_maintenance_create, request=REQ, user=TECH,
                  payload={"equipment_id": eq, "service_type": "Calibration", "next_due_date": "2999-01-01"})
        self.finalize_cbc(item_id, 13.0, eq)

    def test_reagent_lot_must_be_usable(self):
        lots = {}
        for lot_no in ("OK", "QUAR", "EXP"):
            lots[lot_no] = self.call(api.diag_reagent_lot_create, request=REQ, user=TECH,
                                     payload={"item_name": f"Hb reagent {self.tag}", "lot_no": lot_no, "expiry_date": "2999-12-31"})["lot_id"]
        self.call(api.diag_reagent_lot_status_update, lots["QUAR"], request=REQ, payload={"status": "quarantined"}, user=TECH)
        self.db.execute(text("UPDATE diag_reagent_lots SET expiry_date = CURRENT_DATE - 1 WHERE id = :i"), {"i": lots["EXP"]})
        self.db.commit()
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        hb = self.params(self.cbc)["Haemoglobin"]
        for bad in ("QUAR", "EXP"):
            self.assertRejected(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
                {"parameter_id": hb, "value_numeric": 13, "equipment_id": self.analyzer, "reagent_lot_id": lots[bad]}]})
        self.call(api.diag_results_save, item_id, request=REQ, user=TECH, payload={"is_draft": True, "results": [
            {"parameter_id": hb, "value_numeric": 13, "equipment_id": self.analyzer, "reagent_lot_id": lots["OK"]}]})
        self.assertEqual(self.item_detail(item_id)["results"][0]["reagent_lot_id"], lots["OK"])

    def test_tat_stops_for_amendments(self):
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.db.execute(text("UPDATE diag_orders SET created_at = CURRENT_TIMESTAMP - INTERVAL '30 hours' WHERE id = :i"), {"i": order["id"]})
        self.db.commit()
        self.collect_and_receive(item_id)
        self.db.execute(text("UPDATE diag_specimens SET received_at = CURRENT_TIMESTAMP - INTERVAL '20 hours' WHERE order_item_id = :i"), {"i": item_id})
        self.db.commit()
        v1 = self.finalize_cbc(item_id, 13.0)["report_id"]
        self.release_report(v1)
        self.call(api.diag_report_amend, v1, request=REQ, payload={"reason": "Typo", "content": {"summary": "x"}}, user=PATHOLOGIST)
        self.finalize_cbc(item_id, 12.5)  # item is back to results_entered while the amendment is drafted
        row = next(r for r in lq.list_diag_lab_worklist(self.db) if r["id"] == item_id)
        self.assertEqual(row["progress_status"], "results_entered")
        self.assertIsNone(row["tat_status"])
        before = lq.get_diag_overview(self.db)["overdue_count"]
        self.db.execute(text("UPDATE diag_reports SET status = 'draft' WHERE order_item_id = :i"), {"i": item_id})  # pretend never released
        self.db.commit()
        self.assertEqual(lq.get_diag_overview(self.db)["overdue_count"], before + 1, "same item counts as overdue without a released report")
        self.db.execute(text("UPDATE diag_reports SET status = 'released' WHERE id = :i"), {"i": v1})
        self.db.commit()

    def test_failed_qc_flags_results_reported_since_last_pass(self):
        eq = lq.create_diag_equipment(self.db, {"asset_id": f"QCR-{self.tag}", "name": f"QC review {self.tag}"})
        self.call(api.diag_qc_run_create, request=REQ, payload={"equipment_id": eq, "outcome": "passed"}, user=TECH)
        order, _ = self.new_confirmed_order(self.cbc)
        item_id = order["items"][0]["id"]
        self.collect_and_receive(item_id)
        self.finalize_cbc(item_id, 13.0, eq)
        hold_id = self.call(api.diag_qc_run_create, request=REQ, payload={"equipment_id": eq, "outcome": "failed"}, user=TECH)["hold_id"]
        hold = next(h for h in self.call(api.diag_qc_holds_list, user=TECH)["holds"] if h["id"] == hold_id)
        self.assertEqual([a["order_item_id"] for a in hold["affected_items"]], [item_id])
        self.call(api.diag_qc_hold_corrective_action, hold_id, request=REQ, payload={"corrective_action": "Recalibrated"}, user=TECH)
        self.call(api.diag_qc_hold_repeat, hold_id, request=REQ, payload={"outcome": "passed"}, user=TECH)
        exc = self.assertRejected(api.diag_qc_hold_release, hold_id, request=REQ, payload={}, user=TECH)
        self.assertIn("1 test(s)", str(exc))
        self.call(api.diag_qc_hold_release, hold_id, request=REQ, payload={"release_notes": "Re-ran sample, result confirmed"}, user=TECH)

    def test_write_is_rolled_back_when_audit_fails(self):
        audited = database.SessionLocal()
        audited.info[database.DEFER_COMMIT_KEY] = True
        try:
            with mock.patch.object(common.lq, "add_audit_log", side_effect=RuntimeError("audit store down")):
                with self.assertRaises(RuntimeError):
                    api.diag_equipment_create(request=REQ, payload={"asset_id": f"AUD-{self.tag}", "name": "Unaudited"}, db=audited, user=TECH)
        finally:
            audited.close()
        found = self.db.execute(text("SELECT COUNT(*) FROM diag_equipment WHERE asset_id = :a"), {"a": f"AUD-{self.tag}"}).scalar()
        self.assertEqual(found, 0, "equipment must not be saved without its audit row")

        audited = database.SessionLocal()
        audited.info[database.DEFER_COMMIT_KEY] = True
        try:
            eq_id = api.diag_equipment_create(request=REQ, payload={"asset_id": f"AUD-{self.tag}", "name": "Audited"}, db=audited, user=TECH)["equipment_id"]
        finally:
            audited.close()
        self.assertTrue(self.audit_rows("diag_equipment", eq_id, "create"))
        self.assertEqual(self.db.execute(text("SELECT name FROM diag_equipment WHERE id = :i"), {"i": eq_id}).scalar(), "Audited")


if __name__ == "__main__":
    unittest.main()
