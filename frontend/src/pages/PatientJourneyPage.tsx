import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../lib/api";
import { splitStoredPhone, toWhatsAppNumber } from "../lib/phone";
import { generatePDFBlob, downloadPDF, printPDF, patientFilename } from "../lib/exportService";
import type { StandardPdfPayload } from "../lib/exportService";
import type { Notice, Patient } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
  selectedPatient?: Patient | null;
};

type JourneyEncounter = {
  key: string;
  encounter_type: "IP" | "OP" | "EMERGENCY";
  encounter_id: number;
  label: string;
  start: string | null;
  end: string | null;
  status: string;
  ward: string | null;
  bed_no: string | null;
};

type JourneyEvent = {
  date: string;
  time: string;
  type: string;
  title: string;
  subtitle: string;
  charge: number | null;
  received: number | null;
  items?: { name: string; quantity: number; unit_price: number; amount: number }[];
  report_id?: number;
  invoice_no?: string | null;
  prescription?: JourneyPrescription;
};

type JourneyPrescription = {
  id: number;
  medicines: { name: string; dosage: string; frequency: string; duration: string; instructions: string }[];
  diagnosis: string;
  lab_tests: string;
  advice: string;
  follow_up_date: string;
};

type JourneyDocument = { type: string; label: string; available: boolean; ref: number | null };

type JourneyPayment = { date: string; time: string; mode: string; reference: string; invoice_no: string; amount: number };

type JourneyStay = {
  reason?: string | null; department?: string | null; consulting_doctor?: string | null; admission_type?: string | null;
  triage?: string | null; expected_stay?: string | null; payer_type?: string | null;
  bed: { ward?: string | null; room_no?: string | null; bed_no?: string | null; bed_type?: string | null; daily_charge?: number | null; since?: string | null; status?: string | null } | null;
  bed_history: { label: string; from: string | null; to: string | null }[];
};

type Journey = {
  patient: { patient_id: string; name: string; age: number | null; gender: string | null; phone?: string | null; phone_country_code?: string | null };
  encounters: JourneyEncounter[];
  selected: JourneyEncounter | null;
  doctor_name: string | null;
  stay?: JourneyStay | null;
  events: JourneyEvent[];
  financial_summary: { categories: { label: string; amount: number }[]; total_charges: number; payments_received: number; outstanding: number; status: string };
  payments: JourneyPayment[];
  documents: JourneyDocument[];
};

function formatCurrency(amount?: number | null) {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

function formatDateHeading(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric", weekday: "long" });
}

function eventDotColor(type: string) {
  if (type === "discharge" || type === "disposition") return "#16a34a";
  if (type === "nursing_note") return "#7c3aed";
  if (type === "bed_allocated" || type === "bed_released") return "#0ea5e9";
  if (type === "doctor_round" || type === "observation_note" || type === "surgery") return "#2563eb";
  if (type === "medication_order") return "#ea580c";
  if (type === "vitals") return "#db2777";
  if (type === "prescription") return "#2563eb";
  if (type === "pharmacy_issued") return "#ea580c";
  if (type === "lab_bill" || type === "lab_collected" || type === "imaging_completed" || type === "report_released") return "#9333ea";
  return "#0d9488";
}

const EVENT_DEPARTMENTS: Record<string, string> = {
  registration: "Registration", admission: "Admission", consultation: "Consultation",
  emergency_registration: "Emergency", vitals: "Vitals",
  room_charges: "Room & Nursing", payment: "Billing", discharge: "Discharge",
  disposition: "Emergency", nursing_note: "Nursing",
  bed_allocated: "Bed & Ward", bed_released: "Bed & Ward", doctor_round: "Doctor Rounds", observation_note: "Doctor Rounds",
  medication_order: "Pharmacy", surgery: "Surgery",
  prescription: "Consultation", pharmacy_issued: "Pharmacy",
  lab_bill: "Diagnostics", lab_collected: "Diagnostics", imaging_completed: "Diagnostics", report_released: "Diagnostics",
  critical_alert: "Diagnostics", critical_ack: "Diagnostics",
};

export default function PatientJourneyPage({ setNotice, onNavigate, selectedPatient }: Props) {
  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem("selected_journey_patient") || selectedPatient?.patient_id || "");
  const [searching, setSearching] = useState(false);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const [eventFilter, setEventFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"oldest" | "newest">("oldest");
  const [exporting, setExporting] = useState<"" | "pdf" | "print">("");
  const [reportModal, setReportModal] = useState<{ title: string; loading: boolean; content: Record<string, unknown> | null } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("selected_journey_patient");
    const pid = saved || selectedPatient?.patient_id;
    if (pid) {
      setSearchTerm(pid);
      loadJourney(pid);
      localStorage.removeItem("selected_journey_patient");
    }
  }, [selectedPatient?.patient_id]);

  const loadJourney = async (patientId: string, encounter?: JourneyEncounter) => {
    setSearching(true);
    try {
      const qs = encounter ? `?encounter_type=${encounter.encounter_type}&encounter_id=${encounter.encounter_id}` : "";
      const data = await apiFetch<Journey>(`/api/patients/${encodeURIComponent(patientId)}/journey${qs}`);
      setJourney(data);
      setExpandedEvents(new Set());
      if (data.encounters.length === 0) {
        setNotice({ type: "info", message: `${data.patient.name} has no registered visits yet.` });
      }
    } catch (error) {
      setJourney(null);
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load patient journey.");
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = async () => {
    const term = searchTerm.trim();
    if (!term) {
      setNotice({ type: "warning", message: "Enter a patient name or UHID to search." });
      return;
    }
    setSearching(true);
    try {
      if (/^PAT-/i.test(term)) {
        await loadJourney(term);
        return;
      }
      const res = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(term)}`);
      const match = (res.patients || [])[0];
      if (!match) {
        setJourney(null);
        setNotice({ type: "warning", message: `No patient found matching "${term}".` });
        return;
      }
      await loadJourney(match.patient_id);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const changeEncounter = (key: string) => {
    if (!journey) return;
    const enc = journey.encounters.find((e) => e.key === key);
    if (enc) void loadJourney(journey.patient.patient_id, enc);
  };

  const groupedEvents = useMemo(() => {
    if (!journey) return [];
    let events = journey.events.filter((e) => {
      if (eventFilter !== "all" && e.type !== eventFilter) return false;
      if (deptFilter !== "all" && EVENT_DEPARTMENTS[e.type] !== deptFilter) return false;
      return true;
    });
    events = [...events].sort((a, b) => {
      const cmp = `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);
      return sortOrder === "oldest" ? cmp : -cmp;
    });
    const byDate = new Map<string, JourneyEvent[]>();
    for (const e of events) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date)!.push(e);
    }
    return Array.from(byDate.entries());
  }, [journey, eventFilter, deptFilter, sortOrder]);

  const toggleExpand = (index: number) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const openReport = async (reportId: number, title: string) => {
    setReportModal({ title, loading: true, content: null });
    try {
      const data = await apiFetch<{ content: Record<string, unknown> | string; status: string; authorized_by?: string; released_at?: string }>(`/api/diag/reports/${reportId}`);
      const content = typeof data.content === "string" ? { text: data.content } : (data.content || {});
      setReportModal({ title, loading: false, content: { ...content, "Authorized by": data.authorized_by, "Released at": data.released_at, "Status": data.status } });
    } catch (error) {
      setReportModal(null);
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load report.");
    }
  };

  const buildPdfPayload = (): Omit<StandardPdfPayload, "filename"> & { filename: string } => {
    if (!journey || !journey.selected) throw new Error("No journey loaded.");
    const rows = journey.events.map((e) => [
      `${e.date} ${e.time}`, `${e.title} — ${e.subtitle}`,
      e.charge ? formatCurrency(e.charge) : "—", e.received ? formatCurrency(e.received) : "—",
    ]);
    const detailSections: { title: string; headers: string[]; rows: string[][] }[] = [];
    journey.events.forEach((e) => {
      if (e.type === "prescription" && e.prescription) {
        const rx = e.prescription;
        detailSections.push({
          title: `Prescription · ${e.date} ${e.time}`,
          headers: ["Medicine", "Dosage", "Frequency", "Duration", "Instructions"],
          rows: rx.medicines.length
            ? rx.medicines.map((m) => [m.name, m.dosage || "-", m.frequency || "-", m.duration || "-", m.instructions || "-"])
            : [["No medicines prescribed", "-", "-", "-", "-"]],
        });
        const notes = [
          rx.diagnosis ? ["Diagnosis", rx.diagnosis] : null,
          rx.lab_tests ? ["Tests advised", rx.lab_tests] : null,
          rx.advice ? ["Advice", rx.advice] : null,
          rx.follow_up_date ? ["Follow-up", rx.follow_up_date] : null,
        ].filter(Boolean) as string[][];
        if (notes.length) detailSections.push({ title: "Prescription notes", headers: ["Item", "Details"], rows: notes });
      } else if ((e.type === "pharmacy_issued" || e.type === "lab_bill") && e.items?.length) {
        const isLab = e.type === "lab_bill";
        const total = e.items.reduce((sum, it) => sum + it.amount, 0);
        detailSections.push({
          title: `${isLab ? "Lab & Diagnostics Bill" : "Pharmacy Bill"}${e.invoice_no ? ` · ${e.invoice_no}` : ""} · ${e.date}`,
          headers: isLab ? ["Test / Service", "Amount"] : ["Medicine", "Quantity", "Unit price", "Amount"],
          rows: [
            ...e.items.map((it) => (isLab ? [it.name, formatCurrency(it.amount)] : [it.name, `${it.quantity}`, formatCurrency(it.unit_price), formatCurrency(it.amount)])),
            isLab ? ["Total", formatCurrency(total)] : ["Total", "", "", formatCurrency(total)],
          ],
        });
      }
    });
    const fs = journey.financial_summary;
    return {
      title: "Patient Journey Summary",
      subtitle: `${journey.selected.label} · ${journey.selected.start?.slice(0, 10) || ""}${journey.selected.end && journey.selected.end !== journey.selected.start ? ` – ${journey.selected.end.slice(0, 10)}` : ""}`,
      filename: patientFilename(journey.patient.name, journey.patient.patient_id),
      operator_name: "HospAI System",
      patient_info: {
        patient_name: journey.patient.name, patient_id: journey.patient.patient_id,
        age: journey.patient.age ?? undefined, gender: journey.patient.gender ?? undefined,
        consulting_doctor: journey.doctor_name ?? undefined,
      },
      sections: [
        { title: "Chronological Activity", headers: ["Time", "Event and reference", "Charge", "Received"], rows },
        ...detailSections,
      ],
      totals: {
        subtotal: formatCurrency(fs.total_charges), grand_total: formatCurrency(fs.total_charges),
        amount_received: formatCurrency(fs.payments_received), balance: formatCurrency(fs.outstanding),
      },
    };
  };

  const handleDownloadPdf = async () => {
    if (exporting) return;
    setExporting("pdf");
    try {
      const { blob, filename } = await generatePDFBlob(buildPdfPayload(), { dated: false });
      downloadPDF(blob, filename);
      setNotice({ type: "success", message: "Patient journey PDF downloaded." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to generate the journey PDF." });
    } finally {
      setExporting("");
    }
  };

  const handlePrintJourney = async () => {
    if (exporting) return;
    setExporting("print");
    try {
      const { blob } = await generatePDFBlob(buildPdfPayload());
      printPDF(blob);
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to print the journey." });
    } finally {
      setExporting("");
    }
  };

  const patient = journey?.patient;

  const handleShareWhatsApp = () => {
    if (!patient) return;
    const parts = splitStoredPhone(patient.phone, patient.phone_country_code);
    const number = toWhatsAppNumber(parts.countryCode, parts.value);
    if (!number) {
      setNotice({ type: "warning", message: "This patient has no primary mobile number on record." });
      return;
    }
    const msg = `Hello ${patient.name}, your patient number (UHID) at our hospital is ${patient.patient_id}. Please quote it on every visit.`;
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
  };
  const selected = journey?.selected;
  const fs = journey?.financial_summary;

  return (
    <div style={{ padding: "1.25rem 1.75rem 2.5rem", maxWidth: "1480px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
        <div>
          <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500, marginBottom: "4px" }}>
            <span>Hospital</span><span style={{ margin: "0 6px", color: "#94a3b8" }}>/</span>
            <span style={{ color: "#0f172a", fontWeight: 600 }}>Patient Journey</span>
          </div>
          <h1 style={{ fontSize: "1.45rem", fontWeight: 800, margin: 0, color: "#0f172a", letterSpacing: "-0.02em" }}>Patient Journey</h1>
          <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>Registration, care, services and payments — in time order</p>
        </div>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          {journey && journey.patient && onNavigate && (
            <>
              <button
                type="button"
                className="pharmacy-btn-outline"
                style={{ height: "38px", padding: "0 14px", fontWeight: 600 }}
                onClick={() => {
                  localStorage.setItem("selected_billing_patient", journey.patient.patient_id);
                  onNavigate("billing-patient-bills");
                }}
              >
                💳 Bills &amp; Payment
              </button>
              <button
                type="button"
                className="pharmacy-btn-outline"
                style={{ height: "38px", padding: "0 14px", fontWeight: 600 }}
                onClick={() => {
                  localStorage.setItem("selected_pharmacy_patient", journey.patient.patient_id);
                  onNavigate("pharmacy-op-dispense");
                }}
              >
                💊 Pharmacy
              </button>
              <button
                type="button"
                className="pharmacy-btn-outline"
                style={{ height: "38px", padding: "0 14px", fontWeight: 600 }}
                onClick={() => {
                  localStorage.setItem("selected_diag_patient", journey.patient.patient_id);
                  onNavigate("diag-orders-billing");
                }}
              >
                🔬 Diagnostics
              </button>
              <button
                type="button"
                className="pharmacy-btn-outline"
                style={{ height: "38px", padding: "0 14px", fontWeight: 600 }}
                onClick={() => {
                  localStorage.setItem("selected_discharge_admission", journey.patient.patient_id);
                  onNavigate("billing-ip-discharge");
                }}
              >
                🛏️ IP Discharge
              </button>
            </>
          )}
          <button type="button" onClick={() => void handleDownloadPdf()} disabled={!journey || exporting !== ""}
                  className="pharmacy-btn-outline" style={{ height: "38px", padding: "0 16px", opacity: journey ? 1 : 0.5 }}>
            {exporting === "pdf" ? "Preparing…" : "Download PDF"}
          </button>
          <button type="button" onClick={handleShareWhatsApp} disabled={!journey}
                  className="pharmacy-btn-outline" style={{ height: "38px", padding: "0 16px", opacity: journey ? 1 : 0.5 }}>
            💬 Share via WhatsApp
          </button>
          <button type="button" onClick={() => void handlePrintJourney()} disabled={!journey || exporting !== ""}
                  className="pharmacy-btn-teal" style={{ height: "38px", padding: "0 16px", opacity: journey ? 1 : 0.5 }}>
            {exporting === "print" ? "Preparing…" : "🖨️ Print journey"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: "1.25rem" }}>
        <input
          type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          placeholder="Search by patient name or UHID (e.g. PAT-20260920-0024)"
          className="pharmacy-rx-search-input" style={{ flex: 1, maxWidth: "480px", height: "40px", padding: "0 14px" }}
        />
        <button type="button" onClick={() => void handleSearch()} disabled={searching} className="pharmacy-btn-teal" style={{ height: "40px", padding: "0 22px" }}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {!journey && (
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "40px", textAlign: "center", color: "#64748b" }}>
          Search a real patient by name or UHID to see their full registration-to-discharge journey, itemized charges and payments.
        </div>
      )}

      {journey && journey.encounters.length === 0 && patient && (
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "40px", textAlign: "center", color: "#64748b" }}>
          <strong>{patient.name}</strong> ({patient.patient_id}) has no OP, IPD or Emergency visits recorded yet.
        </div>
      )}

      {journey && selected && patient && fs && (
        <>
          <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "18px 22px", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div style={{ width: "46px", height: "46px", borderRadius: "50%", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: "16px" }}>
                {patient.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{patient.name}</div>
                <div style={{ fontSize: "12.5px", color: "#64748b" }}>
                  {patient.age ? `${patient.age} years` : "Age not added"} · {patient.gender || "Gender not added"} · UHID {patient.patient_id}
                </div>
              </div>
            </div>

            <div>
              <label style={{ fontSize: "11px", color: "#64748b", fontWeight: 700, display: "block", marginBottom: "3px", textTransform: "uppercase" }}>Encounter</label>
              <select value={selected.key} onChange={(e) => changeEncounter(e.target.value)} className="pharmacy-rx-search-input" style={{ height: "36px", padding: "0 10px", minWidth: "260px" }}>
                {journey.encounters.map((e) => (
                  <option key={e.key} value={e.key}>{e.label} · {(e.start || "").slice(0, 10)}{e.end && e.end.slice(0, 10) !== (e.start || "").slice(0, 10) ? ` – ${e.end.slice(0, 10)}` : ""}</option>
                ))}
              </select>
            </div>

            <span style={{
              fontSize: "12px", fontWeight: 700, padding: "5px 14px", borderRadius: "9999px",
              background: selected.status === "Discharged" || selected.status === "Admitted" ? "#dcfce7" : "#eff6ff",
              color: selected.status === "Discharged" || selected.status === "Admitted" ? "#166534" : "#1d4ed8",
            }}>
              {selected.status === "Discharged" ? "✅ " : ""}{selected.status}
            </span>

            {selected.ward && (
              <div style={{ fontSize: "12.5px", color: "#475569" }}>{selected.ward} · Bed {selected.bed_no}</div>
            )}
          </div>

          {journey.stay && (
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "16px 22px", marginBottom: "16px" }}>
              <div style={{ fontSize: "12px", fontWeight: 800, color: "#334155", textTransform: "uppercase", marginBottom: "10px" }}>Inpatient stay details</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px 18px" }}>
                {([
                  ["Reason for admission", journey.stay.reason],
                  ["Department", journey.stay.department],
                  ["Consulting doctor", journey.stay.consulting_doctor],
                  ["Admission type", journey.stay.admission_type],
                  ["Triage", journey.stay.triage],
                  ["Expected stay", journey.stay.expected_stay],
                  ["Ward / room", journey.stay.bed ? [journey.stay.bed.ward, journey.stay.bed.room_no].filter(Boolean).join(" · ") : null],
                  ["Bed", journey.stay.bed ? [journey.stay.bed.bed_no, journey.stay.bed.bed_type].filter(Boolean).join(" · ") : null],
                  ["Bed charge", journey.stay.bed?.daily_charge ? `${formatCurrency(journey.stay.bed.daily_charge)} / day` : null],
                  ["Payer", journey.stay.payer_type],
                ] as [string, string | null | undefined][]).map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
                    <div style={{ fontSize: "13px", color: "#0f172a", fontWeight: 600 }}>{value || "Not recorded"}</div>
                  </div>
                ))}
              </div>
              {journey.stay.bed_history.length > 1 && (
                <div style={{ marginTop: "12px", fontSize: "12.5px", color: "#475569" }}>
                  <strong>Bed history:</strong>{" "}
                  {journey.stay.bed_history.map((b) => `${b.label} (${(b.from || "").slice(0, 16).replace("T", " ")}${b.to ? ` → ${b.to.slice(0, 16).replace("T", " ")}` : " → now"})`).join("  ›  ")}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "16px", alignItems: "start" }}>
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "18px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
                <h2 style={{ fontSize: "15px", fontWeight: 800, margin: 0, color: "#0f172a" }}>Activity timeline</h2>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                    <option value="all">All events</option>
                    {Array.from(new Set(journey.events.map((e) => e.type))).map((t) => (
                      <option key={t} value={t}>{journey.events.find((e) => e.type === t)?.title}</option>
                    ))}
                  </select>
                  <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                    <option value="all">All departments</option>
                    {Array.from(new Set(journey.events.map((e) => EVENT_DEPARTMENTS[e.type]).filter(Boolean))).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as "oldest" | "newest")} style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                  </select>
                  <button type="button" onClick={() => setExpandAll((v) => !v)} style={{ fontSize: "12px", fontWeight: 700, color: "#0891b2", background: "none", border: "none", cursor: "pointer" }}>
                    {expandAll ? "Collapse all" : "Expand all"}
                  </button>
                </div>
              </div>

              {groupedEvents.length === 0 && <p style={{ color: "#94a3b8", fontSize: "13px" }}>No events match this filter.</p>}

              {groupedEvents.map(([date, dayEvents]) => (
                <div key={date} style={{ marginBottom: "10px" }}>
                  <div style={{ background: "#f8fafc", padding: "6px 10px", borderRadius: "6px", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "8px" }}>
                    {formatDateHeading(date)}
                  </div>
                  {dayEvents.map((e, idx) => {
                    const globalIdx = journey.events.indexOf(e);
                    const isExpanded = expandAll || expandedEvents.has(globalIdx);
                    const hasItems = (e.items && e.items.length > 0) || !!e.prescription;
                    return (
                      <div key={`${date}-${idx}`} style={{ display: "grid", gridTemplateColumns: "56px 1fr auto", gap: "6px", padding: "9px 6px", borderBottom: "1px solid #f1f5f9" }}>
                        <div style={{ fontSize: "11.5px", color: "#64748b", paddingTop: "2px" }}>{e.time}</div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: eventDotColor(e.type), flexShrink: 0 }} />
                            <strong style={{ fontSize: "13px", color: "#0f172a" }}>{e.title}</strong>
                            {hasItems && (
                              <button type="button" onClick={() => toggleExpand(globalIdx)} style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b", fontSize: "11px" }}>
                                {isExpanded ? "▲" : "▼"}
                              </button>
                            )}
                          </div>
                          <div style={{ fontSize: "12px", color: "#64748b", marginLeft: "16px" }}>{e.subtitle}</div>
                          {e.report_id && (
                            <button type="button" onClick={() => void openReport(e.report_id!, e.title)} style={{ marginLeft: "16px", fontSize: "12px", fontWeight: 700, color: "#0891b2", background: "none", border: "none", cursor: "pointer" }}>
                              View report →
                            </button>
                          )}
                          {hasItems && isExpanded && e.prescription && (
                            <div style={{ marginLeft: "16px", marginTop: "6px", background: "#f8fafc", borderRadius: "6px", padding: "8px 10px", fontSize: "12px", color: "#334155" }}>
                              {e.prescription.medicines.length === 0 && <div style={{ color: "#94a3b8" }}>No medicines prescribed.</div>}
                              {e.prescription.medicines.map((m, i) => (
                                <div key={i} style={{ padding: "2px 0" }}>
                                  <strong style={{ color: "#0f172a" }}>{m.name}</strong>
                                  {[m.dosage, m.frequency, m.duration].filter(Boolean).length > 0 && <span> · {[m.dosage, m.frequency, m.duration].filter(Boolean).join(" · ")}</span>}
                                  {m.instructions && <span style={{ color: "#64748b", fontStyle: "italic" }}> · {m.instructions}</span>}
                                </div>
                              ))}
                              {(e.prescription.lab_tests || e.prescription.advice || e.prescription.follow_up_date) && (
                                <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px solid #e2e8f0", color: "#475569" }}>
                                  {e.prescription.lab_tests && <div><strong>Tests advised:</strong> {e.prescription.lab_tests}</div>}
                                  {e.prescription.advice && <div><strong>Advice:</strong> {e.prescription.advice}</div>}
                                  {e.prescription.follow_up_date && <div><strong>Follow-up:</strong> {e.prescription.follow_up_date}</div>}
                                </div>
                              )}
                            </div>
                          )}
                          {hasItems && isExpanded && e.items && e.items.length > 0 && (
                            <div style={{ marginLeft: "16px", marginTop: "6px", background: "#f8fafc", borderRadius: "6px", padding: "8px 10px" }}>
                              {e.items.map((it, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#334155", padding: "2px 0" }}>
                                  <span>{e.type === "lab_bill" ? it.name : `${it.name} · ${it.quantity} × ${formatCurrency(it.unit_price)}`}</span>
                                  <span>{formatCurrency(it.amount)}</span>
                                </div>
                              ))}
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 700, color: "#0f172a", borderTop: "1px solid #e2e8f0", marginTop: "4px", paddingTop: "4px" }}>
                                <span>Total</span>
                                <span>{formatCurrency(e.items.reduce((sum, it) => sum + it.amount, 0))}</span>
                              </div>
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: "right", fontSize: "12.5px", fontWeight: 700 }}>
                          {e.charge !== null && e.received !== null && e.charge === e.received ? (
                            <span style={{ color: "#16a34a" }}>{formatCurrency(e.charge)} paid</span>
                          ) : (
                            <>
                              {e.charge !== null && <span style={{ color: "#0f172a" }}>{formatCurrency(e.charge)}</span>}
                              {e.received !== null && <span style={{ color: "#16a34a" }}>+{formatCurrency(e.received)}</span>}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "16px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <h3 style={{ fontSize: "13.5px", fontWeight: 800, margin: 0, color: "#0f172a" }}>Financial summary</h3>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>{selected.label.split(" · ")[1] || ""}</span>
                </div>
                {fs.categories.length === 0 && <p style={{ fontSize: "12px", color: "#94a3b8" }}>No charges recorded.</p>}
                {fs.categories.map((c) => (
                  <div key={c.label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: "12.5px", color: "#475569" }}>
                    <span>{c.label}</span><span>{formatCurrency(c.amount)}</span>
                  </div>
                ))}
                <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "8px", paddingTop: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13.5px", fontWeight: 800, color: "#0f172a" }}>
                    <span>Total charges</span><span>{formatCurrency(fs.total_charges)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#16a34a", marginTop: "4px" }}>
                    <span>Payments received</span><span>{formatCurrency(fs.payments_received)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12.5px", marginTop: "4px" }}>
                    <span style={{ color: fs.outstanding > 0 ? "#dc2626" : "#64748b" }}>Outstanding</span>
                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <strong style={{ color: fs.outstanding > 0 ? "#dc2626" : "#0f172a" }}>{formatCurrency(fs.outstanding)}</strong>
                      {fs.status === "Settled" && <span style={{ fontSize: "10.5px", fontWeight: 700, background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: "9999px" }}>Settled</span>}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "16px 18px" }}>
                <h3 style={{ fontSize: "13.5px", fontWeight: 800, margin: "0 0 10px", color: "#0f172a" }}>Payments</h3>
                {journey.payments.length === 0 && <p style={{ fontSize: "12px", color: "#94a3b8" }}>No payments recorded.</p>}
                {journey.payments.map((p, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "6px 0", borderBottom: i < journey.payments.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                    <div>
                      <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#0f172a" }}>{p.date} · {p.time}</div>
                      <div style={{ fontSize: "11.5px", color: "#64748b" }}>{p.mode} · {p.reference}</div>
                    </div>
                    <strong style={{ fontSize: "13px", color: "#16a34a" }}>{formatCurrency(p.amount)}</strong>
                  </div>
                ))}
              </div>

              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "16px 18px" }}>
                <h3 style={{ fontSize: "13.5px", fontWeight: 800, margin: "0 0 10px", color: "#0f172a" }}>Documents</h3>
                {journey.documents.map((d) => (
                  <div key={d.type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                    <span style={{ fontSize: "12.5px", color: d.available ? "#0f172a" : "#94a3b8" }}>{d.label}</span>
                    {d.available ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (d.type === "lab_report" || d.type === "imaging_report") {
                            const evt = journey.events.find((e) => e.title.includes(d.type === "lab_report" ? "Laboratory report" : "Imaging report"));
                            if (evt?.report_id) void openReport(evt.report_id, d.label);
                          } else if (d.type === "pharmacy_slip") {
                            const evt = journey.events.find((e) => e.type === "pharmacy_issued" && e.items && e.items.length > 0);
                            setReportModal({ title: "Pharmacy issue slip", loading: false, content: { "Medicines": evt?.items?.map((it) => `${it.name} × ${it.quantity} = ${formatCurrency(it.amount)}`).join("; ") || "-" } });
                          } else if (d.type === "final_bill") {
                            setReportModal({ title: "Final bill", loading: false, content: { "Total charges": formatCurrency(fs.total_charges), "Payments received": formatCurrency(fs.payments_received), "Outstanding": formatCurrency(fs.outstanding) } });
                          } else if (d.type === "discharge_summary") {
                            const evt = journey.events.find((e) => e.type === "discharge");
                            setReportModal({ title: "Discharge summary", loading: false, content: { "Discharged": `${evt?.date || ""} ${evt?.time || ""}`, "Notes": evt?.subtitle || "-" } });
                          } else if (d.type === "prescription") {
                            const rx = journey.events.find((e) => e.type === "prescription")?.prescription;
                            setReportModal({ title: "Prescription", loading: false, content: rx ? {
                              "Reference": `RX-${rx.id}`,
                              "Medicines": rx.medicines.map((m) => [m.name, m.dosage, m.frequency, m.duration, m.instructions].filter(Boolean).join(" · ")).join("; ") || "-",
                              ...(rx.diagnosis ? { "Diagnosis": rx.diagnosis } : {}),
                              ...(rx.lab_tests ? { "Tests advised": rx.lab_tests } : {}),
                              ...(rx.advice ? { "Advice": rx.advice } : {}),
                              ...(rx.follow_up_date ? { "Follow-up": rx.follow_up_date } : {}),
                            } : { "Reference": `RX-${d.ref}` } });
                          }
                        }}
                        style={{ fontSize: "12px", fontWeight: 700, color: "#0891b2", background: "none", border: "none", cursor: "pointer" }}
                      >
                        View →
                      </button>
                    ) : (
                      <span style={{ fontSize: "11px", color: "#cbd5e1" }}>Not available</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {reportModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setReportModal(null)}>
          <div style={{ background: "#fff", borderRadius: "14px", padding: "22px 26px", minWidth: "380px", maxWidth: "560px", maxHeight: "70vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>{reportModal.title}</h3>
              <button type="button" onClick={() => setReportModal(null)} style={{ background: "none", border: "none", fontSize: "16px", cursor: "pointer", color: "#64748b" }}>✕</button>
            </div>
            {reportModal.loading ? (
              <p style={{ color: "#64748b", fontSize: "13px" }}>Loading…</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {Object.entries(reportModal.content || {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => (
                  <div key={k} style={{ fontSize: "13px" }}>
                    <span style={{ color: "#64748b", fontWeight: 600 }}>{k}: </span>
                    <span style={{ color: "#0f172a" }}>{String(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
