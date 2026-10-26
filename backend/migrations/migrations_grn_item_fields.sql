-- GRN line fields captured from supplier invoices (idempotent; safe to run on every boot)
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS free_qty INTEGER DEFAULT 0;
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS selling_price REAL;
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS discount_pct REAL DEFAULT 0;
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS manufacturer TEXT;
ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS pack_size TEXT;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
