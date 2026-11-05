-- Nurse-to-IPD-patient assignment (patient_assignments already exists from the ORM models).
-- Additive and idempotent; safe to run on every boot. Existing rows are left untouched.
ALTER TABLE patient_assignments ADD COLUMN IF NOT EXISTS admission_id INTEGER;
ALTER TABLE patient_assignments ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
ALTER TABLE patient_assignments ADD COLUMN IF NOT EXISTS ended_by TEXT;
CREATE INDEX IF NOT EXISTS idx_patient_assignments_nurse_active
    ON patient_assignments (hospital_id, LOWER(assigned_nurse)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_patient_assignments_admission ON patient_assignments (admission_id);
-- One active assignment per admission and shift (rows created before this migration have no admission).
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_assignments_active_admission_shift
    ON patient_assignments (admission_id, COALESCE(shift, '')) WHERE status = 'active' AND admission_id IS NOT NULL;
