import os
import re
import traceback

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError, OperationalError

import logging
from database import db_session
import security

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
FRONTEND_DIST = os.path.join(PROJECT_ROOT, "frontend", "dist")

app = FastAPI(title="HospAI API", docs_url=None, redoc_url=None, openapi_url=None)

# ------------------------------------------------------------------ CORS --
default_allowed_origins = {
    "https://app.hospai.ai", "https://staging-app.hospai.ai",
    "http://localhost:5173", "http://127.0.0.1:5173",
}
env_allowed_origins = {o.strip() for o in (os.getenv("CORS_ALLOWED_ORIGINS", "") or "").split(",") if o.strip()}
ALLOWED_ORIGINS = default_allowed_origins | env_allowed_origins
ALLOWED_ORIGIN_REGEX = (
    r"^(https://([a-z0-9-]+\.)*hospai\.ai"
    r"|https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?"
    r")$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Hospital-Code",
                   "X-Platform-Admin-Username", "X-Platform-Admin-Password", "X-Background-Refresh"],
    expose_headers=["X-Session-Refreshed"],
)


@app.middleware("http")
async def session_refreshed_header(request: Request, call_next):
    """Flag responses whose request slid the session expiry forward, so the
    frontend knows when the server last saw user activity and only sends a
    keep-alive when there is activity the server hasn't heard about."""
    response = await call_next(request)
    if getattr(request.state, "session_refreshed", False):
        response.headers["X-Session-Refreshed"] = "1"
    return response


# --------------------------------------------------------------- startup --
@app.on_event("startup")
def on_startup():
    """Seed the baseline accounts on first run (schema itself comes from the
    restored Postgres dump / SQLAlchemy models, not created here)."""
    import schema_setup
    schema_setup.ensure_schema()
    with db_session() as db:
        security.create_default_users(db)


# ------------------------------------------------------------ error handling --
@app.exception_handler(Exception)
async def handle_global_exception(request: Request, exc: Exception):
    logger.error(f"[ERROR] {exc}\n{traceback.format_exc()}")
    if isinstance(exc, HTTPException):
        detail = exc.detail
        body = detail if isinstance(detail, dict) else {"error": detail}
        return JSONResponse(status_code=exc.status_code, content=body)
    if isinstance(exc, ValueError):
        return JSONResponse(status_code=400, content={"error": str(exc)})
    if isinstance(exc, IntegrityError):
        return JSONResponse(status_code=409, content={"error": "Database integrity error. A required record is missing or duplicate data exists."})
    if isinstance(exc, OperationalError):
        return JSONResponse(status_code=500, content={"error": "Database operation failed. Please try again later."})
    return JSONResponse(status_code=500, content={"error": "Internal Server Error", "message": "An unexpected server error occurred. Please try again."})


# FastAPI's own HTTPException should still go through the same JSON shape
# as the rest of the app (the generic handler above only fires for
# unhandled exception types raised outside of FastAPI's own dispatch).
@app.exception_handler(HTTPException)
async def handle_http_exception(request: Request, exc: HTTPException):
    detail = exc.detail
    body = detail if isinstance(detail, dict) else {"error": detail}
    return JSONResponse(status_code=exc.status_code, content=body)


# --------------------------------------------------------------- routers --
from routers.auth import router as auth_router, platform_router
from routers.clinical import router as clinical_router
from routers.patients import router as patients_router
from routers.employees_bed import router as employees_bed_router
from routers.billing import router as billing_router
from routers.pharmacy import router as pharmacy_router, emar_router
from routers.lab_ot_accounts_hr import router as lab_ot_accounts_hr_router
from routers.reports_exports import router as reports_exports_router
from routers.diagnostics import router as diagnostics_router
from routers.patient_reach import router as patient_reach_router

from access_scope import patient_access_guard

for r in (auth_router, platform_router):
    app.include_router(r)
# Data routers: a doctor-linked login can never reach another doctor's patient, even via direct API calls.
for r in (
    clinical_router, patients_router, employees_bed_router,
    billing_router, pharmacy_router, emar_router, lab_ot_accounts_hr_router, reports_exports_router,
    diagnostics_router, patient_reach_router,
):
    app.include_router(r, dependencies=[Depends(patient_access_guard)])


@app.options("/api/{full_path:path}")
def preflight(full_path: str):
    return JSONResponse(status_code=204, content=None)

@app.get("/health")
def health_check():
    return {"status": "ok"}


# ------------------------------------------------------- frontend static --
if os.path.isdir(FRONTEND_DIST):
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/")
    def serve_frontend_index():
        index_path = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return JSONResponse(status_code=503, content={"error": "Frontend build not found. Run npm run build in frontend/."})

    @app.get("/{frontend_path:path}")
    def serve_frontend_asset_or_route(frontend_path: str):
        if frontend_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"error": "API route not found"})
        requested_path = os.path.realpath(os.path.join(os.path.realpath(FRONTEND_DIST), frontend_path))
        if requested_path.startswith(os.path.realpath(FRONTEND_DIST) + os.sep) and os.path.isfile(requested_path):
            return FileResponse(requested_path)
        index_path = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return JSONResponse(status_code=503, content={"error": "Frontend build not found. Run npm run build in frontend/."})
else:
    @app.get("/")
    def frontend_not_built():
        return JSONResponse(status_code=503, content={"error": "Frontend build not found. Run npm run build in frontend/ first."})
