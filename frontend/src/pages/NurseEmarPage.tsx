import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { filterInteger, filterDecimal } from "../lib/format";
import type { Notice } from "../types";

/** BP is entered as "120/80" -- digits and a single separating slash only. */
const filterBP = (val: string): string => {
  let v = val.replace(/[^0-9/]/g, "");
  const parts = v.split("/");
  if (parts.length > 2) v = parts[0] + "/" + parts.slice(1).join("");
  return v;
};

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

type Inpatient = {
  admission_id: number;
  patient_id: string;
  patient_name: string;
  ip_number?: string;
  ward: string;
  bed_no: string;
};

type EmarRow = {
  id: number;
  indent_item_id?: number;
  medicine_name: string;
  dose?: string;
  route?: string;
  scheduled_time: string;
  status: "pending" | "given" | "held" | "refused" | "missed" | "discontinued" | "returned";
  administered_by?: string;
  administered_at?: string;
  notes?: string;
};

type VitalRow = {
  id: number;
  bp?: string;
  pulse?: number;
  temperature?: number;
  respiratory_rate?: number;
  spo2?: number;
  blood_sugar?: number;
  pain_score?: number;
  recorded_by?: string;
  recorded_at?: string;
};

type CareLogRow = {
  id: number;
  nurse_name?: string;
  log_date?: string;
  log_time?: string;
  activity?: string;
  remarks?: string;
  created_at?: string;
};

const EMPTY_VITALS_FORM = { bp: "", pulse: "", temperature: "", respiratory_rate: "", spo2: "", blood_sugar: "", pain_score: "" };
const EMPTY_NOTE_FORM = { nurse_name: "", activity: "", remarks: "" };

const STATUS_OPTIONS = [
  { key: "pending", label: "Due / Scheduled" },
  { key: "given", label: "Administered" },
  { key: "held", label: "Held" },
  { key: "refused", label: "Refused" },
  { key: "missed", label: "Missed" },
  { key: "discontinued", label: "Discontinued" },
  { key: "returned", label: "Returned" },
  { key: "", label: "All" },
];

function badgeClass(status: string) {
  if (status === "given") return "diag-badge-active";
  if (status === "pending") return "diag-badge-info";
  if (status === "held" || status === "missed") return "diag-badge-warning";
  if (status === "refused" || status === "discontinued") return "diag-badge-critical";
  return "diag-badge-muted";
}

function formatTime(value?: string) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export default function NurseEmarPage({ setNotice }: Props) {
  const [inpatients, setInpatients] = useState<Inpatient[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Inpatient | null>(null);
  const [rows, setRows] = useState<EmarRow[]>([]);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [discontinueTarget, setDiscontinueTarget] = useState<EmarRow | null>(null);
  const [discontinueReason, setDiscontinueReason] = useState("");

  const [detailTab, setDetailTab] = useState<"emar" | "vitals" | "notes">("emar");
  const [vitals, setVitals] = useState<VitalRow[]>([]);
  const [vitalsForm, setVitalsForm] = useState(EMPTY_VITALS_FORM);
  const [savingVitals, setSavingVitals] = useState(false);
  const [careLogs, setCareLogs] = useState<CareLogRow[]>([]);
  const [noteForm, setNoteForm] = useState(EMPTY_NOTE_FORM);
  const [savingNote, setSavingNote] = useState(false);
  const [viewingNote, setViewingNote] = useState<CareLogRow | null>(null);

  const loadInpatients = async () => {
    try {
      const res = await apiFetch<{ occupied?: any[] }>("/api/bed/occupancy");
      const mapped = (res.occupied || []).map((a: any) => ({
        admission_id: a.admission_id,
        patient_id: a.patient_id,
        patient_name: a.patient_name || "Inpatient",
        ip_number: `IP-${a.admission_id}`,
        ward: a.ward || "General",
        bed_no: a.bed_no || "-",
      }));
      setInpatients(mapped);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load admitted patients.");
    }
  };

  useEffect(() => { void loadInpatients(); }, []);

  const loadEmar = async (patient: Inpatient, statusFilter: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ admission_id: String(patient.admission_id) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await apiFetch<{ emar: EmarRow[] }>(`/api/patients/${patient.patient_id}/emar?${params}`);
      setRows(res.emar || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load the medication schedule.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (selected) void loadEmar(selected, status); }, [selected, status]);

  const loadVitals = async (patient: Inpatient) => {
    try {
      const res = await apiFetch<{ vitals: VitalRow[] }>(`/api/patients/${patient.patient_id}/vitals?admission_id=${patient.admission_id}`);
      setVitals(res.vitals || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load vitals history.");
    }
  };

  const loadCareLogs = async (patient: Inpatient) => {
    try {
      const res = await apiFetch<{ logs: CareLogRow[] }>(`/api/nursing/care-logs?admission_id=${patient.admission_id}`);
      setCareLogs(res.logs || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load shift notes.");
    }
  };

  useEffect(() => {
    if (!selected) return;
    setVitalsForm(EMPTY_VITALS_FORM);
    setNoteForm(EMPTY_NOTE_FORM);
    void loadVitals(selected);
    void loadCareLogs(selected);
  }, [selected]);

  const submitVitals = async () => {
    if (!selected) return;
    const hasAnyValue = Object.values(vitalsForm).some((v) => v.trim() !== "");
    if (!hasAnyValue) { setNotice({ type: "warning", message: "Enter at least one vital sign." }); return; }
    setSavingVitals(true);
    try {
      await apiFetch(`/api/patients/${selected.patient_id}/vitals`, {
        method: "POST",
        body: JSON.stringify({ ...vitalsForm, admission_id: selected.admission_id }),
      });
      setNotice({ type: "success", message: "Vitals recorded." });
      setVitalsForm(EMPTY_VITALS_FORM);
      await loadVitals(selected);
    } catch (err: any) {
      reportError(setNotice, err, "Could not record vitals.");
    } finally {
      setSavingVitals(false);
    }
  };

  const submitNote = async () => {
    if (!selected) return;
    if (!noteForm.activity.trim()) { setNotice({ type: "warning", message: "Describe the activity/observation." }); return; }
    setSavingNote(true);
    try {
      await apiFetch("/api/nursing/care-logs", {
        method: "POST",
        body: JSON.stringify({ ...noteForm, patient_id: selected.patient_id, admission_id: selected.admission_id }),
      });
      setNotice({ type: "success", message: "Shift note saved." });
      setNoteForm(EMPTY_NOTE_FORM);
      await loadCareLogs(selected);
    } catch (err: any) {
      reportError(setNotice, err, "Could not save the shift note.");
    } finally {
      setSavingNote(false);
    }
  };

  const filteredInpatients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inpatients;
    return inpatients.filter((p) =>
      p.patient_name.toLowerCase().includes(q) ||
      p.patient_id.toLowerCase().includes(q) ||
      (p.ip_number || "").toLowerCase().includes(q) ||
      (p.ward || "").toLowerCase().includes(q) ||
      (p.bed_no || "").toLowerCase().includes(q)
    );
  }, [inpatients, search]);

  const act = async (row: EmarRow, action: "given" | "held" | "refused" | "missed") => {
    setBusyId(row.id);
    try {
      if (action === "given") {
        await apiFetch(`/api/emar/${row.id}/administer`, { method: "POST", body: JSON.stringify({}) });
      } else {
        await apiFetch(`/api/emar/${row.id}/status`, { method: "POST", body: JSON.stringify({ status: action }) });
      }
      setNotice({ type: "success", message: `${row.medicine_name} marked ${action}.` });
      if (selected) await loadEmar(selected, status);
    } catch (err: any) {
      reportError(setNotice, err, "Could not update this dose.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDiscontinue = async () => {
    if (!discontinueTarget || !discontinueTarget.indent_item_id) return;
    if (!discontinueReason.trim()) { setNotice({ type: "warning", message: "A reason is required." }); return; }
    setBusyId(discontinueTarget.id);
    try {
      const res = await apiFetch<{ discontinued_count: number }>(
        `/api/emar/indent-items/${discontinueTarget.indent_item_id}/discontinue`,
        { method: "POST", body: JSON.stringify({ reason: discontinueReason }) }
      );
      setNotice({ type: "success", message: `${res.discontinued_count} upcoming dose(s) of ${discontinueTarget.medicine_name} discontinued.` });
      setDiscontinueTarget(null);
      setDiscontinueReason("");
      if (selected) await loadEmar(selected, status);
    } catch (err: any) {
      reportError(setNotice, err, "Could not discontinue this medication.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="diag-page">
      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Admitted patients</h3></div>
          <Input placeholder="Search patient, UHID, ward or bed" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div style={{ marginTop: "0.75rem" }}>
            {filteredInpatients.length === 0 && <p className="muted">No admitted patients found.</p>}
            {filteredInpatients.map((p) => (
              <div key={p.admission_id} className={`diag-worklist-row ${selected?.admission_id === p.admission_id ? "active" : ""}`} onClick={() => setSelected(p)}>
                <div className="diag-worklist-row-top"><span>{p.patient_name}</span></div>
                <div className="diag-worklist-row-meta"><span>{p.ward} / Bed {p.bed_no}</span><span>{p.ip_number}</span></div>
              </div>
            ))}
          </div>
        </div>

        <div className="diag-card">
          {!selected && <p className="muted">Select an admitted patient to view their medication schedule (eMAR).</p>}
          {selected && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{selected.patient_name}</h3>
                  <div className="diag-detail-meta">
                    <span>UHID: {selected.patient_id}</span>
                    <span>{selected.ward} / Bed {selected.bed_no}</span>
                  </div>
                </div>
              </div>

              <div className="diag-form-actions" style={{ marginBottom: "0.75rem" }}>
                <Button size="sm" variant={detailTab === "emar" ? "primary" : "secondary"} onClick={() => setDetailTab("emar")}>Medication (eMAR)</Button>
                <Button size="sm" variant={detailTab === "vitals" ? "primary" : "secondary"} onClick={() => setDetailTab("vitals")}>Vitals</Button>
                <Button size="sm" variant={detailTab === "notes" ? "primary" : "secondary"} onClick={() => setDetailTab("notes")}>Shift Notes</Button>
              </div>

              {detailTab === "vitals" && (
                <>
                  <div className="diag-form-grid">
                    <div><Label>BP</Label><Input value={vitalsForm.bp} inputMode="numeric" onChange={(e) => setVitalsForm({ ...vitalsForm, bp: filterBP(e.target.value) })} placeholder="120/80" /></div>
                    <div><Label>Pulse</Label><Input value={vitalsForm.pulse} inputMode="numeric" onChange={(e) => setVitalsForm({ ...vitalsForm, pulse: filterInteger(e.target.value) })} placeholder="bpm" /></div>
                    <div><Label>Temp (F)</Label><Input value={vitalsForm.temperature} inputMode="decimal" onChange={(e) => setVitalsForm({ ...vitalsForm, temperature: filterDecimal(e.target.value) })} placeholder="98.6" /></div>
                    <div><Label>SpO2 (%)</Label><Input value={vitalsForm.spo2} inputMode="decimal" onChange={(e) => setVitalsForm({ ...vitalsForm, spo2: filterDecimal(e.target.value) })} placeholder="98" /></div>
                    <div><Label>Resp. Rate</Label><Input value={vitalsForm.respiratory_rate} inputMode="numeric" onChange={(e) => setVitalsForm({ ...vitalsForm, respiratory_rate: filterInteger(e.target.value) })} placeholder="/min" /></div>
                    <div><Label>Blood Glucose</Label><Input value={vitalsForm.blood_sugar} inputMode="decimal" onChange={(e) => setVitalsForm({ ...vitalsForm, blood_sugar: filterDecimal(e.target.value) })} placeholder="mg/dL" /></div>
                    <div><Label>Pain (0-10)</Label><Input value={vitalsForm.pain_score} inputMode="numeric" onChange={(e) => { const v = filterInteger(e.target.value); setVitalsForm({ ...vitalsForm, pain_score: v && Number(v) > 10 ? "10" : v }); }} placeholder="0-10" /></div>
                    <div className="diag-form-full"><Button variant="primary" disabled={savingVitals} onClick={() => void submitVitals()}>Record vitals</Button></div>
                  </div>
                  <div className="diag-section-title" style={{ marginTop: "1rem" }}>History</div>
                  {vitals.length === 0 && <p className="muted">No vitals recorded yet.</p>}
                  {vitals.map((v) => (
                    <div key={v.id} className="diag-worklist-row">
                      <div className="diag-worklist-row-top"><span>{formatTime(v.recorded_at)}</span><span>{v.recorded_by || "-"}</span></div>
                      <div className="diag-worklist-row-meta">
                        <span>BP {v.bp || "-"}</span><span>Pulse {v.pulse ?? "-"}</span><span>Temp {v.temperature ?? "-"}</span>
                        <span>SpO2 {v.spo2 ?? "-"}</span><span>RR {v.respiratory_rate ?? "-"}</span><span>Pain {v.pain_score ?? "-"}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {detailTab === "notes" && (
                <>
                  <div className="diag-form-grid">
                    <div><Label>Nurse</Label><Input value={noteForm.nurse_name} onChange={(e) => setNoteForm({ ...noteForm, nurse_name: e.target.value })} placeholder="Nurse name" /></div>
                    <div className="diag-form-full"><Label>Activity</Label><Input value={noteForm.activity} onChange={(e) => setNoteForm({ ...noteForm, activity: e.target.value })} placeholder="e.g. IV line check, wound dressing" /></div>
                    <div className="diag-form-full"><Label>Remarks</Label><Textarea value={noteForm.remarks} onChange={(e) => setNoteForm({ ...noteForm, remarks: e.target.value })} placeholder="Shift note / observation" /></div>
                    <div className="diag-form-full"><Button variant="primary" disabled={savingNote} onClick={() => void submitNote()}>Save shift note</Button></div>
                  </div>
                  <div className="diag-section-title" style={{ marginTop: "1rem" }}>History</div>
                  {careLogs.length === 0 && <p className="muted">No shift notes recorded yet.</p>}
                  {careLogs.map((n) => (
                    <div key={n.id} className="diag-worklist-row">
                      <div className="diag-worklist-row-top">
                        <span>{n.activity}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {n.nurse_name || "-"}
                          <Button size="sm" variant="ghost" onClick={() => setViewingNote(n)}>View</Button>
                        </span>
                      </div>
                      <div className="diag-worklist-row-meta"><span>{n.log_date} {n.log_time}</span><span>{n.remarks}</span></div>
                    </div>
                  ))}
                </>
              )}

              {viewingNote && (
                <Modal open={!!viewingNote} onClose={() => setViewingNote(null)} title="Shift Note">
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "320px", fontSize: "13.5px" }}>
                    <div><strong>Date / Time:</strong> {viewingNote.log_date} {viewingNote.log_time}</div>
                    <div><strong>Nurse:</strong> {viewingNote.nurse_name || "-"}</div>
                    <div><strong>Activity:</strong> {viewingNote.activity || "-"}</div>
                    <div>
                      <strong>Remarks:</strong>
                      <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", color: "#334155" }}>{viewingNote.remarks || "-"}</p>
                    </div>
                  </div>
                </Modal>
              )}

              {detailTab === "emar" && (
              <>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map((s) => <option key={s.key || "all"} value={s.key}>{s.label}</option>)}
              </Select>

              <div style={{ marginTop: "0.75rem" }}>
                {loading && <p className="muted">Loading...</p>}
                {!loading && rows.length === 0 && <p className="muted">No doses in this state.</p>}
                {rows.map((r) => (
                  <div key={r.id} className="diag-worklist-row">
                    <div className="diag-worklist-row-top">
                      <span>{r.medicine_name} {r.dose ? `- ${r.dose}` : ""} {r.route ? `(${r.route})` : ""}</span>
                      <span className={`diag-badge ${badgeClass(r.status)}`}>{r.status}</span>
                    </div>
                    <div className="diag-worklist-row-meta">
                      <span>Scheduled: {formatTime(r.scheduled_time)}</span>
                      {r.status === "pending" ? null : (
                        <span>{r.administered_at ? `At ${formatTime(r.administered_at)} by ${r.administered_by || "-"}` : (r.notes || "")}</span>
                      )}
                    </div>
                    {r.status === "pending" && (
                      <div className="diag-form-actions" style={{ marginTop: "0.5rem" }}>
                        <Button size="sm" variant="primary" disabled={busyId === r.id} onClick={() => void act(r, "given")}>Administer</Button>
                        <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => void act(r, "held")}>Hold</Button>
                        <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => void act(r, "refused")}>Refused</Button>
                        <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => void act(r, "missed")}>Missed</Button>
                        {r.indent_item_id && (
                          <Button size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => { setDiscontinueTarget(r); setDiscontinueReason(""); }}>
                            Discontinue remaining doses
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {discontinueTarget && (
                <div className="diag-form-grid" style={{ marginTop: "1rem" }}>
                  <div className="diag-form-full">
                    <Label>Discontinue {discontinueTarget.medicine_name} - reason</Label>
                    <Textarea value={discontinueReason} onChange={(e) => setDiscontinueReason(e.target.value)} placeholder="e.g. Doctor discontinued on rounds" />
                  </div>
                  <div className="diag-form-full">
                    <Button variant="destructive" disabled={busyId === discontinueTarget.id} onClick={() => void confirmDiscontinue()}>Confirm discontinue</Button>
                    <Button variant="ghost" onClick={() => setDiscontinueTarget(null)}>Cancel</Button>
                  </div>
                </div>
              )}
              </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
