-- Reagent lot used for a lab result, so expired/quarantined lots can be blocked at result entry (idempotent)
ALTER TABLE diag_results ADD COLUMN IF NOT EXISTS reagent_lot_id INTEGER;
