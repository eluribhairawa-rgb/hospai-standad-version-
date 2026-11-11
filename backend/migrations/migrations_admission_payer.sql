-- Payer (self-pay vs insurance) per inpatient admission (idempotent).
-- Chosen at IP Admission; shown and editable at IP Discharge Billing.
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS payer_type TEXT NOT NULL DEFAULT 'self';
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS insurance_provider TEXT;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS insurance_policy_no TEXT;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS insurance_preauth_no TEXT;
ALTER TABLE admissions DROP CONSTRAINT IF EXISTS admissions_payer_type_check;
ALTER TABLE admissions ADD CONSTRAINT admissions_payer_type_check
    CHECK (payer_type = ANY (ARRAY['self'::text, 'insurance'::text]));
