import { useState } from "react";
import { Button, Input } from "./ui";
import { apiFetch } from "../lib/api";
import type { Patient } from "../types";

type Props = {
  onSelect: (patient: Patient) => void;
  placeholder?: string;
};

export default function PatientSearchPicker({ onSelect, placeholder }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearching(true);
    try {
      const data = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(trimmed)}`);
      const list = data.patients || [];
      // Only auto-select on an unambiguous single match -- an ambiguous
      // search always shows a clickable candidate list, never guesses.
      if (list.length === 1) {
        onSelect(list[0]);
        setResults([]);
        setSearched(false);
        setQuery("");
        return;
      }
      setResults(list);
      setSearched(true);
    } catch {
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const pick = (patient: Patient) => {
    onSelect(patient);
    setResults([]);
    setSearched(false);
    setQuery("");
  };

  return (
    <div className="patient-search-picker">
      <div className="patient-search-picker-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runSearch();
            }
          }}
          placeholder={placeholder || "Search by name, phone, or UHID"}
        />
        <Button type="button" variant="secondary" disabled={searching} onClick={() => void runSearch()}>
          {searching ? "Searching..." : "Search"}
        </Button>
      </div>
      {searched && results.length > 1 && (
        <ul className="patient-search-results" role="listbox">
          {results.map((patient) => (
            <li key={patient.patient_id}>
              <button type="button" className="patient-search-result-item" onClick={() => pick(patient)}>
                <strong>{[patient.name, patient.last_name].filter(Boolean).join(" ")}</strong>
                <span>{patient.patient_id} · {patient.phone || "no phone"} · {patient.gender || "-"} {patient.age ? `· ${patient.age}y` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {searched && results.length === 0 && <p className="muted patient-search-empty">No matching patients found.</p>}
    </div>
  );
}
