// Mobile number with its country code. The number field only accepts digits, and no more
// than the selected country allows (India 10, UAE 9, Singapore 8 ...; rules in lib/phone.ts).
import { Input, Select } from "./ui";
import { COUNTRY_CODES, COUNTRY_CODE_RULES, parsePhoneInput, validateMobileByCountry } from "../lib/phone";

type Props = {
  countryCode: string;
  value: string;
  onChange: (next: { countryCode: string; value: string }) => void;
  required?: boolean;
  /** Show the length message while typing (otherwise only the digit cap applies). */
  showError?: boolean;
  id?: string;
  /** For uncontrolled forms: the number input gets this name and a hidden `${name}_country_code` carries the code. */
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Helplines / landlines (e.g. 1800 toll-free): any 6-15 digits instead of the mobile length. */
  landline?: boolean;
};

export default function PhoneInput({ countryCode, value, onChange, required = false, showError = true, id, name, placeholder, disabled, landline = false }: Props) {
  const code = COUNTRY_CODE_RULES[countryCode] ? countryCode : "+91";
  const rule = landline ? { ...COUNTRY_CODE_RULES[code], min: 6, max: 15 } : COUNTRY_CODE_RULES[code];
  const error = showError && value
    ? (landline ? (value.length < 6 ? "Enter at least 6 digits." : null) : validateMobileByCountry(value, code, required))
    : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <Select
          aria-label="Country code"
          value={code}
          disabled={disabled}
          style={{ width: "min(170px, 52%)", flex: "none" }}
          onChange={(e) => {
            const next = e.target.value;
            // Changing country trims a number that is now too long for it.
            onChange({ countryCode: next, value: landline ? value : value.slice(0, COUNTRY_CODE_RULES[next].max) });
          }}
        >
          {COUNTRY_CODES.map((c) => <option key={c} value={c}>{COUNTRY_CODE_RULES[c].label}</option>)}
        </Select>
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="tel-national"
          // No maxLength: it would cut a pasted "+91 98765 43210" before the code can be removed.
          placeholder={placeholder || (landline ? "Phone number" : `${rule.max}-digit mobile`)}
          value={value}
          name={name}
          disabled={disabled}
          required={required}
          aria-invalid={!!error}
          onChange={(e) => {
            const parsed = parsePhoneInput(e.target.value, code);
            const max = landline ? 15 : COUNTRY_CODE_RULES[parsed.countryCode].max;
            onChange({ countryCode: parsed.countryCode, value: parsed.value.slice(0, max) });
          }}
        />
      </div>
      {name && <input type="hidden" name={`${name}_country_code`} value={code} />}
      {error && <p style={{ color: "hsl(var(--destructive))", fontSize: 12, margin: "4px 0 0" }}>{error}</p>}
    </div>
  );
}
