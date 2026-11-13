-- When the doctor actually started and finished the consultation (the appointment_date is only the booked slot).
-- Idempotent; safe to run on every boot.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consultation_started_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consultation_completed_at TIMESTAMPTZ;
