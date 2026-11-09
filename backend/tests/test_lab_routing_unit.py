"""Unit tests for lab order routing decisions (no database needed).

Run from backend/:  .venv/bin/python -m unittest tests.test_lab_routing_unit -v
"""
import os
import sys
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import diag_service_types as dst  # noqa: E402


def eq(name, status="ready", hold=None):
    return {"name": name, "operational_status": status, "open_hold_scope": hold}


class HomeVisitRoutingTests(unittest.TestCase):
    def test_ready_machine_runs_in_house(self):
        routing, reason, vendor = dst.decide_routing("HOME_VISIT", "LAB", [eq("Sysmex XN")], preferred_vendor_id=7)
        self.assertEqual((routing, vendor), (dst.IN_HOUSE, None))
        self.assertIn("Sysmex XN available", reason)

    def test_unlinked_test_stays_in_house(self):
        routing, reason, vendor = dst.decide_routing("HOME_VISIT", "LAB", [], preferred_vendor_id=7)
        self.assertEqual((routing, vendor), (dst.IN_HOUSE, None))
        self.assertIn("No equipment linked", reason)

    def test_one_ready_machine_among_several_is_enough(self):
        routing, reason, _ = dst.decide_routing(
            "HOME_VISIT", "LAB", [eq("Cobas", "down"), eq("Erba", hold="equipment"), eq("Mindray")], preferred_vendor_id=7)
        self.assertEqual(routing, dst.IN_HOUSE)
        self.assertIn("Mindray", reason)

    def test_unavailable_equipment_outsources_to_preferred_vendor(self):
        cases = [
            (eq("Cobas", "maintenance"), "under maintenance"),
            (eq("Cobas", "down"), "down"),
            (eq("Cobas", "qc_hold"), "on QC hold"),
            (eq("Cobas", hold="equipment"), "on QC hold"),
            (eq("Cobas", hold="assay"), "on QC hold for this test"),
        ]
        for machine, label in cases:
            with self.subTest(label=label, machine=machine):
                routing, reason, vendor = dst.decide_routing("HOME_VISIT", "LAB", [machine], preferred_vendor_id=7)
                self.assertEqual((routing, vendor), (dst.OUTSOURCED, 7))
                self.assertIn(f"Cobas {label}", reason)

    def test_no_preferred_vendor_waits_for_staff(self):
        routing, reason, vendor = dst.decide_routing("HOME_VISIT", "LAB", [eq("Cobas", "down")])
        self.assertEqual((routing, vendor), (dst.PENDING_VENDOR, None))
        self.assertIn("select a partner lab", reason)

    def test_imaging_and_other_are_never_routed(self):
        for dept in ("IMAGING", "OTHER"):
            self.assertEqual(dst.decide_routing("HOME_VISIT", dept, [eq("X", "down")], 7), (None, None, None))


class OutsourcingRoutingTests(unittest.TestCase):
    def test_uses_chosen_vendor_and_ignores_equipment(self):
        routing, _, vendor = dst.decide_routing("OUTSOURCING", "LAB", [eq("Sysmex")], preferred_vendor_id=9, vendor_id=3)
        self.assertEqual((routing, vendor), (dst.OUTSOURCED, 3))

    def test_missing_vendor_is_pending(self):
        self.assertEqual(dst.decide_routing("OUTSOURCING", "LAB", [], vendor_id=None)[0], dst.PENDING_VENDOR)


class UnroutedServiceTypesTests(unittest.TestCase):
    def test_in_house_and_external_orders_keep_existing_flow(self):
        for service_type in ("IN_HOUSE", "EXTERNAL", None, "bogus"):
            self.assertEqual(dst.decide_routing(service_type, "LAB", [eq("X", "down")], 7, 3), (None, None, None))


class SettingsValidationTests(unittest.TestCase):
    def test_fee_bounds(self):
        self.assertEqual(dst.parse_fee("150.456"), 150.46)
        self.assertEqual(dst.parse_fee(0), 0)
        for bad in ("-1", "abc", None, dst.MAX_HOME_VISIT_FEE + 1):
            with self.assertRaises(ValueError):
                dst.parse_fee(bad)

    def test_unknown_setting_rejected_before_db(self):
        with self.assertRaises(ValueError):
            dst.update_settings(None, {"discount": 5})


if __name__ == "__main__":
    unittest.main()
