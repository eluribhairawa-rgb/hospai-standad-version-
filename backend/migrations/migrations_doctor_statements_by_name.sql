-- Doctor payout statements are issued per doctor NAME (every doctor in Doctor Scheduling),
-- not only for doctors who also have a login. doctor_id stays as an optional link to the login.
-- doctor_statements is empty when this runs on existing installs. Idempotent.
ALTER TABLE doctor_statements ALTER COLUMN doctor_id DROP NOT NULL;
ALTER TABLE doctor_statements DROP CONSTRAINT IF EXISTS doctor_statements_doctor_id_period_month_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_doctor_statements_name_month
    ON doctor_statements (LOWER(TRIM(doctor_name)), period_month);
