-- Target turnaround (hours) per diagnostics service, used for TAT status on lab/imaging worklists (idempotent)
ALTER TABLE diag_services ADD COLUMN IF NOT EXISTS turnaround_hours REAL;
