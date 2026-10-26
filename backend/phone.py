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
