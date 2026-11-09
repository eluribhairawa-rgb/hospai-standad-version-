-- Lab order service types (In-house / External / Outsourcing / Home Visit), home-visit
-- sample routing by equipment availability, partner-lab costs and lab settings.
-- Additive and idempotent; safe to run on every boot. Existing rows keep their behaviour.

-- ---- Orders: service type + home-visit details ----
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS service_type TEXT;
-- Backfill once: walk-in sales are EXTERNAL, everything that existed before is IN_HOUSE.
UPDATE diag_orders SET service_type = CASE WHEN sale_type = 'EXTERNAL' THEN 'EXTERNAL' ELSE 'IN_HOUSE' END
WHERE service_type IS NULL;
ALTER TABLE diag_orders ALTER COLUMN service_type SET DEFAULT 'IN_HOUSE';
ALTER TABLE diag_orders ALTER COLUMN service_type SET NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diag_orders_service_type_check') THEN
        ALTER TABLE diag_orders ADD CONSTRAINT diag_orders_service_type_check
            CHECK (service_type IN ('IN_HOUSE', 'EXTERNAL', 'OUTSOURCING', 'HOME_VISIT'));
    END IF;
END $$;

ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS visit_address TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS visit_scheduled_at TIMESTAMP;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS visit_status TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS visit_collected_by TEXT;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS visit_collected_at TIMESTAMP;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS home_visit_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE diag_orders ADD COLUMN IF NOT EXISTS outsource_vendor_id INTEGER;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diag_orders_visit_status_check') THEN
        ALTER TABLE diag_orders ADD CONSTRAINT diag_orders_visit_status_check
            CHECK (visit_status IS NULL OR visit_status IN ('scheduled', 'collected', 'received', 'cancelled'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_diag_orders_service_type ON diag_orders(service_type, created_at);
CREATE INDEX IF NOT EXISTS idx_diag_orders_visit ON diag_orders(visit_scheduled_at) WHERE service_type = 'HOME_VISIT';

-- ---- Order items: where each test is processed ----
-- routing NULL = ordinary in-house test (all orders created before this migration).
ALTER TABLE diag_order_items ADD COLUMN IF NOT EXISTS routing TEXT;
ALTER TABLE diag_order_items ADD COLUMN IF NOT EXISTS routing_reason TEXT;
ALTER TABLE diag_order_items ADD COLUMN IF NOT EXISTS routing_vendor_id INTEGER;
ALTER TABLE diag_order_items ADD COLUMN IF NOT EXISTS routed_at TIMESTAMP;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diag_order_items_routing_check') THEN
        ALTER TABLE diag_order_items ADD CONSTRAINT diag_order_items_routing_check
            CHECK (routing IS NULL OR routing IN ('in_house', 'outsourced', 'pending_vendor'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_diag_order_items_pending_vendor ON diag_order_items(order_id) WHERE routing = 'pending_vendor';

-- ---- Catalogue: which machines run a test, and its default partner lab ----
ALTER TABLE diag_services ADD COLUMN IF NOT EXISTS preferred_vendor_id INTEGER;
CREATE TABLE IF NOT EXISTS diag_service_equipment (
    id SERIAL PRIMARY KEY,
    service_id INTEGER NOT NULL REFERENCES diag_services(id) ON DELETE CASCADE,
    equipment_id INTEGER NOT NULL REFERENCES diag_equipment(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (service_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS idx_diag_service_equipment_equipment ON diag_service_equipment(equipment_id);

-- ---- What a partner lab charges the hospital per test (margin reporting only; never billed) ----
CREATE TABLE IF NOT EXISTS diag_vendor_service_rates (
    id SERIAL PRIMARY KEY,
    vendor_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL REFERENCES diag_services(id) ON DELETE CASCADE,
    cost REAL NOT NULL CHECK (cost >= 0),
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (vendor_id, service_id)
);

-- ---- Lab settings (key/value) ----
CREATE TABLE IF NOT EXISTS diag_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO diag_settings (key, value) VALUES ('home_visit_fee', '0') ON CONFLICT (key) DO NOTHING;
