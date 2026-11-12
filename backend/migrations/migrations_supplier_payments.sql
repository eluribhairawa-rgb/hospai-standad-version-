-- Pharmacy supplier payments are recorded in vendor_payments (the same table the Accounts
-- module uses), now linked to the supplier so the supplier ledger can sum them (idempotent).
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_vendor_payments_supplier ON vendor_payments(supplier_id);
