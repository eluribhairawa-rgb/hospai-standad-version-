-- External Sale: walk-in diagnostics orders with no UHID registration (idempotent)
ALTER TABLE diag_orders ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS walkin_name TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS walkin_mobile TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS walkin_age TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS walkin_gender TEXT;
CREATE INDEX IF NOT EXISTS idx_diag_orders_sale_type ON diag_orders(sale_type, created_at);
