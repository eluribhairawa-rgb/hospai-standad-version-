import { apiFetch } from "./api";
import type { Patient } from "../types";

export const fullPatientName = (patient?: Patient | null) =>
  [patient?.name, patient?.middle_name, patient?.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

export const normalizeUhidLookup = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits && digits.length <= 4) return digits.padStart(4, "0");
  return trimmed;
};

export async function lookupPatientByUhid(value: string): Promise<Patient | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lookup = normalizeUhidLookup(trimmed);
  try {
    const data = await apiFetch<{ patient?: Patient }>(`/api/patients/${encodeURIComponent(lookup)}`);
    if (data.patient) return data.patient;
  } catch {
    // If not found by direct ID, search by name/phone/query
  }
  try {
    const searchData = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(trimmed)}`);
    if (searchData.patients && searchData.patients.length > 0) {
      return searchData.patients[0];
    }
  } catch {
    // ignore
  }
  return null;
}
