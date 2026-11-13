export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 15);
}

export const COUNTRY_CODE_RULES: Record<string, { label: string; min: number; max: number }> = {
  "+91": { label: "India (+91)", min: 10, max: 10 },
  "+1": { label: "USA/Canada (+1)", min: 10, max: 10 },
  "+44": { label: "United Kingdom (+44)", min: 10, max: 10 },
  "+971": { label: "UAE (+971)", min: 9, max: 9 },
  "+61": { label: "Australia (+61)", min: 9, max: 9 },
  "+65": { label: "Singapore (+65)", min: 8, max: 8 },
  "+974": { label: "Qatar (+974)", min: 8, max: 8 },
  "+966": { label: "Saudi Arabia (+966)", min: 9, max: 9 },
  "+968": { label: "Oman (+968)", min: 8, max: 8 },
  "+965": { label: "Kuwait (+965)", min: 8, max: 8 },
  "+880": { label: "Bangladesh (+880)", min: 10, max: 10 },
  "+94": { label: "Sri Lanka (+94)", min: 9, max: 9 },
  "+977": { label: "Nepal (+977)", min: 10, max: 10 },
};
export const COUNTRY_CODES = Object.keys(COUNTRY_CODE_RULES);

export function validateMobileByCountry(value: string, countryCode: string, required: boolean): string | null {
  const digits = onlyDigits(value);
  if (!digits) return required ? "Mobile number is required." : null;
  const rule = COUNTRY_CODE_RULES[countryCode] || COUNTRY_CODE_RULES["+91"];
  if (digits.length < rule.min || digits.length > rule.max) {
    return `${rule.label} mobile must be ${rule.min === rule.max ? rule.min : `${rule.min}-${rule.max}`} digits.`;
  }
  return null;
}

export function withCountryCode(_countryCode: string, value: string): string {
  // Store the local subscriber number in the existing phone columns.
  // The backend also accepts older +countrycode-prefixed payloads, but keeping
  // the stored value local avoids +91 becoming 12 digits and failing validation.
  return onlyDigits(value);
}

/**
 * Splits a pasted or typed phone number into its country code and local digits, so a
 * country code that came along with the paste is never counted as part of the number.
 *
 * - "+<code>..." (or "00<code>...") with a supported code: that code is used and removed,
 *   even when it differs from the selected one (the country switches).
 * - Digits starting with the selected code, longer than the country's length allows
 *   (e.g. 919876543210 for India): the code is removed.
 * - Anything else is kept as typed, so a valid local number that happens to begin with
 *   the code's digits (9112345678) is never cut.
 */
export function parsePhoneInput(value: string, selectedCountryCode: string): { countryCode: string; value: string } {
  const selected = cleanCountryCode(selectedCountryCode);
  const cleaned = (value || "").trim();
  const digits = cleaned.replace(/\D/g, "");
  if (!digits) return { countryCode: selected, value: "" };

  const international = cleaned.startsWith("+") || (cleaned.startsWith("00") && digits.length > 2);
  if (international) {
    const intl = cleaned.startsWith("+") ? digits : digits.slice(2);
    const match = COUNTRY_CODES.slice().sort((a, b) => b.length - a.length).find((c) => intl.startsWith(c.slice(1)));
    if (match) return { countryCode: match, value: intl.slice(match.length - 1).slice(0, 15) };
    return { countryCode: selected, value: intl.slice(0, 15) };
  }

  const cc = selected.slice(1);
  const rule = COUNTRY_CODE_RULES[selected];
  if (digits.startsWith(cc) && digits.length > rule.max && digits.length - cc.length >= rule.min) {
    return { countryCode: selected, value: digits.slice(cc.length).slice(0, 15) };
  }
  return { countryCode: selected, value: digits.slice(0, 15) };
}

/** Local digits only (country code removed) for the selected country. */
export function normalizePhoneNumber(value: string, selectedCountryCode: string): string {
  return parsePhoneInput(value, selectedCountryCode).value;
}

/**
 * Search-safe normalization: only strips the country code when the input
 * looks like a phone number (starts with '+' or is purely digits/separators).
 * For name or ID searches the value passes through unchanged.
 */
export function normalizeSearchQuery(value: string, selectedCountryCode: string = "+91"): string {
  if (!value) return "";
  const trimmed = value.trim();

  // If value starts with '+', it's likely a phone number — normalize it
  if (trimmed.startsWith("+")) {
    return normalizePhoneNumber(trimmed, selectedCountryCode);
  }

  // If value is purely digits (with optional spaces/dashes), normalize it
  const stripped = trimmed.replace(/[\s\-]/g, "");
  if (/^\d+$/.test(stripped)) {
    return normalizePhoneNumber(trimmed, selectedCountryCode);
  }

  // Otherwise it's a name or ID — pass through unchanged
  return value;
}

/** A supported dialling code, or "+91" when blank or unknown. */
export function cleanCountryCode(code?: string | null): string {
  const value = String(code || "").trim();
  const withPlus = value && !value.startsWith("+") ? `+${value.replace(/\D/g, "")}` : value;
  return COUNTRY_CODE_RULES[withPlus] ? withPlus : "+91";
}

/**
 * A stored phone plus its stored country code -> what PhoneInput edits. Older records may
 * hold "+971 501234567" in the number itself; that prefix wins over the default code.
 */
export function splitStoredPhone(value?: string | null, storedCode?: string | null): { countryCode: string; value: string } {
  const raw = String(value || "").trim();
  if (raw.startsWith("+")) {
    const match = COUNTRY_CODES.slice().sort((a, b) => b.length - a.length).find((c) => raw.replace(/\s/g, "").startsWith(c));
    if (match) return { countryCode: match, value: raw.replace(/\s/g, "").slice(match.length).replace(/\D/g, "") };
  }
  return { countryCode: cleanCountryCode(storedCode), value: raw.replace(/\D/g, "") };
}

/** "+971", "501234567" -> "971501234567": the number wa.me links expect. */
export function toWhatsAppNumber(countryCode: string, digits: string): string {
  const local = (digits || "").replace(/\D/g, "");
  return local ? `${cleanCountryCode(countryCode).replace(/\D/g, "")}${local}` : "";
}

/** "+971", "501234567" -> "+971 501234567" for display and printouts. */
export function formatPhone(countryCode: string | null | undefined, digits: string | null | undefined): string {
  const local = String(digits || "").replace(/\D/g, "");
  return local ? `${cleanCountryCode(countryCode)} ${local}` : "";
}
