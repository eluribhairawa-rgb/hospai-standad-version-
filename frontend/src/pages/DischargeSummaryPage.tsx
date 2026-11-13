import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../lib/api";
import { printViaIframe } from "../lib/printViaIframe";
import { splitStoredPhone, toWhatsAppNumber } from "../lib/phone";
import type { Notice, Patient } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  selectedPatient?: Patient | null;
  /** patients.write: save drafts and submit for review. */
  canEdit?: boolean;
  /** clinical.author: approve, return, finalise and amend. */
  canApprove?: boolean;
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
  medication_orders?: Record<string, unknown>[];
  procedures: Record<string, unknown>[];
  surgeries: Record<string, unknown>[];
  nursing: Record<string, unknown>[];
  diagnostic_reports: { test: string; type: string; released_at: string; result: string }[];
  pharmacy_issued: string[];
  timeline: Record<string, string>[];
  billing: { total_charges: number; payments_received: number; outstanding: number; status: string } | null;
};

type DischargeMedicine = { medicine: string; dosage: string; frequency: string; duration: string; instructions: string; source?: string; prescription_id?: number | null };

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

type AiWarning = { section: string; removed: string; reasons: string[] };

type SummaryStatus = "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "FINALIZED";

type SavedSummary = {
  id: number;
  encounter_type: string;
  encounter_id: number;
  status: SummaryStatus;
  current_version: number;
  content: Omit<Report, "discharge_medications">;
  medications: DischargeMedicine[];
  ai_generated: boolean;
  ai_model?: string | null;
  ai_warnings: AiWarning[];
  amendment_count?: number;
  created_by?: string; created_at?: string;
  updated_by?: string; updated_at?: string;
  submitted_by?: string | null; submitted_at?: string | null;
  approved_by?: string | null; approved_at?: string | null; approval_note?: string | null;
  finalized_by?: string | null; finalized_at?: string | null;
  versions?: { version: number; status: SummaryStatus; change_type: string; change_note: string | null; changed_by: string | null; changed_at: string }[];
};

type SummaryListItem = { id: number; encounter_type: string; encounter_id: number; encounter_label: string | null; status: SummaryStatus; current_version: number; updated_at: string };

type Action = "submit" | "approve" | "return" | "finalize" | "amend";

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

const STATUS_META: Record<SummaryStatus, { label: string; bg: string; color: string }> = {
  DRAFT: { label: "Draft", bg: "#f1f5f9", color: "#475569" },
  PENDING_REVIEW: { label: "Pending doctor review", bg: "#fffbeb", color: "#b45309" },
  APPROVED: { label: "Approved", bg: "#eff6ff", color: "#1d4ed8" },
  FINALIZED: { label: "Finalised", bg: "#ecfdf5", color: "#047857" },
};

const ACTION_LABELS: Record<Action, string> = {
  submit: "Submit for Review",
  approve: "Approve",
  return: "Return to Draft",
  finalize: "Finalise",
  amend: "Amend",
};

const EMPTY_MED: DischargeMedicine = { medicine: "", dosage: "", frequency: "", duration: "", instructions: "", source: "Added by doctor", prescription_id: null };

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

const emptyReport = (meds: DischargeMedicine[]): Report => ({
  summary: "", presenting_complaints: "", diagnosis: "", clinical_course: "", key_investigations: "", procedures: "",
  treatment_given: "", condition_at_discharge: "", advice: "", follow_up: "", discharge_medications: meds,
});

const fromSaved = (s: SavedSummary): Report => ({ ...emptyReport([]), ...s.content, discharge_medications: s.medications || [] });

const card: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "18px 22px",
  marginBottom: "18px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
};

const btn = (bg: string, disabled = false): React.CSSProperties => ({
  height: "36px", padding: "0 14px", borderRadius: "8px", background: disabled ? "#94a3b8" : bg, color: "#fff", fontWeight: 700,
  fontSize: "12.5px", border: "none", cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap",
});
const btnOutline: React.CSSProperties = {
  height: "36px", padding: "0 14px", borderRadius: "8px", background: "#fff", color: "#334155", fontWeight: 600,
  fontSize: "12.5px", border: "1px solid #cbd5e1", cursor: "pointer", whiteSpace: "nowrap",
};
const cellInput: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "4px 6px", fontSize: "12.5px" };

export default function DischargeSummaryPage({ setNotice, selectedPatient, canEdit = true, canApprove = false }: Props) {
  const [searchTerm, setSearchTerm] = useState(selectedPatient?.patient_id || "");
  const [loading, setLoading] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounters, setEncounters] = useState<EncounterOption[]>([]);
  const [encounterKey, setEncounterKey] = useState("");
  const [records, setRecords] = useState<Records | null>(null);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [generatedAt, setGeneratedAt] = useState("");
  const [saved, setSaved] = useState<SavedSummary | null>(null);
  const [dirty, setDirty] = useState(false);
  const [aiMeta, setAiMeta] = useState<{ generated: boolean; model?: string; warnings: AiWarning[] }>({ generated: false, warnings: [] });
  // True only between an AI generation and the next save, so later manual edits are not recorded as AI output.
  const [freshAi, setFreshAi] = useState(false);
  const [prescribedMeds, setPrescribedMeds] = useState<DischargeMedicine[]>([]);
  const [medSource, setMedSource] = useState<{ prescription_id: number; label: string } | null>(null);
  const [summaries, setSummaries] = useState<SummaryListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [viewing, setViewing] = useState<{ version: number; status: SummaryStatus; report: Report } | null>(null);
  const [errorText, setErrorText] = useState("");

  const selectedEncounter = encounters.find((e) => e.key === encounterKey);
  const status: SummaryStatus | null = saved?.status || null;
  const readOnly = !!viewing || status === "FINALIZED" || !canEdit;
  const shown = viewing?.report || report;

  const loadSummaries = async (pid: string) => {
    try {
      const res = await apiFetch<{ summaries: SummaryListItem[] }>(`/api/patients/${encodeURIComponent(pid)}/discharge-summaries`);
      setSummaries(res.summaries || []);
    } catch {
      setSummaries([]);
    }
  };

  const applySaved = (s: SavedSummary | null) => {
    setSaved(s);
    setFreshAi(false);
    setViewing(null);
    setDirty(false);
    if (s) {
      setReport(fromSaved(s));
      setAiMeta({ generated: s.ai_generated, model: s.ai_model || undefined, warnings: s.ai_warnings || [] });
      setGeneratedAt(s.updated_at || "");
    } else {
      setReport(null);
      setAiMeta({ generated: false, warnings: [] });
      setGeneratedAt("");
    }
  };

  const loadRecords = async (pid: string, enc?: EncounterOption) => {
    if (dirty && !window.confirm("You have unsaved changes to this summary. Discard them?")) return;
    setLoading(true);
    setErrorText("");
    try {
      const qs = enc ? `?encounter_type=${enc.encounter_type}&encounter_id=${enc.encounter_id}` : "";
      const [journey, data] = await Promise.all([
        apiFetch<{ encounters: EncounterOption[]; selected: EncounterOption | null }>(`/api/patients/${encodeURIComponent(pid)}/journey${qs}`),
        apiFetch<{ records: Records; saved: SavedSummary | null; prescribed_medications: DischargeMedicine[]; medication_source: { prescription_id: number; label: string } | null }>(
          `/api/patients/${encodeURIComponent(pid)}/discharge-summary${qs}`
        ),
      ]);
      setPatientId(pid);
      setEncounters(journey.encounters || []);
      setEncounterKey(data.records.encounter ? `${data.records.encounter.type === "EMERGENCY" ? "ER" : data.records.encounter.type}:${data.records.encounter.id}` : journey.selected?.key || "");
      setRecords(data.records);
      setPrescribedMeds(data.prescribed_medications || []);
      setMedSource(data.medication_source || null);
      applySaved(data.saved);
      void loadSummaries(pid);
    } catch (err) {
      setRecords(null);
      applySaved(null);
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load patient records.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedPatient?.patient_id) void loadRecords(selectedPatient.patient_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.patient_id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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

  const encounterBody = () => (records?.encounter ? { encounter_type: records.encounter.type, encounter_id: records.encounter.id } : selectedEncounter ? { encounter_type: selectedEncounter.encounter_type, encounter_id: selectedEncounter.encounter_id } : {});

  const handleGenerate = async () => {
    if (!patientId) return;
    if (dirty && !window.confirm("Regenerating replaces your unsaved edits. Continue?")) return;
    setGenerating(true);
    setErrorText("");
    try {
      const data = await apiFetch<{ records: Records; report: Report; warnings: AiWarning[]; model: string; generated_at: string; medication_source: { prescription_id: number; label: string } | null }>(
        `/api/patients/${encodeURIComponent(patientId)}/discharge-summary/generate`,
        { method: "POST", body: JSON.stringify(encounterBody()) }
      );
      setRecords(data.records);
      setReport(data.report);
      setGeneratedAt(data.generated_at);
      setAiMeta({ generated: true, model: data.model, warnings: data.warnings || [] });
      setMedSource(data.medication_source || null);
      setViewing(null);
      setDirty(true);
      setFreshAi(true);
      setNotice({
        type: data.warnings?.length ? "warning" : "success",
        message: data.warnings?.length
          ? `Draft generated. ${data.warnings.length} AI statement(s) not supported by the records were removed. Review, then Save Draft.`
          : "Draft generated from this visit's records. Review it, then Save Draft.",
      });
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not generate the discharge summary.");
    } finally {
      setGenerating(false);
    }
  };

  const startManual = () => {
    setFreshAi(false);
    setReport(emptyReport(prescribedMeds));
    setAiMeta({ generated: false, warnings: [] });
    setGeneratedAt("");
    setDirty(true);
  };

  const handleSave = async () => {
    if (!report || !patientId || !records?.encounter) return;
    setBusy(true);
    setErrorText("");
    try {
      const { discharge_medications, ...content } = report;
      const res = await apiFetch<{ summary: SavedSummary }>(`/api/patients/${encodeURIComponent(patientId)}/discharge-summary`, {
        method: "PUT",
        body: JSON.stringify({
          ...encounterBody(),
          content,
          discharge_medications: discharge_medications.filter((m) => m.medicine.trim() || m.dosage.trim() || m.frequency.trim()),
          expected_version: saved?.current_version ?? null,
          ai_generated: freshAi,
          ai_model: aiMeta.model,
          ai_warnings: aiMeta.warnings,
        }),
      });
      applySaved(res.summary);
      setFreshAi(false);
      void loadSummaries(patientId);
      setNotice({ type: "success", message: `Draft saved (version ${res.summary.current_version}).` });
    } catch (err) {
      const e = err as { message?: string; status?: number };
      setErrorText(e.message || "Could not save the draft.");
      reportError(setNotice, e, "Could not save the draft.");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: Action, note?: string) => {
    if (!saved) return;
    if (dirty) {
      setNotice({ type: "warning", message: "Save your changes first." });
      return;
    }
    setBusy(true);
    setErrorText("");
    try {
      const res = await apiFetch<{ summary: SavedSummary }>(`/api/discharge-summaries/${saved.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ note: note || undefined, expected_version: saved.current_version }),
      });
      applySaved(res.summary);
      void loadSummaries(patientId);
      setPendingAction(null);
      setActionNote("");
      setNotice({ type: "success", message: `Summary ${STATUS_META[res.summary.status].label.toLowerCase()} (version ${res.summary.current_version}).` });
    } catch (err) {
      const e = err as { message?: string; status?: number };
      setErrorText(e.message || "Action failed.");
      reportError(setNotice, e, "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const requestAction = (action: Action) => {
    if (action === "return" || action === "amend") {
      setPendingAction(action);
      setActionNote("");
      return;
    }
    void runAction(action);
  };

  const viewVersion = async (version: number) => {
    if (!saved) return;
    if (version === saved.current_version) {
      setViewing(null);
      return;
    }
    try {
      const res = await apiFetch<{ version: { version: number; status: SummaryStatus; content: SavedSummary["content"]; medications: DischargeMedicine[] } }>(
        `/api/discharge-summaries/${saved.id}/versions/${version}`
      );
      setViewing({ version: res.version.version, status: res.version.status, report: { ...emptyReport([]), ...res.version.content, discharge_medications: res.version.medications || [] } });
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not load that version.");
    }
  };

  const updateReport = (key: keyof Report, value: string) => {
    setReport((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  };
  const updateMed = (index: number, key: keyof DischargeMedicine, value: string) => {
    setReport((prev) => (prev ? { ...prev, discharge_medications: prev.discharge_medications.map((m, i) => (i === index ? { ...m, [key]: value, ...(key === "medicine" && m.prescription_id ? { source: `${m.source || ""} (edited)`.trim() } : {}) } : m)) } : prev));
    setDirty(true);
  };
  const removeMed = (index: number) => {
    setReport((prev) => (prev ? { ...prev, discharge_medications: prev.discharge_medications.filter((_, i) => i !== index) } : prev));
    setDirty(true);
  };
  const addMed = () => {
    setReport((prev) => (prev ? { ...prev, discharge_medications: [...prev.discharge_medications, { ...EMPTY_MED }] } : prev));
    setDirty(true);
  };
  const resetMedsFromPrescription = () => {
    setReport((prev) => (prev ? { ...prev, discharge_medications: prescribedMeds } : prev));
    setDirty(true);
  };

  const patientName = records
    ? [records.patient.name, records.patient.middle_name, records.patient.last_name].filter(Boolean).join(" ")
    : "";

  const moduleCounts = records
    ? [
        { label: "Vitals", count: records.vitals.length },
        { label: "Prescriptions", count: records.prescriptions.length },
        { label: "Doctor rounds", count: records.doctor_rounds.length },
        { label: "Observation notes", count: records.observation_notes.length },
        { label: "Medication orders", count: (records.medication_orders || []).length },
        { label: "Diagnostic reports", count: records.diagnostic_reports.length },
        { label: "Procedures / OT", count: records.procedures.length + records.surgeries.length },
        { label: "Doctor clinical notes", count: ((records as unknown as { doctor_clinical_notes?: unknown[] }).doctor_clinical_notes || []).length },
        { label: "Nursing logs", count: records.nursing.length },
        { label: "Pharmacy items", count: records.pharmacy_issued.length },
        { label: "Timeline events", count: records.timeline.length },
      ]
    : [];

  const handlePrint = () => {
    if (!shown || !records) return;
    const enc = records.encounter;
    const p = records.patient;
    const printStatus: SummaryStatus | "UNSAVED" = viewing ? viewing.status : dirty || !saved ? "UNSAVED" : saved.status;
    const isFinal = printStatus === "FINALIZED";
    const meds = shown.discharge_medications.length
      ? `<table class="ds-table"><thead><tr><th>#</th><th>Medicine</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Instructions</th></tr></thead><tbody>${shown.discharge_medications
          .map((m, i) => `<tr><td>${i + 1}</td><td><strong>${esc(m.medicine)}</strong></td><td>${esc(m.dosage)}</td><td>${esc(m.frequency)}</td><td>${esc(m.duration)}</td><td>${esc(m.instructions)}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p>No discharge medications.</p>`;
    const vitalsRows = records.vitals.length
      ? `<table class="ds-table"><thead><tr><th>Recorded</th><th>BP</th><th>Pulse</th><th>Temp</th><th>SpO2</th><th>RR</th></tr></thead><tbody>${records.vitals
          .map((v) => `<tr><td>${esc(fmtDateTime(String(v.recorded_at || "")))}</td><td>${esc(v.bp ?? "—")}</td><td>${esc(v.pulse ?? "—")}</td><td>${esc(v.temperature ?? "—")}</td><td>${esc(v.spo2 ?? "—")}</td><td>${esc(v.respiratory_rate ?? "—")}</td></tr>`)
          .join("")}</tbody></table>`
      : "";
    const reportsRows = records.diagnostic_reports.length
      ? `<table class="ds-table"><thead><tr><th>Test</th><th>Released</th><th>Result</th></tr></thead><tbody>${records.diagnostic_reports
          .map((r) => `<tr><td>${esc(r.test)}</td><td>${esc(fmtDate(r.released_at))}</td><td>${esc(r.result)}</td></tr>`)
          .join("")}</tbody></table>`
      : "";
    const watermark = isFinal ? "" : `<div class="ds-watermark">${printStatus === "APPROVED" ? "APPROVED – NOT FINALISED" : "DRAFT – NOT FOR CLINICAL USE"}</div>`;
    const versionLine = saved ? `Version ${viewing ? viewing.version : saved.current_version}${saved.amendment_count ? ` · Amended ${saved.amendment_count}×` : ""}` : "Unsaved draft";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Discharge Summary - ${esc(patientName)}</title>
      <style>
        /* Page size and margins come from the shared print frame (header, footer, 10mm sides). */
        @page { size: A4 portrait; }
        * { box-sizing: border-box; }
        /* Everything is scoped to .ds-doc so these rules cannot restyle the shared letterhead/footer. */
        .ds-doc { font-family: Arial, sans-serif; color: #1e293b; font-size: 12px; line-height: 1.5; width: 100%; max-width: 100%;
          overflow-wrap: anywhere; word-break: break-word; }
        .ds-doc h1 { font-size: 16px; text-align: center; margin: 4px 0 2px; color: #16324a; letter-spacing: 0.06em; }
        .ds-sub { text-align: center; font-size: 11px; color: #475569; margin-bottom: 12px; }
        .ds-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 3px 24px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 9px 13px; margin-bottom: 12px; }
        .ds-grid > div { min-width: 0; }
        .ds-summary { background: #f0fdfa; border-left: 4px solid #00828a; padding: 9px 13px; margin-bottom: 10px; white-space: pre-wrap; }
        .ds-section { break-inside: avoid; page-break-inside: avoid; }
        .ds-doc h2 { font-size: 12.5px; color: #00828a; margin: 11px 0 3px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #e2e8f0; padding-bottom: 2px; }
        .ds-doc p { margin: 0 0 5px; white-space: pre-wrap; }
        .ds-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11.5px; margin-bottom: 6px; }
        .ds-table th, .ds-table td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
        .ds-table th { background: #f1f5f9; }
        .ds-table tr { break-inside: avoid; }
        .ds-sign { margin-top: 34px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; font-size: 11.5px; break-inside: avoid; }
        .ds-sign div { border-top: 1px solid #94a3b8; padding-top: 4px; min-width: 0; }
        .ds-watermark { position: fixed; top: 42%; left: 0; right: 0; padding: 0 12mm; text-align: center; font-size: 34px; font-weight: 800; color: rgba(220, 38, 38, 0.12); transform: rotate(-24deg); pointer-events: none; }
        .ds-muted { color: #64748b; font-size: 11px; }
      </style></head><body>
      ${watermark}
      <div class="ds-doc">
      <h1>DISCHARGE SUMMARY</h1>
      <div class="ds-sub">${esc(enc?.type === "EMERGENCY" ? "Emergency visit" : enc?.type === "IP" ? "Inpatient admission" : "Outpatient visit")} · ${esc(versionLine)} · ${esc(isFinal ? "FINAL" : STATUS_META[printStatus as SummaryStatus]?.label || "Unsaved")}</div>
      <div class="ds-grid">
        <div><strong>Patient:</strong> ${esc(patientName)}</div><div><strong>UHID:</strong> ${esc(p.patient_id)}</div>
        <div><strong>Age / Gender:</strong> ${esc(p.age ?? "—")} / ${esc(p.gender ?? "—")}</div><div><strong>Blood Group:</strong> ${esc(p.blood_group ?? "—")}</div>
        <div><strong>Visit:</strong> ${esc(enc?.label ?? "—")}</div><div><strong>Attending Doctor:</strong> ${esc(enc?.attending_doctor ?? "—")}</div>
        <div><strong>${enc?.type === "IP" ? "Admitted" : "Visit Date"}:</strong> ${esc(fmtDate(enc?.start))}</div><div><strong>${enc?.type === "OP" ? "Visit closed" : "Discharge Date"}:</strong> ${esc(fmtDate(enc?.end))}</div>
        ${enc?.ward ? `<div><strong>Ward / Bed:</strong> ${esc(enc.ward)} / ${esc(enc.bed_no ?? "")}</div>` : ""}
        <div><strong>Allergies:</strong> ${esc(p.allergies || "None recorded")}</div>
      </div>
      <div class="ds-section"><h2>Summary</h2><div class="ds-summary">${esc(shown.summary || "Not recorded")}</div></div>
      ${REPORT_SECTIONS.map((s) => `<div class="ds-section"><h2>${esc(s.label)}</h2><p>${esc((shown[s.key] as string) || "Not recorded")}</p></div>`).join("")}
      ${vitalsRows ? `<div class="ds-section"><h2>Vitals (first / last recorded this visit)</h2>${vitalsRows}</div>` : ""}
      ${reportsRows ? `<div class="ds-section"><h2>Released Investigation Reports</h2>${reportsRows}</div>` : ""}
      <div class="ds-section"><h2>Discharge Medications</h2>${meds}</div>
      <div class="ds-sign">
        <div>Prepared by: ${esc(saved?.created_by || "—")}<br/><span class="ds-muted">${esc(fmtDateTime(saved?.created_at))}</span></div>
        <div>${saved?.approved_by ? `Approved by: Dr. ${esc(saved.approved_by)}<br/><span class="ds-muted">${esc(fmtDateTime(saved.approved_at))}</span>` : "Signature of Consultant: ____________________"}</div>
        ${isFinal ? `<div>Finalised by: ${esc(saved?.finalized_by || "—")}<br/><span class="ds-muted">${esc(fmtDateTime(saved?.finalized_at))}</span></div>` : ""}
        <div class="ds-muted">Printed ${esc(new Date().toLocaleString("en-IN"))}${saved?.ai_generated ? " · Drafted with AI assistance and reviewed by the clinical team" : ""}</div>
      </div>
      </div>
      </body></html>`;
    printViaIframe(html);
  };

  const handleShareWhatsApp = () => {
    if (!records || !records.patient) {
      setNotice({ type: "warning", message: "No patient record loaded." });
      return;
    }
    const p = records.patient;
    const enc = records.encounter;
    const rawPhone = String(p.phone || p.mobile || "");
    const rawCode = String(p.phone_country_code || p.country_code || "+91");
    const parts = splitStoredPhone(rawPhone, rawCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const printStatus: SummaryStatus | "UNSAVED" = viewing ? viewing.status : dirty || !saved ? "UNSAVED" : saved.status;
    const lines = [
      `*HospAI Hospital - Discharge Summary*`,
      `----------------------------------------`,
      `Patient: ${p.name || patientName} (UHID: ${p.patient_id || patientId})`,
      enc?.attending_doctor ? `Consultant: Dr. ${enc.attending_doctor}` : "",
      enc?.ward ? `Ward: ${enc.ward}${enc.bed_no ? ` · Bed ${enc.bed_no}` : ""}` : "",
      enc?.start ? `Admitted: ${fmtDate(enc.start)}` : "",
      `Discharge Date: ${fmtDate(enc?.end || new Date().toISOString())}`,
      shown?.diagnosis ? `Final Diagnosis: ${shown.diagnosis}` : "",
      `Status: ${printStatus}`,
      `----------------------------------------`,
      `Discharge summary details have been recorded. For medications or emergency assistance, contact HospAI Hospital.`,
      `Wishing you good health & a speedy recovery!`,
    ].filter(Boolean);

    const text = lines.join("\n");
    const url = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setNotice({
      type: "success",
      message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened.",
    });
  };

  const meta = status ? STATUS_META[status] : null;
  const actions: Action[] = !saved || dirty || viewing ? [] : [
    ...(status === "DRAFT" && canEdit ? (["submit"] as Action[]) : []),
    ...((status === "DRAFT" || status === "PENDING_REVIEW") && canApprove ? (["approve"] as Action[]) : []),
    ...((status === "PENDING_REVIEW" || status === "APPROVED") && canApprove ? (["return"] as Action[]) : []),
    ...(status === "APPROVED" && canApprove ? (["finalize"] as Action[]) : []),
    ...(status === "FINALIZED" && canApprove ? (["amend"] as Action[]) : []),
  ];

  return (
    <div style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      <div style={{ marginBottom: "18px" }}>
        <h1 style={{ fontSize: "27px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.02em" }}>Discharge Summary</h1>
        <p style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
          Collects the patient&apos;s records for the selected visit and drafts a discharge summary with the Qwen model for doctor review.
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
                {encounters.map((e) => {
                  const s = summaries.find((x) => `${x.encounter_type === "EMERGENCY" ? "ER" : x.encounter_type}:${x.encounter_id}` === e.key);
                  return (
                    <option key={e.key} value={e.key}>
                      {e.label} · {fmtDate(e.start)} · {e.status}{s ? ` · Summary: ${STATUS_META[s.status].label}` : ""}
                    </option>
                  );
                })}
              </select>
            )}
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating || loading || !records.encounter || status === "FINALIZED" || !canEdit}
              title={!records.encounter ? "This patient has no visit to summarise yet." : status === "FINALIZED" ? "Finalised summaries cannot be regenerated. Use Amend." : ""}
              style={{
                marginLeft: "auto",
                height: "38px",
                padding: "0 18px",
                borderRadius: "8px",
                background: generating || status === "FINALIZED" ? "#94a3b8" : "#2563eb",
                color: "#fff",
                fontWeight: 700,
                fontSize: "13px",
                border: "none",
                cursor: generating || loading || !records.encounter || status === "FINALIZED" ? "not-allowed" : "pointer",
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
          <div style={{ fontSize: "13.5px", fontWeight: 800, color: "#0f172a", marginBottom: "10px" }}>Data collected for this visit</div>
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
          {!report && records.encounter && canEdit && (
            <div style={{ marginTop: "12px", fontSize: "12.5px", color: "#475569" }}>
              No saved summary for this visit.{" "}
              <button type="button" onClick={startManual} style={{ ...btnOutline, height: "30px" }}>Start a blank draft (no AI)</button>
            </div>
          )}
        </div>
      )}

      {shown && records && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              Discharge Summary
              {meta && <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "999px", background: meta.bg, color: meta.color }}>{meta.label} · v{saved?.current_version}</span>}
              {!saved && <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "999px", background: "#fef2f2", color: "#b91c1c" }}>Not saved</span>}
              {dirty && saved && <span style={{ fontSize: "11px", fontWeight: 700, color: "#b45309" }}>● unsaved changes</span>}
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                {aiMeta.generated ? `AI-assisted${generatedAt ? ` · ${fmtDateTime(generatedAt)}` : ""}` : ""}
                {saved?.approved_by ? ` · approved by ${saved.approved_by} ${fmtDateTime(saved.approved_at)}` : ""}
                {saved?.finalized_by ? ` · finalised by ${saved.finalized_by} ${fmtDateTime(saved.finalized_at)}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {!readOnly && <button type="button" onClick={() => void handleSave()} disabled={busy || (!dirty && !!saved)} style={btn("#0f766e", busy || (!dirty && !!saved))}>💾 Save Draft</button>}
              {actions.map((a) => (
                <button key={a} type="button" disabled={busy} onClick={() => requestAction(a)}
                  style={a === "return" || a === "amend" ? btnOutline : btn(a === "finalize" ? "#047857" : a === "approve" ? "#1d4ed8" : "#7c3aed", busy)}>
                  {ACTION_LABELS[a]}
                </button>
              ))}
              <button
                type="button"
                onClick={handlePrint}
                style={{ height: "36px", padding: "0 16px", borderRadius: "8px", background: "#00828a", color: "#fff", fontWeight: 700, fontSize: "13px", border: "none", cursor: "pointer" }}
              >
                🖨 Print / Save PDF
              </button>
              <button
                type="button"
                onClick={handleShareWhatsApp}
                style={{
                  height: "36px",
                  padding: "0 16px",
                  borderRadius: "8px",
                  background: "#25D366",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "13px",
                  border: "none",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                💬 Share via WhatsApp
              </button>
            </div>
          </div>

          {viewing && (
            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px", marginBottom: "12px", display: "flex", justifyContent: "space-between", gap: "8px" }}>
              <span>Viewing version {viewing.version} ({STATUS_META[viewing.status].label}) — read only.</span>
              <button type="button" style={{ ...btnOutline, height: "28px" }} onClick={() => setViewing(null)}>Back to current version</button>
            </div>
          )}
          {status === "FINALIZED" && !viewing && (
            <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px", marginBottom: "12px", color: "#065f46" }}>
              This summary is finalised and locked. {canApprove ? "Use Amend to correct it; the finalised version stays in the history." : ""}
            </div>
          )}
          {saved?.approval_note && status === "DRAFT" && !viewing && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px", marginBottom: "12px", color: "#92400e" }}>
              Returned for changes: {saved.approval_note}
            </div>
          )}
          {pendingAction && (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 12px", marginBottom: "12px", background: "#f8fafc" }}>
              <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Reason to {pendingAction === "amend" ? "amend this finalised summary" : "return this summary to draft"} *</label>
              <textarea value={actionNote} onChange={(e) => setActionNote(e.target.value)} rows={2} maxLength={1000}
                style={{ width: "100%", boxSizing: "border-box", marginTop: "4px", padding: "8px 10px", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "13px" }} />
              <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                <button type="button" disabled={busy || !actionNote.trim()} onClick={() => void runAction(pendingAction, actionNote.trim())} style={btn("#b45309", busy || !actionNote.trim())}>
                  Confirm {ACTION_LABELS[pendingAction]}
                </button>
                <button type="button" style={btnOutline} onClick={() => setPendingAction(null)}>Cancel</button>
              </div>
            </div>
          )}
          {errorText && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px", marginBottom: "12px" }}>{errorText}</div>
          )}
          {aiMeta.warnings.length > 0 && !viewing && (
            <details style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px", marginBottom: "12px" }}>
              <summary style={{ cursor: "pointer", fontWeight: 700, color: "#92400e" }}>
                {aiMeta.warnings.length} AI statement(s) removed because they are not supported by this visit&apos;s records
              </summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px", color: "#78350f" }}>
                {aiMeta.warnings.map((w, i) => (
                  <li key={i}><strong>{REPORT_SECTIONS.find((s) => s.key === w.section)?.label || "Summary"}:</strong> “{w.removed}” — {w.reasons.join("; ")}</li>
                ))}
              </ul>
            </details>
          )}

          <label style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", letterSpacing: "0.04em" }}>Summary</label>
          <textarea
            value={shown.summary}
            readOnly={readOnly}
            onChange={(e) => updateReport("summary", e.target.value)}
            rows={4}
            maxLength={5000}
            style={{ width: "100%", boxSizing: "border-box", marginTop: "4px", marginBottom: "14px", padding: "10px 12px", borderRadius: "8px", border: "1.5px solid #99f6e4", background: readOnly ? "#f8fafc" : "#f0fdfa", fontSize: "13.5px", lineHeight: 1.55, resize: "vertical" }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px 18px" }}>
            {REPORT_SECTIONS.map((s) => {
              const required = s.key === "diagnosis" || s.key === "condition_at_discharge" || s.key === "follow_up";
              return (
                <div key={s.key}>
                  <label style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569" }}>{s.label}{required && <span style={{ color: "#dc2626" }} title="Required to approve/finalise"> *</span>}</label>
                  <textarea
                    value={shown[s.key] as string}
                    readOnly={readOnly}
                    onChange={(e) => updateReport(s.key, e.target.value)}
                    rows={2}
                    maxLength={5000}
                    style={{ width: "100%", boxSizing: "border-box", marginTop: "3px", padding: "8px 10px", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "13px", resize: "vertical", background: readOnly ? "#f8fafc" : "#fff" }}
                  />
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 6px", gap: "8px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569" }}>
              Discharge Medications{" "}
              <span style={{ fontWeight: 500, color: "#64748b" }}>
                {medSource ? `from ${medSource.label}` : "No prescription found for this visit"} · never written by the AI
              </span>
            </div>
            {!readOnly && (
              <div style={{ display: "flex", gap: "6px" }}>
                <button type="button" style={{ ...btnOutline, height: "30px" }} onClick={addMed}>+ Add medicine</button>
                <button type="button" style={{ ...btnOutline, height: "30px" }} onClick={resetMedsFromPrescription} disabled={!prescribedMeds.length}>Reset from prescription</button>
              </div>
            )}
          </div>
          {shown.discharge_medications.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  {["Medicine", "Dosage", "Frequency", "Duration", "Instructions", "Source", ...(readOnly ? [] : [""])].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", border: "1px solid #e2e8f0" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.discharge_medications.map((m, i) => (
                  <tr key={i}>
                    {(["medicine", "dosage", "frequency", "duration", "instructions"] as const).map((k) => (
                      <td key={k} style={{ padding: "4px 6px", border: "1px solid #e2e8f0", fontWeight: k === "medicine" ? 600 : 400 }}>
                        {readOnly ? m[k] : <input value={m[k]} onChange={(e) => updateMed(i, k, e.target.value)} maxLength={300} style={cellInput} />}
                      </td>
                    ))}
                    <td style={{ padding: "4px 6px", border: "1px solid #e2e8f0", fontSize: "11px", color: "#64748b" }}>{m.source || "—"}</td>
                    {!readOnly && (
                      <td style={{ padding: "4px 6px", border: "1px solid #e2e8f0" }}>
                        <button type="button" onClick={() => removeMed(i)} style={{ ...btnOutline, height: "26px", padding: "0 8px", color: "#b91c1c" }} title="Remove">✕</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No discharge medications.</div>
          )}

          {saved?.versions && saved.versions.length > 0 && (
            <details style={{ marginTop: "16px" }}>
              <summary style={{ cursor: "pointer", fontSize: "12.5px", fontWeight: 700, color: "#334155" }}>Version history ({saved.versions.length})</summary>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginTop: "6px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {["Version", "Change", "Status", "By", "When", "Note", ""].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "5px 8px", borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {saved.versions.map((v) => (
                    <tr key={v.version} style={{ background: viewing?.version === v.version ? "#eff6ff" : undefined }}>
                      <td style={{ padding: "5px 8px" }}>v{v.version}</td>
                      <td style={{ padding: "5px 8px" }}>{v.change_type.replace(/_/g, " ")}</td>
                      <td style={{ padding: "5px 8px" }}>{STATUS_META[v.status]?.label || v.status}</td>
                      <td style={{ padding: "5px 8px" }}>{v.changed_by || "—"}</td>
                      <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{fmtDateTime(v.changed_at)}</td>
                      <td style={{ padding: "5px 8px", color: "#64748b" }}>{v.change_note || ""}</td>
                      <td style={{ padding: "5px 8px" }}>
                        <button type="button" style={{ ...btnOutline, height: "26px", padding: "0 8px" }} onClick={() => void viewVersion(v.version)}>
                          {v.version === saved.current_version ? "Current" : "View"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
