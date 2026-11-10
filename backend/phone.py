import re

COUNTRY_CODE_RULES = {
    "+91": {"label": "India (+91)", "min": 10, "max": 10},
    "+1": {"label": "USA/Canada (+1)", "min": 10, "max": 10},
    "+44": {"label": "United Kingdom (+44)", "min": 10, "max": 10},
    "+971": {"label": "UAE (+971)", "min": 9, "max": 9},
    "+61": {"label": "Australia (+61)", "min": 9, "max": 9},
    "+65": {"label": "Singapore (+65)", "min": 8, "max": 8},
    "+974": {"label": "Qatar (+974)", "min": 8, "max": 8},
    "+966": {"label": "Saudi Arabia (+966)", "min": 9, "max": 9},
    "+968": {"label": "Oman (+968)", "min": 8, "max": 8},
    "+965": {"label": "Kuwait (+965)", "min": 8, "max": 8},
    "+880": {"label": "Bangladesh (+880)", "min": 10, "max": 10},
    "+94": {"label": "Sri Lanka (+94)", "min": 9, "max": 9},
    "+977": {"label": "Nepal (+977)", "min": 10, "max": 10},
}

def normalize_phone_number(value: str, selected_country_code: str = "+91") -> str:
    if not value:
        return ""

    cleaned = value.strip()
    has_plus = cleaned.startswith('+')
    digits = re.sub(r'\D', '', cleaned)
    
    cc_digits = re.sub(r'\D', '', selected_country_code)
    rule = COUNTRY_CODE_RULES.get(selected_country_code, COUNTRY_CODE_RULES["+91"])
    
    if has_plus:
        if digits.startswith(cc_digits):
            return digits[len(cc_digits):][:15]
        return digits[:15]
    
    if digits.startswith(cc_digits):
        remainder = digits[len(cc_digits):]
        if len(remainder) >= rule["min"]:
            return remainder[:15]
            
    return digits[:15]


def normalize_search_query(value: str, selected_country_code: str = "+91") -> str:
    """Search-safe normalization: only strips country code when input looks like a phone number."""
    if not value:
        return ""
    trimmed = value.strip()

    # If starts with '+', likely a phone number — normalize
    if trimmed.startswith("+"):
        return normalize_phone_number(trimmed, selected_country_code)

    # If purely digits (with optional spaces/dashes), normalize
    stripped = re.sub(r'[\s\-]', '', trimmed)
    if stripped.isdigit():
        return normalize_phone_number(trimmed, selected_country_code)

    # Otherwise it's a name or ID — pass through unchanged
    return value


def clean_country_code(code: str | None) -> str:
    """A supported dialling code ('+971'), or '+91' for anything unknown or blank."""
    value = str(code or "").strip()
    if value and not value.startswith("+"):
        value = "+" + re.sub(r"\D", "", value)
    return value if value in COUNTRY_CODE_RULES else "+91"


def validate_phone(value, country_code: str | None = "+91", required: bool = False, label: str = "Mobile number",
                   landline: bool = False):
    """Normalise a phone number for its country and check its length.

    Returns (digits, country_code, error): digits is the local number without the
    country code ("" when blank); error is None when the number is valid (or blank
    and not required). Used by every endpoint that saves a phone number.
    """
    code = clean_country_code(country_code)
    raw = "" if value is None else str(value)
    digits = normalize_phone_number(raw, code)
    if not digits:
        return "", code, (f"{label} is required." if required else None)
    if code == "+91" and len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]  # trunk prefix: 09876543210
    # Helplines and landlines (1800 toll-free, city numbers) vary in length: 6-15 digits.
    rule = {**COUNTRY_CODE_RULES[code], "min": 6, "max": 15} if landline else COUNTRY_CODE_RULES[code]
    if not rule["min"] <= len(digits) <= rule["max"]:
        size = rule["min"] if rule["min"] == rule["max"] else f"{rule['min']}-{rule['max']}"
        return digits, code, f"{label} for {rule['label']} must be {size} digits."
    return digits, code, None


def to_international(digits: str, country_code: str | None) -> str:
    """'501234567', '+971' -> '971501234567' (the form wa.me and SMS gateways expect)."""
    local = re.sub(r"\D", "", digits or "")
    return (re.sub(r"\D", "", clean_country_code(country_code)) + local) if local else ""
