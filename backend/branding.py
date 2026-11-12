"""Global document branding: hospital title, letterhead logo, footer image/text.

One row per hospital in `document_branding` (independent of every transactional
table). Assets live under uploads/branding/<hospital_id>/ (the existing uploads
volume). Every document generator asks `get_branding()`; when nothing custom is
configured it returns None and callers keep their built-in HospAI defaults.
"""
import contextvars
import io
import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from contextlib import contextmanager

from sqlalchemy import text

logger = logging.getLogger(__name__)

UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "branding")
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 40_000_000
ALIGNMENTS = ("left", "center", "right")
# Document header / footer boxes in mm (A4 content width is 180mm).
LOGO_BOX_MM = (70.0, 28.0)
FOOTER_BOX_MM = (150.0, 9.0)
OFFSET_LIMIT_MM = 30.0
# Raster logos are normalised so the longest side is within this pixel range.
RASTER_MIN_SIDE, RASTER_MAX_SIDE = 600, 1600

_current_hospital = contextvars.ContextVar("branding_hospital_id", default=None)


@contextmanager
def use_hospital(hospital_id):
    """Scope `get_branding()` (no argument) to a hospital while a PDF is built."""
    token = _current_hospital.set(int(hospital_id) if hospital_id else None)
    try:
        yield
    finally:
        _current_hospital.reset(token)


# ---------- asset processing ----------

class BrandingError(ValueError):
    pass


def _svg_size(data: bytes):
    low = data[:4096].lower()
    if b"<!doctype" in low or b"<!entity" in low:
        raise BrandingError("SVG with DOCTYPE/ENTITY declarations is not allowed.")
    if re.search(rb"<script|javascript:|<foreignobject|\son[a-z]+\s*=|<iframe|<embed|href\s*=\s*[\"']\s*(?!#)", data, re.I):
        raise BrandingError("SVG contains scripts or external references and was rejected.")
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise BrandingError("The SVG file is not valid.")
    if not root.tag.lower().endswith("svg"):
        raise BrandingError("The SVG file is not valid.")

    def num(v):
        m = re.match(r"^\s*([0-9.]+)", v or "")
        return float(m.group(1)) if m else None
    w, h = num(root.get("width")), num(root.get("height"))
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if (not w or not h) and len(vb) == 4:
        w, h = float(vb[2]), float(vb[3])
    if not w or not h or w <= 0 or h <= 0:
        raise BrandingError("The SVG needs a width/height or viewBox.")
    return int(round(w)), int(round(h))


def process_asset(data: bytes, filename: str):
    """Validate + normalise an upload. Returns (bytes, mime, width_px, height_px)."""
    if not data:
        raise BrandingError("The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise BrandingError("The file is larger than 5 MB.")
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".svg"):
        raise BrandingError("Only .png, .jpg and .svg files are supported.")
    if ext == ".svg":
        w, h = _svg_size(data)
        return data, "image/svg+xml", w, h

    from PIL import Image, ImageChops
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()
        img = Image.open(io.BytesIO(data))
        if img.format not in ("PNG", "JPEG"):
            raise BrandingError("Only .png, .jpg and .svg files are supported.")
        if img.width * img.height > MAX_PIXELS:
            raise BrandingError("The image dimensions are too large.")
        img.load()
    except BrandingError:
        raise
    except Exception:
        raise BrandingError("The image could not be read.")
    img = img.convert("RGBA")
    # Trim empty margins (transparent, or plain white) so the artwork fills its box.
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if bbox and alpha.getextrema()[0] == 255:  # fully opaque -> trim near-white border
        bg = Image.new("RGB", img.size, (255, 255, 255))
        diff = ImageChops.difference(img.convert("RGB"), bg).convert("L").point(lambda v: 255 if v > 12 else 0)
        bbox = diff.getbbox() or bbox
    if bbox:
        img = img.crop(bbox)
    # Auto-fit: shrink oversized assets, enlarge tiny ones, aspect ratio preserved.
    longest = max(img.size)
    target = min(max(longest, RASTER_MIN_SIDE), RASTER_MAX_SIDE)
    if target != longest:
        scale = target / longest
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue(), "image/png", img.width, img.height


def fit_mm(width_px, height_px, box_w, box_h, auto_fit=True):
    """Scale (w,h) into the box keeping aspect ratio. With auto_fit off the image
    keeps its natural 96-dpi size but is still capped at the page width."""
    if not width_px or not height_px:
        return box_w, box_h
    ratio = width_px / height_px
    if auto_fit:
        w = min(box_w, box_h * ratio)
    else:
        w = min(width_px * 25.4 / 96.0, 180.0)
    return round(w, 2), round(w / ratio, 2)


# ---------- storage ----------

def _dir(hospital_id):
    return os.path.join(UPLOAD_ROOT, str(int(hospital_id)))


def save_asset(hospital_id, kind, data, mime):
    ext = {"image/png": ".png", "image/svg+xml": ".svg"}[mime]
    os.makedirs(_dir(hospital_id), exist_ok=True)
    name = f"{kind}_{int(time.time())}{ext}"
    path = os.path.join(_dir(hospital_id), name)
    with open(path, "wb") as f:
        f.write(data)
    return f"branding/{int(hospital_id)}/{name}"


def abs_path(rel):
    if not rel:
        return None
    full = os.path.abspath(os.path.join(os.path.dirname(UPLOAD_ROOT), rel))
    if not full.startswith(os.path.abspath(UPLOAD_ROOT) + os.sep):
        return None
    return full if os.path.isfile(full) else None


def remove_asset(rel):
    p = abs_path(rel)
    if p:
        try:
            os.remove(p)
        except OSError:
            pass


# ---------- config access ----------

_CACHE = {}
_TTL = 15.0


def invalidate(hospital_id=None):
    if hospital_id is None:
        _CACHE.clear()
    else:
        _CACHE.pop(int(hospital_id), None)


def fetch_row(db, hospital_id):
    row = db.execute(text("SELECT * FROM document_branding WHERE hospital_id = :h"), {"h": hospital_id}).mappings().first()
    return dict(row) if row else None


def _is_custom(row):
    return bool(row and (row.get("hospital_title") or row.get("logo_path") or row.get("footer_path") or row.get("footer_text")))


def get_branding(hospital_id=None):
    """Branding for PDF generators, or None -> use built-in HospAI defaults.
    Never raises: any failure degrades to the defaults."""
    hid = hospital_id or _current_hospital.get()
    key = int(hid) if hid else 0
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1]
    result = None
    try:
        from database import SessionLocal
        with SessionLocal() as db:
            if hid:
                row = fetch_row(db, int(hid))
            else:  # no hospital context: use the only configured hospital, if unambiguous
                rows = db.execute(text("SELECT * FROM document_branding")).mappings().all()
                customised = [dict(r) for r in rows if _is_custom(dict(r))]
                row = customised[0] if len(customised) == 1 else None
        if _is_custom(row):
            result = dict(row)
            result["logo_file"] = abs_path(row.get("logo_path"))
            result["footer_file"] = abs_path(row.get("footer_path"))
            for k in ("logo_offset_x_mm", "logo_offset_y_mm"):
                result[k] = float(result.get(k) or 0)
    except Exception:
        logger.exception("[branding] lookup failed; using defaults")
        result = None
    _CACHE[key] = (time.monotonic(), result)
    return result
