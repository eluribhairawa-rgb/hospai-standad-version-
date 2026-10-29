-- Allow ward_indents.status = 'partially_issued' (idempotent).
-- create_pharmacy_dispense sets it when pharmacy issues part of an order, and the
-- IP Dispense filter and Pharmacy Overview count it, but the original constraint
-- rejected it -- so every partial issue rolled back and created no eMAR doses.
ALTER TABLE ward_indents DROP CONSTRAINT IF EXISTS ward_indents_status_check;
ALTER TABLE ward_indents ADD CONSTRAINT ward_indents_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'partially_issued'::text, 'dispensed'::text, 'cancelled'::text]));

-- A Doctor Prescription written for an admitted patient becomes an IP medication
-- order; this links the indent back to the prescription so a re-save can replace
-- its not-yet-issued lines.
ALTER TABLE ward_indents ADD COLUMN IF NOT EXISTS prescription_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_ward_indents_prescription ON ward_indents(prescription_id);
