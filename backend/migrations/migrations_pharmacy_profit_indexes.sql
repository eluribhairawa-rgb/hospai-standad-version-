-- Indexes for the Pharmacy Profit & Loss analysis (/api/pharmacy/profit-analysis).
-- Inventory, GRN lines and sales are joined on the normalised medicine name,
-- and sales/returns are filtered by transaction date. Idempotent.
CREATE INDEX IF NOT EXISTS idx_pharmacy_sales_sold_at ON pharmacy_sales (sold_at);
CREATE INDEX IF NOT EXISTS idx_pharmacy_sales_med_key
    ON pharmacy_sales (LOWER(TRIM(REGEXP_REPLACE(medicine_name, '\s+', ' ', 'g'))));
CREATE INDEX IF NOT EXISTS idx_pharmacy_inventory_med_key
    ON pharmacy_inventory (LOWER(TRIM(REGEXP_REPLACE(medicine_name, '\s+', ' ', 'g'))));
CREATE INDEX IF NOT EXISTS idx_pharmacy_inventory_medicine_id ON pharmacy_inventory (medicine_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_inventory_expiry ON pharmacy_inventory (expiry_date) WHERE batch_status = 'available';
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_grn ON goods_receipt_items (grn_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_med_key
    ON goods_receipt_items (LOWER(TRIM(REGEXP_REPLACE(medicine_name, '\s+', ' ', 'g'))));
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_medicine_id ON goods_receipt_items (medicine_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_returns_sale ON pharmacy_returns (original_sale_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_returns_created_at ON pharmacy_returns (created_at);
