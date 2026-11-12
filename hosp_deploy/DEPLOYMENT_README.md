# HospAI – Deployment Guide (staging / standardversion stack)

Generated: **2026-11-12 16:22 IST** (10:52 UTC) · Branch: `feature/role-based-dashboards`

This guide describes how the system is built, deployed and operated, what is in the code
base, how the database is laid out, and how time is stored and displayed. It complements
`README.md` (first-time setup, Windows laptop notes, pre-push checklist). **No secret appears
in this file; variable names only.** Security scan results are in `../SCA_REPORT.md`.

---

## 1. Architecture

```
 browser ──HTTPS──▶ edge proxy (TLS) ──HTTP──▶ standardversion-frontend (nginx :8080 → published)
                                                        │  /api/*  (proxy, rate limited)
                                                        ▼
                                              standardversion-backend (FastAPI/uvicorn :8000)
                                                        │  postgresql://
                                                        ▼
                                              standardversion-db (PostgreSQL 16, no published port)
```

| Item | Value |
|---|---|
| Compose project | `standardversion` (`hosp_deploy/docker-compose.yml`) |
| Containers | `standardversion-frontend`, `standardversion-backend`, `standardversion-db` |
| Images | `standardversion/frontend:1.0.0`, `standardversion/backend:1.0.0`, `postgres:16-alpine` |
| Network | `standardversion-net` (private bridge) |
| Published port | frontend only: `${APP_BIND}:${APP_PORT}` → container `8080` (staging uses port **8091**) |
| Backend | Python 3.12-slim, FastAPI, uvicorn (1 worker), runs as non-root uid/gid `10001`, `tini` as PID 1 |
| Frontend | React 18 + Vite 6 build (Node 22 build stage) served by `nginxinc/nginx-unprivileged` (uid 101) |
| TLS | **Not handled here**; terminate HTTPS at an edge proxy |

Health checks: frontend `GET /healthz`, backend TCP :8000 (and `GET /health` → `{"status":"ok"}`),
db `pg_isready`.

> **Shared-server rule:** this host runs many live containers. Use only the existing
> `standardversion-*` stack. Never create extra databases, throwaway Postgres containers or
> virtualenvs for testing (see "Testing" below).

---

## 2. Code base structure

```
hosai-standard-version/
├── backend/                     FastAPI application (Python 3.12)
│   ├── main.py                  App factory, middleware, router registration, /health
│   ├── database.py              Engine, session factory, IST session pin, timestamptz adapter
│   ├── schema_setup.py          Startup schema creation + ordered, idempotent SQL migrations
│   ├── models.py                SQLAlchemy models (ORM tables)
│   ├── security.py              Auth, sessions (UTC), roles/permissions, default accounts
│   ├── deps.py / common.py      Request dependencies, permission checks, audit logging
│   ├── access_scope.py          Doctor/patient access guard applied to data routers
│   ├── legacy_sql.py            Compatibility layer: "?"-style SQL over the SQLAlchemy session
│   ├── legacy_queries.py        Core business queries (appointments, admissions, pharmacy, billing…)
│   ├── billing_service.py       Billing v2: invoices, receipts, cashier sessions, refunds, payouts
│   ├── discharge_summary.py     AI-assisted discharge summaries (versioned, approval workflow)
│   ├── export_utils.py          PDF (fpdf2) and Word (python-docx) generation, branding aware
│   ├── branding.py              Document branding service: assets, auto-fit, cached lookup
│   ├── storage.py               File storage (local uploads/ or S3-compatible bucket)
│   ├── ocr.py / qwen_ocr.py     Prescription / document OCR integration
│   ├── role_dashboard.py, pharmacy_profit.py, revenue_details.py, patient_journey.py, …
│   ├── routers/                 HTTP API, all under /api
│   │   ├── auth.py  patients.py  clinical.py  employees_bed.py  nursing.py
│   │   ├── billing.py  pharmacy.py  diagnostics.py  lab_orders.py  lab_ot_accounts_hr.py
│   │   ├── patient_reach.py  pre_bookings.py  reports_exports.py  branding.py
│   ├── migrations/              22 registered SQL migrations (run on every start, idempotent)
│   ├── assets/                  Default HospAI print logo
│   ├── tests/                   Unit tests (*_unit.py) and DB-backed tests (*_pg.py)
│   └── requirements.txt         Pinned Python dependencies
├── frontend/                    React 18 + TypeScript + Vite
│   ├── src/App.tsx              Shell, routing, sidebar, permission-gated pages
│   ├── src/pages/               ~50 pages (OP, IP, pharmacy, billing, lab, reach, branding…)
│   ├── src/components/          Shared UI (ui/ primitives, modals, brand, charts)
│   ├── src/lib/                 api client, format (IST handling), branding, print/PDF helpers
│   ├── public/                  Static logos and background
│   └── package.json / package-lock.json
├── e2e/                         Selenium suite (disposable stack; see Testing)
├── hosp_deploy/                 Docker deployment
│   ├── docker-compose.yml  Dockerfile  nginx.conf
│   ├── .env.example             Variable template (placeholders only)
│   ├── README.md                First-time setup and team workflow
│   ├── DEPLOYMENT_README.md     This file
│   └── volumes/                 postgres/ (data), uploads/ (files), backups/ (dumps) – git-ignored
├── SCA_REPORT.md                Software composition analysis results
└── INCIDENT_users_user_type_check.md
```

API surface: routers register under `/api/...`; the nginx config proxies only `/api`.
Routes `/api/auth/signup`, `check-username`, `setup-admin` and `/api/platform/` are blocked at
nginx and must not be re-opened without a security review.

---

## 3. Configuration (`hosp_deploy/.env`, never committed)

| Variable | Purpose |
|---|---|
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database credentials (password fixed at first start) |
| `POSTGRES_URL_PASSWORD` | Optional URL-encoded copy of the DB password (only if it contains `@ : / # %`); defaults to `POSTGRES_PASSWORD` |
| `SESSION_PEPPER` | Secret mixed into session-token hashes |
| `SESSION_COOKIE_SECURE` | `true` behind HTTPS; `false` only for plain-HTTP local use |
| `SESSION_TTL_MINUTES` | Idle session lifetime (staging: 480) |
| `DEFAULT_ADMIN_USERNAME`, `DEFAULT_ADMIN_PASSWORD` | Super-admin seeded on first start |
| `APP_BIND`, `APP_PORT` | Interface/port nginx publishes |
| Optional: `GEMINI_API_KEY`, `RAZORPAY_KEY_ID/SECRET`, `BUCKET_URL`, `AWS_*`, `QWEN_OCR_URL/MODEL` | Feature integrations; leave unset to disable |

The container sets `TZ=Asia/Kolkata`. `DATABASE_URL` is assembled by compose.

---

## 4. Deploy, update, roll back

Run everything from `hosp_deploy/`.

**First time:** follow `README.md` ("First-time setup"). There is no DB-init step; the backend
creates and upgrades the schema on start.

**Update an existing stack (code changed):**

```bash
# 1. Back up the database first
docker exec standardversion-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > volumes/backups/pre_<change>_$(date +%Y%m%d_%H%M%S).sql.gz

# 2. Rebuild and replace only the app containers (the DB container is never recreated)
docker compose build backend frontend
docker compose up -d --no-deps backend frontend

# 3. Confirm
docker compose ps
docker logs --tail 30 standardversion-backend | grep -E "schema|startup complete|Traceback"
curl -s http://<server-ip>:<port>/health
```

**Restart without rebuilding:** `docker restart standardversion-backend standardversion-frontend`.

**Roll back:** check out the previous commit/tag and repeat step 2. Schema migrations are
forward-only; to undo data changes restore the matching pre-change dump (section 6).

**Logs:** `docker logs -f standardversion-backend` (migration lines are prefixed `[schema]`).

---

## 5. Database details

| Item | Value (staging, 2026-11-12) |
|---|---|
| Engine | PostgreSQL **16.15** (Alpine) |
| Database / role | `hospai` / role from `POSTGRES_USER` |
| Size | ~19 MB |
| Tables | **142** (public schema); extension: `plpgsql` only |
| Data location | `hosp_deploy/volumes/postgres` (bind mount, owned by the postgres user; git-ignored) |
| Network exposure | None (no published port; reachable only on `standardversion-net`) |
| Multi-tenancy | Row level: most tables carry `hospital_id`; code scopes every query by it |

**Schema management.** On every backend start `schema_setup.ensure_schema()` takes a
session-level advisory lock (so only one process migrates), runs `Base.metadata.create_all`,
then applies each file listed in `MIGRATIONS` (22 files, in order) from `backend/migrations/`.
Rules for new migrations:

1. Idempotent (`IF NOT EXISTS`, `ON CONFLICT`, guarded `DO` blocks) – they run on every start.
2. Register the file in `MIGRATIONS` in `schema_setup.py`.
3. Never drop or truncate in a migration.

The last migration, `migrations_timestamptz_utc.sql`, converts any remaining
`timestamp without time zone` column to `timestamptz` and pins the database time zone, so
tables added by future migrations are normalised at the next start.

**Backups and restore**

```bash
# backup (db + uploaded files)
docker exec standardversion-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > volumes/backups/db_$(date +%F).sql.gz
tar -czf volumes/backups/uploads_$(date +%F).tar.gz volumes/uploads backend/uploads 2>/dev/null

# restore into an EMPTY database (stop the backend first)
gunzip -c volumes/backups/db_<date>.sql.gz | docker exec -i standardversion-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Copy dumps off the server; they contain patient data and must never be committed.

**Uploaded files.** Document branding assets are stored under `uploads/branding/<hospital_id>/`
on the uploads volume; the metadata is in table `document_branding` (one row per hospital).
Other uploads use `BUCKET_URL` when set, otherwise `uploads/`.

---

## 6. Time stamps and time zones (important)

**Convention: store UTC, display IST.**

| Layer | Behaviour |
|---|---|
| Postgres columns | All **247** timestamp columns are `timestamptz`; Postgres keeps the instant in UTC. No `timestamp without time zone` columns remain. |
| Meaning of a value | `2026-11-12 15:29 IST` is stored as `2026-11-12 09:59 UTC` (IST = UTC + 5:30). |
| Database time zone | Pinned: `ALTER DATABASE … SET timezone TO 'Asia/Kolkata'` (applied by the migration). |
| Application connections | Every connection sets `timezone=Asia/Kolkata` (`database.py`). `CURRENT_DATE`, `::date`, `to_char()` and day filters therefore use IST day boundaries on any host. |
| Python code | A psycopg2 adapter returns `timestamptz` as **naive IST datetimes**, so business logic is unchanged. Naive datetimes written by the app are interpreted as IST. |
| Sessions | Written as real UTC instants (aware datetimes); read back and converted consistently in `security.py`. |
| API JSON | Timestamps are sent in IST without an offset (e.g. `2026-11-12T15:29:39.12`). |
| Frontend | `src/lib/format.ts` reads offset-less timestamps as **IST** and formats in IST regardless of the browser's zone. Values that carry an offset or `Z` are honoured. |
| PDFs / Word | Generated server-side from IST values; print headers show IST. |

**Why it is portable.** `pg_dump` writes each value with its offset (for example
`2026-11-12 15:29:39.12+05:30`), so a dump restores to exactly the same instants on any
PostgreSQL instance whatever its default time zone (UTC or otherwise). The application pins its
own sessions, so a host or container time-zone change cannot shift stored data.

**Rules for developers**
- New columns: use `timestamptz` (or let the migration convert them). Never `timestamp`.
- Do not use `datetime.utcnow()` for database values; use `datetime.now()` (IST naive) or an
  aware datetime.
- Ad-hoc SQL / BI tools: set the session to IST (`SET timezone='Asia/Kolkata'`) or use
  `col AT TIME ZONE 'Asia/Kolkata'`; otherwise a midnight-IST value shows as 18:30 UTC of the
  previous day (the data is correct, the viewer is in UTC).
- Date-only values (date of birth, expiry) are `date` columns and are not affected.

**Quick verification**

```sql
-- no naive timestamps should exist
select count(*) from information_schema.columns
 where table_schema='public' and data_type='timestamp without time zone';      -- expect 0
show timezone;                                                                 -- Asia/Kolkata
begin; set local timezone='UTC'; select created_at from patients order by id desc limit 1; rollback;
```

---

## 7. Document branding (Admin → Branding & Templates)

Hospital title, header logo (PNG/JPG/SVG, auto-fitted), alignment and X/Y offsets, footer image
and footer text are stored per hospital (`document_branding`). They are applied to server PDFs
and Word exports (`export_utils.py`), to every browser print/PDF path (`printViaIframe.ts`,
`exportService.ts`) and to the prescription sheet. With nothing configured every document falls
back to the default HospAI layout. API: `GET/PUT /api/branding`, `POST/DELETE
/api/branding/{logo|footer}`, `GET /api/branding/public`. Requires `admin.use`.

---

## 8. Security posture

- nginx: security headers (conditional HSTS, `nosniff`, `X-Frame-Options`, Permissions-Policy,
  COOP), `client_max_body_size 25m`, API rate limit 50 r/s and 10 r/min on auth routes.
- Backend runs unprivileged; DB has no published port; secrets only in `.env`.
- Sessions are single-login per user, hashed with `SESSION_PEPPER`, sliding idle expiry.
- Dependency scan: see `../SCA_REPORT.md` (Python clean; npm: 0 vulnerabilities after the 2026-11-12 upgrade to vite 6.4.6 / jspdf 4.2.1; build image on Node 22).

---

## 9. Testing

- Unit tests (no database): `cd backend && .venv/bin/python -m unittest discover -s tests -p "*_unit.py"`
  (161 tests, 4 skipped at time of writing).
- DB-backed `*_pg.py` tests need a database whose name contains `test`; do **not** create one
  on the shared server without approval.
- End-to-end checks on staging use the live stack with clearly labelled data (`E2EAUDIT…`
  names). Do not delete existing records.
- The Selenium suite in `e2e/` is designed for its own disposable stack (`e2e/stack.sh`);
  do not run it on the shared server.

---

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Login does not stick | `SESSION_COOKIE_SECURE=true` over plain HTTP |
| 502 from nginx | `docker logs standardversion-backend`; backend still migrating at start |
| Dates look 5½ h off | Browser running an old bundle (hard refresh); confirm `show timezone;` is `Asia/Kolkata` |
| Logo missing on PDFs | Branding saved? `GET /api/branding/public`; uploads volume writable by uid 10001 |
| Upload fails | uploads folder ownership (`chown 10001:10001`) and the 25 MB request limit |
