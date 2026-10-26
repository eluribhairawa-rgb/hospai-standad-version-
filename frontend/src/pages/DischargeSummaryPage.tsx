import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../lib/api";
import { printViaIframe } from "../lib/printViaIframe";
import type { Notice, Patient } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  selectedPatient?: Patient | null;
};

type EncounterOption = { key: string; encounter_type: "IP" | "OP" | "EMERGENCY"; encounter_id: number; label: string; start: string | null; status: string };

type Records = {
  patient: Record<string, string | number>;
  encounter: { type: string; id: number; label: string; start: string | null; end: string | null; status: string; ward: string | null; bed_no: string | null; attending_doctor: string | null } | null;
  vitals: Record<string, string | number>[];
  prescriptions: Record<string, unknown>[];
  doctor_rounds: Record<string, unknown>[];
  observation_notes: Record<string, unknown>[];
  inpatient_medications: Record<string, unknown>[];
  procedures: Record<string, unknown>[];
  surgeries: Record<string, unknown>[];
  nursing: Record<string, unknown>[];
  diagnostic_reports: { test: string; type: string; released_at: string; result: string }[];
  pharmacy_issued: string[];
  timeline: Record<string, string>[];
  billing: { total_charges: number; payments_received: number; outstanding: number; status: string } | null;
};

type DischargeMedicine = { medicine: string; dosage: string; frequency: string; duration: string; instructions: string };

type Report = {
  summary: string;
  presenting_complaints: string;
  diagnosis: string;
  clinical_course: string;
  key_investigations: string;
  procedures: string;
  treatment_given: string;
  condition_at_discharge: string;
  discharge_medications: DischargeMedicine[];
  advice: string;
  follow_up: string;
};

const REPORT_SECTIONS: { key: keyof Report; label: string }[] = [
  { key: "presenting_complaints", label: "Presenting Complaints" },
  { key: "diagnosis", label: "Diagnosis" },
  { key: "clinical_course", label: "Clinical Course" },
  { key: "key_investigations", label: "Key Investigations" },
  { key: "procedures", label: "Procedures / Surgery" },
  { key: "treatment_given", label: "Treatment Given" },
  { key: "condition_at_discharge", label: "Condition at Discharge" },
  { key: "advice", label: "Advice" },
  { key: "follow_up", label: "Follow-up" },
];

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const card: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "18px 22px",
  marginBottom: "18px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
};

export default function DischargeSummaryPage({ setNotice, selectedPatient }: Props) {
  const [searchTerm, setSearchTerm] = useState(selectedPatient?.patient_id || "");
  const [loading, setLoading] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounters, setEncounters] = useState<EncounterOption[]>([]);
  const [encounterKey, setEncounterKey] = useState("");
  const [records, setRecords] = useState<Records | null>(null);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [generatedAt, setGeneratedAt] = useState("");

  const selectedEncounter = encounters.find((e) => e.key === encounterKey);

  const loadRecords = async (pid: string, enc?: EncounterOption) => {
    setLoading(true);
    setReport(null);
    try {
      const qs = enc ? `?encounter_type=${enc.encounter_type}&encounter_id=${enc.encounter_id}` : "";
      const [journey, data] = await Promise.all([
        apiFetch<{ encounters: EncounterOption[]; selected: EncounterOption | null }>(`/api/patients/${encodeURIComponent(pid)}/journey${qs}`),
        apiFetch<{ records: Records }>(`/api/patients/${encodeURIComponent(pid)}/discharge-summary${qs}`),
      ]);
      setPatientId(pid);
      setEncounters(journey.encounters || []);
      setEncounterKey(journey.selected?.key || "");
      setRecords(data.records);
    } catch (err) {
      setRecords(null);
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load patient records.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedPatient?.patient_id) void loadRecords(selectedPatient.patient_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.patient_id]);

  const handleSearch = async () => {
    const term = searchTerm.trim();
    if (!term) {
      setNotice({ type: "warning", message: "Enter a patient name, UHID or mobile number." });
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(term)}`);
      const match = (res.patients || [])[0];
      if (!match) {
        setRecords(null);
        setNotice({ type: "warning", message: `No patient found matching "${term}".` });
        return;
      }
      await loadRecords(match.patient_id);
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Search failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!patientId) return;
    setGenerating(true);
    try {
      const data = await apiFetch<{ records: Records; report: Report; generated_at: string }>(
        `/api/patients/${encodeURIComponent(patientId)}/discharge-summary/generate`,
        {
          method: "POST",
          body: JSON.stringify(selectedEncounter ? { encounter_type: selectedEncounter.encounter_type, encounter_id: selectedEncounter.encounter_id } : {}),
        }
      );
      setRecords(data.records);
      setReport(data.report);
      setGeneratedAt(data.generated_at);
      setNotice({ type: "success", message: "Discharge summary generated. Please review before printing." });
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not generate the discharge summary.");
    } finally {
      setGenerating(false);
    }
  };

  const updateReport = (key: keyof Report, value: string) => setReport((prev) => (prev ? { ...prev, [key]: value } : prev));

  const patientName = records
    ? [records.patient.name, records.patient.middle_name, records.patient.last_name].filter(Boolean).join(" ")
    : "";

  const moduleCounts = records
    ? [
        { label: "Vitals", count: records.vitals.length },
        { label: "Prescriptions", count: records.prescriptions.length },
        { label: "Doctor rounds", count: records.doctor_rounds.length },
        { label: "Observation notes", count: records.observation_notes.length },
        { label: "Diagnostic reports", count: records.diagnostic_reports.length },
        { label: "Procedures / OT", count: records.procedures.length + records.surgeries.length },
        { label: "Nursing logs", count: records.nursing.length },
        { label: "Pharmacy items", count: records.pharmacy_issued.length },
        { label: "Timeline events", count: records.timeline.length },
      ]
    : [];

  const handlePrint = () => {
    if (!report || !records) return;
    const enc = records.encounter;
    const p = records.patient;
    const meds = report.discharge_medications.length
      ? `<table class="ds-table"><thead><tr><th>Medicine</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Instructions</th></tr></thead><tbody>${report.discharge_medications
          .map((m) => `<tr><td>${esc(m.medicine)}</td><td>${esc(m.dosage)}</td><td>${esc(m.frequency)}</td><td>${esc(m.duration)}</td><td>${esc(m.instructions)}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p>Not recorded</p>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Discharge Summary - ${esc(patientName)}</title>
      <style>
        body { font-family: Arial, sans-serif; color: #1e293b; font-size: 12.5px; line-height: 1.5; }
        h1 { font-size: 18px; text-align: center; margin: 8px 0 14px; color: #16324a; letter-spacing: 0.04em; }
        .ds-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; }
        .ds-summary { background: #f0fdfa; border-left: 4px solid #00828a; padding: 10px 14px; margin-bottom: 14px; }
        h2 { font-size: 13px; color: #00828a; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
        p { margin: 0 0 6px; }
        .ds-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .ds-table th, .ds-table td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; }
        .ds-table th { background: #f1f5f9; }
        .ds-sign { margin-top: 40px; display: flex; justify-content: space-between; }
      </style></head><body>
      <h1>DISCHARGE SUMMARY</h1>
      <div class="ds-grid">
        <div><strong>Patient:</strong> ${esc(patientName)}</div><div><strong>UHID:</strong> ${esc(p.patient_id)}</div>
        <div><strong>Age / Gender:</strong> ${esc(p.age ?? "—")} / ${esc(p.gender ?? "—")}</div><div><strong>Blood Group:</strong> ${esc(p.blood_group ?? "—")}</div>
        <div><strong>Visit:</strong> ${esc(enc?.label ?? "—")}</div><div><strong>Attending Doctor:</strong> ${esc(enc?.attending_doctor ?? "—")}</div>
        <div><strong>Admitted / Visit Date:</strong> ${esc(fmtDate(enc?.start))}</div><div><strong>Discharge Date:</strong> ${esc(fmtDate(enc?.end))}</div>
        ${enc?.ward ? `<div><strong>Ward / Bed:</strong> ${esc(enc.ward)} / ${esc(enc.bed_no ?? "")}</div>` : ""}
        <div><strong>Allergies:</strong> ${esc(p.allergies || "None recorded")}</div>
      </div>
      <h2>Summary</h2><div class="ds-summary">${esc(report.summary)}</div>
      ${REPORT_SECTIONS.map((s) => `<h2>${esc(s.label)}</h2><p>${esc(report[s.key] as string)}</p>`).join("")}
      <h2>Discharge Medications</h2>${meds}
      <div class="ds-sign"><div>Prepared on: ${esc(new Date(generatedAt || Date.now()).toLocaleString("en-IN"))}</div><div>Signature of Consultant: ____________________</div></div>
      </body></html>`;
    printViaIframe(html);
  };

  return (
    <div style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      <div style={{ marginBottom: "18px" }}>
        <h1 style={{ fontSize: "27px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.02em" }}>Discharge Summary</h1>
        <p style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
          Collects the patient&apos;s records from every module and generates an AI discharge summary with the Qwen model.
        </p>
      </div>

      {/* Patient & visit selection */}
      <div style={card}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSearch();
            }}
            placeholder="Search by Patient Name, UHID or Mobile Number..."
            style={{ flex: "1 1 320px", height: "40px", padding: "0 14px", borderRadius: "8px", border: "1.5px solid #cbd5e1", fontSize: "13px" }}
          />
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={loading}
            style={{ height: "40px", padding: "0 20px", borderRadius: "8px", background: "#00828a", color: "#fff", fontWeight: 700, fontSize: "13px", border: "none", cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Loading…" : "Search Patient"}
          </button>
        </div>

        {records && (
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center", marginTop: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
              {patientName}{" "}
              <span style={{ background: "#ccfbf1", color: "#0f766e", padding: "2px 8px", borderRadius: "10px", fontSize: "11.5px", fontWeight: 700 }}>
                {records.patient.patient_id}
              </span>{" "}
              <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                {records.patient.age ? `${records.patient.age} yrs` : ""} {records.patient.gender || ""}
              </span>
            </div>
            {encounters.length > 0 && (
              <select
                value={encounterKey}
                onChange={(e) => {
                  const enc = encounters.find((x) => x.key === e.target.value);
                  if (enc) void loadRecords(patientId, enc);
                }}
                style={{ height: "36px", borderRadius: "8px", border: "1.5px solid #cbd5e1", padding: "0 10px", fontSize: "13px" }}
              >
                {encounters.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.label} · {fmtDate(e.start)} · {e.status}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating || loading || !records.encounter}
              title={records.encounter ? "" : "This patient has no visit to summarise yet."}
              style={{
                marginLeft: "auto",
                height: "38px",
                padding: "0 18px",
                borderRadius: "8px",
                background: generating ? "#94a3b8" : "#2563eb",
                color: "#fff",
                fontWeight: 700,
                fontSize: "13px",
                border: "none",
                cursor: generating || loading || !records.encounter ? "not-allowed" : "pointer",
                opacity: records.encounter ? 1 : 0.6,
              }}
            >
              {generating ? "Generating with AI…" : report ? "↻ Regenerate Summary" : "✨ Generate Discharge Summary"}
            </button>
          </div>
        )}
      </div>

      {records && (
        <div style={card}>
          <div style={{ fontSize: "13.5px", fontWeight: 800, color: "#0f172a", marginBottom: "10px" }}>Data collected across modules</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {moduleCounts.map((m) => (
              <span
                key={m.label}
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: "999px",
                  background: m.count ? "#eff6ff" : "#f1f5f9",
                  color: m.count ? "#1d4ed8" : "#94a3b8",
                  border: `1px solid ${m.count ? "#bfdbfe" : "#e2e8f0"}`,
                }}
              >
                {m.label}: {m.count}
              </span>
            ))}
          </div>
          {records.billing && records.billing.total_charges > 0 && (
            <div style={{ fontSize: "12px", color: "#475569", marginTop: "10px" }}>
              Billing: ₹{records.billing.total_charges.toLocaleString("en-IN")} charged · ₹{records.billing.payments_received.toLocaleString("en-IN")} received · {records.billing.status}
            </div>
          )}
        </div>
      )}

      {report && records && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>
              AI Discharge Summary{" "}
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                generated {generatedAt ? new Date(generatedAt).toLocaleString("en-IN") : ""} · editable
              </span>
            </div>
            <button
              type="button"
              onClick={handlePrint}
              style={{ height: "36px", padding: "0 16px", borderRadius: "8px", background: "#00828a", color: "#fff", fontWeight: 700, fontSize: "13px", border: "none", cursor: "pointer" }}
            >
              🖨 Print / Save PDF
            </button>
          </div>

          <label style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", letterSpacing: "0.04em" }}>Summary</label>
          <textarea
            value={report.summary}
            onChange={(e) => updateReport("summary", e.target.value)}
            rows={4}
            style={{ width: "100%", boxSizing: "border-box", marginTop: "4px", marginBottom: "14px", padding: "10px 12px", borderRadius: "8px", border: "1.5px solid #99f6e4", background: "#f0fdfa", fontSize: "13.5px", lineHeight: 1.55, resize: "vertical" }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px 18px" }}>
            {REPORT_SECTIONS.map((s) => (
              <div key={s.key}>
                <label style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569" }}>{s.label}</label>
                <textarea
                  value={report[s.key] as string}
                  onChange={(e) => updateReport(s.key, e.target.value)}
                  rows={2}
                  style={{ width: "100%", boxSizing: "border-box", marginTop: "3px", padding: "8px 10px", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "13px", resize: "vertical" }}
                />
              </div>
            ))}
          </div>

          <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", margin: "14px 0 6px" }}>Discharge Medications</div>
          {report.discharge_medications.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  {["Medicine", "Dosage", "Frequency", "Duration", "Instructions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", border: "1px solid #e2e8f0" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.discharge_medications.map((m, i) => (
                  <tr key={i}>
                    <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0", fontWeight: 600 }}>{m.medicine}</td>
                    <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{m.dosage}</td>
                    <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{m.frequency}</td>
                    <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{m.duration}</td>
                    <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{m.instructions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>Not recorded</div>
          )}
        </div>
      )}
    </div>
  );
}
