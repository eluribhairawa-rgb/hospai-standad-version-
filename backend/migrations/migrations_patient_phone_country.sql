-- Country dialling code for the patient's primary mobile (e.g. +91, +971), so the number
-- is validated with the right length when it is edited later. Additive and idempotent.
-- Backfill: 10-digit numbers already on file are Indian mobiles (+91); any other length
-- is left NULL so staff pick the country the next time the patient is edited.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_country_code TEXT;
UPDATE patients SET phone_country_code = '+91'
WHERE phone_country_code IS NULL AND length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10;
