"""Unit tests for the unified lab-result import (CSV layouts, parameter matching, routing).
No database or OCR model needed: model calls are mocked.

Run from backend/:  .venv/bin/python -m unittest tests.test_lab_result_import_unit -v
"""
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import file_import as fi  # noqa: E402
import lab_result_import as lri  # noqa: E402

CBC = [
    {"id": 1, "name": "Haemoglobin", "data_type": "numeric", "unit": "g/dL"},
    {"id": 2, "name": "Total Leucocyte Count", "data_type": "numeric"},
    {"id": 3, "name": "Platelet Count", "data_type": "numeric"},
    {"id": 4, "name": "Peripheral Smear", "data_type": "text"},
]


def values(out):
    return {v["parameter_id"]: v["value"] for v in out["values"]}


class LongLayoutTests(unittest.TestCase):
    def test_partner_lab_report_with_preamble_units_and_sections(self):
        csv_bytes = (
            "Apex Diagnostics Pvt Ltd\nPatient: Ravi Kumar\n\n"
            "Investigation,Result,Units,Biological Reference Interval,Flag\n"
            "HAEMATOLOGY,,,,\n"
            "Hb,13.4 g/dL,g/dL,12-16,\n"
            "TLC,\"11,200\",cells/cumm,4000-11000,H\n"
            "Platelets,<20000,/cumm,150000-450000,L\n"
            "Peripheral Smear,Normocytic normochromic,,,\n"
            "Vitamin D,32,ng/mL,30-100,\n"
        ).encode()
        out = lri.import_lab_results("apex.csv", csv_bytes, CBC, patient_name="Ravi Kumar")
        self.assertEqual((out["file_type"], out["processing"], out["layout"]), ("csv", "csv_direct", "long"))
        self.assertEqual(values(out), {1: "13.4", 2: "11200", 4: "Normocytic normochromic"})
        self.assertEqual([s["parameter_id"] for s in out["skipped"]], [3])  # censored "<20000" never filled
        self.assertEqual([u["name"] for u in out["unmatched"]], ["Vitamin D"])  # section heading not reported
        self.assertEqual(out["field_mapping"]["Investigation"], "parameter")
        self.assertTrue(any("Skipped 3 line" in w for w in out["warnings"]))
        self.assertEqual(out["identity_warnings"], [])

    def test_semicolon_and_patient_column_identity_warning(self):
        csv_bytes = b"Patient Name;Test Name;Value\nSita Devi;Haemoglobin;9.1\n"
        out = lri.import_lab_results("r.csv", csv_bytes, CBC, patient_name="Ravi Kumar")
        self.assertEqual(values(out), {1: "9.1"})
        self.assertEqual(len(out["identity_warnings"]), 1)

    def test_duplicate_parameter_keeps_first_and_warns(self):
        out = lri.import_lab_results("r.csv", b"Test,Result\nHb,13\nHGB,14\n", CBC)
        self.assertEqual(values(out), {1: "13"})
        self.assertTrue(any("more than once" in w for w in out["warnings"]))


class WideLayoutTests(unittest.TestCase):
    def test_analyser_export_picks_this_patients_sample(self):
        csv_bytes = (
            "Sample ID,Date,HGB (g/dL),WBC,PLT,MPV\n"
            "SPC-260101-0001,2026-11-09,10.2,5600,210000,9.1\n"
            "SPC-260101-1234,2026-11-09,13.9,7200,250000,8.8\n"
        ).encode()
        out = lri.import_lab_results("xn.csv", csv_bytes, CBC, specimen_nos=["SPC-260101-1234"])
        self.assertEqual(out["layout"], "wide")
        self.assertEqual(values(out), {1: "13.9", 2: "7200", 3: "250000"})
        self.assertEqual(out["field_mapping"]["HGB (g/dL)"], "parameter: Haemoglobin")
        self.assertEqual(out["field_mapping"]["Date"], "ignore")
        self.assertEqual([u["name"] for u in out["unmatched"]], ["MPV"])
        self.assertEqual(out["sample_id"], "SPC-260101-1234")
        self.assertEqual(out["identity_warnings"], [])

    def test_multiple_rows_without_sample_match_warns(self):
        out = lri.import_lab_results("xn.csv", b"HGB,PLT\n10,1\n11,2\n", CBC)
        self.assertEqual(values(out), {1: "10", 3: "1"})
        self.assertTrue(any("2 sample rows" in w for w in out["warnings"]))


class MatchingTests(unittest.TestCase):
    def test_synonyms_and_bracketed_abbreviations(self):
        m = lri.ParameterMatcher([{"id": 9, "name": "Alanine Aminotransferase (ALT)"}, {"id": 8, "name": "Fasting Blood Sugar"}])
        self.assertEqual(m.match("SGPT")[0]["id"], 9)
        self.assertEqual(m.match("alt")[0]["id"], 9)
        self.assertEqual(m.match("Glucose - Fasting")[0]["id"], 8)
        self.assertIsNone(m.match("Bilirubin")[0])

    def test_ambiguous_match_is_not_guessed(self):
        m = lri.ParameterMatcher([{"id": 1, "name": "Hb"}, {"id": 2, "name": "Haemoglobin"}])
        self.assertEqual(m.match("Hb")[0]["id"], 1)  # exact name wins
        param, reason = m.match("HGB")
        self.assertIsNone(param)
        self.assertIn("more than one", reason)


class RoutingAndErrorTests(unittest.TestCase):
    def test_unrecognised_csv_returns_preview_and_explains(self):
        out = lri.import_lab_results("x.csv", b"Foo,Bar\n1,2\n", CBC)
        self.assertIsNone(out["layout"])
        self.assertEqual(out["values"], [])
        self.assertEqual(out["preview"], [{"Foo": "1", "Bar": "2"}])
        self.assertTrue(any("Could not recognise" in w for w in out["warnings"]))

    def test_errors(self):
        cases = [("x.csv", b"", 400), ("x.csv", b"Test,Result\n", 400), ("x.xlsx", b"PK\x03\x04", 415),
                 ("x.csv", b"a" * (fi.MAX_UPLOAD_BYTES + 1), 413), ("x.pdf", b"not a pdf", 400 if fi.PdfReader else 503)]
        for name, content, status in cases:
            with self.subTest(name=name, status=status), self.assertRaises(fi.FileImportError) as ctx:
                lri.import_lab_results(name, content, CBC)
            self.assertEqual(ctx.exception.status_code, status)
        with self.assertRaises(fi.FileImportError):
            lri.import_lab_results("x.csv", b"Test,Result\nHb,1\n", [])

    def test_csv_never_calls_the_model(self):
        with mock.patch.object(lri.qwen_ocr, "_chat") as chat:
            lri.import_lab_results("x.csv", b"Test,Result\nHb,12\n", CBC)
        chat.assert_not_called()

    def test_image_goes_through_ocr_and_keeps_existing_shape(self):
        ocr = {"values": [{"parameter_id": 1, "value": "12.5"}], "skipped": [], "equipment": "XN-1000",
               "patient_name": "Ravi Kumar", "sample_id": ""}
        with mock.patch.object(lri.qwen_ocr, "extract_lab_results", return_value=ocr) as fn:
            out = lri.import_lab_results("scan.JPG", b"\xff\xd8\xff", CBC, "CBC", "Ravi Kumar")
        fn.assert_called_once()
        self.assertEqual((out["file_type"], out["processing"], out["equipment"]), ("image", "ocr_image", "XN-1000"))
        self.assertEqual(out["detected_fields"], ["Haemoglobin"])
        for key in ("values", "skipped", "identity_warnings", "patient_name", "sample_id"):
            self.assertIn(key, out)

    def test_ocr_failures(self):
        empty = {"values": [], "skipped": [], "equipment": "", "patient_name": "", "sample_id": ""}
        for effect, status in ((RuntimeError("down"), 502), (ValueError("bad image"), 400), (empty, 422)):
            kwargs = {"side_effect": effect} if isinstance(effect, Exception) else {"return_value": effect}
            with mock.patch.object(lri.qwen_ocr, "extract_lab_results", **kwargs), self.assertRaises(fi.FileImportError) as ctx:
                lri.import_lab_results("scan.png", b"\x89PNG", CBC)
            self.assertEqual(ctx.exception.status_code, status)


if __name__ == "__main__":
    unittest.main()
