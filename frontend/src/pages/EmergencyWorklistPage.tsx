import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type Encounter = {
  id: number;
  patient_id: string;
  patient_first_name?: string;
  patient_last_name?: string;
  encounter_no?: string;
  arrival_at: string;
  chief_complaint?: string;
  triage_priority?: string;
  attendant_name?: string;
  attending_doctor?: string;
  disposition?: string | null;
};

const TRIAGE_LEVELS = [
  { value: "Red (Critical)", label: "Critical" },
  { value: "Yellow (Urgent)", label: "Urgent" },
  { value: "Green (Non-urgent)", label: "Non-urgent" },
];

// Filter keys for the KPI cards: a triage level, or every patient past their triage wait limit.
const OVERDUE_FILTER = "__overdue__";

// Patients still awaiting triage sort first so they get classified immediately.
const TRIAGE_RANK: Record<string, number> = {
  "": -1,
  "Red (Critical)": 0,
  "Yellow (Urgent)": 1,
  "Green (Non-urgent)": 2,
};

const TRIAGE_ACCENT: Record<string, string> = {
  "Red (Critical)": "hsl(var(--destructive))",
  "Yellow (Urgent)": "hsl(38 92% 50%)",
  "Green (Non-urgent)": "hsl(164 55% 40%)",
};

const TRIAGE_OVERDUE_MINS: Record<string, number> = {
  "Red (Critical)": 30,
  "Yellow (Urgent)": 120,
  "Green (Non-urgent)": 240,
};

function triageBadgeClass(triage?: string) {
  if (triage === "Red (Critical)") return "diag-badge-critical";
  if (triage === "Yellow (Urgent)") return "diag-badge-warning";
  if (triage === "Green (Non-urgent)") return "diag-badge-active";
  return "diag-badge-muted";
}

function minutesInEr(arrivalAt: string) {
  const start = new Date(arrivalAt).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.round((Date.now() - start) / 60000));
}

function formatDuration(mins: number) {
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function isWaitOverdue(triage: string | undefined, mins: number | null) {
  if (mins == null) return false;
  const threshold = TRIAGE_OVERDUE_MINS[triage || ""] ?? TRIAGE_OVERDUE_MINS["Green (Non-urgent)"];
  return mins > threshold;
}

function triageLabel(triage?: string) {
  return TRIAGE_LEVELS.find((t) => t.value === triage)?.label || "Triage pending";
}

export default function EmergencyWorklistPage({ setNotice, onNavigate }: Props) {
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Encounter | null>(null);
  const [dispositionAction, setDispositionAction] = useState<"discharged" | "admitted" | "referred" | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [triageFilter, setTriageFilter] = useState<string | null>(null);
  const [triageSaving, setTriageSaving] = useState(false);
  // Re-renders every minute so wait times and overdue flags stay current between reloads.
  const [, setTick] = useState(0);

  const load = async (background = false) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ encounters: Encounter[] }>("/api/encounters?encounter_type=EMERGENCY&active_only=true", { background: background === true });
      const next = res.encounters || [];
      setEncounters(next);
      // Keep the open patient in sync with fresh data; drop it once it leaves the active list.
      setSelected((prev) => (prev ? next.find((e) => e.id === prev.id) || null : prev));
    } catch (err: any) {
      reportError(setNotice, err, "Could not load the Emergency worklist.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = window.setInterval(() => void load(true), 30000);
    const clock = window.setInterval(() => setTick((n) => n + 1), 60000);
    return () => { window.clearInterval(t); window.clearInterval(clock); };
  }, []);

  // Highest priority first; within the same priority, whoever has waited longest first.
  const sorted = [...encounters].sort((a, b) => {
    const rank = (TRIAGE_RANK[a.triage_priority || ""] ?? 9) - (TRIAGE_RANK[b.triage_priority || ""] ?? 9);
    return rank || new Date(a.arrival_at).getTime() - new Date(b.arrival_at).getTime();
  });

  const filtered = !triageFilter
    ? sorted
    : triageFilter === OVERDUE_FILTER
      ? sorted.filter((e) => isWaitOverdue(e.triage_priority, minutesInEr(e.arrival_at)))
      : sorted.filter((e) => e.triage_priority === triageFilter);

  const counts = { red: 0, yellow: 0, green: 0, pending: 0, overdue: 0, longest: 0, total: encounters.length };
  for (const e of encounters) {
    if (e.triage_priority === "Red (Critical)") counts.red += 1;
    else if (e.triage_priority === "Yellow (Urgent)") counts.yellow += 1;
    else if (e.triage_priority === "Green (Non-urgent)") counts.green += 1;
    else counts.pending += 1;
    const mins = minutesInEr(e.arrival_at);
    if (mins != null && mins > counts.longest) counts.longest = mins;
    if (isWaitOverdue(e.triage_priority, mins)) counts.overdue += 1;
  }

  const toggleFilter = (key: string) => setTriageFilter((prev) => (prev === key ? null : key));

  const updateTriage = async (triage: string) => {
    if (!selected || selected.triage_priority === triage) return;
    setTriageSaving(true);
    try {
      await apiFetch(`/api/encounters/${selected.id}/triage`, { method: "POST", body: JSON.stringify({ triage_priority: triage }) });
      setNotice({ type: "success", message: `Triage set to ${triageLabel(triage)}.` });
      await load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not update triage.");
    } finally {
      setTriageSaving(false);
    }
  };

  const confirmDisposition = async () => {
    if (!selected || !dispositionAction) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ admission_id?: number }>(`/api/encounters/${selected.id}/disposition`, {
        method: "POST",
        body: JSON.stringify({ disposition: dispositionAction, notes: notes || undefined }),
      });
      setNotice({
        type: "success",
        message: dispositionAction === "admitted"
          ? `Patient admitted to IPD (admission #${res.admission_id}). Emergency history preserved.`
          : `Emergency encounter marked ${dispositionAction}.`,
      });
      setSelected(null);
      setDispositionAction(null);
      setNotes("");
      await load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record disposition.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="diag-page">
      <div className="diag-kpi-row">
        <div className={`diag-kpi-tile ${triageFilter === null ? "active" : ""}`} onClick={() => setTriageFilter(null)}>
          <span>Total active</span><strong>{counts.total}</strong>
          {counts.pending > 0 && <small className="diag-flag-critical_high">{counts.pending} awaiting triage</small>}
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Red (Critical)" ? "active" : ""}`} onClick={() => toggleFilter("Red (Critical)")}>
          <span>Critical</span><strong style={{ color: "hsl(var(--destructive))" }}>{counts.red}</strong>
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Yellow (Urgent)" ? "active" : ""}`} onClick={() => toggleFilter("Yellow (Urgent)")}>
          <span>Urgent</span><strong style={{ color: "hsl(30 80% 40%)" }}>{counts.yellow}</strong>
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Green (Non-urgent)" ? "active" : ""}`} onClick={() => toggleFilter("Green (Non-urgent)")}>
          <span>Non-urgent</span><strong style={{ color: "hsl(164 55% 30%)" }}>{counts.green}</strong>
        </div>
        <div
          className={`diag-kpi-tile ${triageFilter === OVERDUE_FILTER ? "active" : ""}`}
          onClick={() => toggleFilter(OVERDUE_FILTER)}
          title="Show patients waiting longer than their triage limit (Critical 30 min, Urgent 2 h, Non-urgent 4 h)"
        >
          <span>Longest wait</span>
          <strong className={counts.overdue > 0 ? "diag-flag-critical_high" : undefined}>{counts.total ? formatDuration(counts.longest) : "-"}</strong>
          <small className={counts.overdue > 0 ? "diag-flag-critical_high" : "muted"}>{counts.overdue} overdue</small>
        </div>
      </div>

      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Active Emergency patients ({filtered.length})</h3></div>
          {loading && <p className="muted">Loading...</p>}
          {!loading && filtered.length === 0 && (
            <p className="muted">
              {encounters.length === 0 ? "No active Emergency patients." : triageFilter === OVERDUE_FILTER ? "No patients are past their triage wait limit." : "No patients match this filter."}
            </p>
          )}
          {filtered.map((e) => {
            const mins = minutesInEr(e.arrival_at);
            const overdue = isWaitOverdue(e.triage_priority, mins);
            return (
              <div
                key={e.id}
                className={`diag-worklist-row ${selected?.id === e.id ? "active" : ""}`}
                style={{ borderLeft: `4px solid ${TRIAGE_ACCENT[e.triage_priority || ""] || "hsl(var(--border))"}` }}
                onClick={() => { setSelected(e); setDispositionAction(null); setNotes(""); }}
              >
                <div className="diag-worklist-row-top">
                  <span>{[e.patient_first_name, e.patient_last_name].filter(Boolean).join(" ") || e.patient_id}</span>
                  <span className={`diag-badge ${triageBadgeClass(e.triage_priority)}`}>{triageLabel(e.triage_priority)}</span>
                </div>
                <div className="diag-worklist-row-meta">
                  <span>{e.chief_complaint || "No chief complaint recorded"}</span>
                  <span>{e.encounter_no}</span>
                  <span className={overdue ? "diag-flag-critical_high" : undefined}>
                    In ER: {mins != null ? formatDuration(mins) : "-"}{overdue ? " (overdue)" : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="diag-card">
          {!selected && <p className="muted">Select a patient from the worklist to review details and record a disposition.</p>}
          {selected && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{[selected.patient_first_name, selected.patient_last_name].filter(Boolean).join(" ") || selected.patient_id}</h3>
                  <div className="diag-detail-meta">
                    <span>UHID: {selected.patient_id}</span>
                    <span>{selected.encounter_no}</span>
                    <span>Arrived: {new Date(selected.arrival_at).toLocaleString()}</span>
                    <span>Attendant: {selected.attendant_name || "-"}</span>
                    <span>Doctor: {selected.attending_doctor || "-"}</span>
                  </div>
                </div>
                <span className={`diag-badge ${triageBadgeClass(selected.triage_priority)}`}>{triageLabel(selected.triage_priority)}</span>
              </div>

              <div className="diag-section-title">Triage priority</div>
              {!selected.triage_priority && <div className="diag-note-box diag-note-critical">This patient has not been triaged yet. Set a priority now.</div>}
              <div className="diag-form-actions">
                {TRIAGE_LEVELS.map((t) => (
                  <Button
                    key={t.value}
                    size="sm"
                    variant={selected.triage_priority === t.value ? "primary" : "secondary"}
                    disabled={triageSaving}
                    onClick={() => void updateTriage(t.value)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>

              <div className="diag-section-title">Chief complaint</div>
              <div className="diag-note-box">{selected.chief_complaint || "Not recorded"}</div>

              <div className="diag-section-title">Disposition</div>
              <div className="diag-form-actions">
                <Button variant="secondary" onClick={() => setDispositionAction("discharged")}>Discharge</Button>
                <Button variant="primary" onClick={() => setDispositionAction("admitted")}>Admit to IPD</Button>
                <Button variant="ghost" onClick={() => setDispositionAction("referred")}>Refer / Transfer</Button>
                {onNavigate && <Button variant="ghost" onClick={() => onNavigate("diag-orders-billing")}>Lab / Imaging orders</Button>}
                {onNavigate && <Button variant="ghost" onClick={() => onNavigate("pharmacy-ip-dispense")}>Pharmacy</Button>}
              </div>

              {dispositionAction && (
                <div className="diag-form-grid" style={{ marginTop: "1rem" }}>
                  <div className="diag-form-full">
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={`Notes for ${dispositionAction}...`} />
                  </div>
                  <div className="diag-form-full">
                    <Button variant="primary" disabled={busy} onClick={() => void confirmDisposition()}>Confirm {dispositionAction}</Button>
                    <Button variant="ghost" onClick={() => setDispositionAction(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
