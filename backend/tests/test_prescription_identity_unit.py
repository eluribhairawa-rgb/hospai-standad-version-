"""Uploaded prescription must belong to the selected patient: UHID and name are checked."""
import unittest

import qwen_ocr as q

UHID = "PAT-20261111-0055"
NAME = "Ramya Kumari"


def check(printed_uhid="", printed_name="", uhid=UHID, name=NAME):
    return q.prescription_identity_check({"patient_uhid": printed_uhid, "patient_name": printed_name}, uhid, name)


class NameMatching(unittest.TestCase):
    def test_same_name_in_any_order_or_form(self):
        for printed in ("Ramya Kumari", "KUMARI RAMYA", "Ramya", "Mrs. Ramya Kumari", "Ramya K", "ramya  kumari"):
            self.assertTrue(q.prescription_name_matches(printed, NAME), printed)

    def test_one_small_ocr_slip_is_tolerated(self):
        self.assertTrue(q.prescription_name_matches("Ramaya Kumari", NAME))

    def test_shared_surname_is_not_enough(self):
        self.assertFalse(q.prescription_name_matches("Suresh Kumari", NAME))
        self.assertFalse(q.prescription_name_matches("Ravi Kumar", "Suresh Kumar"))

    def test_different_names_do_not_match(self):
        self.assertFalse(q.prescription_name_matches("Arjun Mehta", NAME))

    def test_nothing_to_compare_is_unknown(self):
        self.assertIsNone(q.prescription_name_matches("", NAME))
        self.assertIsNone(q.prescription_name_matches("Dr.", NAME))


class UhidMatching(unittest.TestCase):
    def test_exact_in_any_formatting(self):
        for printed in (UHID, "pat-20261111-0055", "PAT 20261111 0055", "PAT202611110055"):
            self.assertTrue(q.prescription_uhid_matches(printed, UHID), printed)

    def test_ocr_lookalikes_are_folded(self):
        self.assertTrue(q.prescription_uhid_matches("PAT-2O261111-OO55", UHID))

    def test_neighbouring_uhid_is_not_accepted(self):
        # UHIDs are sequential: one digit off is a different patient, never an OCR slip.
        self.assertFalse(q.prescription_uhid_matches("PAT-20261111-0056", UHID))
        self.assertFalse(q.prescription_uhid_matches("PAT-20261110-0055", UHID))

    def test_no_uhid_printed_is_unknown(self):
        self.assertIsNone(q.prescription_uhid_matches("", UHID))
        self.assertIsNone(q.prescription_uhid_matches("55", UHID))


class IdentityDecision(unittest.TestCase):
    def test_both_match(self):
        r = check(UHID, "Ramya Kumari")
        self.assertTrue(r["ok"]); self.assertEqual(r["verified_by"], "UHID and name")

    def test_uhid_matches_name_not_printed(self):
        r = check(UHID, "")
        self.assertTrue(r["ok"]); self.assertEqual(r["verified_by"], "UHID")

    def test_name_matches_uhid_not_printed(self):
        r = check("", "Ramya Kumari")
        self.assertTrue(r["ok"]); self.assertEqual(r["verified_by"], "name")

    def test_wrong_uhid_is_refused_even_if_name_matches(self):
        r = check("PAT-20261111-0099", "Ramya Kumari")
        self.assertFalse(r["ok"]); self.assertTrue(r["message"].startswith("UHID doesn't match"))

    def test_wrong_name_is_refused_even_if_uhid_matches(self):
        r = check(UHID, "Arjun Mehta")
        self.assertFalse(r["ok"]); self.assertTrue(r["message"].startswith("Patient name doesn't match"))

    def test_both_wrong(self):
        r = check("PAT-20261111-0099", "Arjun Mehta")
        self.assertFalse(r["ok"]); self.assertTrue(r["message"].startswith("UHID and patient name don't match"))
        self.assertIn("Arjun Mehta", r["message"]); self.assertIn(UHID, r["message"])

    def test_nothing_readable_cannot_be_confirmed(self):
        r = check("", "")
        self.assertFalse(r["ok"]); self.assertIn("can't be confirmed", r["message"])

    def test_clean_prescription_keeps_the_printed_uhid(self):
        cleaned = q._clean_prescription({"patient_name": " Ramya ", "patient_uhid": " PAT-20261111-0055 "})
        self.assertEqual(cleaned["patient_uhid"], "PAT-20261111-0055")
        self.assertEqual(cleaned["patient_name"], "Ramya")


if __name__ == "__main__":
    unittest.main()
