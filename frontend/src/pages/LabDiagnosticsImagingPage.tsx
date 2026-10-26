import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Checkbox, Input, Label, Tabs, TabsTrigger } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { openReportForItem } from "../lib/diagReports";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type ImagingWorklistRow = {
  id: number;
  order_id: number;
  service_id: number;
  service_name: string;
  order_no: string;
  patient_id: string;
  encounter_type: string;
  priority: string;
  patient_first_name?: string;
  patient_last_name?: string;
  exam_id: number;
  modality?: string;
  room?: string;
  scheduled_at?: string;
  expected_duration_min?: number;
  exam_status: string;
  assigned_staff?: string;
  prep_instructions?: string;
  image_available?: boolean;
  tat_status?: "on_time" | "near_due" | "overdue" | null;
  elapsed_hours?: number;
  tat_target_hours?: number;
};

type ImagingItemDetail = {
  id: number;
  service_name: string;
  order_no: string;
  patient_id: string;
  clinical_indication?: string;
  referring_clinician?: string;
  patient?: { name: string; last_name: string; age?: number; gender?: string };
  exam: {
    id: number;
    modality?: string;
    room?: string;
    scheduled_at?: string;
    expected_duration_min?: number;
    status: string;
    assigned_staff?: string;
    prep_instructions?: string;
    consent_recorded?: boolean;
    image_available?: boolean;
  };
};

type ScheduleForm = {
  room: string;
  scheduled_at: string;
  expected_duration_min: number;
  assigned_staff: string;
  modality: string;
};

const STAGES: { key: string; label: string }[] = [
  { key: "to_schedule", label: "To schedule" },
  { key: "scheduled", label: "Scheduled" },
  { key: "in_progress", label: "In progress" },
  { key: "for_reporting", label: "For reporting" },
];

const EMPTY_SCHEDULE_FORM: ScheduleForm = { room: "", scheduled_at: "", expected_duration_min: 30, assigned_staff: "", modality: "" };

/** Joins first/last name parts, falling back to the given identifier when no name is available. */
function formatPatientName(first?: string, last?: string, fallback?: string): string {
  return [first, last].filter(Boolean).join(" ").trim() || fallback || "";
}

export default function LabDiagnosticsImagingPage({ setNotice, onNavigate }: Props) {
  const [rows, setRows] = useState<ImagingWorklistRow[]>([]);
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("to_schedule");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ImagingWorklistRow | null>(null);
  const [detail, setDetail] = useState<ImagingItemDetail | null>(null);
  const [saving, setSaving] = useState(false);

  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(EMPTY_SCHEDULE_FORM);
  const [consentRecorded, setConsentRecorded] = useState(false);
  const [performingStaff, setPerformingStaff] = useState("");
  const [imageAvailable, setImageAvailable] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ stage, ...(search.trim() ? { q: search.trim() } : {}) });
      const data = await apiFetch<{ items: ImagingWorklistRow[] }>(`/api/diag/imaging/worklist?${params}`);
      setRows(data.items || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load imaging worklist.");
    } finally {
      setLoading(false);
    }
  };

  const loadStageCounts = async () => {
    try {
      const results = await Promise.all(
        STAGES.map((s) => apiFetch<{ items: ImagingWorklistRow[] }>(`/api/diag/imaging/worklist?stage=${s.key}`))
      );
      const next: Record<string, number> = {};
      STAGES.forEach((s, idx) => { next[s.key] = (results[idx].items || []).length; });
      setStageCounts(next);
    } catch {
      /* supplementary counts only -- ignore failures */
    }
  };

  useEffect(() => { void load(); void loadStageCounts(); }, [stage]);
  useEffect(() => { const t = window.setTimeout(() => void load(), 300); return () => window.clearTimeout(t); }, [search]);

  const openItem = async (row: ImagingWorklistRow) => {
    setSelected(row);
    try {
      const d = await apiFetch<ImagingItemDetail>(`/api/diag/imaging/items/${row.id}`);
      setDetail(d);
      setScheduleForm({
        room: d.exam.room || "",
        scheduled_at: d.exam.scheduled_at ? d.exam.scheduled_at.slice(0, 16) : "",
        expected_duration_min: d.exam.expected_duration_min || 30,
        assigned_staff: d.exam.assigned_staff || "",
        modality: d.exam.modality || "",
      });
      setConsentRecorded(!!d.exam.consent_recorded);
      setPerformingStaff(d.exam.assigned_staff || "");
      setImageAvailable(true);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load exam details.");
    }
  };

  const refreshAfterMutation = async () => {
    if (selected) await openItem(selected);
    void load();
    void loadStageCounts();
  };

  const postExamAction = (examId: number, action: string, body: unknown) =>
    apiFetch(`/api/diag/imaging/exams/${examId}/${action}`, { method: "POST", body: JSON.stringify(body) });

  const doSchedule = async () => {
    if (!detail) return;
    if (!scheduleForm.room.trim() || !scheduleForm.scheduled_at) {
      setNotice({ type: "warning", message: "Room and date/time are required to schedule." });
      return;
    }
    setSaving(true);
    try {
      await postExamAction(detail.exam.id, "schedule", scheduleForm);
      setNotice({ type: "success", message: "Examination scheduled." });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not schedule -- check for a room conflict.");
    } finally {
      setSaving(false);
    }
  };

  const doCancel = async (reasonPrompt: string) => {
    if (!detail) return;
    const reason = window.prompt(reasonPrompt);
    if (!reason) return;
    try {
      await postExamAction(detail.exam.id, "cancel", { reason });
      setNotice({ type: "success", message: "Examination updated." });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not update the examination.");
    }
  };

  const advanceStatus = async (status: string, extra: Record<string, unknown> = {}) => {
    if (!detail) return;
    setSaving(true);
    try {
      await postExamAction(detail.exam.id, "status", { status, ...extra });
      setNotice({ type: "success", message: `Marked ${status.replace("_", " ")}.` });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not update status.");
    } finally {
      setSaving(false);
    }
  };

  const updateScheduleForm = (patch: Partial<ScheduleForm>) => setScheduleForm((prev) => ({ ...prev, ...patch }));

  // Completing the exam creates the report draft on the server; this opens it.
  const goToReport = () => {
    if (!onNavigate || !detail) return;
    void openReportForItem(detail.id, "IMAGING", onNavigate);
  };

  return (
    <div className="diag-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <Tabs>
          {STAGES.map((s) => (
            <TabsTrigger
              key={s.key}
              active={stage === s.key}
              onClick={() => setStage(s.key)}
            >
              {s.label} {stageCounts[s.key] !== undefined ? `(${stageCounts[s.key]})` : ""}
            </TabsTrigger>
          ))}
        </Tabs>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {onNavigate && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onNavigate("diag-orders-billing")}
            >
              + New Order / Billing
            </Button>
          )}
          {onNavigate && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate("diag-reports-approval")}
            >
              Reports &amp; Approval →
            </Button>
          )}
        </div>
      </div>

      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Imaging worklist</h3></div>
          <Input placeholder="Search patient or accession" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div style={{ marginTop: "0.75rem" }}>
            {loading && <p className="muted">Loading...</p>}
            {!loading && rows.length === 0 && <p className="muted">Nothing in this stage.</p>}
            {rows.map((r) => (
              <div key={r.id} className={`diag-worklist-row ${selected?.id === r.id ? "active" : ""}`} onClick={() => void openItem(r)}>
                <div className="diag-worklist-row-top">
                  <span>{formatPatientName(r.patient_first_name, r.patient_last_name, r.patient_id)}</span>
                  {r.priority !== "Routine" && <span className="diag-badge diag-badge-critical">{r.priority}</span>}
                  {r.tat_status === "overdue" && <span className="diag-badge diag-badge-critical">Overdue</span>}
                  {r.tat_status === "near_due" && <span className="diag-badge diag-badge-warning">Near TAT</span>}
                </div>
                <div className="diag-worklist-row-meta">
                  <span>{r.service_name}</span>
                  {r.scheduled_at && <span>{new Date(r.scheduled_at).toLocaleString()}</span>}
                  {r.room && <span>{r.room}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="diag-card">
          {!detail && <p className="muted">Select an examination.</p>}
          {detail && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{detail.service_name}</h3>
                  <div className="diag-detail-meta">
                    <span>{formatPatientName(detail.patient?.name, detail.patient?.last_name, detail.patient_id)}</span>
                    <span>UHID: {detail.patient_id}</span>
                    <span>Order: {detail.order_no}</span>
                    <span>Status: {detail.exam.status.replace("_", " ")}</span>
                  </div>
                </div>
              </div>

              {detail.exam.status === "scheduled" && (
                <div>
                  <div className="diag-section-title">Scheduling</div>
                  <div className="diag-form-grid">
                    <div>
                      <Label>Modality</Label>
                      <Input value={scheduleForm.modality} onChange={(e) => updateScheduleForm({ modality: e.target.value })} />
                    </div>
                    <div>
                      <Label>Room / equipment</Label>
                      <Input value={scheduleForm.room} onChange={(e) => updateScheduleForm({ room: e.target.value })} />
                    </div>
                    <div>
                      <Label>Date & time</Label>
                      <Input
                        type="datetime-local"
                        value={scheduleForm.scheduled_at}
                        onChange={(e) => updateScheduleForm({ scheduled_at: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Duration (min)</Label>
                      <Input
                        type="number"
                        value={scheduleForm.expected_duration_min}
                        onChange={(e) => updateScheduleForm({ expected_duration_min: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <Label>Assigned staff</Label>
                      <Input value={scheduleForm.assigned_staff} onChange={(e) => updateScheduleForm({ assigned_staff: e.target.value })} />
                    </div>
                    <div className="diag-form-full">
                      <Button variant="primary" disabled={saving} onClick={() => void doSchedule()}>
                        {detail.exam.scheduled_at ? "Reschedule" : "Schedule"}
                      </Button>{" "}
                      <Button variant="ghost" onClick={() => void doCancel("Reason for cancellation / no-show:")}>Cancel / no-show</Button>{" "}
                      {detail.exam.scheduled_at && (
                        <Button variant="secondary" disabled={saving} onClick={() => void advanceStatus("arrived")}>Mark arrived</Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {detail.exam.status === "arrived" && (
                <div>
                  <div className="diag-section-title">Preparation & safety review</div>
                  {detail.exam.prep_instructions && <div className="diag-note-box">Preparation: {detail.exam.prep_instructions}</div>}
                  <div className="diag-checkbox-field">
                    <label>
                      <Checkbox checked={consentRecorded} onChange={(e) => setConsentRecorded(e.target.checked)} /> Consent / screening recorded
                    </label>
                  </div>
                  <Button variant="primary" onClick={() => void advanceStatus("prep", { consent_recorded: consentRecorded })}>
                    Complete preparation
                  </Button>
                </div>
              )}

              {detail.exam.status === "prep" && (
                <div>
                  <div className="diag-section-title">Start examination</div>
                  <Label>Performing staff</Label>
                  <Input value={performingStaff} onChange={(e) => setPerformingStaff(e.target.value)} placeholder="Technologist name" />
                  <div className="diag-form-actions">
                    <Button variant="primary" onClick={() => void advanceStatus("in_progress", { performing_staff: performingStaff })}>
                      Start examination
                    </Button>
                  </div>
                </div>
              )}

              {detail.exam.status === "in_progress" && (
                <div>
                  <div className="diag-section-title">Complete examination</div>
                  <div className="diag-checkbox-field">
                    <label>
                      <Checkbox checked={imageAvailable} onChange={(e) => setImageAvailable(e.target.checked)} /> Images available for reporting
                    </label>
                  </div>
                  <Button variant="primary" onClick={() => void advanceStatus("completed", { image_available: imageAvailable })}>
                    Mark examination completed
                  </Button>
                </div>
              )}

              {detail.exam.status === "completed" && (
                <div className="diag-note-box">
                  Examination completed{detail.exam.image_available ? " -- images available." : "."} A report draft has been created --
                  continue in Reports & Approval to record the findings.
                  {onNavigate && (
                    <div style={{ marginTop: "0.5rem" }}>
                      <Button variant="secondary" size="sm" onClick={goToReport}>Go to report</Button>
                    </div>
                  )}
                </div>
              )}

              {(detail.exam.status === "cancelled" || detail.exam.status === "no_show") && (
                <div className="diag-note-box">This examination was marked {detail.exam.status.replace("_", " ")}.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
