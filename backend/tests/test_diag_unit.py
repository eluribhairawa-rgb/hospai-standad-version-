"""Unit tests for the Lab & Diagnostics pure helpers (no database needed).

Run from backend/:  .venv/bin/python -m unittest discover -s tests -v
"""
import os
import sys
import unittest
from datetime import date, datetime, timedelta
from unittest import mock

# database.py requires DATABASE_URL at import time; create_engine() never connects
# until a query runs, so a placeholder is enough for these DB-free tests. When the
# PostgreSQL suite runs in the same process it needs the engine bound to its test DB.
if os.environ.get("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import legacy_queries as lq  # noqa: E402
import qwen_ocr  # noqa: E402


class ResultFlagTests(unittest.TestCase):
    def test_critical_takes_priority_over_reference_range(self):
        self.assertEqual(lq._compute_result_flag(2.0, 12, 16, 7, 20), "critical_low")
        self.assertEqual(lq._compute_result_flag(25, 12, 16, 7, 20), "critical_high")

    def test_reference_range_flags(self):
        self.assertEqual(lq._compute_result_flag(10, 12, 16, 7, 20), "low")
        self.assertEqual(lq._compute_result_flag(17, 12, 16, 7, 20), "high")
        self.assertEqual(lq._compute_result_flag(14, 12, 16, 7, 20), "normal")

    def test_boundaries_are_inclusive_of_normal(self):
        self.assertEqual(lq._compute_result_flag(12, 12, 16, None, None), "normal")
        self.assertEqual(lq._compute_result_flag(16, 12, 16, None, None), "normal")

    def test_no_range_or_no_value_gives_no_flag(self):
        self.assertIsNone(lq._compute_result_flag(None, 12, 16, 7, 20))
        self.assertIsNone(lq._compute_result_flag(5, None, None, None, None))
        self.assertIsNone(lq._compute_result_flag("abc", 1, 2, None, None))


class TatStatusTests(unittest.TestCase):
    def test_on_time_near_due_overdue(self):
        now = datetime(2026, 1, 1, 12, 0)
        self.assertEqual(lq._tat_status(now - timedelta(hours=1), 4, now)["tat_status"], "on_time")
        self.assertEqual(lq._tat_status(now - timedelta(hours=3.5), 4, now)["tat_status"], "near_due")
        self.assertEqual(lq._tat_status(now - timedelta(hours=5), 4, now)["tat_status"], "overdue")

    def test_never_fabricated_without_target_or_start(self):
        self.assertIsNone(lq._tat_status(None, 4)["tat_status"])
        self.assertIsNone(lq._tat_status(datetime.now(), None)["tat_status"])
        self.assertIsNone(lq._tat_status(datetime.now(), 0)["tat_status"])

    def test_iso_string_start(self):
        now = datetime(2026, 1, 1, 12, 0)
        res = lq._tat_status("2026-01-01T10:00:00", 4, now)
        self.assertEqual(res["elapsed_hours"], 2.0)


class CancellationBalanceTests(unittest.TestCase):
    def test_unpaid_invoice_needs_no_refund(self):
        # total 1000 -> cancel 400 -> new total 600, nothing paid
        self.assertEqual(lq._invoice_balance_after_cancellation(600, 0, 0, 0), (0.0, 0.0, 600.0, "due"))

    def test_fully_paid_invoice_refunds_cancelled_amount(self):
        refund, refunded, due, status = lq._invoice_balance_after_cancellation(600, 1000, 0, 0)
        self.assertEqual((refund, refunded, due, status), (400.0, 400.0, 0.0, "paid"))

    def test_partially_paid_overpayment_is_refunded(self):
        # total 1000, paid 600; cancel 500 -> total 500, 100 must go back
        refund, refunded, due, status = lq._invoice_balance_after_cancellation(500, 600, 0, 0)
        self.assertEqual((refund, refunded, due, status), (100.0, 100.0, 0.0, "paid"))

    def test_partial_payment_still_below_new_total(self):
        refund, refunded, due, status = lq._invoice_balance_after_cancellation(800, 300, 0, 0)
        self.assertEqual((refund, refunded, due, status), (0.0, 0.0, 500.0, "partial"))

    def test_everything_cancelled_after_payment_is_refunded(self):
        refund, refunded, due, status = lq._invoice_balance_after_cancellation(0, 700, 0, 0)
        self.assertEqual((refund, refunded, due, status), (700.0, 700.0, 0.0, "refunded"))

    def test_earlier_refunds_are_respected(self):
        # paid 1000, already refunded 200 (net 800); new total 500 -> refund 300 more
        refund, refunded, due, status = lq._invoice_balance_after_cancellation(500, 1000, 0, 200)
        self.assertEqual((refund, refunded, due, status), (300.0, 500.0, 0.0, "paid"))


class ReagentExpiryTests(unittest.TestCase):
    def test_expiry(self):
        today = date(2026, 5, 10)
        self.assertTrue(lq._reagent_lot_is_expired("2026-05-09", today))
        self.assertFalse(lq._reagent_lot_is_expired("2026-05-10", today))
        self.assertFalse(lq._reagent_lot_is_expired(None, today))
        self.assertTrue(lq._reagent_lot_is_expired(date(2020, 1, 1), today))

    def test_bad_date_is_rejected(self):
        with self.assertRaises(ValueError):
            lq._reagent_lot_is_expired("10/05/2026")

    def test_status_change_validates_status_before_db(self):
        with self.assertRaises(ValueError):
            lq.update_diag_reagent_lot_status(None, 1, "bogus")

    def test_receiving_expired_lot_is_rejected_before_db(self):
        with self.assertRaises(ValueError):
            lq.create_diag_reagent_lot(None, {"item_name": "Glucose reagent", "lot_no": "L1", "expiry_date": "2000-01-01"})


class ReportSnapshotHelpersTests(unittest.TestCase):
    def test_strip_snapshot_from_client_content(self):
        content = {"summary": "ok", lq.RESULTS_SNAPSHOT_KEY: [{"value_numeric": 1}]}
        self.assertEqual(lq._strip_results_snapshot(content), {"summary": "ok"})
        self.assertEqual(content[lq.RESULTS_SNAPSHOT_KEY], [{"value_numeric": 1}], "input must not be mutated")

    def test_content_dict_parsing(self):
        self.assertEqual(lq._report_content_dict(None), {})
        self.assertEqual(lq._report_content_dict('{"a": 1}'), {"a": 1})
        self.assertEqual(lq._report_content_dict("[1, 2]"), {})
        self.assertEqual(lq._report_content_dict("not json"), {})


class CriticalAlertValidationTests(unittest.TestCase):
    def test_escalation_requires_target(self):
        with self.assertRaises(ValueError):
            lq.escalate_diag_critical_alert(None, 1, "  ")

    def test_cancellation_requires_reason(self):
        with self.assertRaises(ValueError):
            lq.cancel_diag_order_item(None, 1, "")


class OcrParsingTests(unittest.TestCase):
    PARAMS = [
        {"id": 1, "name": "Haemoglobin", "data_type": "numeric", "unit": "g/dL"},
        {"id": 2, "name": "Platelet Count", "data_type": "numeric", "unit": "/cumm"},
        {"id": 3, "name": "HBsAg", "data_type": "qualitative"},
        {"id": 4, "name": "WBC", "data_type": "numeric"},
    ]

    def test_numeric_parsing(self):
        self.assertEqual(qwen_ocr._lab_numeric("13.4 g/dL H"), "13.4")
        self.assertEqual(qwen_ocr._lab_numeric("2,50,000"), "250000")
        self.assertEqual(qwen_ocr._lab_numeric("1,500"), "1500")
        self.assertEqual(qwen_ocr._lab_numeric("13,4"), "13.4")
        self.assertEqual(qwen_ocr._lab_numeric("Hb 13,4 g/dL"), "13.4")
        self.assertEqual(qwen_ocr._lab_numeric("-2.5"), "-2.5")
        self.assertIsNone(qwen_ocr._lab_numeric("Positive"))

    def test_mapping_onto_configured_parameters_only(self):
        model_reply = """```json
        {"results": [
            {"parameter_id": 1, "value": "13.4 g/dL"},
            {"parameter_id": 2, "value": "2,50,000"},
            {"parameter_id": 3, "value": "Non-reactive"},
            {"parameter_id": 4, "value": "see note"},
            {"parameter_id": 99, "value": "5"},
            {"parameter_id": "x", "value": "5"}
        ], "equipment": "Sysmex XN-350", "patient_name": "Ravi Kumar", "sample_id": "SPC-260101-1234"}
        ```"""
        with mock.patch.object(qwen_ocr, "_chat", return_value=model_reply), \
                mock.patch.object(qwen_ocr, "_image_to_data_url", return_value="data:image/png;base64,"):
            out = qwen_ocr.extract_lab_results(b"img", self.PARAMS, "CBC")
        self.assertEqual(
            {v["parameter_id"]: v["value"] for v in out["values"]},
            {1: "13.4", 2: "250000", 3: "Non-reactive"},
        )
        self.assertEqual(out["equipment"], "Sysmex XN-350")
        self.assertEqual(out["sample_id"], "SPC-260101-1234")

    def test_censored_values_are_not_autofilled(self):
        reply = '{"results": [{"parameter_id": 1, "value": "<0.5"}, {"parameter_id": 4, "value": "> 1000"}, {"parameter_id": 2, "value": "150000"}]}'
        with mock.patch.object(qwen_ocr, "_chat", return_value=reply), \
                mock.patch.object(qwen_ocr, "_image_to_data_url", return_value="data:image/png;base64,"):
            out = qwen_ocr.extract_lab_results(b"img", self.PARAMS)
        self.assertEqual(out["values"], [{"parameter_id": 2, "value": "150000"}])
        self.assertEqual([(s["parameter_id"], s["value"]) for s in out["skipped"]], [(1, "<0.5"), (4, "> 1000")])

    def test_unreadable_model_reply_raises(self):
        with mock.patch.object(qwen_ocr, "_chat", return_value="sorry, cannot read"), \
                mock.patch.object(qwen_ocr, "_image_to_data_url", return_value="data:image/png;base64,"):
            with self.assertRaises(RuntimeError):
                qwen_ocr.extract_lab_results(b"img", self.PARAMS)

    def test_identity_warnings(self):
        ok = {"patient_name": "RAVI KUMAR", "sample_id": "SPC-260101-1234"}
        self.assertEqual(qwen_ocr.lab_identity_warnings(ok, "Ravi Kumar", ["SPC-260101-1234"]), [])
        wrong_patient = {"patient_name": "Sita Devi", "sample_id": ""}
        self.assertEqual(len(qwen_ocr.lab_identity_warnings(wrong_patient, "Ravi Kumar", ["SPC-260101-1234"])), 1)
        wrong_sample = {"patient_name": "", "sample_id": "SPC-260101-9999"}
        self.assertEqual(len(qwen_ocr.lab_identity_warnings(wrong_sample, "Ravi Kumar", ["SPC-260101-1234"])), 1)
        # External labs print their own accession numbers -- not compared.
        external = {"patient_name": "Ravi K", "sample_id": "ACC/889812"}
        self.assertEqual(qwen_ocr.lab_identity_warnings(external, "Ravi Kumar", ["SPC-260101-1234"]), [])


if __name__ == "__main__":
    unittest.main()
