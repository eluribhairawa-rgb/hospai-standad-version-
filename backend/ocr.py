import io
from dotenv import load_dotenv, dotenv_values
import mimetypes
import os
from pathlib import Path
import json
import re
try:
    from google import genai
    from google.genai import types
    _GENAI_IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - import guard for local/dev env mismatch
    genai = None
    types = None
    _GENAI_IMPORT_ERROR = exc
try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - dependency guard
    PdfReader = None


_CURRENT_FILE = Path(__file__).resolve()
_BACKEND_DIR = _CURRENT_FILE.parents[1]
_PROJECT_ROOT = _CURRENT_FILE.parents[2]


def _load_environment():
    load_dotenv(_BACKEND_DIR / ".env", override=False)
    load_dotenv(_PROJECT_ROOT / ".env", override=False)


def _resolve_api_key():
    key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
    if key:
        return key

    backend_env = dotenv_values(_BACKEND_DIR / ".env")
    root_env = dotenv_values(_PROJECT_ROOT / ".env")
    key = (backend_env.get("GEMINI_API_KEY") or root_env.get("GEMINI_API_KEY") or "").strip()
    if key:
        return key

    key = (backend_env.get("GOOGLE_API_KEY") or root_env.get("GOOGLE_API_KEY") or "").strip()
    return key or None


_load_environment()

LANGUAGE_PROMPTS = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
}

LANGUAGE_NAMES = {"en": "English", "es": "Spanish", "fr": "French", "de": "German"}

_client = None
SUPPORTED_IMAGE_MIME_TYPES = {
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
}


def get_genai_model():
    global _client
    if genai is None:
        raise RuntimeError(
            "google-genai is not installed or failed to import. "
            f"Original import error: {_GENAI_IMPORT_ERROR}"
        )
    if _client is None:
        api_key = _resolve_api_key()
        if not api_key:
            return None
        _client = genai.Client(api_key=api_key)
    return _client


def _generate_content(client, prompt, mime_type=None, file_bytes=None):
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    if mime_type and file_bytes is not None:
        contents = [
            types.UserContent(
                parts=[
                    types.Part.from_text(text=prompt),
                    types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                ]
            )
        ]
        response = client.models.generate_content(model=model_name, contents=contents)
    else:
        response = client.models.generate_content(model=model_name, contents=prompt)
    return (response.text or "").strip()


def _detect_mime_type(file_bytes, filename=None):
    if filename:
        guessed, _ = mimetypes.guess_type(filename)
        if guessed:
            return guessed.lower()

    header = file_bytes[:32]
    if header.startswith(b"%PDF-"):
        return "application/pdf"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    if header.startswith(b"GIF87a") or header.startswith(b"GIF89a"):
        return "image/gif"
    if header.startswith(b"BM"):
        return "image/bmp"
    if header.startswith(b"RIFF") and b"WEBP" in header:
        return "image/webp"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brand = header[8:12].lower()
        if brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
        if brand in {b"mif1", b"msf1"}:
            return "image/heif"
    return None


def _extract_text_from_pdf_bytes(pdf_bytes):
    if PdfReader is None:
        raise RuntimeError("PDF support requires pypdf. Install dependencies and retry.")
    reader = PdfReader(io.BytesIO(pdf_bytes))
    chunks = []
    for page in reader.pages:
        page_text = page.extract_text() or ""
        if page_text.strip():
            chunks.append(page_text.strip())
    return "\n\n".join(chunks).strip()


def _document_hint(doc_type):
    type_hints = {
        "prescription": "This is a medical prescription. Focus on medication names, dosages, frequencies, and instructions.",
        "xray_mri": "This is a medical imaging report (X-Ray/MRI). Extract findings, impressions, and any measurements.",
        "test_docs": "This is a medical test report. Extract test names, values, reference ranges, and any abnormal findings.",
    }
    return type_hints.get(doc_type, "")


def _vision_prompt(target_language, doc_type):
    return f"""Extract ALL text from this medical document.

{_document_hint(doc_type)}

Output language: {target_language}
Return format (STRICT):
1. Return only valid JSON
2. Use exactly one top-level key: "markdown"
3. Value of "markdown" must be markdown text only
4. Do not include code fences, explanations, or extra keys

**Formatting Requirements:**
1. Preserve document structure with clear sections
2. Use markdown headers (##) for main sections like Patient Information, Medications, Diagnosis, Instructions, Test Results
3. Use **bold** for medication names, dosages, frequencies, and critical findings
4. Use bullet points (•) for multiple items
5. Format tables using markdown table syntax with aligned columns
6. Separate different sections with blank lines

JSON example:
{{"markdown":"## Section\\n- item"}}"""


def _pdf_formatting_prompt(text, target_language, doc_type):
    return f"""You are given raw text extracted from a PDF medical document.

{_document_hint(doc_type)}

Task:
1. Rewrite and normalize the content in {target_language}
2. Preserve all medical details and numbers accurately
3. Remove OCR noise and obvious extraction artifacts
4. Use markdown structure with clear sections and bullets
5. Use markdown tables when rows/columns are present
6. Return only valid JSON with exactly one key: "markdown"
7. Do not include code fences or commentary

Input text:
\"\"\"
{text}
\"\"\"
"""


def _extract_markdown_from_llm_response(raw_text):
    text = (raw_text or "").strip()
    if not text:
        return ""

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and isinstance(parsed.get("markdown"), str):
            return parsed["markdown"].strip()
    except Exception:
        pass

    fenced_json = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced_json:
        candidate = fenced_json.group(1).strip()
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and isinstance(parsed.get("markdown"), str):
                return parsed["markdown"].strip()
        except Exception:
            pass

    fenced_md = re.search(r"```(?:markdown|md)\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced_md:
        return fenced_md.group(1).strip()

    for marker in ("## ", "# "):
        pos = text.find(marker)
        if pos >= 0:
            return text[pos:].strip()
    return text


def extract_text_from_image(file_bytes, language="en", doc_type="document", filename=None):
    client = get_genai_model()
    if client is None:
        return (
            "OCR Error: GEMINI_API_KEY not configured. "
            "Set GEMINI_API_KEY in your environment to enable OCR."
        )

    try:
        target_language = LANGUAGE_PROMPTS.get(language, "English")
        mime_type = _detect_mime_type(file_bytes, filename)

        if mime_type == "application/pdf":
            raw_text = _extract_text_from_pdf_bytes(file_bytes)
            if raw_text:
                result_text = _generate_content(
                    client,
                    _pdf_formatting_prompt(raw_text, target_language, doc_type),
                )
                cleaned = _extract_markdown_from_llm_response(result_text)
                return cleaned or raw_text

            result_text = _generate_content(
                client,
                _vision_prompt(target_language, doc_type),
                mime_type="application/pdf",
                file_bytes=file_bytes,
            )
            return _extract_markdown_from_llm_response(result_text)

        if mime_type and mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
            return (
                f"OCR Error: Unsupported file type ({mime_type}). "
                "Upload an image (JPG, PNG, WEBP, TIFF, BMP, GIF, HEIC/HEIF) or PDF."
            )

        content_mime = mime_type or "image/jpeg"
        result_text = _generate_content(
            client,
            _vision_prompt(target_language, doc_type),
            mime_type=content_mime,
            file_bytes=file_bytes,
        )
        return _extract_markdown_from_llm_response(result_text)
    except Exception as exc:
        return f"OCR Error: {exc}\n\nPlease ensure you have a valid Gemini API key configured."
