-- Attending doctor's daily clinical notes for an admitted patient (Doctor Clinicals module).
-- Additive only; idempotent; safe to run on every boot. Touches no existing table.
CREATE TABLE IF NOT EXISTS doctor_clinical_notes (
    id                  SERIAL PRIMARY KEY,
    hospital_id         INTEGER,
    admission_id        INTEGER NOT NULL REFERENCES admissions(id),
    patient_id          TEXT NOT NULL,
    doctor_id           INTEGER,
    doctor_name         TEXT NOT NULL,
    subjective          TEXT,
    objective_analysis  TEXT,
    diagnosis           TEXT,
    treatment_plan      TEXT,
    prognosis           TEXT,
    discharge_readiness TEXT NOT NULL DEFAULT 'not_assessed',
    created_by          TEXT,
    updated_by          TEXT,
    created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_doctor_clinical_notes_admission ON doctor_clinical_notes (admission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_doctor_clinical_notes_patient ON doctor_clinical_notes (patient_id);

-- A nurse may enter the note on behalf of the attending doctor; doctor_name stays the attending doctor.
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS entered_role TEXT NOT NULL DEFAULT 'doctor';

-- Hand-over of an admitted patient from one attending doctor to another (Doctor Clinicals > Transfer).
CREATE TABLE IF NOT EXISTS doctor_patient_transfers (
    id               SERIAL PRIMARY KEY,
    hospital_id      INTEGER,
    admission_id     INTEGER NOT NULL REFERENCES admissions(id),
    patient_id       TEXT NOT NULL,
    from_doctor      TEXT,
    from_department  TEXT,
    to_doctor        TEXT NOT NULL,
    to_department    TEXT NOT NULL,
    reason           TEXT,
    transferred_by   TEXT,
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_doctor_patient_transfers_admission ON doctor_patient_transfers (admission_id, created_at);

-- Fields that map one-to-one onto the discharge summary sections.
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS presenting_complaints TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS clinical_course TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS key_investigations TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS procedures TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS treatment_given TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS condition_at_discharge TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS advice TEXT;
ALTER TABLE doctor_clinical_notes ADD COLUMN IF NOT EXISTS follow_up TEXT;
