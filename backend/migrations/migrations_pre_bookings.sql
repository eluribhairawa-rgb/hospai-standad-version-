-- Pre-booking module migration
CREATE TABLE IF NOT EXISTS pre_bookings (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER DEFAULT 1,
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    phone_country_code TEXT DEFAULT '+91',
    dob DATE,
    age INTEGER,
    email TEXT,
    appointment_date DATE,
    appointment_time TEXT,
    department TEXT,
    doctor_name TEXT,
    reason TEXT,
    status TEXT DEFAULT 'Confirmed',
    patient_id TEXT,
    appointment_id INTEGER,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pre_bookings_date ON pre_bookings (appointment_date);
CREATE INDEX IF NOT EXISTS idx_pre_bookings_phone ON pre_bookings (phone);
CREATE INDEX IF NOT EXISTS idx_pre_bookings_patient_id ON pre_bookings (patient_id);
