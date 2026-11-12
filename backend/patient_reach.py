"""Patient Reach AI - survey templates, manual WhatsApp survey requests,
survey responses, WhatsApp templates/message log and feedback reports.

WhatsApp messages are sent by staff through wa.me links (no Business Cloud
API); this module only records what was sent and the replies staff enter.
Tables are created by migrations/migrations_patient_reach_surveys.sql.
"""
import json
from datetime import date, datetime, timedelta

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from database import IST_TIMEZONE

SURVEY_TYPES = ("IPD", "OPD", "EMERGENCY", "GENERAL")
TEMPLATE_STATUSES = ("DRAFT", "ACTIVE", "INACTIVE")
QUESTION_TYPES = ("RATING", "SINGLE_CHOICE", "MULTI_CHOICE", "YES_NO", "TEXT")
CHOICE_TYPES = ("SINGLE_CHOICE", "MULTI_CHOICE")
WHATSAPP_CATEGORIES = ("SURVEY", "DISCHARGE", "FOLLOW_UP", "REMINDER", "GENERAL")
REQUEST_STATUSES = ("NOT_SENT", "PENDING", "COMPLETED", "CANCELLED")
OPEN_STATUSES = ("NOT_SENT", "PENDING")
CHANNELS = ("WHATSAPP", "PHONE", "IN_PERSON")
YES_NO_OPTIONS = ["Yes", "No"]

_SEED_LOCK_KEY = 748291510

DEFAULT_SURVEY_TEMPLATES = [
    {
        "name": "IPD Discharge Feedback",
        "description": "Feedback from inpatients after discharge.",
        "survey_type": "IPD",
        "questions": [
            ("How would you rate the doctor's behaviour and care?", "RATING", "Doctor Behaviour", [], True),
            ("How would you rate the nursing care during your stay?", "RATING", "Nursing Care", [], True),
            ("How clean were your room, ward and washrooms?", "RATING", "Cleanliness", [], True),
            ("How smooth was the discharge process?", "RATING", "Discharge Process", [], True),
            ("How would you rate your overall experience?", "RATING", "Overall Experience", [], True),
            ("Would you recommend our hospital to family and friends?", "YES_NO", "Overall Experience", YES_NO_OPTIONS, True),
            ("Any suggestions for us?", "TEXT", "Suggestions", [], False),
        ],
    },
    {
        "name": "OPD Visit Feedback",
        "description": "Feedback from outpatients after a consultation.",
        "survey_type": "OPD",
        "questions": [
            ("How would you rate your consultation with the doctor?", "RATING", "Doctor Behaviour", [], True),
            ("How long did you wait before your consultation?", "SINGLE_CHOICE", "Front Office",
             ["Under 15 minutes", "15 to 30 minutes", "30 to 60 minutes", "Over 1 hour"], True),
            ("How helpful was the front office / registration staff?", "RATING", "Front Office", [], True),
            ("How clean was the hospital?", "RATING", "Cleanliness", [], True),
            ("How would you rate your overall experience?", "RATING", "Overall Experience", [], True),
            ("Any suggestions for us?", "TEXT", "Suggestions", [], False),
        ],
    },
]

DEFAULT_WHATSAPP_TEMPLATES = [
    (
        "Patient Feedback Survey", "SURVEY",
        "Dear {patient_name},\n\n"
        "Thank you for choosing {hospital_name}. We hope you are recovering well after your visit with {doctor_name}.\n\n"
        "Please spare a minute to share your feedback on *{survey_name}* by replying to this message:\n\n"
        "{survey_questions}\n\n"
        "For rating questions, reply with a number from 1 (Poor) to 5 (Excellent).\n"
        "Your feedback helps us serve you better.\n\n"
        "- {hospital_name}",
    ),
    (
        "Survey Reminder", "REMINDER",
        "Dear {patient_name},\n\n"
        "This is a gentle reminder to share your feedback about your recent visit to {hospital_name} (UHID: {uhid}).\n\n"
        "{survey_questions}\n\n"
        "Simply reply to this message with your answers. Thank you!\n\n"
        "- {hospital_name}",
    ),
    (
        "Follow-up Reminder", "FOLLOW_UP",
        "Dear {patient_name},\n\n"
        "This is a reminder for your follow-up consultation with {doctor_name} ({department}) at {hospital_name}.\n"
        "Please carry your previous prescription and reports.\n\n"
        "- {hospital_name}",
    ),
    (
        "Thank You for Feedback", "GENERAL",
        "Dear {patient_name},\n\n"
        "Thank you for sharing your valuable feedback with {hospital_name}. We wish you good health!\n\n"
        "- {hospital_name}",
    ),
]


# ------------------------------------------------------------------ helpers --

def _rows(db: Session, sql: str, params: dict | None = None, expanding: tuple = ()):
    stmt = text(sql)
    if expanding:
        stmt = stmt.bindparams(*[bindparam(name, expanding=True) for name in expanding])
    return [dict(r) for r in db.execute(stmt, params or {}).mappings().all()]


def _row(db: Session, sql: str, params: dict | None = None):
    found = _rows(db, sql, params)
    return found[0] if found else None


def _now() -> datetime:
    return datetime.now(IST_TIMEZONE).replace(tzinfo=None)


def _clean(value, limit: int | None = None) -> str:
    s = str(value or "").strip()
    return s[:limit] if limit else s


def _parse_date(value, label: str):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ValueError(f"{label} must be a date in YYYY-MM-DD format.")


def _parse_int(value, label: str, required: bool = False):
    if value in (None, ""):
        if required:
            raise ValueError(f"{label} is required.")
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number.")


def _options_list(value) -> list:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    return value if isinstance(value, list) else []


def _date_range_clause(column: str, date_from, date_to, params: dict, clauses: list):
    d_from = _parse_date(date_from, "From date")
    d_to = _parse_date(date_to, "To date")
    if d_from and d_to and d_from > d_to:
        raise ValueError("From date cannot be after To date.")
    if d_from:
        clauses.append(f"{column} >= :date_from")
        params["date_from"] = datetime.combine(d_from, datetime.min.time())
    if d_to:
        clauses.append(f"{column} < :date_to")
        params["date_to"] = datetime.combine(d_to + timedelta(days=1), datetime.min.time())


def hospital_name(db: Session, hospital_id: int) -> str:
    row = _row(db, "SELECT name FROM hospitals WHERE id = :hid", {"hid": hospital_id})
    return (row or {}).get("name") or "HospAI Hospital"


def _patient(db: Session, hospital_id: int, patient_id: str):
    return _row(db, """
        SELECT p.patient_id, CONCAT_WS(' ', p.name, p.middle_name, p.last_name) AS patient_name,
               COALESCE(NULLIF(p.phone, ''), p.family_mobile) AS phone,
               (SELECT a.doctor_name FROM appointments a WHERE a.patient_id = p.patient_id
                ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_doctor_name,
               (SELECT a.department FROM appointments a WHERE a.patient_id = p.patient_id
                ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_department
        FROM patients p WHERE p.patient_id = :pid AND p.hospital_id = :hid
    """, {"pid": patient_id, "hid": hospital_id})


# ----------------------------------------------------------------- defaults --

def ensure_defaults(db: Session, hospital_id: int):
    """Give a hospital the starter survey and WhatsApp templates the first
    time it opens the module. Deleted templates are soft-deleted, so a
    hospital that removed them never gets them back."""
    has_surveys = _row(db, "SELECT 1 AS x FROM reach_survey_templates WHERE hospital_id = :hid LIMIT 1", {"hid": hospital_id})
    has_whatsapp = _row(db, "SELECT 1 AS x FROM reach_whatsapp_templates WHERE hospital_id = :hid LIMIT 1", {"hid": hospital_id})
    if has_surveys and has_whatsapp:
        return
    db.execute(text("SELECT pg_advisory_xact_lock(:k, :hid)"), {"k": _SEED_LOCK_KEY, "hid": hospital_id})
    if not _row(db, "SELECT 1 AS x FROM reach_survey_templates WHERE hospital_id = :hid LIMIT 1", {"hid": hospital_id}):
        for tpl in DEFAULT_SURVEY_TEMPLATES:
            _insert_template(db, hospital_id, {
                "name": tpl["name"], "description": tpl["description"], "survey_type": tpl["survey_type"], "status": "ACTIVE",
                "questions": [
                    {"question_text": q[0], "question_type": q[1], "category": q[2], "options": q[3], "is_required": q[4]}
                    for q in tpl["questions"]
                ],
            }, "system")
    if not _row(db, "SELECT 1 AS x FROM reach_whatsapp_templates WHERE hospital_id = :hid LIMIT 1", {"hid": hospital_id}):
        for name, category, body in DEFAULT_WHATSAPP_TEMPLATES:
            db.execute(text("""
                INSERT INTO reach_whatsapp_templates (hospital_id, name, category, body, created_by, updated_by)
                VALUES (:hid, :name, :category, :body, 'system', 'system')
            """), {"hid": hospital_id, "name": name, "category": category, "body": body})
    db.commit()


# --------------------------------------------------------- survey templates --

def _normalize_template(payload: dict) -> dict:
    name = _clean(payload.get("name"), 200)
    if not name:
        raise ValueError("Survey name is required.")
    survey_type = _clean(payload.get("survey_type") or "GENERAL").upper()
    if survey_type not in SURVEY_TYPES:
        raise ValueError(f"Survey type must be one of {', '.join(SURVEY_TYPES)}.")
    status = _clean(payload.get("status") or "ACTIVE").upper()
    if status not in TEMPLATE_STATUSES:
        raise ValueError(f"Status must be one of {', '.join(TEMPLATE_STATUSES)}.")
    raw_questions = payload.get("questions") or []
    if not isinstance(raw_questions, list) or not raw_questions:
        raise ValueError("Add at least one question to the survey.")
    if len(raw_questions) > 50:
        raise ValueError("A survey can have at most 50 questions.")
    questions = []
    for idx, q in enumerate(raw_questions, start=1):
        q = q or {}
        q_text = _clean(q.get("question_text"), 500)
        if not q_text:
            raise ValueError(f"Question {idx}: question text is required.")
        q_type = _clean(q.get("question_type") or "RATING").upper()
        if q_type not in QUESTION_TYPES:
            raise ValueError(f"Question {idx}: invalid question type.")
        options: list[str] = []
        if q_type in CHOICE_TYPES:
            seen = set()
            for opt in _options_list(q.get("options")):
                label = _clean(opt, 200)
                if label and label.lower() not in seen:
                    seen.add(label.lower())
                    options.append(label)
            if len(options) < 2:
                raise ValueError(f"Question {idx}: add at least two answer options.")
        elif q_type == "YES_NO":
            options = list(YES_NO_OPTIONS)
        questions.append({
            "id": _parse_int(q.get("id"), f"Question {idx} id"),
            "question_text": q_text,
            "question_type": q_type,
            "category": _clean(q.get("category"), 100) or None,
            "options": options,
            "is_required": bool(q.get("is_required", True)),
        })
    return {
        "name": name,
        "description": _clean(payload.get("description"), 1000) or None,
        "survey_type": survey_type,
        "status": status,
        "questions": questions,
    }


def _insert_question(db: Session, template_id: int, position: int, q: dict):
    db.execute(text("""
        INSERT INTO reach_survey_questions (template_id, position, question_text, question_type, category, options, is_required)
        VALUES (:tid, :pos, :qt, :qtype, :cat, CAST(:opts AS JSONB), :req)
    """), {"tid": template_id, "pos": position, "qt": q["question_text"], "qtype": q["question_type"],
           "cat": q["category"], "opts": json.dumps(q["options"]), "req": q["is_required"]})


def _insert_template(db: Session, hospital_id: int, data: dict, username: str | None) -> int:
    template_id = db.execute(text("""
        INSERT INTO reach_survey_templates (hospital_id, name, description, survey_type, status, created_by, updated_by)
        VALUES (:hid, :name, :desc, :stype, :status, :user, :user) RETURNING id
    """), {"hid": hospital_id, "name": data["name"], "desc": data["description"], "stype": data["survey_type"],
           "status": data["status"], "user": username}).scalar_one()
    for pos, q in enumerate(data["questions"], start=1):
        _insert_question(db, template_id, pos, q)
    return template_id


def _check_unique_template_name(db: Session, hospital_id: int, name: str, exclude_id: int | None = None):
    clash = _row(db, """
        SELECT id FROM reach_survey_templates
        WHERE hospital_id = :hid AND NOT is_deleted AND LOWER(name) = LOWER(:name) AND (:ex IS NULL OR id <> :ex)
    """, {"hid": hospital_id, "name": name, "ex": exclude_id})
    if clash:
        raise ValueError(f"A survey named '{name}' already exists.")


def list_survey_templates(db: Session, hospital_id: int, status=None, survey_type=None, q=None):
    clauses = ["t.hospital_id = :hid", "NOT t.is_deleted"]
    params: dict = {"hid": hospital_id}
    if status:
        clauses.append("t.status = :status")
        params["status"] = str(status).upper()
    if survey_type:
        clauses.append("t.survey_type = :stype")
        params["stype"] = str(survey_type).upper()
    if q:
        clauses.append("(LOWER(t.name) LIKE :q OR LOWER(COALESCE(t.description, '')) LIKE :q)")
        params["q"] = f"%{str(q).strip().lower()}%"
    return _rows(db, f"""
        SELECT t.id, t.name, t.description, t.survey_type, t.status, t.created_by, t.created_at, t.updated_by, t.updated_at,
               (SELECT COUNT(*) FROM reach_survey_questions qq WHERE qq.template_id = t.id) AS question_count,
               (SELECT COUNT(*) FROM reach_survey_responses rr WHERE rr.template_id = t.id) AS response_count,
               (SELECT COUNT(*) FROM reach_survey_requests sr WHERE sr.template_id = t.id AND sr.status IN ('NOT_SENT', 'PENDING')) AS open_count,
               (SELECT ROUND(AVG(rr.overall_rating), 1)::float FROM reach_survey_responses rr WHERE rr.template_id = t.id) AS avg_rating,
               (SELECT MAX(rr.submitted_at) FROM reach_survey_responses rr WHERE rr.template_id = t.id) AS last_response_at
        FROM reach_survey_templates t
        WHERE {' AND '.join(clauses)}
        ORDER BY CASE t.status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END, t.name
    """, params)


def _template_row(db: Session, hospital_id: int, template_id: int):
    return _row(db, """
        SELECT id, name, description, survey_type, status, created_by, created_at, updated_by, updated_at
        FROM reach_survey_templates WHERE id = :tid AND hospital_id = :hid AND NOT is_deleted
    """, {"tid": template_id, "hid": hospital_id})


def template_questions(db: Session, template_id: int):
    rows = _rows(db, """
        SELECT id, position, question_text, question_type, category, options, is_required
        FROM reach_survey_questions WHERE template_id = :tid ORDER BY position, id
    """, {"tid": template_id})
    for r in rows:
        r["options"] = _options_list(r["options"])
    return rows


def get_survey_template(db: Session, hospital_id: int, template_id: int):
    tpl = _template_row(db, hospital_id, template_id)
    if not tpl:
        return None
    tpl["questions"] = template_questions(db, template_id)
    tpl["response_count"] = _row(db, "SELECT COUNT(*) AS n FROM reach_survey_responses WHERE template_id = :tid", {"tid": template_id})["n"]
    return tpl


def create_survey_template(db: Session, hospital_id: int, payload: dict, username: str | None) -> int:
    data = _normalize_template(payload)
    _check_unique_template_name(db, hospital_id, data["name"])
    template_id = _insert_template(db, hospital_id, data, username)
    db.commit()
    return template_id


def update_survey_template(db: Session, hospital_id: int, template_id: int, payload: dict, username: str | None) -> bool:
    if not _template_row(db, hospital_id, template_id):
        return False
    data = _normalize_template(payload)
    _check_unique_template_name(db, hospital_id, data["name"], template_id)
    db.execute(text("""
        UPDATE reach_survey_templates
        SET name = :name, description = :desc, survey_type = :stype, status = :status, updated_by = :user, updated_at = CURRENT_TIMESTAMP
        WHERE id = :tid
    """), {"name": data["name"], "desc": data["description"], "stype": data["survey_type"], "status": data["status"],
           "user": username, "tid": template_id})
    existing_ids = {r["id"] for r in _rows(db, "SELECT id FROM reach_survey_questions WHERE template_id = :tid", {"tid": template_id})}
    kept: set[int] = set()
    for pos, q in enumerate(data["questions"], start=1):
        if q["id"] and q["id"] in existing_ids:
            kept.add(q["id"])
            db.execute(text("""
                UPDATE reach_survey_questions
                SET position = :pos, question_text = :qt, question_type = :qtype, category = :cat,
                    options = CAST(:opts AS JSONB), is_required = :req
                WHERE id = :qid
            """), {"pos": pos, "qt": q["question_text"], "qtype": q["question_type"], "cat": q["category"],
                   "opts": json.dumps(q["options"]), "req": q["is_required"], "qid": q["id"]})
        else:
            _insert_question(db, template_id, pos, q)
    removed = existing_ids - kept
    if removed:
        # Recorded answers keep their own copy of the question text (question_id goes NULL).
        _rows(db, "DELETE FROM reach_survey_questions WHERE id IN :ids RETURNING id", {"ids": list(removed)}, expanding=("ids",))
    db.commit()
    return True


def set_survey_template_status(db: Session, hospital_id: int, template_id: int, status: str, username: str | None) -> bool:
    status = _clean(status).upper()
    if status not in TEMPLATE_STATUSES:
        raise ValueError(f"Status must be one of {', '.join(TEMPLATE_STATUSES)}.")
    res = db.execute(text("""
        UPDATE reach_survey_templates SET status = :status, updated_by = :user, updated_at = CURRENT_TIMESTAMP
        WHERE id = :tid AND hospital_id = :hid AND NOT is_deleted
    """), {"status": status, "user": username, "tid": template_id, "hid": hospital_id})
    db.commit()
    return res.rowcount > 0


def duplicate_survey_template(db: Session, hospital_id: int, template_id: int, username: str | None):
    tpl = get_survey_template(db, hospital_id, template_id)
    if not tpl:
        return None
    base = f"{tpl['name']} (Copy)"
    name, n = base, 2
    while _row(db, "SELECT 1 AS x FROM reach_survey_templates WHERE hospital_id = :hid AND NOT is_deleted AND LOWER(name) = LOWER(:name)",
               {"hid": hospital_id, "name": name}):
        name, n = f"{base} {n}", n + 1
    new_id = _insert_template(db, hospital_id, {
        "name": name[:200], "description": tpl["description"], "survey_type": tpl["survey_type"], "status": "DRAFT",
        "questions": [{**q, "is_required": bool(q["is_required"])} for q in tpl["questions"]],
    }, username)
    db.commit()
    return new_id


def delete_survey_template(db: Session, hospital_id: int, template_id: int, username: str | None) -> bool:
    if not _template_row(db, hospital_id, template_id):
        return False
    # Soft delete: responses and requests keep pointing at it for reports.
    db.execute(text("""
        UPDATE reach_survey_templates SET is_deleted = TRUE, status = 'INACTIVE', updated_by = :user, updated_at = CURRENT_TIMESTAMP
        WHERE id = :tid
    """), {"user": username, "tid": template_id})
    db.execute(text("""
        UPDATE reach_survey_requests SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE template_id = :tid AND status = 'NOT_SENT'
    """), {"tid": template_id})
    db.commit()
    return True


# -------------------------------------------------------- whatsapp templates --

def _normalize_whatsapp_template(payload: dict) -> dict:
    name = _clean(payload.get("name"), 200)
    if not name:
        raise ValueError("Template name is required.")
    category = _clean(payload.get("category") or "GENERAL").upper()
    if category not in WHATSAPP_CATEGORIES:
        raise ValueError(f"Category must be one of {', '.join(WHATSAPP_CATEGORIES)}.")
    body = str(payload.get("body") or "").strip()
    if not body:
        raise ValueError("Message body is required.")
    if len(body) > 4000:
        raise ValueError("Message body cannot exceed 4000 characters.")
    return {"name": name, "category": category, "body": body, "is_active": bool(payload.get("is_active", True))}


def list_whatsapp_templates(db: Session, hospital_id: int, category=None, active_only: bool = False, q=None):
    clauses = ["hospital_id = :hid", "NOT is_deleted"]
    params: dict = {"hid": hospital_id}
    if category:
        clauses.append("category = :cat")
        params["cat"] = str(category).upper()
    if active_only:
        clauses.append("is_active")
    if q:
        clauses.append("(LOWER(name) LIKE :q OR LOWER(body) LIKE :q)")
        params["q"] = f"%{str(q).strip().lower()}%"
    return _rows(db, f"""
        SELECT id, name, category, body, is_active, created_by, created_at, updated_by, updated_at
        FROM reach_whatsapp_templates WHERE {' AND '.join(clauses)}
        ORDER BY is_active DESC, category, name
    """, params)


def create_whatsapp_template(db: Session, hospital_id: int, payload: dict, username: str | None) -> int:
    data = _normalize_whatsapp_template(payload)
    new_id = db.execute(text("""
        INSERT INTO reach_whatsapp_templates (hospital_id, name, category, body, is_active, created_by, updated_by)
        VALUES (:hid, :name, :cat, :body, :active, :user, :user) RETURNING id
    """), {"hid": hospital_id, "name": data["name"], "cat": data["category"], "body": data["body"],
           "active": data["is_active"], "user": username}).scalar_one()
    db.commit()
    return new_id


def update_whatsapp_template(db: Session, hospital_id: int, template_id: int, payload: dict, username: str | None) -> bool:
    data = _normalize_whatsapp_template(payload)
    res = db.execute(text("""
        UPDATE reach_whatsapp_templates
        SET name = :name, category = :cat, body = :body, is_active = :active, updated_by = :user, updated_at = CURRENT_TIMESTAMP
        WHERE id = :id AND hospital_id = :hid AND NOT is_deleted
    """), {"name": data["name"], "cat": data["category"], "body": data["body"], "active": data["is_active"],
           "user": username, "id": template_id, "hid": hospital_id})
    db.commit()
    return res.rowcount > 0


def delete_whatsapp_template(db: Session, hospital_id: int, template_id: int, username: str | None) -> bool:
    res = db.execute(text("""
        UPDATE reach_whatsapp_templates SET is_deleted = TRUE, is_active = FALSE, updated_by = :user, updated_at = CURRENT_TIMESTAMP
        WHERE id = :id AND hospital_id = :hid AND NOT is_deleted
    """), {"user": username, "id": template_id, "hid": hospital_id})
    db.commit()
    return res.rowcount > 0


# ---------------------------------------------------------- survey requests --

_REQUEST_SELECT = """
    SELECT r.id, r.template_id, t.name AS template_name, t.survey_type, r.patient_id,
           CONCAT_WS(' ', p.name, p.middle_name, p.last_name) AS patient_name, p.age, p.gender,
           COALESCE(NULLIF(r.phone, ''), NULLIF(p.phone, ''), p.family_mobile) AS phone,
           CASE WHEN NULLIF(p.phone, '') IS NOT NULL THEN p.phone_country_code ELSE p.family_country_code END AS patient_phone_country_code,
           r.encounter_type, r.encounter_id, r.encounter_label, r.doctor_name, r.department,
           r.whatsapp_template_id, r.message, r.status, r.send_count, r.sent_at, r.sent_by,
           r.completed_at, r.cancelled_at, r.created_by, r.created_at,
           resp.id AS response_id, resp.overall_rating::float AS overall_rating, resp.comments,
           resp.channel, resp.submitted_at, resp.recorded_by,
           COALESCE(cr.category_ratings, '{}'::jsonb) AS category_ratings
    FROM reach_survey_requests r
    JOIN reach_survey_templates t ON t.id = r.template_id
    LEFT JOIN patients p ON p.patient_id = r.patient_id AND p.hospital_id = r.hospital_id
    LEFT JOIN reach_survey_responses resp ON resp.request_id = r.id
    LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(c.category, c.avg_val) AS category_ratings
        FROM (
            SELECT a.category, ROUND(AVG(a.rating_value), 1)::float AS avg_val
            FROM reach_survey_answers a
            WHERE a.response_id = resp.id AND a.rating_value IS NOT NULL AND COALESCE(a.category, '') <> ''
            GROUP BY a.category
        ) c
    ) cr ON TRUE
"""


def _request_filters(hospital_id: int, filters: dict):
    clauses = ["r.hospital_id = :hid"]
    params: dict = {"hid": hospital_id}
    status = _clean(filters.get("status")).upper()
    if status:
        if status not in REQUEST_STATUSES:
            raise ValueError("Invalid status filter.")
        clauses.append("r.status = :status")
        params["status"] = status
    elif not filters.get("include_cancelled"):
        clauses.append("r.status <> 'CANCELLED'")
    template_id = _parse_int(filters.get("template_id"), "Survey")
    if template_id:
        clauses.append("r.template_id = :tid")
        params["tid"] = template_id
    if filters.get("patient_id"):
        clauses.append("r.patient_id = :pid")
        params["pid"] = _clean(filters["patient_id"])
    if filters.get("survey_type"):
        clauses.append("t.survey_type = :stype")
        params["stype"] = _clean(filters["survey_type"]).upper()
    rating = _clean(filters.get("rating")).lower()
    if rating:
        if rating == "low":
            clauses.append("resp.overall_rating <= 2")
        elif rating == "high":
            clauses.append("resp.overall_rating >= 4")
        elif rating in ("1", "2", "3", "4", "5"):
            clauses.append("ROUND(resp.overall_rating) = :rating")
            params["rating"] = int(rating)
        else:
            raise ValueError("Invalid rating filter.")
    q = _clean(filters.get("q")).lower()
    if q:
        clauses.append("""(
            LOWER(CONCAT_WS(' ', p.name, p.middle_name, p.last_name)) LIKE :q OR LOWER(r.patient_id) LIKE :q
            OR COALESCE(r.phone, p.phone, '') LIKE :q OR LOWER(COALESCE(resp.comments, '')) LIKE :q
            OR LOWER(COALESCE(r.doctor_name, '')) LIKE :q OR LOWER(t.name) LIKE :q
        )""")
        params["q"] = f"%{q}%"
    _date_range_clause("COALESCE(resp.submitted_at, r.sent_at, r.created_at)", filters.get("date_from"), filters.get("date_to"), params, clauses)
    return clauses, params


def list_survey_requests(db: Session, hospital_id: int, filters: dict):
    clauses, params = _request_filters(hospital_id, filters)
    limit = min(max(_parse_int(filters.get("limit"), "Limit") or 200, 1), 5000)
    offset = max(_parse_int(filters.get("offset"), "Offset") or 0, 0)
    where = " AND ".join(clauses)
    total = _row(db, f"""
        SELECT COUNT(*) AS n FROM reach_survey_requests r
        JOIN reach_survey_templates t ON t.id = r.template_id
        LEFT JOIN patients p ON p.patient_id = r.patient_id AND p.hospital_id = r.hospital_id
        LEFT JOIN reach_survey_responses resp ON resp.request_id = r.id
        WHERE {where}
    """, params)["n"]
    items = _rows(db, f"""
        {_REQUEST_SELECT}
        WHERE {where}
        ORDER BY COALESCE(resp.submitted_at, r.sent_at, r.created_at) DESC, r.id DESC
        LIMIT :limit OFFSET :offset
    """, {**params, "limit": limit, "offset": offset})
    return {"items": items, "total": total}


def get_survey_request(db: Session, hospital_id: int, request_id: int):
    req = _row(db, f"{_REQUEST_SELECT} WHERE r.id = :rid AND r.hospital_id = :hid", {"rid": request_id, "hid": hospital_id})
    if not req:
        return None
    req["questions"] = template_questions(db, req["template_id"])
    req["answers"] = _response_answers(db, req["response_id"]) if req["response_id"] else []
    req["messages"] = _rows(db, """
        SELECT id, phone, template_name, message, sent_by, sent_at FROM reach_whatsapp_messages
        WHERE request_id = :rid ORDER BY sent_at DESC
    """, {"rid": request_id})
    return req


def _open_request(db: Session, hospital_id: int, patient_id: str, template_id: int):
    return _row(db, """
        SELECT id FROM reach_survey_requests
        WHERE hospital_id = :hid AND patient_id = :pid AND template_id = :tid AND status IN ('NOT_SENT', 'PENDING')
        ORDER BY created_at DESC LIMIT 1
    """, {"hid": hospital_id, "pid": patient_id, "tid": template_id})


def _active_template(db: Session, hospital_id: int, template_id):
    template_id = _parse_int(template_id, "Survey", required=True)
    tpl = _template_row(db, hospital_id, template_id)
    if not tpl:
        raise ValueError("Survey template not found.")
    if tpl["status"] != "ACTIVE":
        raise ValueError(f"Survey '{tpl['name']}' is not active. Activate it in Survey Templates first.")
    return tpl


def create_survey_requests(db: Session, hospital_id: int, payload: dict, username: str | None):
    tpl = _active_template(db, hospital_id, payload.get("template_id"))
    patient_ids = payload.get("patient_ids") or ([payload["patient_id"]] if payload.get("patient_id") else [])
    patient_ids = list(dict.fromkeys(_clean(pid) for pid in patient_ids if _clean(pid)))
    if not patient_ids:
        raise ValueError("Select at least one patient.")
    if len(patient_ids) > 500:
        raise ValueError("You can queue at most 500 patients at a time.")
    wa_id = _parse_int(payload.get("whatsapp_template_id"), "WhatsApp template")
    if wa_id and not _row(db, "SELECT id FROM reach_whatsapp_templates WHERE id = :id AND hospital_id = :hid AND NOT is_deleted",
                          {"id": wa_id, "hid": hospital_id}):
        raise ValueError("WhatsApp template not found.")
    single = len(patient_ids) == 1
    created, skipped = [], []
    for pid in patient_ids:
        patient = _patient(db, hospital_id, pid)
        if not patient:
            skipped.append({"patient_id": pid, "reason": "Patient not found"})
            continue
        existing = _open_request(db, hospital_id, pid, tpl["id"])
        if existing:
            skipped.append({"patient_id": pid, "reason": "Survey already queued or awaiting response", "request_id": existing["id"]})
            continue
        new_id = db.execute(text("""
            INSERT INTO reach_survey_requests (hospital_id, template_id, patient_id, encounter_type, encounter_id, encounter_label,
                                               doctor_name, department, phone, whatsapp_template_id, message, created_by)
            VALUES (:hid, :tid, :pid, :etype, :eid, :elabel, :doctor, :dept, :phone, :wa, :msg, :user) RETURNING id
        """), {
            "hid": hospital_id, "tid": tpl["id"], "pid": pid,
            "etype": (_clean(payload.get("encounter_type"), 20) or None) if single else None,
            "eid": _parse_int(payload.get("encounter_id"), "Encounter") if single else None,
            "elabel": (_clean(payload.get("encounter_label"), 200) or None) if single else None,
            "doctor": (_clean(payload.get("doctor_name"), 200) if single else "") or patient["latest_doctor_name"],
            "dept": (_clean(payload.get("department"), 200) if single else "") or patient["latest_department"],
            "phone": (_clean(payload.get("phone"), 30) if single else "") or patient["phone"],
            "wa": wa_id, "msg": (str(payload.get("message") or "").strip() or None) if single else None, "user": username,
        }).scalar_one()
        created.append(new_id)
    db.commit()
    return {"created": created, "skipped": skipped}


def mark_request_sent(db: Session, hospital_id: int, request_id: int, payload: dict, username: str | None):
    req = _row(db, """
        SELECT r.id, r.status, r.patient_id, COALESCE(NULLIF(r.phone, ''), p.phone) AS phone,
               CONCAT_WS(' ', p.name, p.last_name) AS patient_name
        FROM reach_survey_requests r
        LEFT JOIN patients p ON p.patient_id = r.patient_id AND p.hospital_id = r.hospital_id
        WHERE r.id = :rid AND r.hospital_id = :hid FOR UPDATE OF r
    """, {"rid": request_id, "hid": hospital_id})
    if not req:
        return None
    if req["status"] not in OPEN_STATUSES:
        raise ValueError(f"This survey is already {req['status'].lower().replace('_', ' ')}.")
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("Message text is required.")
    phone = _clean(payload.get("phone"), 30) or req["phone"]
    wa_id = _parse_int(payload.get("whatsapp_template_id"), "WhatsApp template")
    db.execute(text("""
        UPDATE reach_survey_requests
        SET status = 'PENDING', send_count = send_count + 1, sent_at = CURRENT_TIMESTAMP, sent_by = :user,
            message = :msg, phone = :phone, whatsapp_template_id = COALESCE(:wa, whatsapp_template_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = :rid
    """), {"user": username, "msg": message, "phone": phone, "wa": wa_id, "rid": request_id})
    db.execute(text("""
        INSERT INTO reach_whatsapp_messages (hospital_id, patient_id, recipient_name, phone, purpose, template_name, request_id, message, sent_by)
        VALUES (:hid, :pid, :name, :phone, 'SURVEY', :tname, :rid, :msg, :user)
    """), {"hid": hospital_id, "pid": req["patient_id"], "name": req["patient_name"], "phone": phone,
           "tname": _clean(payload.get("template_name"), 200) or None, "rid": request_id, "msg": message, "user": username})
    db.commit()
    return get_survey_request(db, hospital_id, request_id)


def cancel_survey_request(db: Session, hospital_id: int, request_id: int) -> bool:
    req = _row(db, "SELECT status FROM reach_survey_requests WHERE id = :rid AND hospital_id = :hid", {"rid": request_id, "hid": hospital_id})
    if not req:
        return False
    if req["status"] not in OPEN_STATUSES:
        raise ValueError("Only surveys that are not sent or awaiting a response can be cancelled.")
    db.execute(text("""
        UPDATE reach_survey_requests SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = :rid
    """), {"rid": request_id})
    db.commit()
    return True


# --------------------------------------------------------- survey responses --

def _response_answers(db: Session, response_id: int):
    rows = _rows(db, """
        SELECT id, question_id, position, question_text, question_type, category, rating_value::float AS rating_value,
               answer_text, answer_options
        FROM reach_survey_answers WHERE response_id = :rid ORDER BY position, id
    """, {"rid": response_id})
    for r in rows:
        r["answer_options"] = _options_list(r["answer_options"])
    return rows


def _validate_answers(questions: list, raw_answers) -> list:
    by_question = {}
    for a in raw_answers or []:
        qid = _parse_int((a or {}).get("question_id"), "Question")
        if qid:
            by_question[qid] = a
    answers, missing = [], []
    for idx, q in enumerate(questions, start=1):
        a = by_question.get(q["id"]) or {}
        rating, answer_text, picked = None, None, []
        qtype = q["question_type"]
        if qtype == "RATING":
            if a.get("rating_value") not in (None, ""):
                try:
                    rating = float(a["rating_value"])
                except (TypeError, ValueError):
                    raise ValueError(f"Question {idx}: rating must be a number.")
                if rating < 1 or rating > 5 or rating != int(rating):
                    raise ValueError(f"Question {idx}: rating must be a whole number from 1 to 5.")
        elif qtype in ("SINGLE_CHOICE", "YES_NO"):
            answer_text = _clean(a.get("answer_text"), 200) or None
            if answer_text and answer_text not in q["options"]:
                raise ValueError(f"Question {idx}: '{answer_text}' is not one of the answer options.")
        elif qtype == "MULTI_CHOICE":
            picked = [_clean(o, 200) for o in _options_list(a.get("answer_options")) if _clean(o)]
            invalid = [o for o in picked if o not in q["options"]]
            if invalid:
                raise ValueError(f"Question {idx}: '{invalid[0]}' is not one of the answer options.")
            picked = [o for o in q["options"] if o in picked]
            answer_text = ", ".join(picked) or None
        else:
            answer_text = str(a.get("answer_text") or "").strip()[:2000] or None
        has_answer = rating is not None or bool(answer_text) or bool(picked)
        if not has_answer:
            if q["is_required"]:
                missing.append(str(idx))
            continue
        answers.append({
            "question_id": q["id"], "position": q["position"], "question_text": q["question_text"], "question_type": qtype,
            "category": q["category"], "rating_value": rating, "answer_text": answer_text, "answer_options": picked,
        })
    if missing:
        raise ValueError(f"Please answer the required question(s): {', '.join(missing)}.")
    return answers


def _parse_submitted_at(value):
    if value in (None, ""):
        return _now()
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Response date/time is invalid.")
    if parsed.tzinfo:
        parsed = parsed.astimezone(IST_TIMEZONE).replace(tzinfo=None)
    if parsed > _now() + timedelta(minutes=5):
        raise ValueError("Response date/time cannot be in the future.")
    return parsed


def create_survey_response(db: Session, hospital_id: int, payload: dict, username: str | None):
    request_id = _parse_int(payload.get("request_id"), "Survey request")
    if request_id:
        req = _row(db, """
            SELECT id, template_id, patient_id, status FROM reach_survey_requests
            WHERE id = :rid AND hospital_id = :hid FOR UPDATE
        """, {"rid": request_id, "hid": hospital_id})
        if not req:
            raise ValueError("Survey request not found.")
        if req["status"] == "COMPLETED":
            raise ValueError("A response has already been recorded for this survey.")
        if req["status"] == "CANCELLED":
            raise ValueError("This survey was cancelled.")
        template_id, patient_id = req["template_id"], req["patient_id"]
    else:
        tpl = _active_template(db, hospital_id, payload.get("template_id"))
        template_id = tpl["id"]
        patient_id = _clean(payload.get("patient_id"))
        if not patient_id:
            raise ValueError("Select a patient.")
        patient = _patient(db, hospital_id, patient_id)
        if not patient:
            raise ValueError("Patient not found.")
        open_req = _open_request(db, hospital_id, patient_id, template_id)
        if open_req:
            request_id = open_req["id"]
        else:
            # Feedback taken without a prior WhatsApp request (e.g. a phone call).
            request_id = db.execute(text("""
                INSERT INTO reach_survey_requests (hospital_id, template_id, patient_id, encounter_type, encounter_id, encounter_label,
                                                   doctor_name, department, phone, created_by)
                VALUES (:hid, :tid, :pid, :etype, :eid, :elabel, :doctor, :dept, :phone, :user) RETURNING id
            """), {
                "hid": hospital_id, "tid": template_id, "pid": patient_id,
                "etype": _clean(payload.get("encounter_type"), 20) or None,
                "eid": _parse_int(payload.get("encounter_id"), "Encounter"),
                "elabel": _clean(payload.get("encounter_label"), 200) or None,
                "doctor": _clean(payload.get("doctor_name"), 200) or patient["latest_doctor_name"],
                "dept": _clean(payload.get("department"), 200) or patient["latest_department"],
                "phone": patient["phone"], "user": username,
            }).scalar_one()

    try:
        overall = float(payload.get("overall_rating"))
    except (TypeError, ValueError):
        raise ValueError("Overall rating is required.")
    if overall < 1 or overall > 5 or overall != int(overall):
        raise ValueError("Overall rating must be a whole number from 1 to 5.")
    channel = _clean(payload.get("channel") or "WHATSAPP").upper()
    if channel not in CHANNELS:
        raise ValueError(f"Channel must be one of {', '.join(CHANNELS)}.")
    answers = _validate_answers(template_questions(db, template_id), payload.get("answers"))
    submitted_at = _parse_submitted_at(payload.get("submitted_at"))

    response_id = db.execute(text("""
        INSERT INTO reach_survey_responses (hospital_id, request_id, template_id, patient_id, overall_rating, comments, channel, submitted_at, recorded_by)
        VALUES (:hid, :rid, :tid, :pid, :overall, :comments, :channel, :submitted, :user) RETURNING id
    """), {"hid": hospital_id, "rid": request_id, "tid": template_id, "pid": patient_id, "overall": overall,
           "comments": str(payload.get("comments") or "").strip()[:2000] or None, "channel": channel,
           "submitted": submitted_at, "user": username}).scalar_one()
    for a in answers:
        db.execute(text("""
            INSERT INTO reach_survey_answers (response_id, question_id, position, question_text, question_type, category,
                                              rating_value, answer_text, answer_options)
            VALUES (:resp, :qid, :pos, :qt, :qtype, :cat, :rating, :atext, CAST(:aopts AS JSONB))
        """), {"resp": response_id, "qid": a["question_id"], "pos": a["position"], "qt": a["question_text"],
               "qtype": a["question_type"], "cat": a["category"], "rating": a["rating_value"],
               "atext": a["answer_text"], "aopts": json.dumps(a["answer_options"])})
    db.execute(text("""
        UPDATE reach_survey_requests SET status = 'COMPLETED', completed_at = :submitted, updated_at = CURRENT_TIMESTAMP
        WHERE id = :rid
    """), {"submitted": submitted_at, "rid": request_id})
    db.commit()
    return {"response_id": response_id, "request_id": request_id}


def delete_survey_response(db: Session, hospital_id: int, response_id: int) -> bool:
    resp = _row(db, """
        SELECT s.id, s.request_id, r.send_count FROM reach_survey_responses s
        LEFT JOIN reach_survey_requests r ON r.id = s.request_id
        WHERE s.id = :sid AND s.hospital_id = :hid
    """, {"sid": response_id, "hid": hospital_id})
    if not resp:
        return False
    db.execute(text("DELETE FROM reach_survey_responses WHERE id = :sid"), {"sid": response_id})
    if resp["request_id"]:
        if resp["send_count"]:
            db.execute(text("""
                UPDATE reach_survey_requests SET status = 'PENDING', completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = :rid
            """), {"rid": resp["request_id"]})
        else:
            # The request only existed to hold this directly-recorded response.
            db.execute(text("DELETE FROM reach_survey_requests WHERE id = :rid"), {"rid": resp["request_id"]})
    db.commit()
    return True


# ------------------------------------------------------------ summary / KPIs --

def _status_counts(db: Session, hospital_id: int, extra: str = "", params: dict | None = None):
    rows = _rows(db, f"""
        SELECT r.status, COUNT(*) AS n FROM reach_survey_requests r
        WHERE r.hospital_id = :hid {extra} GROUP BY r.status
    """, {"hid": hospital_id, **(params or {})})
    counts = {s: 0 for s in REQUEST_STATUSES}
    for r in rows:
        counts[r["status"]] = r["n"]
    return counts


def _pct_change(current, previous):
    if not previous:
        return None
    return round((current - previous) * 100.0 / previous, 1)


def survey_summary(db: Session, hospital_id: int, patient_id=None, template_id=None):
    extra, params = "", {}
    if patient_id:
        extra += " AND r.patient_id = :pid"
        params["pid"] = _clean(patient_id)
    template_id = _parse_int(template_id, "Survey")
    if template_id:
        extra += " AND r.template_id = :tid"
        params["tid"] = template_id
    counts = _status_counts(db, hospital_id, extra, params)
    resp_extra = extra.replace("r.patient_id", "s.patient_id").replace("r.template_id", "s.template_id")
    avg_row = _row(db, f"""
        SELECT ROUND(AVG(s.overall_rating), 2)::float AS avg_rating, COUNT(*) AS responses
        FROM reach_survey_responses s WHERE s.hospital_id = :hid {resp_extra}
    """, {"hid": hospital_id, **params})
    categories = _rows(db, f"""
        SELECT a.category, ROUND(AVG(a.rating_value), 2)::float AS avg_rating, COUNT(*) AS answers
        FROM reach_survey_answers a JOIN reach_survey_responses s ON s.id = a.response_id
        WHERE s.hospital_id = :hid AND a.rating_value IS NOT NULL AND COALESCE(a.category, '') <> '' {resp_extra}
        GROUP BY a.category ORDER BY COUNT(*) DESC, a.category
    """, {"hid": hospital_id, **params})

    # Month-over-month trend for the KPI cards.
    today = _now().date()
    this_month = today.replace(day=1)
    last_month = (this_month - timedelta(days=1)).replace(day=1)
    month_params = {"m0": datetime.combine(last_month, datetime.min.time()), "m1": datetime.combine(this_month, datetime.min.time())}

    def month_stats(start_key, end_key):
        rng = f" AND r.created_at >= :{start_key}" + (f" AND r.created_at < :{end_key}" if end_key else "")
        c = _status_counts(db, hospital_id, extra + rng, {**params, **month_params})
        s_rng = f" AND s.submitted_at >= :{start_key}" + (f" AND s.submitted_at < :{end_key}" if end_key else "")
        a = _row(db, f"""
            SELECT ROUND(AVG(s.overall_rating), 2)::float AS avg_rating, COUNT(*) AS n
            FROM reach_survey_responses s WHERE s.hospital_id = :hid {resp_extra}{s_rng}
        """, {"hid": hospital_id, **params, **month_params})
        return {"total": c["PENDING"] + c["COMPLETED"], "pending": c["PENDING"], "completed": a["n"], "avg_rating": a["avg_rating"]}

    cur, prev = month_stats("m1", None), month_stats("m0", "m1")
    sent_total = counts["PENDING"] + counts["COMPLETED"]
    return {
        "total": sent_total,
        "pending": counts["PENDING"],
        "completed": counts["COMPLETED"],
        "not_sent": counts["NOT_SENT"],
        "cancelled": counts["CANCELLED"],
        "responses": avg_row["responses"],
        "avg_rating": avg_row["avg_rating"],
        "response_rate": round(counts["COMPLETED"] * 100.0 / sent_total, 1) if sent_total else 0,
        "categories": categories,
        "trend": {
            "total_pct": _pct_change(cur["total"], prev["total"]),
            "pending_pct": _pct_change(cur["pending"], prev["pending"]),
            "completed_pct": _pct_change(cur["completed"], prev["completed"]),
            "avg_rating_delta": round(cur["avg_rating"] - prev["avg_rating"], 1)
            if cur["avg_rating"] is not None and prev["avg_rating"] is not None else None,
        },
    }


# ------------------------------------------------------------------ reports --

def survey_report(db: Session, hospital_id: int, filters: dict):
    clauses = ["s.hospital_id = :hid"]
    params: dict = {"hid": hospital_id}
    template_id = _parse_int(filters.get("template_id"), "Survey")
    if template_id:
        clauses.append("s.template_id = :tid")
        params["tid"] = template_id
    if filters.get("survey_type"):
        clauses.append("t.survey_type = :stype")
        params["stype"] = _clean(filters["survey_type"]).upper()
    if filters.get("doctor"):
        clauses.append("LOWER(TRIM(COALESCE(r.doctor_name, ''))) = LOWER(TRIM(:doctor))")
        params["doctor"] = _clean(filters["doctor"])
    if filters.get("department"):
        clauses.append("LOWER(TRIM(COALESCE(r.department, ''))) = LOWER(TRIM(:dept))")
        params["dept"] = _clean(filters["department"])
    _date_range_clause("s.submitted_at", filters.get("date_from"), filters.get("date_to"), params, clauses)
    base = f"""
        FROM reach_survey_responses s
        JOIN reach_survey_templates t ON t.id = s.template_id
        LEFT JOIN reach_survey_requests r ON r.id = s.request_id
        LEFT JOIN patients p ON p.patient_id = s.patient_id AND p.hospital_id = s.hospital_id
        WHERE {' AND '.join(clauses)}
    """

    summary = _row(db, f"""
        SELECT COUNT(*) AS responses, ROUND(AVG(s.overall_rating), 2)::float AS avg_rating,
               COUNT(*) FILTER (WHERE s.overall_rating >= 4) AS promoters,
               COUNT(*) FILTER (WHERE s.overall_rating = 3) AS passives,
               COUNT(*) FILTER (WHERE s.overall_rating <= 2) AS detractors,
               COUNT(*) FILTER (WHERE COALESCE(s.comments, '') <> '') AS with_comments
        {base}
    """, params)
    responses = summary["responses"] or 0
    summary["satisfaction_pct"] = round(summary["promoters"] * 100.0 / responses, 1) if responses else 0
    summary["nps"] = round((summary["promoters"] - summary["detractors"]) * 100.0 / responses, 1) if responses else None

    # Request status counts over the same window (requests created in range).
    r_clauses = ["r.hospital_id = :hid"]
    r_params: dict = {"hid": hospital_id}
    if template_id:
        r_clauses.append("r.template_id = :tid")
        r_params["tid"] = template_id
    if filters.get("survey_type"):
        r_clauses.append("t.survey_type = :stype")
        r_params["stype"] = params["stype"]
    if filters.get("doctor"):
        r_clauses.append("LOWER(TRIM(COALESCE(r.doctor_name, ''))) = LOWER(TRIM(:doctor))")
        r_params["doctor"] = params["doctor"]
    if filters.get("department"):
        r_clauses.append("LOWER(TRIM(COALESCE(r.department, ''))) = LOWER(TRIM(:dept))")
        r_params["dept"] = params["dept"]
    _date_range_clause("r.created_at", filters.get("date_from"), filters.get("date_to"), r_params, r_clauses)
    status_rows = _rows(db, f"""
        SELECT r.status, COUNT(*) AS n FROM reach_survey_requests r JOIN reach_survey_templates t ON t.id = r.template_id
        WHERE {' AND '.join(r_clauses)} GROUP BY r.status
    """, r_params)
    status_counts = {s: 0 for s in REQUEST_STATUSES}
    for row in status_rows:
        status_counts[row["status"]] = row["n"]
    sent = status_counts["PENDING"] + status_counts["COMPLETED"]
    summary["status_counts"] = status_counts
    summary["response_rate"] = round(status_counts["COMPLETED"] * 100.0 / sent, 1) if sent else 0

    distribution = {int(r["rating"]): r["n"] for r in _rows(db, f"SELECT ROUND(s.overall_rating)::int AS rating, COUNT(*) AS n {base} GROUP BY 1", params)}
    rating_distribution = [{"rating": n, "count": distribution.get(n, 0)} for n in (5, 4, 3, 2, 1)]

    categories = _rows(db, f"""
        SELECT a.category, ROUND(AVG(a.rating_value), 2)::float AS avg_rating, COUNT(*) AS answers,
               COUNT(*) FILTER (WHERE a.rating_value <= 2) AS low_count
        FROM reach_survey_answers a JOIN ({'SELECT s.id ' + base}) f ON f.id = a.response_id
        WHERE a.rating_value IS NOT NULL AND COALESCE(a.category, '') <> ''
        GROUP BY a.category ORDER BY AVG(a.rating_value) DESC
    """, params)

    daily = _rows(db, f"""
        SELECT s.submitted_at::date AS day, COUNT(*) AS responses, ROUND(AVG(s.overall_rating), 2)::float AS avg_rating
        {base} GROUP BY 1 ORDER BY 1
    """, params)

    def grouped(expr: str):
        return _rows(db, f"""
            SELECT COALESCE(NULLIF({expr}, ''), 'Not recorded') AS label, COUNT(*) AS responses,
                   ROUND(AVG(s.overall_rating), 2)::float AS avg_rating,
                   COUNT(*) FILTER (WHERE s.overall_rating <= 2) AS low_count
            {base} GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 50
        """, params)

    questions = _rows(db, f"""
        SELECT COALESCE(a.question_id::text, a.question_text) AS qkey, MIN(a.question_id) AS question_id,
               MIN(t2.name) AS template_name, MIN(a.position) AS position,
               MAX(a.question_text) AS question_text, MAX(a.question_type) AS question_type,
               MAX(a.category) AS category, COUNT(*) AS answers,
               ROUND(AVG(a.rating_value), 2)::float AS avg_rating
        FROM reach_survey_answers a
        JOIN ({'SELECT s.id, s.template_id ' + base}) f ON f.id = a.response_id
        JOIN reach_survey_templates t2 ON t2.id = f.template_id
        GROUP BY 1
        ORDER BY MIN(t2.name), MIN(a.position)
    """, params)
    option_rows = _rows(db, f"""
        SELECT COALESCE(a.question_id::text, a.question_text) AS qkey, opt AS option_label, COUNT(*) AS n
        FROM reach_survey_answers a
        JOIN ({'SELECT s.id ' + base}) f ON f.id = a.response_id
        CROSS JOIN LATERAL (
            SELECT jsonb_array_elements_text(a.answer_options) AS opt WHERE a.question_type = 'MULTI_CHOICE'
            UNION ALL SELECT a.answer_text WHERE a.question_type IN ('SINGLE_CHOICE', 'YES_NO')
        ) o
        WHERE opt IS NOT NULL
        GROUP BY 1, 2
    """, params)
    text_source = "SELECT s.id, s.submitted_at, CONCAT_WS(' ', p.name, p.last_name) AS patient_name " + base
    text_rows = _rows(db, f"""
        SELECT COALESCE(a.question_id::text, a.question_text) AS qkey, a.answer_text, f.submitted_at, f.patient_name
        FROM reach_survey_answers a
        JOIN ({text_source}) f ON f.id = a.response_id
        WHERE a.question_type = 'TEXT' AND COALESCE(a.answer_text, '') <> ''
        ORDER BY f.submitted_at DESC
    """, params)
    rating_rows = _rows(db, f"""
        SELECT COALESCE(a.question_id::text, a.question_text) AS qkey, a.rating_value::int AS rating, COUNT(*) AS n
        FROM reach_survey_answers a JOIN ({'SELECT s.id ' + base}) f ON f.id = a.response_id
        WHERE a.question_type = 'RATING' AND a.rating_value IS NOT NULL GROUP BY 1, 2
    """, params)
    for q in questions:
        key = q.pop("qkey")
        q["options"] = sorted(({"option": r["option_label"], "count": r["n"]} for r in option_rows if r["qkey"] == key),
                              key=lambda o: -o["count"])
        dist = {r["rating"]: r["n"] for r in rating_rows if r["qkey"] == key}
        q["rating_distribution"] = [{"rating": n, "count": dist.get(n, 0)} for n in (5, 4, 3, 2, 1)] if q["question_type"] == "RATING" else []
        q["text_answers"] = [{"answer": r["answer_text"], "submitted_at": r["submitted_at"], "patient_name": r["patient_name"]}
                             for r in text_rows if r["qkey"] == key][:20]

    detail_select = f"""
        SELECT s.id AS response_id, s.request_id, s.patient_id, CONCAT_WS(' ', p.name, p.middle_name, p.last_name) AS patient_name,
               COALESCE(NULLIF(r.phone, ''), p.phone) AS phone, t.name AS template_name, r.doctor_name, r.department,
               s.overall_rating::float AS overall_rating, s.comments, s.channel, s.submitted_at
        {base}
    """
    low_ratings = _rows(db, f"{detail_select} AND s.overall_rating <= 2 ORDER BY s.submitted_at DESC LIMIT 50", params)
    comments = _rows(db, f"{detail_select} AND COALESCE(s.comments, '') <> '' ORDER BY s.submitted_at DESC LIMIT 50", params)

    return {
        "summary": summary,
        "rating_distribution": rating_distribution,
        "categories": categories,
        "daily": daily,
        "by_doctor": grouped("r.doctor_name"),
        "by_department": grouped("r.department"),
        "by_template": grouped("t.name"),
        "questions": questions,
        "low_ratings": low_ratings,
        "comments": comments,
        "filter_options": {
            "doctors": [r["v"] for r in _rows(db, """
                SELECT DISTINCT v FROM (
                    SELECT doctor_name AS v FROM doctor_schedules WHERE COALESCE(doctor_name, '') <> ''
                    UNION
                    SELECT doctor_name AS v FROM users WHERE (job_role = 'Doctor' OR doctor_name IS NOT NULL) AND COALESCE(doctor_name, '') <> ''
                    UNION
                    SELECT doctor_name AS v FROM reach_survey_requests WHERE hospital_id = :hid AND COALESCE(doctor_name, '') <> ''
                    UNION
                    SELECT doctor_name AS v FROM appointments WHERE COALESCE(doctor_name, '') <> ''
                ) sub
                ORDER BY 1
            """, {"hid": hospital_id})],
            "departments": [r["v"] for r in _rows(db, """
                SELECT DISTINCT v FROM (
                    SELECT department_name AS v FROM department_master WHERE (hospital_id = :hid OR hospital_id IS NULL) AND COALESCE(department_name, '') <> ''
                    UNION
                    SELECT department AS v FROM doctor_schedules WHERE COALESCE(department, '') <> ''
                    UNION
                    SELECT department AS v FROM reach_survey_requests WHERE hospital_id = :hid AND COALESCE(department, '') <> ''
                    UNION
                    SELECT department AS v FROM appointments WHERE COALESCE(department, '') <> ''
                ) sub
                ORDER BY 1
            """, {"hid": hospital_id})],
        },
    }


# --------------------------------------------------------- whatsapp messages --

def list_whatsapp_messages(db: Session, hospital_id: int, patient_id=None, purpose=None, limit=100):
    clauses = ["m.hospital_id = :hid"]
    params: dict = {"hid": hospital_id, "limit": min(max(_parse_int(limit, "Limit") or 100, 1), 1000)}
    if patient_id:
        clauses.append("m.patient_id = :pid")
        params["pid"] = _clean(patient_id)
    if purpose:
        clauses.append("m.purpose = :purpose")
        params["purpose"] = _clean(purpose).upper()
    return _rows(db, f"""
        SELECT m.id, m.patient_id, m.recipient_name, m.phone, m.purpose, m.template_name, m.request_id,
               m.message, m.sent_by, m.sent_at
        FROM reach_whatsapp_messages m WHERE {' AND '.join(clauses)}
        ORDER BY m.sent_at DESC, m.id DESC LIMIT :limit
    """, params)


def log_whatsapp_message(db: Session, hospital_id: int, payload: dict, username: str | None) -> int:
    patient_id = _clean(payload.get("patient_id"))
    if not patient_id:
        raise ValueError("Patient is required.")
    if not _patient(db, hospital_id, patient_id):
        raise ValueError("Patient not found.")
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("Message text is required.")
    purpose = _clean(payload.get("purpose") or "GENERAL").upper()
    if purpose not in WHATSAPP_CATEGORIES:
        purpose = "GENERAL"
    new_id = db.execute(text("""
        INSERT INTO reach_whatsapp_messages (hospital_id, patient_id, recipient_name, phone, purpose, template_name, message, sent_by)
        VALUES (:hid, :pid, :name, :phone, :purpose, :tname, :msg, :user) RETURNING id
    """), {"hid": hospital_id, "pid": patient_id, "name": _clean(payload.get("recipient_name"), 200) or None,
           "phone": _clean(payload.get("phone"), 30) or None, "purpose": purpose,
           "tname": _clean(payload.get("template_name"), 200) or None, "msg": message[:8000], "user": username}).scalar_one()
    db.commit()
    return new_id
