"""A discharged stay is shown from what its discharge invoice(s) really billed and collected,
whichever discharge screen created them."""
import unittest
from decimal import Decimal

import billing_service as bs


class FakeCursor:
    """Returns the queued result sets, in order, one per execute()."""
    def __init__(self, *result_sets):
        self.queue = list(result_sets)
        self.executed = []

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.queue.pop(0)


def inv(id, no, total, paid, due, subtotal=0, discount=0, status="paid"):
    return {"id": id, "invoice_no": no, "total_amount": total, "subtotal": subtotal, "discount": discount,
            "paid_amount": paid, "due_amount": due, "payment_status": status, "created_at": "2026-11-12 11:42:52"}


def pay(id, invoice_id, amount, mode="cash", receipt=None):
    return {"id": id, "invoice_id": invoice_id, "amount": amount, "payment_mode": mode, "gateway_ref": None,
            "created_at": "2026-11-12 11:42:52", "receipt_no": receipt, "canonical_receipt_id": None}


class AdmissionSettlement(unittest.TestCase):
    def test_no_discharge_invoice_means_not_settled(self):
        self.assertIsNone(bs._admission_settlement(FakeCursor([]), 31))

    def test_inpatient_screen_invoice_paid_in_full(self):
        # INV-DIS-*: subtotal set, paid_amount = collected, nothing from advances.
        cur = FakeCursor([inv(88, "INV-DIS-20261112114252", 4850, 4850, 0, subtotal=4850)], [pay(85, 88, 4850)], [])
        s = bs._admission_settlement(cur, 31)
        self.assertEqual((s["total"], s["collected"], s["due"], s["advance_applied"]),
                         (Decimal("4850.00"), Decimal("4850.00"), Decimal("0.00"), Decimal("0.00")))
        self.assertEqual(s["billed_gross"], Decimal("4850.00"))

    def test_inpatient_screen_invoice_with_advance_not_counted_in_paid(self):
        # advance_paid 645: the invoice's paid_amount (51,765) excludes the advance.
        cur = FakeCursor([inv(63, "INV-DIS-1", 52410, 51765, 0, subtotal=52500, discount=90)], [pay(70, 63, 51765)], [])
        s = bs._admission_settlement(cur, 9)
        self.assertEqual(s["advance_applied"], Decimal("645.00"))
        self.assertEqual(s["billed_gross"], Decimal("52500.00"))
        self.assertEqual(s["discount"], Decimal("90.00"))

    def test_billing_invoice_paid_amount_includes_advance(self):
        # INV-IP-*: paid_amount = advance 2,000 + tendered 2,850; no subtotal recorded.
        cur = FakeCursor([inv(60, "INV-IP-0024", 4850, 4850, 0)], [pay(90, 60, 2850, "upi", "RCP-1")], [])
        s = bs._admission_settlement(cur, 24)
        self.assertEqual((s["collected"], s["advance_applied"], s["due"]), (Decimal("2850.00"), Decimal("2000.00"), Decimal("0.00")))
        self.assertEqual(s["billed_gross"], Decimal("4850.00"))   # no subtotal: falls back to total + discount

    def test_partly_settled_keeps_the_balance_due(self):
        cur = FakeCursor([inv(61, "INV-IP-0025", 5000, 3000, 2000, status="partial")], [pay(91, 61, 3000)], [])
        s = bs._admission_settlement(cur, 25)
        self.assertEqual((s["collected"], s["due"], s["advance_applied"]), (Decimal("3000.00"), Decimal("2000.00"), Decimal("0.00")))

    def test_two_discharge_invoices_are_added_up(self):
        cur = FakeCursor(
            [inv(1, "INV-IP-0006", 2400, 2400, 0), inv(2, "INV-DIS-2", 13300, 13300, 0, subtotal=13300)],
            [pay(1, 1, 2400), pay(2, 2, 13300)],
            [],
        )
        s = bs._admission_settlement(cur, 6)
        self.assertEqual((s["total"], s["collected"], s["due"]), (Decimal("15700.00"), Decimal("15700.00"), Decimal("0.00")))
        self.assertEqual(len(s["invoices"]), 2)

    def test_bill_sent_to_the_insurer_is_due_from_the_insurer_not_paid(self):
        row = inv(70, "INV-DIS-9", 4850, 0, 4850, subtotal=4850, status="due")
        row["payment_mode"] = "insurance"
        claim = {"id": 5, "invoice_id": 70, "insurer_name": "ICICI Lombard", "claim_status": "submitted",
                 "settlement_status": "unpaid", "claim_amount": 4850}
        s = bs._admission_settlement(FakeCursor([row], [], [claim]), 31)
        self.assertEqual((s["collected"], s["due"], s["advance_applied"]), (Decimal("0.00"), Decimal("4850.00"), Decimal("0.00")))
        self.assertTrue(s["billed_to_insurance"])
        self.assertTrue(s["insurance_open"])
        self.assertEqual((s["insurer_name"], s["claim_status"]), ("ICICI Lombard", "submitted"))

    def test_rejected_claim_is_no_longer_waiting_on_the_insurer(self):
        row = inv(71, "INV-DIS-10", 4850, 0, 4850, subtotal=4850, status="due")
        row["payment_mode"] = "insurance"
        claim = {"id": 6, "invoice_id": 71, "insurer_name": "ICICI Lombard", "claim_status": "rejected",
                 "settlement_status": "unpaid", "claim_amount": 4850}
        s = bs._admission_settlement(FakeCursor([row], [], [claim]), 31)
        self.assertTrue(s["billed_to_insurance"])
        self.assertFalse(s["insurance_open"])          # the patient owes it now
        self.assertEqual(s["due"], Decimal("4850.00"))

    def test_insurer_payment_clears_the_balance(self):
        row = inv(72, "INV-DIS-11", 4850, 4850, 0, subtotal=4850)
        row["payment_mode"] = "insurance"
        claim = {"id": 7, "invoice_id": 72, "insurer_name": "ICICI Lombard", "claim_status": "settled",
                 "settlement_status": "paid", "claim_amount": 4850}
        s = bs._admission_settlement(FakeCursor([row], [pay(99, 72, 4850, "bank_transfer")], [claim]), 31)
        self.assertEqual((s["collected"], s["due"]), (Decimal("4850.00"), Decimal("0.00")))
        self.assertFalse(s["insurance_open"])

    def test_looks_up_both_invoice_naming_schemes(self):
        cur = FakeCursor([inv(60, "INV-IP-0024", 100, 100, 0)], [], [])
        bs._admission_settlement(cur, 24)
        sql, params = cur.executed[0]
        self.assertIn("i.admission_id = ?", sql)
        self.assertIn("i.invoice_no = ?", sql)
        self.assertEqual(params[1], "INV-IP-0024")


if __name__ == "__main__":
    unittest.main()
