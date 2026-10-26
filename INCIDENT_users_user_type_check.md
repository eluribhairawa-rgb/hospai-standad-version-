# Incident Report: Backend crash on startup (`users_user_type_check`)

**Date:** 2026-10-09
**Service:** `hospai-backend` (FastAPI + SQLAlchemy + PostgreSQL), deployed from `hosp_deploy/`
**Status:** Resolved on the deployment server. **Code changes must still be committed and pushed to `main`** (see "Action items for dev").

---

## 1. Summary

The backend container crashed on every startup and restarted in a loop. The deployment never became healthy, so `docker compose up -d` reported `hospai-backend is unhealthy`.

The startup step `create_default_users` tried to insert the default admin with `user_type = 'super_admin'`. The `users` table has a CHECK constraint, `users_user_type_check`, that only allowed `'admin'` and `'normal'`. PostgreSQL rejected the insert, and the app exited with "Application startup failed".

**In one line:** the application code was updated to support `super_admin`, but the database constraint was never updated to match.

---

## 2. Symptoms

- `docker compose up -d` ends with `dependency failed to start: container hospai-backend is unhealthy`.
- Backend logs repeat this error on every restart:

```
sqlalchemy.exc.IntegrityError: (psycopg2.errors.CheckViolation)
new row for relation "users" violates check constraint "users_user_type_check"
DETAIL: Failing row contains (..., Kalpra@superadmin.com, ..., employee, owner, super_admin, ...)
```

- The failing call stack ends at:
  - `backend/main.py` line 56, `on_startup` -> `security.create_default_users(db)`
  - `backend/security.py` line 538, `create_default_users` -> `db.commit()`
- The user `id` in the failing row increased between restarts (10, 11, 12, ... 24). This is harmless. Failed inserts roll back but still consume sequence numbers.
- The other default users (ids 1-7 in the fresh DB) inserted fine. Only the `super_admin` row was rejected.

---

## 3. Root cause

### Confirmed

1. **Code and database disagreed.**
   - `security.py` line 32 defines `USER_TYPES = ("super_admin", "admin", "normal")`.
   - `routers/auth.py` uses `super_admin` in several places (lines 123, 144-145, 160-162, 174, 189-193).
   - `create_default_users` inserts the default admin with `user_type='super_admin'`.
   - The database constraint was still:
     `CHECK (user_type = ANY (ARRAY['admin'::text, 'normal'::text]))`
2. **`models.py` also had the old list.** `backend/models.py` line 2006 defined the constraint with only `admin` and `normal`.
3. **Changing `models.py` does not alter an existing table.** `Base.metadata.create_all()` only creates tables that do not exist yet. It never modifies constraints on existing tables. Any database that already exists keeps the old constraint.
4. **No migration existed for this change.** `schema_setup.py` applies only `migrations_billing_v2.sql` and `migrations_insurance_providers.sql`. Neither touches `users_user_type_check`.

### Not confirmed

- Even on a freshly wiped Postgres data folder with a rebuilt image, the old `('admin','normal')` constraint still appeared. So some other source creates the `users` table (or its constraint) with the old list before or instead of `models.py`. Candidates:
  - a restored Postgres dump (the `main.py` startup docstring says "schema itself comes from the restored Postgres dump / SQLAlchemy models"),
  - a DB init script,
  - a different copy of the model.
- We did not find that source. The migration fix (section 5) makes this harmless, but the dev should still find and update it so the source of truth is consistent.

### Contributing factors (what made it harder to diagnose)

- **A stale image ran the old code.** An interrupted build (Ctrl+C during `docker compose build --no-cache backend`) left the image tagged `hospai/backend:1.0.0` without the new code. `docker compose up -d` started the old image. This was proven by comparing line 2006 of `backend/models.py` on the host (new) vs inside the container at `/app/backend/models.py` (old).
- **Fixes were applied directly on the server.** `models.py` was edited in place, so the server copy and the git repository now differ until the dev commits it. This is how code drift happens.
- **No automated check ties the model constraints to the migrations or the database.**

---

## 4. Investigation timeline

1. Read the stack trace and found the failure point: `create_default_users` -> `CheckViolation` on `users_user_type_check`.
2. Wiped `volumes/postgres/*` and restarted. Same error, so the problem is not stale data alone.
3. Queried the live constraint:
   `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='users_user_type_check';`
   Result: `CHECK ((user_type = ANY (ARRAY['admin'::text, 'normal'::text])))`.
4. Grepped the source and found the constraint at `backend/models.py:2006` with only `admin` and `normal`.
5. Edited `models.py` to include `super_admin` and rebuilt. The build was interrupted, so the old image kept running and the error persisted.
6. Verified the image contents with
   `docker compose run --rm --no-deps --entrypoint sh backend -c "sed -n '2006p' /app/backend/models.py"`.
   It showed the old line, which proved the image was stale.
7. Rebuilt to completion (`docker compose build backend`) and re-checked. The image now showed the new line.
8. Wiped the DB and started again. The error **still** occurred, so the constraint was being created from a source other than `models.py`.
9. Read `schema_setup.py` and `main.py`. Startup order is: `ensure_schema()` (`create_all`, then migration files) -> `create_default_users`. That is the right place to correct the constraint regardless of where it came from.
10. Added an idempotent migration and registered it. The backend started cleanly.

---

## 5. The fix

### 5.1 `backend/models.py` (line 2006)

Before:
```python
CheckConstraint("user_type = ANY (ARRAY['admin'::text, 'normal'::text])", name='users_user_type_check'),
```
After:
```python
CheckConstraint("user_type = ANY (ARRAY['super_admin'::text, 'admin'::text, 'normal'::text])", name='users_user_type_check'),
```
This makes brand-new databases created by `create_all` correct.

### 5.2 New file `backend/migrations/migrations_user_types.sql`

```sql
-- Allow 'super_admin' as a user_type (idempotent; safe to run on every boot)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE users ADD CONSTRAINT users_user_type_check
  CHECK (user_type = ANY (ARRAY['super_admin'::text, 'admin'::text, 'normal'::text]));
```
This corrects the constraint on **every** database (fresh, restored from a dump, or existing), regardless of how the old constraint got there.

### 5.3 `backend/schema_setup.py` (line 12)

Before:
```python
MIGRATIONS = ["migrations_billing_v2.sql", "migrations_insurance_providers.sql"]
```
After:
```python
MIGRATIONS = ["migrations_billing_v2.sql", "migrations_insurance_providers.sql", "migrations_user_types.sql"]
```
Migrations run after `create_all` and before `create_default_users`, so the constraint is correct by the time the default admin is inserted.

---

## 6. How we verified it worked

1. Rebuilt the image (`docker compose build backend`) and started the stack (`docker compose up -d`).
2. Compose output: `hospai-db` Healthy, `hospai-backend` **Healthy**, `hospai-frontend` Started.
3. Backend log:
```
[schema] applied migrations_billing_v2.sql
[schema] applied migrations_insurance_providers.sql
[schema] applied migrations_user_types.sql
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```
4. Live database constraint after the fix:
```
CHECK ((user_type = ANY (ARRAY['super_admin'::text, 'admin'::text, 'normal'::text])))
```

Still to confirm manually: log in with the `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` values from `.env`.

---

## 7. Action items for dev (to prevent code drift)

**Must do now**
1. **Commit and push to `main`** these three changes, which currently exist only on the deployment server:
   - `backend/models.py` (line 2006)
   - `backend/schema_setup.py` (`MIGRATIONS` list)
   - `backend/migrations/migrations_user_types.sql` (new file)
2. Check `.gitignore` does not exclude `*.sql` or `backend/migrations/`, and confirm with `git status` that the new migration file is tracked.
3. Find where the old `('admin','normal')` constraint was coming from (a Postgres dump, an init script, or another model copy) and update it. The migration masks the problem but the source of truth should match.
4. Compare the deployment server's `backend/` folder against `main` (`git diff`) to catch any other changes made directly on the server.

**Should do**
5. **Consider a real migration tool (e.g. Alembic)** with versioned migrations, instead of `create_all` plus re-run SQL files on every boot. `create_all` never alters existing tables, which is the root of this class of bug.
6. **Add a startup/CI check** that every value in `security.USER_TYPES` is accepted by the DB constraint, for example by building a fresh DB in CI and running `create_default_users`.
7. **Make the migration safer on large or live data.** The migration takes a brief table lock on every boot and `ADD CONSTRAINT` validates all existing rows. If any row has a `user_type` outside the three allowed values, startup would fail. Options: check `pg_constraint` first and only run if the definition differs, or use `ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE CONSTRAINT`.
8. **Whenever you add a new enum-like value** (user types, roles, statuses), update in the same pull request: the Python constants, the `CheckConstraint` in `models.py`, and a migration file.
9. **Do not edit code on the server.** Make changes in git, build the image from `main`, and deploy that image.
10. **Use unique image tags** (git SHA or a version bump) instead of reusing `hospai/backend:1.0.0`. A reused tag made it easy to run a stale image without noticing. Deploys should also run a quick check, such as printing a build version at startup.
11. Update the `main.py` startup docstring, which still says the schema comes from a "restored Postgres dump", so it describes how the schema is actually created.

**Security hygiene**
12. The `.env` file contents (database password, session pepper, default admin password) were shared during troubleshooting. Rotate them if this server is reachable beyond a trusted LAN or if any value is reused elsewhere. Keep `.env` out of git and out of shared logs.

---

## 8. Useful commands (reference)

Check the live constraint:
```bash
docker compose exec db psql -U hospai -d hospai -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='users_user_type_check';"
```

Check that the running image has your code (adjust the file and line):
```bash
docker compose run --rm --no-deps --entrypoint sh backend -c "sed -n '2006p' /app/backend/models.py"
```

Rebuild and start without wiping data:
```bash
cd hosp_deploy
docker compose build backend
docker compose up -d
docker compose logs -f backend    # Ctrl+C only leaves the log view
```

Note: run `docker compose` commands from `hosp_deploy/`, where `docker-compose.yml` lives. From the parent folder they fail with "no configuration file provided".
