"""Unit tests for the Pharmacy Profit & Loss calculations (pharmacy_profit.py).
No database is needed: the pure merge/summary helpers are exercised directly.

Run from backend/:  .venv/bin/python -m unittest tests.test_pharmacy_profit_unit -v
"""
import os
import sys
import unittest
from datetime import date

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pharmacy_profit as pp  # noqa: E402


def rows(**facts):
    base = dict(inventory={}, grn={}, master={}, sales={}, returns={})
    base.update(facts)
    return {r["medicine_key"]: r for r in pp.build_rows(**base)}


class EffectiveCostTests(unittest.TestCase):
    def test_discount_and_free_goods_lower_unit_cost(self):
        # 100 received of which 10 free, rate 20 less 10% -> 18 x 90/100
        self.assertEqual(pp.effective_unit_cost(20, 10, 100, 10), 16.2)

    def test_plain_rate(self):
        self.assertEqual(pp.effective_unit_cost(18.5, 0, 0, 0), 18.5)

    def test_missing_rate_is_unknown_not_zero(self):
        self.assertIsNone(pp.effective_unit_cost(0, 0, 10, 0))
        self.assertIsNone(pp.effective_unit_cost(None))


class BuildRowsTests(unittest.TestCase):
    def test_profit_uses_net_revenue_and_restocked_units(self):
        r = rows(
            inventory={"dolo": {"qty_in_stock": 5, "current_sale_price": 14, "display_name": "Dolo"}},
            grn={"dolo": {"unit_cost": 10.0, "grn_no": "GRN-1"}},
            sales={"dolo": {"qty_sold": 20, "revenue": 280}},
            # 2 returned: 1 released back to shelf, 1 rejected (destroyed)
            returns={"dolo": {"qty_returned": 2, "qty_restocked": 1, "refund": 28}},
        )["dolo"]
        self.assertEqual(r["net_revenue"], 252)
        self.assertEqual(r["cogs"], 190)          # (20 - 1 restocked) x 10
        self.assertEqual(r["profit_earned"], 62)
        self.assertEqual(r["unit_margin"], 4)
        self.assertEqual(r["margin_pct"], 28.6)
        self.assertEqual(r["net_qty"], 18)

    def test_one_row_per_medicine_and_sold_out_items_kept(self):
        r = rows(
            inventory={"a": {"qty_in_stock": 3}, "b": {"qty_in_stock": 0}, "c": {"qty_in_stock": 0}},
            sales={"b": {"qty_sold": 1, "revenue": 5}},
        )
        self.assertEqual(sorted(r), ["a", "b"])   # c: out of stock and unsold

    def test_inactive_master_medicine_is_excluded(self):
        r = rows(
            inventory={"old": {"qty_in_stock": 4}, "new": {"qty_in_stock": 4}},
            master={"old": {"name": "Old", "active": 0}, "new": {"name": "New", "active": 1}},
        )
        self.assertEqual(list(r), ["new"])
        self.assertEqual(r["new"]["medicine_name"], "New")

    def test_unknown_cost_gives_unknown_profit(self):
        r = rows(inventory={"x": {"qty_in_stock": 1}}, sales={"x": {"qty_sold": 2, "revenue": 10}})["x"]
        self.assertIsNone(r["cost_price"])
        self.assertIsNone(r["profit_earned"])

    def test_batch_cost_fallback_when_no_grn(self):
        r = rows(inventory={"x": {"qty_in_stock": 1, "last_batch_cost": 7, "current_sale_price": 9}})["x"]
        self.assertEqual((r["cost_price"], r["cost_source"]), (7, "batch"))

    def test_sold_out_item_uses_last_dispensing_rate_before_grn_price(self):
        r = rows(
            inventory={"amox": {"qty_in_stock": 0, "last_sale_price": 100}},
            grn={"amox": {"unit_cost": 5.0, "selling_price": 9}},
            sales={"amox": {"qty_sold": 1, "revenue": 100}},
        )["amox"]
        self.assertEqual((r["sale_price"], r["sale_price_source"]), (100, "last_batch"))

    def test_below_cost_flag(self):
        r = rows(inventory={"x": {"qty_in_stock": 1, "current_sale_price": 175}}, grn={"x": {"unit_cost": 1050.0}})["x"]
        self.assertTrue(r["below_cost"])


class SummaryTests(unittest.TestCase):
    def test_cards(self):
        r = list(rows(
            inventory={"a": {"qty_in_stock": 1, "current_sale_price": 10}, "b": {"qty_in_stock": 1, "current_sale_price": 10},
                       "c": {"qty_in_stock": 1, "current_sale_price": 10}},
            grn={"a": {"unit_cost": 5.0}, "b": {"unit_cost": 8.0}, "c": {"unit_cost": 50.0}},
            sales={"a": {"qty_sold": 2, "revenue": 20}, "b": {"qty_sold": 1, "revenue": 10}},
        ).values())
        s = pp.summarize(r, profit_today=3, near_expiry={})
        self.assertTrue(s["has_sales"])
        self.assertEqual(s["profit_period"], 12)      # (20-10) + (10-8)
        self.assertEqual(s["gross_margin_pct"], 40.0)
        self.assertEqual(s["avg_supplier_margin_pct"], 20.0)  # median of 50, 20, -400
        self.assertEqual(s["top_medicine"]["profit_earned"], 10)
        self.assertEqual(s["below_cost_count"], 1)

    def test_empty_period(self):
        s = pp.summarize(list(rows(inventory={"a": {"qty_in_stock": 1}}).values()), 0, {})
        self.assertFalse(s["has_sales"])
        self.assertIsNone(s["top_medicine"])
        self.assertIsNone(s["gross_margin_pct"])

    def test_near_expiry_exposure(self):
        batches = [{"mkey": "a", "qty_available": 10, "unit_price": 12, "purchase_price": 8},
                   {"mkey": "b", "qty_available": 5, "unit_price": 0, "purchase_price": 0}]
        out = pp.near_expiry_exposure(batches, {"b": {"cost_price": 20, "sale_price": 15}})
        self.assertEqual(out["margin_at_risk"], 40)   # b is below cost: no margin to lose
        self.assertEqual(out["cost_at_risk"], 180)
        self.assertEqual(out["batch_count"], 2)


class PagingAndPeriodTests(unittest.TestCase):
    def test_sort_puts_unknown_values_last_and_pages(self):
        data = [{"medicine_name": n, "profit_earned": p} for n, p in [("a", 5), ("b", None), ("c", 9), ("d", 1)]]
        page, total, pg, size, pages = pp.sort_and_page(data, "profit_earned", "desc", 1, 2)
        self.assertEqual([r["medicine_name"] for r in page], ["c", "a"])
        page, *_ = pp.sort_and_page(data, "profit_earned", "asc", 2, 2)
        self.assertEqual([r["medicine_name"] for r in page], ["c", "b"])
        self.assertEqual((total, pages), (4, 2))

    def test_invalid_sort_field_falls_back(self):
        data = [{"medicine_name": "a", "profit_earned": 1}]
        self.assertEqual(pp.sort_and_page(data, "DROP TABLE", "desc")[1], 1)

    def test_period_defaults_to_month_to_date(self):
        self.assertEqual(pp.resolve_period(today=date(2026, 11, 10)), (date(2026, 11, 1), date(2026, 11, 10)))

    def test_period_validation(self):
        with self.assertRaises(ValueError):
            pp.resolve_period("2026-11-10", "2026-11-01")
        with self.assertRaises(ValueError):
            pp.resolve_period("2024-01-01", "2026-01-01")
        with self.assertRaises(ValueError):
            pp.resolve_period("10/11/2026", None, today=date(2026, 11, 10))

    def test_like_escaping(self):
        self.assertEqual(pp.escape_like("50%_a\\b"), "50\\%\\_a\\\\b")


if __name__ == "__main__":
    unittest.main()
