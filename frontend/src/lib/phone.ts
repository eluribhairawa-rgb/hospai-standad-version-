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
 * Normalizes a pasted or typed phone number.
 * 
 * - Strips +[countryCode] unconditionally if present.
 * - Strips [countryCode] digits if the remaining string is a valid local number length.
 * - Handles non-matching country codes safely by returning purely digits.
 */
export function normalizePhoneNumber(value: string, selectedCountryCode: string): string {
  if (!value) return "";

  const cleaned = value.trim();
  const hasPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/\D/g, '');

  const ccDigits = selectedCountryCode.replace(/\D/g, '');
  const rule = COUNTRY_CODE_RULES[selectedCountryCode] || COUNTRY_CODE_RULES["+91"];

  if (hasPlus) {
    if (digits.startsWith(ccDigits)) {
      return digits.slice(ccDigits.length).slice(0, 15);
    }
    return digits.slice(0, 15);
  }

  if (digits.startsWith(ccDigits)) {
    const remainder = digits.slice(ccDigits.length);
    if (remainder.length >= rule.min) {
      return remainder.slice(0, 15);
    }
  }

  return digits.slice(0, 15);
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
