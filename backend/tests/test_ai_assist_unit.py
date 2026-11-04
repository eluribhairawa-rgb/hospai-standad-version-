"""Unit tests for the AI-assist helpers: lab report summary drafts and prescription
suggestions (no database or model server needed).

Run from backend/:  .venv/bin/python -m unittest discover -s tests -v
"""
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import lab_interpretation as li  # noqa: E402
import prescription_suggestions as ps  # noqa: E402


def _result(name, value, flag, low=None, high=None, unit=""):
    return {"parameter_name": name, "value_numeric": value, "flag": flag, "ref_low": low, "ref_high": high, "unit": unit}


class LabInterpretationTests(unittest.TestCase):
    def test_all_normal_needs_no_model_call(self):
        with mock.patch.object(li, "_chat") as chat:
            out = li.draft_lab_interpretation("CBC", [_result("Hb", 13.5, "normal", 12, 16)])
        chat.assert_not_called()
        self.assertEqual(out, {"summary": li.ALL_NORMAL_TEXT, "source": "rule"})

    def test_no_values_entered_is_rejected(self):
        with self.assertRaises(ValueError):
            li.draft_lab_interpretation("CBC", [{"parameter_name": "Hb", "value_numeric": None, "value_text": ""}])

    def test_sentence_with_invented_number_is_dropped(self):
        reply = "Haemoglobin is low at 9.1 g/dL, suggestive of anaemia. Ferritin is likely 8 ng/mL. Suggest HbA1c and B12."
        with mock.patch.object(li, "_chat", return_value=reply):
            out = li.draft_lab_interpretation("CBC", [_result("Hb", 9.1, "low", 12, 16, "g/dL")], 40, "Female")
        self.assertEqual(out["source"], "ai")
        self.assertIn("9.1", out["summary"])
        self.assertNotIn("Ferritin", out["summary"])
        # Digits inside test names are not treated as values.
        self.assertIn("HbA1c and B12", out["summary"])

    def test_nothing_usable_raises(self):
        with mock.patch.object(li, "_chat", return_value="Value is 99.9."):
            with self.assertRaises(RuntimeError):
                li.draft_lab_interpretation("CBC", [_result("Hb", 9.1, "low", 12, 16)])


class PrescriptionSuggestionTests(unittest.TestCase):
    def test_counts_once_per_prescription_and_uses_common_details(self):
        rx = [{"id": i, "lab_tests": "CBC, Dengue NS1" if i < 3 else ("cbc" if i == 5 else "CBC")} for i in range(1, 6)]
        meds = [
            {"prescription_id": i, "medicine_name": "Tab Paracetamol 650mg", "dosage": "1 tab", "frequency": "1-1-1",
             "duration": "3 Days", "instructions": "After Food", "is_custom": 0, "freq_custom": None}
            for i in range(1, 5)
        ] + [
            {"prescription_id": 1, "medicine_name": "tab paracetamol  650mg", "dosage": "1 tab", "frequency": "1-0-1",
             "duration": "5 Days", "instructions": "", "is_custom": 0, "freq_custom": None},
            {"prescription_id": 5, "medicine_name": "Syp Rare", "dosage": "5 ml", "frequency": "SOS",
             "duration": "", "instructions": "", "is_custom": 1, "freq_custom": None},
        ]
        out = ps.aggregate(rx, meds)
        self.assertEqual(out["prescription_count"], 5)
        self.assertEqual(len(out["medicines"]), 1)  # one-off "Syp Rare" is left out with 5+ prescriptions
        para = out["medicines"][0]
        self.assertEqual((para["medicine_name"], para["frequency"], para["count"]), ("Tab Paracetamol 650mg", "1-1-1", 4))
        self.assertFalse(para["is_custom"])
        self.assertEqual(out["lab_tests"], [{"name": "CBC", "count": 5}, {"name": "Dengue NS1", "count": 2}])

    def test_single_prescription_still_suggests(self):
        out = ps.aggregate([{"id": 1, "lab_tests": ""}],
                           [{"prescription_id": 1, "medicine_name": "Tab Cetirizine 10mg", "frequency": "0-0-1"}])
        self.assertEqual([m["medicine_name"] for m in out["medicines"]], ["Tab Cetirizine 10mg"])
        self.assertEqual(out["lab_tests"], [])

    def test_short_diagnosis_skips_database(self):
        self.assertEqual(ps.suggest_for_diagnosis(None, "fe")["medicines"], [])


if __name__ == "__main__":
    unittest.main()
