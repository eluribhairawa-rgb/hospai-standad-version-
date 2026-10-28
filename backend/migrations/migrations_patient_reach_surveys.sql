-- Patient Reach AI: survey templates, manual WhatsApp survey requests, responses
-- and WhatsApp message log (idempotent)

CREATE TABLE IF NOT EXISTS reach_survey_templates (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    survey_type TEXT NOT NULL DEFAULT 'GENERAL',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reach_survey_templates_type_check CHECK (survey_type IN ('IPD', 'OPD', 'EMERGENCY', 'GENERAL')),
    CONSTRAINT reach_survey_templates_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE'))
);
CREATE INDEX IF NOT EXISTS idx_reach_survey_templates_hospital ON reach_survey_templates(hospital_id, is_deleted);

CREATE TABLE IF NOT EXISTS reach_survey_questions (
    id SERIAL PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES reach_survey_templates(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT 'RATING',
    category TEXT,
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_required BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT reach_survey_questions_type_check CHECK (question_type IN ('RATING', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'TEXT'))
);
CREATE INDEX IF NOT EXISTS idx_reach_survey_questions_template ON reach_survey_questions(template_id, position);

CREATE TABLE IF NOT EXISTS reach_whatsapp_templates (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'GENERAL',
    body TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reach_whatsapp_templates_category_check CHECK (category IN ('SURVEY', 'DISCHARGE', 'FOLLOW_UP', 'REMINDER', 'GENERAL'))
);
CREATE INDEX IF NOT EXISTS idx_reach_whatsapp_templates_hospital ON reach_whatsapp_templates(hospital_id, is_deleted);

-- One row per survey sent (or queued) to a patient. Status moves
-- NOT_SENT -> PENDING (WhatsApp opened / marked sent) -> COMPLETED (response recorded).
CREATE TABLE IF NOT EXISTS reach_survey_requests (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL REFERENCES reach_survey_templates(id),
    patient_id TEXT NOT NULL,
    encounter_type TEXT,
    encounter_id INTEGER,
    encounter_label TEXT,
    doctor_name TEXT,
    department TEXT,
    phone TEXT,
    whatsapp_template_id INTEGER REFERENCES reach_whatsapp_templates(id) ON DELETE SET NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'NOT_SENT',
    send_count INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMP,
    sent_by TEXT,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reach_survey_requests_status_check CHECK (status IN ('NOT_SENT', 'PENDING', 'COMPLETED', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_reach_survey_requests_hospital ON reach_survey_requests(hospital_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_reach_survey_requests_patient ON reach_survey_requests(patient_id, created_at);

CREATE TABLE IF NOT EXISTS reach_survey_responses (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    request_id INTEGER UNIQUE REFERENCES reach_survey_requests(id) ON DELETE SET NULL,
    template_id INTEGER NOT NULL REFERENCES reach_survey_templates(id),
    patient_id TEXT NOT NULL,
    overall_rating NUMERIC(3, 1) NOT NULL,
    comments TEXT,
    channel TEXT NOT NULL DEFAULT 'WHATSAPP',
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recorded_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reach_survey_responses_rating_check CHECK (overall_rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_reach_survey_responses_hospital ON reach_survey_responses(hospital_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_reach_survey_responses_patient ON reach_survey_responses(patient_id, submitted_at);

-- Answers keep a snapshot of the question so later template edits never
-- change what a patient actually answered.
CREATE TABLE IF NOT EXISTS reach_survey_answers (
    id SERIAL PRIMARY KEY,
    response_id INTEGER NOT NULL REFERENCES reach_survey_responses(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES reach_survey_questions(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL,
    category TEXT,
    rating_value NUMERIC(3, 1),
    answer_text TEXT,
    answer_options JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_reach_survey_answers_response ON reach_survey_answers(response_id);
CREATE INDEX IF NOT EXISTS idx_reach_survey_answers_question ON reach_survey_answers(question_id);

CREATE TABLE IF NOT EXISTS reach_whatsapp_messages (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL,
    patient_id TEXT NOT NULL,
    recipient_name TEXT,
    phone TEXT,
    purpose TEXT NOT NULL DEFAULT 'GENERAL',
    template_name TEXT,
    request_id INTEGER REFERENCES reach_survey_requests(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    sent_by TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reach_whatsapp_messages_patient ON reach_whatsapp_messages(hospital_id, patient_id, sent_at);
