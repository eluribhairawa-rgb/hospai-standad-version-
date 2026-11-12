-- Universal time storage: every timestamp column is timestamptz (stored as UTC by Postgres).
-- Existing "timestamp without time zone" values were IST wall-clock, so they are interpreted
-- as Asia/Kolkata. Idempotent: once no naive columns remain this does nothing, and it also
-- converts naive columns created later by other migrations or on a fresh database.
DO $$
DECLARE
    t record;
    stmt text;
BEGIN
    FOR t IN
        SELECT c.table_name,
               string_agg(format('ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''Asia/Kolkata''', c.column_name, c.column_name), ', ') AS alters
        FROM information_schema.columns c
        JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.data_type = 'timestamp without time zone'
        GROUP BY c.table_name
    LOOP
        stmt := format('ALTER TABLE public.%I %s', t.table_name, t.alters);
        EXECUTE stmt;
    END LOOP;
    -- Sessions that don't pass a time zone get IST day boundaries, whichever server hosts the DB.
    BEGIN
        EXECUTE format('ALTER DATABASE %I SET timezone TO ''Asia/Kolkata''', current_database());
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'could not pin database time zone';
    END;
END $$;
