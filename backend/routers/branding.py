"""Document Branding & Templates API (admin-managed, read by every print/PDF path)."""
import base64
import re
from typing import Optional

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.orm import Session

import branding as svc
from common import client_ip, log_audit_event
from database import get_db
from deps import current_hospital_id, get_current_user, require_permissions

router = APIRouter(prefix="/api/branding", tags=["branding"])


def _asset_payload(row, kind, with_data):
    rel = row.get(f"{kind}_path") if row else None
    path = svc.abs_path(rel)
    if not path:
        return None
    out = {"mime": row.get(f"{kind}_mime"), "width_px": row.get(f"{kind}_width_px"), "height_px": row.get(f"{kind}_height_px"),
           "url": f"/api/branding/asset/{kind}?v={row.get('version') or 1}"}
    if with_data:
        with open(path, "rb") as f:
            out["data_uri"] = f"data:{row.get(f'{kind}_mime')};base64," + base64.b64encode(f.read()).decode()
    return out


def _serialize(row, with_data=False):
    row = row or {}
    return {
        "configured": svc._is_custom(row),
        "hospital_title": row.get("hospital_title") or "",
        "logo_alignment": row.get("logo_alignment") or "left",
        "logo_offset_x_mm": float(row.get("logo_offset_x_mm") or 0),
        "logo_offset_y_mm": float(row.get("logo_offset_y_mm") or 0),
        "auto_fit_scaling": True if row.get("auto_fit_scaling") is None else bool(row.get("auto_fit_scaling")),
        "footer_text": row.get("footer_text") or "",
        "logo": _asset_payload(row, "logo", with_data),
        "footer": _asset_payload(row, "footer", with_data),
        "logo_box_mm": list(svc.LOGO_BOX_MM),
        "footer_box_mm": list(svc.FOOTER_BOX_MM),
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "updated_by": row.get("updated_by"),
    }


def _ensure_row(db, hospital_id, username):
    db.execute(text("INSERT INTO document_branding (hospital_id, updated_by) VALUES (:h, :u) ON CONFLICT (hospital_id) DO NOTHING"),
               {"h": hospital_id, "u": username})


@router.get("/public")
def public_branding(db: Session = Depends(get_db), user: dict = Depends(get_current_user), hospital_id: int = Depends(current_hospital_id)):
    """Read-only branding (with inline images) for the browser's print/PDF code. Any signed-in user."""
    return _serialize(svc.fetch_row(db, hospital_id), with_data=True)


@router.get("")
def get_branding_settings(db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.use")),
                          hospital_id: int = Depends(current_hospital_id)):
    return _serialize(svc.fetch_row(db, hospital_id))


@router.put("")
def update_branding_settings(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                             user: dict = Depends(require_permissions("admin.use")), hospital_id: int = Depends(current_hospital_id)):
    title = str(payload.get("hospital_title") or "").strip()
    footer_text = str(payload.get("footer_text") or "").strip()
    align = str(payload.get("logo_alignment") or "left").strip().lower()
    if len(title) > 200:
        raise HTTPException(400, "Hospital title must be 200 characters or fewer.")
    if len(footer_text) > 500:
        raise HTTPException(400, "Footer text must be 500 characters or fewer.")
    if align not in svc.ALIGNMENTS:
        raise HTTPException(400, "Logo alignment must be left, center or right.")
    try:
        ox = float(payload.get("logo_offset_x_mm") or 0)
        oy = float(payload.get("logo_offset_y_mm") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Offsets must be numbers (mm).")
    lim = svc.OFFSET_LIMIT_MM
    if not (-lim <= ox <= lim and -lim <= oy <= lim):
        raise HTTPException(400, f"Offsets must be between -{lim:g} and {lim:g} mm.")
    # No control characters in text that is drawn onto documents (preserves \r and \n).
    title, footer_text = (re.sub(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]", " ", v) for v in (title, footer_text))
    _ensure_row(db, hospital_id, user.get("username"))
    db.execute(text("""UPDATE document_branding SET hospital_title = :t, footer_text = :f, logo_alignment = :a,
                       logo_offset_x_mm = :ox, logo_offset_y_mm = :oy, auto_fit_scaling = :af,
                       version = version + 1, updated_by = :u, updated_at = NOW() WHERE hospital_id = :h"""),
               {"t": title or None, "f": footer_text or None, "a": align, "ox": ox, "oy": oy,
                "af": bool(payload.get("auto_fit_scaling", True)), "u": user.get("username"), "h": hospital_id})
    log_audit_event(db, user, client_ip(request), "update", "branding", str(hospital_id), {"title": title, "alignment": align})
    db.commit()
    svc.invalidate(hospital_id)
    return _serialize(svc.fetch_row(db, hospital_id))


async def _upload(kind, request, file, db, user, hospital_id):
    data = await file.read(svc.MAX_UPLOAD_BYTES + 1)
    try:
        blob, mime, w, h = svc.process_asset(data, file.filename or "")
    except svc.BrandingError as exc:
        raise HTTPException(400, str(exc))
    _ensure_row(db, hospital_id, user.get("username"))
    old = svc.fetch_row(db, hospital_id) or {}
    rel = svc.save_asset(hospital_id, kind, blob, mime)
    db.execute(text(f"""UPDATE document_branding SET {kind}_path = :p, {kind}_mime = :m, {kind}_width_px = :w, {kind}_height_px = :h2,
                        version = version + 1, updated_by = :u, updated_at = NOW() WHERE hospital_id = :h"""),
               {"p": rel, "m": mime, "w": w, "h2": h, "u": user.get("username"), "h": hospital_id})
    log_audit_event(db, user, client_ip(request), "upload", "branding", str(hospital_id), {"asset": kind, "mime": mime, "size": [w, h]})
    db.commit()
    svc.remove_asset(old.get(f"{kind}_path"))
    svc.invalidate(hospital_id)
    return _serialize(svc.fetch_row(db, hospital_id))


@router.post("/logo")
async def upload_logo(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("admin.use")), hospital_id: int = Depends(current_hospital_id)):
    return await _upload("logo", request, file, db, user, hospital_id)


@router.post("/footer")
async def upload_footer(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("admin.use")), hospital_id: int = Depends(current_hospital_id)):
    return await _upload("footer", request, file, db, user, hospital_id)


def _delete(kind, request, db, user, hospital_id):
    old = svc.fetch_row(db, hospital_id)
    if old and old.get(f"{kind}_path"):
        db.execute(text(f"""UPDATE document_branding SET {kind}_path = NULL, {kind}_mime = NULL, {kind}_width_px = NULL, {kind}_height_px = NULL,
                            version = version + 1, updated_by = :u, updated_at = NOW() WHERE hospital_id = :h"""),
                   {"u": user.get("username"), "h": hospital_id})
        log_audit_event(db, user, client_ip(request), "remove", "branding", str(hospital_id), {"asset": kind})
        db.commit()
        svc.remove_asset(old.get(f"{kind}_path"))
        svc.invalidate(hospital_id)
    return _serialize(svc.fetch_row(db, hospital_id))


@router.delete("/logo")
def delete_logo(request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.use")),
                hospital_id: int = Depends(current_hospital_id)):
    return _delete("logo", request, db, user, hospital_id)


@router.delete("/footer")
def delete_footer(request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("admin.use")),
                  hospital_id: int = Depends(current_hospital_id)):
    return _delete("footer", request, db, user, hospital_id)


@router.get("/asset/{kind}")
def get_asset(kind: str, db: Session = Depends(get_db), user: dict = Depends(get_current_user),
              hospital_id: int = Depends(current_hospital_id)):
    if kind not in ("logo", "footer"):
        raise HTTPException(404, "Not found")
    row = svc.fetch_row(db, hospital_id) or {}
    path = svc.abs_path(row.get(f"{kind}_path"))
    if not path:
        raise HTTPException(404, "Not found")
    with open(path, "rb") as f:
        body = f.read()
    # SVG is served as an image only; the CSP blocks any script if it is opened directly.
    return Response(body, media_type=row.get(f"{kind}_mime"),
                    headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff",
                             "Cache-Control": "private, max-age=300"})
