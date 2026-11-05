import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Select } from "./ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";

/**
 * Nurse-to-IPD-patient assignments and per-nurse workload, shown on the Nursing Station.
 *
 * What a login may see or change is decided by /api/nursing/* on the server:
 * admins and nursing supervisors can assign / end assignments and see every nurse's
 * workload; other staff see the assignment board and only their own workload.
 */

export type NurseAssignment = {
  id: number;
  admission_id: number;
  patient_id: string;
  patient_name?: string;
  ward?: string;
  bed?: string;
  shift?: string | null;
  assigned_nurse: string;
  nurse_name?: string;
};

type Unassigned = { admission_id: number; patient_id: string; patient_name?: string; ward?: string; bed_no?: string };
type NurseOption = { username: string; full_name: string; job_role?: string };
type WorkloadRow = {
  username: string; full_name: string; patients: number; doses_due: number; overdue: number;
  pending_indents: number; doses_given: number;
};

type AssignmentsResponse = {
  assignments: NurseAssignment[];
  unassigned: Unassigned[];
  nurses: NurseOption[];
  shifts: string[];
  can_manage: boolean;
  me: string;
};

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  /** Called with the active assignments whenever they load, so the page can label/filter patients. */
  onAssignmentsChange?: (assignments: NurseAssignment[], me: string) => void;
};

const grid = (cols: string) => ({ display: "grid", gridTemplateColumns: cols, gap: "8px", alignItems: "center" } as const);

export default function NurseAssignmentsPanel({ setNotice, onAssignmentsChange }: Props) {
  const [data, setData] = useState<AssignmentsResponse | null>(null);
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [workloadScope, setWorkloadScope] = useState<"all" | "self">("self");
  const [open, setOpen] = useState(true);
  const [form, setForm] = useState({ admission_id: "", nurse_username: "", shift: "" });
  const [saving, setSaving] = useState(false);
  const [endingId, setEndingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, w] = await Promise.all([
        apiFetch<AssignmentsResponse>("/api/nursing/assignments"),
        apiFetch<{ workload: WorkloadRow[]; scope: "all" | "self" }>("/api/nursing/workload"),
      ]);
      setData(a);
      setWorkload(w.workload || []);
      setWorkloadScope(w.scope);
      onAssignmentsChange?.(a.assignments || [], a.me || "");
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not load nurse assignments.");
    }
  }, [onAssignmentsChange, setNotice]);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!form.admission_id || !form.nurse_username) {
      setNotice({ type: "warning", message: "Select a patient and a nurse." });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/nursing/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admission_id: Number(form.admission_id), nurse_username: form.nurse_username, shift: form.shift || null }),
      });
      setNotice({ type: "success", message: "Nurse assigned." });
      setForm({ admission_id: "", nurse_username: "", shift: "" });
      await load();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not assign nurse.");
    } finally {
      setSaving(false);
    }
  };

  const endAssignment = async (id: number) => {
    setEndingId(id);
    try {
      await apiFetch(`/api/nursing/assignments/${id}/end`, { method: "POST" });
      await load();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not end assignment.");
    } finally {
      setEndingId(null);
    }
  };

  if (!data) return null;
  const assignments = data.assignments || [];
  // A manager may hand over an already-assigned patient, so offer every admitted patient they can see.
  const assignable = [
    ...data.unassigned.map((u) => ({ ...u, label: `${u.patient_name || u.patient_id} · ${u.ward || "-"} / ${u.bed_no || "-"} (unassigned)` })),
    ...assignments.map((a) => ({ admission_id: a.admission_id, patient_id: a.patient_id, label: `${a.patient_name || a.patient_id} · ${a.ward || "-"} / ${a.bed || "-"} (now: ${a.nurse_name || a.assigned_nurse}${a.shift ? `, ${a.shift}` : ""})` })),
  ].filter((v, i, arr) => arr.findIndex((x) => x.admission_id === v.admission_id) === i);

  return (
    <div className="diag-card" data-testid="nurse-assignments-panel" style={{ marginBottom: "0.75rem" }}>
      <div className="diag-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>Nurse Assignments &amp; Workload</h3>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</Button>
      </div>
      {open && (
        <div style={{ display: "grid", gap: "12px" }}>
          {data.can_manage && (
            <div style={grid("2fr 1.4fr 1fr auto")} data-testid="nurse-assign-form">
              <Select aria-label="Patient" value={form.admission_id} onChange={(e) => setForm((f) => ({ ...f, admission_id: e.target.value }))}>
                <option value="">Select admitted patient</option>
                {assignable.map((p) => <option key={p.admission_id} value={p.admission_id}>{p.label}</option>)}
              </Select>
              <Select aria-label="Nurse" value={form.nurse_username} onChange={(e) => setForm((f) => ({ ...f, nurse_username: e.target.value }))}>
                <option value="">Select nurse</option>
                {data.nurses.map((n) => <option key={n.username} value={n.username}>{n.full_name}{n.job_role ? ` (${n.job_role})` : ""}</option>)}
              </Select>
              <Select aria-label="Shift" value={form.shift} onChange={(e) => setForm((f) => ({ ...f, shift: e.target.value }))}>
                <option value="">Any shift</option>
                {data.shifts.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Button variant="primary" onClick={() => void submit()} disabled={saving}>{saving ? "Assigning..." : "Assign"}</Button>
            </div>
          )}

          <div className="hosp-revenue-pop-table" data-testid="nurse-assignments-table">
            <div className="hosp-revenue-pop-head" style={grid(data.can_manage ? "2fr 1.2fr 1.4fr 0.8fr auto" : "2fr 1.2fr 1.4fr 0.8fr")}>
              <span>Patient</span><span>Ward / Bed</span><span>Nurse</span><span>Shift</span>{data.can_manage && <span />}
            </div>
            {assignments.length === 0 && (
              <div className="hosp-revenue-pop-row" style={{ display: "block" }}><span className="muted">No active nurse assignments.</span></div>
            )}
            {assignments.map((a) => (
              <div key={a.id} className="hosp-revenue-pop-row" style={grid(data.can_manage ? "2fr 1.2fr 1.4fr 0.8fr auto" : "2fr 1.2fr 1.4fr 0.8fr")}>
                <span>{a.patient_name || a.patient_id}</span>
                <span>{a.ward || "-"} / {a.bed || "-"}</span>
                <span style={{ fontWeight: a.assigned_nurse.toLowerCase() === (data.me || "").toLowerCase() ? 800 : 500 }}>
                  {a.nurse_name || a.assigned_nurse}{a.assigned_nurse.toLowerCase() === (data.me || "").toLowerCase() ? " (you)" : ""}
                </span>
                <span>{a.shift || "Any"}</span>
                {data.can_manage && (
                  <Button size="sm" variant="ghost" onClick={() => void endAssignment(a.id)} disabled={endingId === a.id}>End</Button>
                )}
              </div>
            ))}
          </div>

          <div className="hosp-revenue-pop-table" data-testid="nurse-workload-table">
            <div className="hosp-revenue-pop-head" style={grid("2fr repeat(5, 1fr)")}>
              <span>{workloadScope === "all" ? "Nurse workload (today)" : "My workload (today)"}</span>
              <span>Patients</span><span>Doses due</span><span>Overdue</span><span>Indents</span><span>Given</span>
            </div>
            {workload.length === 0 && (
              <div className="hosp-revenue-pop-row" style={{ display: "block" }}><span className="muted">No nursing staff found.</span></div>
            )}
            {workload.map((w) => (
              <div key={w.username} className="hosp-revenue-pop-row" style={grid("2fr repeat(5, 1fr)")}>
                <span>{w.full_name}</span>
                <span>{w.patients}</span>
                <span>{w.doses_due}</span>
                <span style={w.overdue > 0 ? { color: "#dc2626", fontWeight: 800 } : undefined}>{w.overdue}</span>
                <span>{w.pending_indents}</span>
                <span>{w.doses_given}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
