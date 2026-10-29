-- Saved discharge summaries: one per encounter, with full version history (idempotent).
CREATE TABLE IF NOT EXISTS discharge_summaries (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    patient_id TEXT NOT NULL,
    encounter_type TEXT NOT NULL,
    encounter_id INTEGER NOT NULL,
    encounter_label TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    current_version INTEGER NOT NULL DEFAULT 1,
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    medications JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
    ai_model TEXT,
    ai_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    records_snapshot JSONB,
    amendment_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    submitted_by TEXT,
    submitted_at TIMESTAMP,
    approved_by TEXT,
    approved_at TIMESTAMP,
    approval_note TEXT,
    finalized_by TEXT,
    finalized_at TIMESTAMP,
    CONSTRAINT discharge_summaries_type_check CHECK (encounter_type IN ('IP', 'OP', 'EMERGENCY')),
    CONSTRAINT discharge_summaries_status_check CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'FINALIZED')),
    CONSTRAINT discharge_summaries_encounter_key UNIQUE (hospital_id, patient_id, encounter_type, encounter_id)
);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_patient ON discharge_summaries(hospital_id, patient_id, updated_at);

CREATE TABLE IF NOT EXISTS discharge_summary_versions (
    id SERIAL PRIMARY KEY,
    summary_id INTEGER NOT NULL REFERENCES discharge_summaries(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    content JSONB NOT NULL,
    medications JSONB NOT NULL DEFAULT '[]'::jsonb,
    change_type TEXT NOT NULL,
    change_note TEXT,
    changed_by TEXT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT discharge_summary_versions_key UNIQUE (summary_id, version)
);
