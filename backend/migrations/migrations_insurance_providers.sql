-- ====================================================================
-- Migration: Insurance Providers master list (HospAI HMS)
-- Lets registration staff add a provider that isn't already in the list,
-- instead of being stuck with a hardcoded dropdown. Fully additive.
-- ====================================================================

CREATE TABLE IF NOT EXISTS insurance_providers (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    contact_person TEXT,
    contact_phone TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_insurance_providers_name ON insurance_providers(LOWER(name));

INSERT INTO insurance_providers (name) VALUES
    ('Star Health'),
    ('HDFC ERGO'),
    ('ICICI Lombard'),
    ('Ayushman Bharat (PM-JAY)'),
    ('United India Insurance')
ON CONFLICT (name) DO NOTHING;
