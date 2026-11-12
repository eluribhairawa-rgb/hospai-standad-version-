-- Global document branding (letterhead logo, title, footer). Independent of all transactional tables.
CREATE TABLE IF NOT EXISTS document_branding (
    hospital_id      INTEGER PRIMARY KEY,
    hospital_title   VARCHAR(200),
    logo_path        VARCHAR(500),
    logo_mime        VARCHAR(50),
    logo_width_px    INTEGER,
    logo_height_px   INTEGER,
    logo_alignment   VARCHAR(10) NOT NULL DEFAULT 'left',
    logo_offset_x_mm NUMERIC(6,2) NOT NULL DEFAULT 0,
    logo_offset_y_mm NUMERIC(6,2) NOT NULL DEFAULT 0,
    auto_fit_scaling BOOLEAN NOT NULL DEFAULT TRUE,
    footer_path      VARCHAR(500),
    footer_mime      VARCHAR(50),
    footer_width_px  INTEGER,
    footer_height_px INTEGER,
    footer_text      VARCHAR(500),
    version          INTEGER NOT NULL DEFAULT 1,
    updated_by       VARCHAR(100),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
