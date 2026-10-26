# HospAI – Deployment

Three containers on one Docker network (`hospai-net`):

| Container | Image | Role |
|---|---|---|
| `hospai-frontend` | nginx (unprivileged) | Serves the React app, proxies `/api` to the backend, applies security headers and rate limits. The only published port. |
| `hospai-backend` | Python 3.12 / FastAPI | The API. Creates and upgrades its own schema at startup and seeds the default accounts. |
| `hospai-db` | postgres:16-alpine | Database. No published port. |

TLS is **not** handled here. Put an edge proxy (Traefik, a Cloudflare tunnel, etc.) in front, terminate HTTPS there and forward to `http://<server-ip>:<APP_PORT>`.

## First-time setup

Run everything from this folder (`hosp_deploy/`).

```bash
# 1. Folders (the uploads folder must be writable by the backend user, uid 10001)
mkdir -p volumes/postgres volumes/uploads
sudo chown 10001:10001 volumes/uploads

# 2. Configuration
cp .env.example .env
chmod 600 .env
for k in POSTGRES_PASSWORD SESSION_PEPPER; do
  sed -i "s/^$k=.*/$k=$(openssl rand -hex 24)/" .env
done
nano .env        # set APP_BIND to this server's LAN IP (and APP_PORT if 8090 is taken)

# 3. Start (builds both images; the first build takes a few minutes)
docker compose up -d --build
docker compose ps        # all three should become "healthy"
```

There is no database-init step: the backend builds the schema on startup.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database credentials. The password cannot be changed after the first start without recreating the database. |
| `SESSION_PEPPER` | Signing secrets for sessions. |
| `SESSION_COOKIE_SECURE` | `true` when users reach the site over HTTPS (the normal case). Over plain HTTP, logins will not stick. |
| `APP_BIND`, `APP_PORT` | IP and port nginx publishes. Must be reachable from the edge proxy. |
| `DEFAULT_ADMIN_USERNAME`, `DEFAULT_ADMIN_PASSWORD` | Super admin credentials created on first start. |
| Optional: `GEMINI_API_KEY`, `RAZORPAY_*`, `BUCKET_URL`, `AWS_*` | Leave commented out to keep those features off. |

## Updating

```bash
git pull
docker compose up -d --build
docker compose ps
```

To roll back, check out the previous commit or tag and run the same `up -d --build`. Database and uploads are kept in `volumes/` and survive rebuilds.

## Backups

```bash
docker exec hospai-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > db_$(date +%F).sql.gz
tar -czf uploads_$(date +%F).tar.gz volumes/uploads
```

Copy the results off this server.

## Notes

- Python dependencies are pinned in `backend/requirements.txt`. Do not loosen them without testing.
- Default accounts are created by the application on first start (see `create_default_users` in `backend/security.py`).
- `volumes/` and `.env` are git-ignored. Never commit them: they hold patient data and secrets.





## Running locally on a Windows laptop

Use **Docker Desktop with the WSL2 backend** and Git. Do the whole setup **inside a WSL2 terminal, in the Linux filesystem** (for example `~/hospai`), not under `C:\...` or `/mnt/c/...`. Postgres fails on Windows-mounted folders, and the uploads permission step does not work there either.

```bash
git clone <PRIVATE-REPO-URL> ~/hospai
cd ~/hospai/hosp_deploy
mkdir -p volumes/postgres volumes/uploads
sudo chown 10001:10001 volumes/uploads
cp .env.example .env
for k in POSTGRES_PASSWORD SESSION_PEPPER; do
  sed -i "s/^$k=.*/$k=$(openssl rand -hex 24)/" .env
done
```

Then edit `.env` for local use:

| Setting | Local value | Why |
|---|---|---|
| `APP_BIND` | `127.0.0.1` | Only your own machine can reach it |
| `APP_PORT` | `8090` (change if taken) | |
| `SESSION_COOKIE_SECURE` | `false` | Local access is plain `http://`. With `true`, browsers refuse the login cookie and login appears broken. |

```bash
docker compose up -d --build
docker compose ps          # wait for all three to show "healthy"
```

Open `http://localhost:8090`. Stop with `docker compose down` (data stays in `volumes/`).

Notes:
- Keep `.env` in **LF** line endings. The repository's `.gitattributes` enforces this; do not override it.
- Local logins use the default accounts the app seeds on first start.
- For hot-reload frontend work, run `npm install && npm run dev` in `frontend/`. It proxies `/api` to `127.0.0.1:8000`, so the backend must be reachable there. To expose the dev database, create a local `docker-compose.override.yml` (git-ignored) that publishes the db port on `127.0.0.1` only.
- **Never copy production data, dumps or uploads to a laptop.** They contain patient records.

## Before you push (read this)

This repository goes to a staging and production pipeline. Anything you commit can reach a hospital server and is stored in git history forever, even if you delete it later.

**Workflow**
- Work on a feature branch and open a pull request into `staging`. Do not push directly to `staging` or `main`, and never force-push.
- Add files by name (`git add path/to/file`). Avoid `git add -A` or `git add .` unless you have just reviewed `git status`.
- Changes to `nginx.conf`, `docker-compose.yml`, `Dockerfile`, `backend/security.py` or anything in `hosp_deploy/` need a second reviewer.

**Pre-push checklist, run all of it**

```bash
git status
git diff --cached --name-only | grep -E '(^|/)\.env$|volumes/(postgres|backups)|node_modules|/dist/|__pycache__|\.(exe|zip|dump|log|bak|orig)$' ; echo "junk-check-done"
git diff --cached -U0 | grep -nE '^\+.*(PASSWORD|SECRET|PEPPER|API_KEY|TOKEN)\s*=\s*[A-Za-z0-9]{12,}' ; echo "secret-check-done"
git ls-files -z | xargs -0 du -k | sort -rn | head -5
```

`junk-check-done` and `secret-check-done` must each print **alone**. The last command lists the five largest tracked files; anything over a few hundred KB needs a reason.

**Never commit**
- `.env` or any real credential
- `hosp_deploy/volumes/` content (database, uploads, backups)
- Database dumps, exports or screenshots that show patient data
- Binaries and archives (`.exe`, `.zip`, `.tar.gz`), log files, generated PDFs, test output
- Large base64 blobs, local helper scripts, `node_modules`, `dist`, `__pycache__`
- Personal tunnel or proxy credentials

**Update these when you change something**

| You changed | Also update |
|---|---|
| A Python dependency | `backend/requirements.txt`, pinned with `==`. Rebuild, then check: `docker run --rm --entrypoint pip hospai/backend:1.0.0 freeze \| diff - backend/requirements.txt` must print nothing. |
| A frontend dependency | `frontend/package.json` **and** `frontend/package-lock.json`. Generate the lockfile with `npm install`; never edit it by hand. |
| A new environment variable | `hosp_deploy/.env.example` (placeholder only) and the configuration table above |
| The database schema | A migration in `backend/migrations/` that is safe to run twice (`IF NOT EXISTS`, `ON CONFLICT`), **registered in `MIGRATIONS` in `backend/schema_setup.py`**. It runs on every start. |
| An API route outside `/api` | `hosp_deploy/nginx.conf` (it only proxies `/api`) |
| A release | The image tags in `docker-compose.yml` |

**Do not**
- Re-open the routes blocked in `nginx.conf` (`/api/auth/signup`, `check-username`, `setup-admin`, `/api/platform/`) without a security review.
- Loosen or remove the `.gitignore` rules to "make a file go through".
- Commit commented-out code, scratch files or one-off scripts. Delete them or keep them outside the repository.
