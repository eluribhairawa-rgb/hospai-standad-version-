"""Unit tests for phone validation by country (phone.py). No database needed.

Run from backend/:  .venv/bin/python -m unittest tests.test_phone_unit -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import phone  # noqa: E402


class ValidatePhoneTests(unittest.TestCase):
    def test_length_follows_country(self):
        cases = [("9876543210", "+91", True), ("939145189787654", "+91", False), ("501234567", "+971", True),
                 ("5012345678", "+971", False), ("81234567", "+65", True), ("812345678", "+65", False)]
        for value, code, ok in cases:
            with self.subTest(value=value, code=code):
                digits, out_code, error = phone.validate_phone(value, code)
                self.assertEqual(out_code, code)
                self.assertEqual(error is None, ok, error)

    def test_country_prefix_and_trunk_zero_are_stripped(self):
        self.assertEqual(phone.validate_phone("+971 50 123 4567", "+971")[:2], ("501234567", "+971"))
        self.assertEqual(phone.validate_phone("09876543210", "+91")[0], "9876543210")

    def test_blank_and_required(self):
        self.assertEqual(phone.validate_phone("", "+91"), ("", "+91", None))
        self.assertIn("required", phone.validate_phone(None, "+91", required=True, label="Phone")[2])

    def test_unknown_code_falls_back_to_india(self):
        self.assertEqual(phone.clean_country_code("+999"), "+91")
        self.assertEqual(phone.clean_country_code("971"), "+971")
        self.assertEqual(phone.clean_country_code(None), "+91")

    def test_landline_allows_helplines(self):
        self.assertIsNone(phone.validate_phone("18004253800", "+91", landline=True)[2])
        self.assertIsNotNone(phone.validate_phone("18004253800", "+91")[2])
        self.assertIsNotNone(phone.validate_phone("12345", "+91", landline=True)[2])

    def test_to_international(self):
        self.assertEqual(phone.to_international("501234567", "+971"), "971501234567")
        self.assertEqual(phone.to_international("", "+971"), "")


if __name__ == "__main__":
    unittest.main()
