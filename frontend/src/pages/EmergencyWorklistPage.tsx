import { useEffect, useMemo, useState } from "react";
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

const TRIAGE_RANK: Record<string, number> = {
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

export default function EmergencyWorklistPage({ setNotice, onNavigate }: Props) {
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Encounter | null>(null);
  const [dispositionAction, setDispositionAction] = useState<"discharged" | "admitted" | "referred" | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [triageFilter, setTriageFilter] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ encounters: Encounter[] }>("/api/encounters?encounter_type=EMERGENCY&active_only=true");
      setEncounters(res.encounters || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load the Emergency worklist.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(t);
  }, []);

  const sorted = useMemo(
    () => [...encounters].sort((a, b) => (TRIAGE_RANK[a.triage_priority || ""] ?? 9) - (TRIAGE_RANK[b.triage_priority || ""] ?? 9)),
    [encounters]
  );

  const filtered = useMemo(
    () => (triageFilter ? sorted.filter((e) => (e.triage_priority || "Unclassified") === triageFilter) : sorted),
    [sorted, triageFilter]
  );

  const counts = useMemo(() => {
    const c = { red: 0, yellow: 0, green: 0, unclassified: 0, overdue: 0 };
    let longest = 0;
    for (const e of encounters) {
      if (e.triage_priority === "Red (Critical)") c.red += 1;
      else if (e.triage_priority === "Yellow (Urgent)") c.yellow += 1;
      else if (e.triage_priority === "Green (Non-urgent)") c.green += 1;
      else c.unclassified += 1;
      const mins = minutesInEr(e.arrival_at);
      if (mins != null && mins > longest) longest = mins;
      if (isWaitOverdue(e.triage_priority, mins)) c.overdue += 1;
    }
    return { ...c, total: encounters.length, longest };
  }, [encounters]);

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
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Red (Critical)" ? "active" : ""}`} onClick={() => setTriageFilter(triageFilter === "Red (Critical)" ? null : "Red (Critical)")}>
          <span>Critical</span><strong style={{ color: "hsl(var(--destructive))" }}>{counts.red}</strong>
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Yellow (Urgent)" ? "active" : ""}`} onClick={() => setTriageFilter(triageFilter === "Yellow (Urgent)" ? null : "Yellow (Urgent)")}>
          <span>Urgent</span><strong style={{ color: "hsl(30 80% 40%)" }}>{counts.yellow}</strong>
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Green (Non-urgent)" ? "active" : ""}`} onClick={() => setTriageFilter(triageFilter === "Green (Non-urgent)" ? null : "Green (Non-urgent)")}>
          <span>Non-urgent</span><strong>{counts.green}</strong>
        </div>
        <div className={`diag-kpi-tile ${triageFilter === "Unclassified" ? "active" : ""}`} onClick={() => setTriageFilter(triageFilter === "Unclassified" ? null : "Unclassified")}>
          <span>Unclassified</span><strong>{counts.unclassified}</strong>
        </div>
        <div className="diag-kpi-tile" style={{ cursor: "default" }}>
          <span>Longest wait</span><strong className={counts.overdue > 0 ? "diag-flag-critical_high" : undefined}>{counts.total ? formatDuration(counts.longest) : "-"}</strong>
        </div>
      </div>

      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Active Emergency patients ({filtered.length})</h3></div>
          {loading && <p className="muted">Loading...</p>}
          {!loading && filtered.length === 0 && <p className="muted">{encounters.length === 0 ? "No active Emergency patients." : "No patients match this filter."}</p>}
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
                  <span className={`diag-badge ${triageBadgeClass(e.triage_priority)}`}>{e.triage_priority || "Unclassified"}</span>
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
                <span className={`diag-badge ${triageBadgeClass(selected.triage_priority)}`}>{selected.triage_priority || "Unclassified"}</span>
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
