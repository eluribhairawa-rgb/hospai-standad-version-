-- Allow 'super_admin' as a user_type (idempotent; safe to run on every boot)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE users ADD CONSTRAINT users_user_type_check
  CHECK (user_type = ANY (ARRAY['super_admin'::text, 'admin'::text, 'normal'::text]));
