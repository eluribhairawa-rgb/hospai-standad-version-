import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { apiFetch } from "../lib/api";
import { Input, Label } from "./ui";

/** Payer of an inpatient admission: self-pay or an insurance policy. */
export type AdmissionPayer = {
  payer_type: "self" | "insurance";
  insurance_provider: string;
  insurance_policy_no: string;
  insurance_preauth_no: string;
};

export const EMPTY_PAYER: AdmissionPayer = {
  payer_type: "self",
  insurance_provider: "",
  insurance_policy_no: "",
  insurance_preauth_no: "",
};

/** Returns an error message, or null when the payer is complete. */
export function payerError(p: AdmissionPayer): string | null {
  if (p.payer_type !== "insurance") return null;
  if (!p.insurance_provider.trim()) return "Please select the insurance provider.";
  if (!p.insurance_policy_no.trim()) return "Please enter the insurance policy number.";
  return null;
}

export function payerLabel(p: Partial<AdmissionPayer> | null | undefined): string {
  if (!p || p.payer_type !== "insurance") return "Self-pay";
  return `Insurance · ${p.insurance_provider || "-"}`;
}

type Props = {
  value: AdmissionPayer;
  onChange: (next: AdmissionPayer) => void;
};

export default function AdmissionPayerFields({ value, onChange }: Props) {
  const [providers, setProviders] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    apiFetch<{ providers?: { id: number; name: string }[] }>("/api/insurance-providers")
      .then((res) => setProviders(res.providers || []))
      .catch(() => setProviders([]));
  }, []);

  const set = (patch: Partial<AdmissionPayer>) => onChange({ ...value, ...patch });
  const isInsurance = value.payer_type === "insurance";
  // Keep a provider stored on the patient selectable even if it was renamed in the master list.
  const providerNames = providers.map((p) => p.name);
  if (value.insurance_provider && !providerNames.includes(value.insurance_provider)) providerNames.unshift(value.insurance_provider);

  const pill = (active: boolean): CSSProperties => ({
    padding: "8px 16px",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 700,
    border: `1.5px solid ${active ? "#00828a" : "#cbd5e1"}`,
    background: active ? "#e6f6f7" : "#ffffff",
    color: active ? "#00666c" : "#475569",
    cursor: "pointer",
  });

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: isInsurance ? "14px" : 0 }} role="radiogroup" aria-label="Payer">
        <button type="button" role="radio" aria-checked={!isInsurance} style={pill(!isInsurance)} onClick={() => set({ payer_type: "self" })}>
          Self-pay
        </button>
        <button type="button" role="radio" aria-checked={isInsurance} style={pill(isInsurance)} onClick={() => set({ payer_type: "insurance" })}>
          Insurance
        </button>
      </div>

      {isInsurance && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
          <div>
            <Label>Insurance Provider <span style={{ color: "#ef4444" }}>*</span></Label>
            <select
              value={value.insurance_provider}
              onChange={(e) => set({ insurance_provider: e.target.value })}
              style={{ width: "100%", height: "42px", padding: "0 10px", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "13px", background: "#fff" }}
            >
              <option value="">Select insurance provider</option>
              {providerNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Policy Number <span style={{ color: "#ef4444" }}>*</span></Label>
            <Input
              value={value.insurance_policy_no}
              onChange={(e) => set({ insurance_policy_no: e.target.value })}
              placeholder="Policy / member ID"
              style={{ height: "42px" }}
            />
          </div>
          <div>
            <Label>Pre-authorisation No. (optional)</Label>
            <Input
              value={value.insurance_preauth_no}
              onChange={(e) => set({ insurance_preauth_no: e.target.value })}
              placeholder="TPA / cashless approval no."
              style={{ height: "42px" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
