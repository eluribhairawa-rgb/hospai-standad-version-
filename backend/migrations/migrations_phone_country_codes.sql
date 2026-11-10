-- Country dialling codes stored beside every saved phone number, so each number is
-- validated (and shown / dialled) for its own country. Additive and idempotent.
-- Backfill: 10-digit numbers already on file are Indian (+91); blanks stay NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_country_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_country_code TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_country_code TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_country_code TEXT;
ALTER TABLE pharmacy_suppliers ADD COLUMN IF NOT EXISTS phone_country_code TEXT;
ALTER TABLE insurance_providers ADD COLUMN IF NOT EXISTS contact_phone_country_code TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS walkin_country_code TEXT;

UPDATE users SET phone_country_code = '+91'
WHERE phone_country_code IS NULL AND length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10;
UPDATE users SET emergency_contact_country_code = '+91'
WHERE emergency_contact_country_code IS NULL AND length(regexp_replace(coalesce(emergency_contact, ''), '\D', '', 'g')) = 10;
UPDATE patients SET family_country_code = '+91'
WHERE family_country_code IS NULL AND length(regexp_replace(coalesce(family_mobile, ''), '\D', '', 'g')) = 10;
UPDATE patients SET emergency_country_code = '+91'
WHERE emergency_country_code IS NULL AND length(regexp_replace(coalesce(emergency_mobile, ''), '\D', '', 'g')) = 10;
UPDATE pharmacy_suppliers SET phone_country_code = '+91'
WHERE phone_country_code IS NULL AND length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10;
UPDATE insurance_providers SET contact_phone_country_code = '+91'
WHERE contact_phone_country_code IS NULL AND length(regexp_replace(coalesce(contact_phone, ''), '\D', '', 'g')) = 10;
UPDATE diag_orders SET walkin_country_code = '+91'
WHERE walkin_country_code IS NULL AND length(regexp_replace(coalesce(walkin_mobile, ''), '\D', '', 'g')) = 10;
