-- Link an employee login to a doctor (doctor_schedules.doctor_name) so a doctor sees only their own patients.
-- Idempotent; safe to run on every boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_name TEXT;
