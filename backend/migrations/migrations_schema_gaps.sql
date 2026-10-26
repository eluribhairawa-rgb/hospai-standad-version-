-- Columns the application writes but the model-built schema never created (idempotent; safe to run on every boot)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS admission_id INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_mode TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS patient_mobile TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS patient_age TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS patient_address TEXT;
ALTER TABLE diag_imaging_exams ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMP;
