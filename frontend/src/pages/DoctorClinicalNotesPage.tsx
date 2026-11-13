import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Select, Textarea, Input, Label, ConfirmDialog } from "../components/ui";
import { doctorsInDepartment, useDoctorDirectory } from "../lib/doctorDirectory";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTimeIST } from "../lib/format";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  /** The logged-in doctor's linked name, or null (admins can read but not write). */
  scopedDoctor?: string | null;
  /** Nursing staff can enter notes on behalf of the patient's attending doctor. */
  isNurse?: boolean;
  isAdmin?: boolean;
  username?: string;
};

type AssignedPatient = {
  admission_id: number;
  patient_id: string;
  patient_name: string;
  age?: number | string | null;
  gender?: string | null;
  ward?: string | null;
  room_no?: string | null;
  bed_no?: string | null;
  admitted_at?: string | null;
  reason?: string | null;
  department?: string | null;
  consulting_doctor?: string | null;
  assigned_to_me?: boolean;
  /** Set when this doctor handed the patient over: the doctor now responsible. */
  transferred_to?: string | null;
  note_count: number;
  last_note_at?: string | null;
  discharge_readiness?: string | null;
};

type ClinicalNote = {
  id: number;
  doctor_name: string;
  subjective?: string | null;
  objective_analysis?: string | null;
  diagnosis?: string | null;
  treatment_plan?: string | null;
  prognosis?: string | null;
  presenting_complaints?: string | null;
  clinical_course?: string | null;
  key_investigations?: string | null;
  procedures?: string | null;
  treatment_given?: string | null;
  condition_at_discharge?: string | null;
  advice?: string | null;
  follow_up?: string | null;
  discharge_readiness: string;
  created_by?: string | null;
  entered_role?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

const READINESS: Record<string, { label: string; color: string; bg: string }> = {
  not_assessed: { label: "Not assessed", color: "#64748b", bg: "#f1f5f9" },
  not_ready: { label: "Not ready for discharge", color: "#b91c1c", bg: "#fef2f2" },
  improving: { label: "Improving", color: "#b45309", bg: "#fffbeb" },
  ready_24h: { label: "Ready within 24 h", color: "#0369a1", bg: "#eff6ff" },
  ready: { label: "Ready for discharge", color: "#166534", bg: "#f0fdf4" },
};

const EMPTY_FORM = {
  subjective: "", objective_analysis: "", diagnosis: "", treatment_plan: "", prognosis: "", discharge_readiness: "not_assessed",
  presenting_complaints: "", clinical_course: "", key_investigations: "", procedures: "", treatment_given: "",
  condition_at_discharge: "", advice: "", follow_up: "",
};

// Same sections as the Discharge Summary, so what the doctor writes here fills them directly.
const TEXT_KEYS = ["subjective", "objective_analysis", "diagnosis", "treatment_plan", "prognosis", "presenting_complaints", "clinical_course",
  "key_investigations", "procedures", "treatment_given", "condition_at_discharge", "advice", "follow_up"] as const;

const NOTE_LABELS: [keyof ClinicalNote, string][] = [
  ["subjective", "Subjective"], ["objective_analysis", "Objective analysis"], ["diagnosis", "Diagnosis"], ["treatment_plan", "Treatment plan"],
  ["prognosis", "Prognosis"], ["presenting_complaints", "Presenting complaints"], ["clinical_course", "Clinical course"],
  ["key_investigations", "Key investigations"], ["procedures", "Procedures / surgery"], ["treatment_given", "Treatment given"],
  ["condition_at_discharge", "Condition at discharge"], ["advice", "Advice"], ["follow_up", "Follow-up"],
];

function ReadinessBadge({ value }: { value?: string | null }) {
  const r = READINESS[value || "not_assessed"] || READINESS.not_assessed;
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999, color: r.color, background: r.bg }}>{r.label}</span>;
}

export default function DoctorClinicalNotesPage({ setNotice, scopedDoctor, isNurse = false, isAdmin = false, username = "" }: Props) {
  const canWrite = !!scopedDoctor || isNurse;
  const { departments, doctors } = useDoctorDirectory();
  const [transferDept, setTransferDept] = useState("");
  const [transferDoctor, setTransferDoctor] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [transfers, setTransfers] = useState<{ id: number; from_doctor?: string | null; from_department?: string | null; to_doctor: string; to_department: string; reason?: string | null; transferred_by?: string | null; created_at?: string | null }[]>([]);
  const canEdit = (n: ClinicalNote) =>
    scopedDoctor
      ? String(n.doctor_name).trim().toLowerCase() === scopedDoctor.trim().toLowerCase()
      : isNurse && String(n.created_by || "").trim().toLowerCase() === username.trim().toLowerCase();
  const [patients, setPatients] = useState<AssignedPatient[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notes, setNotes] = useState<ClinicalNote[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = patients.find((p) => p.admission_id === selectedId) || null;

  const loadPatients = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ patients?: AssignedPatient[] }>("/api/doctor-notes/my-patients");
      const list = data.patients || [];
      setPatients(list);
      setSelectedId((current) => (current && list.some((p) => p.admission_id === current) ? current : list[0]?.admission_id ?? null));
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load your admitted patients.");
    } finally {
      setLoading(false);
    }
  };

  const loadNotes = async (admissionId: number) => {
    setLoadingNotes(true);
    try {
      const data = await apiFetch<{ notes?: ClinicalNote[] }>(`/api/admissions/${admissionId}/doctor-notes`);
      setNotes(data.notes || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load clinical notes.");
      setNotes([]);
    } finally {
      setLoadingNotes(false);
    }
  };

  useEffect(() => { void loadPatients(); }, []);
  const loadTransfers = async (admissionId: number) => {
    try {
      const data = await apiFetch<{ transfers?: typeof transfers }>(`/api/admissions/${admissionId}/doctor-transfers`);
      setTransfers(data.transfers || []);
    } catch {
      setTransfers([]);
    }
  };

  useEffect(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setTransferDept("");
    setTransferDoctor("");
    setTransferReason("");
    if (selectedId) { void loadNotes(selectedId); void loadTransfers(selectedId); }
    else { setNotes([]); setTransfers([]); }
  }, [selectedId]);

  // Only the doctor now looking after the patient (or an administrator) can hand them over.
  const handedOver = !!selected?.transferred_to;
  const canTransfer = !!selected && !handedOver && ((!!scopedDoctor && String(selected.consulting_doctor || "").trim().toLowerCase() === scopedDoctor.trim().toLowerCase()) || (isAdmin && !scopedDoctor && !isNurse));
  const transferTargets = doctorsInDepartment(doctors, transferDept).filter((d) => d.doctor_name.trim().toLowerCase() !== String(selected?.consulting_doctor || "").trim().toLowerCase());

  const doTransfer = async () => {
    if (!selected) return;
    setTransferring(true);
    try {
      await apiFetch(`/api/admissions/${selected.admission_id}/transfer-doctor`, {
        method: "POST",
        body: JSON.stringify({ to_department: transferDept, to_doctor: transferDoctor, reason: transferReason }),
      });
      setNotice({ type: "success", message: `${selected.patient_name} transferred to Dr. ${transferDoctor.replace(/^Dr\.?\s*/i, "")} (${transferDept}). They can now see the patient and all their records.` });
      setConfirmTransfer(false);
      setTransferDept("");
      setTransferDoctor("");
      setTransferReason("");
      await loadPatients();
      await loadTransfers(selected.admission_id);
    } catch (error) {
      setConfirmTransfer(false);
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to transfer the patient.");
    } finally {
      setTransferring(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) => [p.patient_name, p.patient_id, p.bed_no, p.ward].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [patients, search]);

  const startEdit = (n: ClinicalNote) => {
    setEditingId(n.id);
    setForm({
      ...EMPTY_FORM,
      ...Object.fromEntries(TEXT_KEYS.map((k) => [k, (n[k] as string | null | undefined) || ""])),
      discharge_readiness: n.discharge_readiness || "not_assessed",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!selected) return;
    if (!TEXT_KEYS.some((k) => form[k].trim())) {
      setNotice({ type: "warning", message: "Enter at least one clinical finding before saving." });
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await apiFetch(`/api/doctor-notes/${editingId}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await apiFetch(`/api/admissions/${selected.admission_id}/doctor-notes`, { method: "POST", body: JSON.stringify(form) });
      }
      setNotice({ type: "success", message: `${editingId ? "Clinical note updated" : "Clinical note saved"} for ${selected.patient_name}. It now shows in the patient journey and the discharge summary.` });
      setForm(EMPTY_FORM);
      setEditingId(null);
      await Promise.all([loadNotes(selected.admission_id), loadPatients()]);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save the clinical note.");
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof typeof EMPTY_FORM, rows = 4, placeholder = "") => (
    <div>
      <Label>{label}</Label>
      <Textarea rows={rows} value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={placeholder} disabled={!canWrite || handedOver || saving} />
    </div>
  );

  return (
    <div style={{ padding: "1.25rem 1.75rem 2.5rem", maxWidth: 1480, margin: "0 auto" }}>
      {/* The page title and description come from the app header above. */}
      <div style={{ marginBottom: 16 }}>
        {!canWrite && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "#92400e" }}>
            You are viewing as an administrator. Only attending doctors and nurses can record clinical notes.
          </div>
        )}
        {isNurse && !scopedDoctor && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "#1e40af" }}>
            You are entering notes as nursing staff. Each note is recorded under the patient's attending doctor and marked "entered by nurse {username}".
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 340px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", textTransform: "uppercase", marginBottom: 8 }}>
            {scopedDoctor ? `My admitted patients (${patients.length})` : `Admitted patients (${patients.length})`}
          </div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, UHID or bed" style={{ marginBottom: 10 }} />
          {loading && <p style={{ color: "#64748b", fontSize: 13 }}>Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p style={{ color: "#94a3b8", fontSize: 13 }}>{patients.length === 0 ? "No admitted patients are assigned to you right now." : "No patient matches the search."}</p>
          )}
          <div style={{ display: "grid", gap: 8, maxHeight: "70vh", overflowY: "auto" }}>
            {filtered.map((p) => {
              const active = p.admission_id === selectedId;
              return (
                <button
                  key={p.admission_id}
                  type="button"
                  onClick={() => setSelectedId(p.admission_id)}
                  style={{ textAlign: "left", cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: active ? "1.5px solid #00828a" : "1px solid #e2e8f0", background: active ? "#f0fdfa" : "#fff" }}
                >
                  <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 14 }}>{p.patient_name}</div>
                  <div style={{ fontSize: 11.5, color: "#64748b" }}>{p.patient_id} · {p.age ? `${p.age} yrs` : "-"} / {p.gender || "-"}</div>
                  {p.transferred_to && <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309" }}>Transferred to Dr. {String(p.transferred_to).replace(/^Dr\.?\s*/i, "")}</div>}
                  {isNurse && p.assigned_to_me && <div style={{ fontSize: 11, fontWeight: 700, color: "#00828a" }}>Assigned to you</div>}
                  {isNurse && p.consulting_doctor && <div style={{ fontSize: 11.5, color: "#475569" }}>Dr. {String(p.consulting_doctor).replace(/^Dr\.?\s*/i, "")}</div>}
                  <div style={{ fontSize: 12, color: "#334155", marginTop: 3 }}>{[p.ward, p.bed_no].filter(Boolean).join(" · ") || "Bed not allotted"}</div>
                  {p.reason && <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{p.reason}</div>}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{p.note_count} note{p.note_count === 1 ? "" : "s"}</span>
                    {p.note_count > 0 && <ReadinessBadge value={p.discharge_readiness} />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {!selected && <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 24, color: "#94a3b8" }}>Select a patient to record or review clinical notes.</div>}
          {selected && (
            <>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "16px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>{selected.patient_name}</div>
                    <div style={{ fontSize: 12.5, color: "#64748b" }}>
                      {selected.patient_id} · ADM-{selected.admission_id} · {[selected.ward, selected.room_no, selected.bed_no].filter(Boolean).join(" / ") || "no bed"} · Admitted {formatDateTimeIST(selected.admitted_at)}
                    </div>
                    {selected.reason && <div style={{ fontSize: 12.5, color: "#334155", marginTop: 2 }}>Reason for admission: {selected.reason}</div>}
                  </div>
                  {editingId && <span style={{ fontSize: 12, fontWeight: 700, color: "#b45309" }}>Editing an earlier note</span>}
                </div>

                <div style={{ display: "grid", gap: 12 }}>
                  {field("Subjective findings & daily observations", "subjective", 4, "Patient complaints, overnight events, symptoms, daily observations")}
                  {field("Objective clinical analysis", "objective_analysis", 4, "Examination findings, investigation review, clinical analysis")}
                  <div>
                    <Label>Diagnosis / assessment</Label>
                    <Input value={form.diagnosis} onChange={(e) => setForm((p) => ({ ...p, diagnosis: e.target.value }))} placeholder="Working or updated diagnosis" disabled={!canWrite || handedOver || saving} />
                  </div>
                  {field("Treatment plan adjustments & special instructions", "treatment_plan", 3, "Changes to medication, diet, monitoring, procedures, special instructions")}
                  {field("Prognosis", "prognosis", 2, "Expected course and outcome")}
                  <div style={{ maxWidth: 320 }}>
                    <Label>Discharge readiness</Label>
                    <Select value={form.discharge_readiness} onChange={(e) => setForm((p) => ({ ...p, discharge_readiness: e.target.value }))} disabled={!canWrite || handedOver || saving}>
                      {Object.entries(READINESS).map(([value, r]) => <option key={value} value={value}>{r.label}</option>)}
                    </Select>
                  </div>

                  <div style={{ borderTop: "1px dashed #cbd5e1", paddingTop: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", textTransform: "uppercase" }}>Discharge summary details</div>
                    <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "#64748b" }}>Optional. Anything written here fills the matching section of the Discharge Summary.</p>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
                    {field("Presenting complaints", "presenting_complaints", 3, "Complaints the patient came with")}
                    {field("Clinical course", "clinical_course", 3, "How the stay progressed")}
                    {field("Key investigations", "key_investigations", 3, "Important lab / imaging findings")}
                    {field("Procedures / surgery", "procedures", 3, "Procedures or surgery performed")}
                    {field("Treatment given", "treatment_given", 3, "Treatment the patient received")}
                    {field("Condition at discharge", "condition_at_discharge", 3, "Patient's condition on discharge")}
                    {field("Advice", "advice", 3, "Advice on discharge: diet, activity, precautions")}
                    {field("Follow-up", "follow_up", 3, "When and with whom to follow up")}
                  </div>
                </div>

                {canWrite && !handedOver && (
                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <Button variant="primary" onClick={() => void save()} disabled={saving} style={{ background: "#00828a", borderColor: "#00828a" }}>
                      {saving ? "Saving..." : editingId ? "Update note" : "Save clinical note"}
                    </Button>
                    {(editingId || Object.values(form).some((v) => v && v !== "not_assessed")) && (
                      <Button variant="ghost" onClick={() => { setForm(EMPTY_FORM); setEditingId(null); }} disabled={saving}>Clear</Button>
                    )}
                  </div>
                )}
              </div>

              {handedOver && (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 14, padding: "12px 18px", fontSize: 13, color: "#92400e" }}>
                  This patient was transferred to <strong>Dr. {String(selected.transferred_to).replace(/^Dr\.?\s*/i, "")}</strong>. You can still read the notes and records; only the doctor now responsible can add notes.
                </div>
              )}

              {canTransfer && (
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "16px 20px" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", textTransform: "uppercase", marginBottom: 4 }}>Transfer patient to another doctor</div>
                  <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "#64748b" }}>
                    Currently under Dr. {String(selected.consulting_doctor || "-").replace(/^Dr\.?\s*/i, "")}{selected.department ? ` (${selected.department})` : ""}. After the transfer the new doctor sees this patient and all their records, and you keep read access to the history.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <div>
                      <Label>Department</Label>
                      <Select value={transferDept} onChange={(e) => { setTransferDept(e.target.value); setTransferDoctor(""); }}>
                        <option value="">Select department</option>
                        {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                      </Select>
                    </div>
                    <div>
                      <Label>Doctor</Label>
                      <Select value={transferDoctor} onChange={(e) => setTransferDoctor(e.target.value)} disabled={!transferDept}>
                        <option value="">{transferDept ? (transferTargets.length ? "Select doctor" : "No other doctor in this department") : "Select a department first"}</option>
                        {transferTargets.map((d) => <option key={d.doctor_name} value={d.doctor_name}>{d.doctor_name}</option>)}
                      </Select>
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Label>Reason / hand-over notes (optional)</Label>
                    <Textarea rows={2} value={transferReason} onChange={(e) => setTransferReason(e.target.value)} placeholder="Why the patient is being transferred and anything the new doctor should know" />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Button variant="primary" disabled={!transferDept || !transferDoctor || transferring} onClick={() => setConfirmTransfer(true)} style={{ background: "#00828a", borderColor: "#00828a" }}>
                      Transfer patient
                    </Button>
                  </div>
                </div>
              )}

              {transfers.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 20px" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", textTransform: "uppercase", marginBottom: 8 }}>Transfer history</div>
                  {transfers.map((t) => (
                    <div key={t.id} style={{ fontSize: 13, padding: "6px 0", borderTop: "1px solid #f1f5f9" }}>
                      <strong>{t.from_doctor ? `Dr. ${String(t.from_doctor).replace(/^Dr\.?\s*/i, "")}` : "—"}</strong>{t.from_department ? ` (${t.from_department})` : ""} → <strong>Dr. {String(t.to_doctor).replace(/^Dr\.?\s*/i, "")}</strong> ({t.to_department})
                      <span style={{ color: "#64748b" }}> · {formatDateTimeIST(t.created_at)} · by {t.transferred_by}</span>
                      {t.reason && <div style={{ color: "#475569" }}>{t.reason}</div>}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "16px 20px" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", textTransform: "uppercase", marginBottom: 10 }}>Clinical notes this stay ({notes.length}) · {selected.patient_name} · {selected.patient_id}</div>
                {loadingNotes && <p style={{ color: "#64748b", fontSize: 13 }}>Loading…</p>}
                {!loadingNotes && notes.length === 0 && <p style={{ color: "#94a3b8", fontSize: 13 }}>No clinical notes recorded yet.</p>}
                {notes.map((n) => (
                  <div key={n.id} style={{ borderTop: "1px solid #f1f5f9", padding: "12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12.5, color: "#475569" }}>
                        <strong style={{ color: "#0f172a" }}>{n.doctor_name}</strong>
                        {n.entered_role === "nurse" ? ` (entered by nurse ${n.created_by})` : ""} · <strong style={{ color: "#0f172a" }}>{selected.patient_id}</strong> · {formatDateTimeIST(n.created_at)}
                        {n.updated_at && n.created_at && n.updated_at !== n.created_at ? " · edited" : ""}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <ReadinessBadge value={n.discharge_readiness} />
                        {canWrite && canEdit(n) && (
                          <Button variant="ghost" onClick={() => startEdit(n)} style={{ fontSize: 12 }}>Edit</Button>
                        )}
                      </div>
                    </div>
                    {NOTE_LABELS.filter(([key]) => n[key]).map(([key, label]) => {
                      const v = n[key] as string;
                      return (                      <div key={label} style={{ marginTop: 6, fontSize: 13 }}>
                        <strong style={{ fontSize: 12, fontWeight: 800, color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.02em" }}>{label}: </strong>
                        <span style={{ color: "#0f172a", whiteSpace: "pre-wrap" }}>{v}</span>
                      </div>
                    );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmTransfer}
        onClose={() => setConfirmTransfer(false)}
        onConfirm={doTransfer}
        loading={transferring}
        title="Transfer this patient?"
        description={selected ? `${selected.patient_name} (${selected.patient_id}) will move from Dr. ${String(selected.consulting_doctor || "-").replace(/^Dr\.?\s*/i, "")} to Dr. ${transferDoctor.replace(/^Dr\.?\s*/i, "")} (${transferDept}).` : ""}
        confirmLabel="Transfer"
      />
    </div>
  );
}
