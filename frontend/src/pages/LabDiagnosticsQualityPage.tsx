import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Checkbox, Input, Label, Modal, Select, Tabs, TabsTrigger, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };

type Overview = { open_qc_reviews: number; equipment_ready: number; equipment_total: number; maintenance_due_soon: number; expiring_lots: number; open_release_holds: number };
type Equipment = { id: number; asset_id: string; name: string; type?: string; location?: string; operational_status: string; responsible_staff?: string; next_maintenance_date?: string; next_calibration_date?: string };
type QcRun = { id: number; equipment_id: number; equipment_name: string; service_name?: string; outcome: string; run_at: string; operator?: string; reviewed_at?: string };
type QcHold = { id: number; equipment_id: number; equipment_name: string; service_name?: string; scope: string; status: string; corrective_action?: string; repeat_qc_run_id?: number; repeat_qc_outcome?: string; created_at: string };
type ReagentLot = { id: number; item_name: string; lot_no: string; quantity: number; unit?: string; expiry_date?: string; storage_location?: string; status: string };
type MaintenanceLog = { id: number; service_date?: string; service_type?: string; completion_status: string };

const EXPIRY_WARNING_MS = 14 * 86400000;

function qcOutcomeBadgeClass(outcome: string): string {
  if (outcome === "passed") return "diag-badge-active";
  if (outcome === "failed") return "diag-badge-critical";
  return "diag-badge-warning";
}

function equipmentStatusBadgeClass(status: string): string {
  return status === "ready" ? "diag-badge-active" : "diag-badge-critical";
}

function lotStatusBadgeClass(status: string): string {
  if (status === "available") return "diag-badge-active";
  if (status === "quarantined") return "diag-badge-warning";
  return "diag-badge-muted";
}

/** Runs an API action, surfacing success/failure via the shared Notice banner. Returns whether it succeeded. */
async function submitAction(
  setNotice: Dispatch<SetStateAction<Notice | null>>,
  action: () => Promise<unknown>,
  failureMessage: string,
  successMessage?: string
): Promise<boolean> {
  try {
    await action();
    if (successMessage) setNotice({ type: "success", message: successMessage });
    return true;
  } catch (err: any) {
    reportError(setNotice, err, failureMessage);
    return false;
  }
}

export default function LabDiagnosticsQualityPage({ setNotice }: Props) {
  const [tab, setTab] = useState<"overview" | "qc" | "equipment" | "reagents">("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [qcRuns, setQcRuns] = useState<QcRun[]>([]);
  const [qcHolds, setQcHolds] = useState<QcHold[]>([]);
  const [lots, setLots] = useState<ReagentLot[]>([]);
  const [maintLogs, setMaintLogs] = useState<MaintenanceLog[]>([]);

  const [qcModalOpen, setQcModalOpen] = useState(false);
  const [equipModalOpen, setEquipModalOpen] = useState(false);
  const [maintModalOpen, setMaintModalOpen] = useState(false);
  const [lotModalOpen, setLotModalOpen] = useState(false);
  const [selectedHold, setSelectedHold] = useState<QcHold | null>(null);
  const [maintEquipmentId, setMaintEquipmentId] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [ov, eq, runs, holds, lotRows] = await Promise.all([
        apiFetch<Overview>("/api/diag/quality/overview"),
        apiFetch<{ equipment: Equipment[] }>("/api/diag/equipment"),
        apiFetch<{ runs: QcRun[] }>("/api/diag/qc/runs"),
        apiFetch<{ holds: QcHold[] }>("/api/diag/qc/holds"),
        apiFetch<{ lots: ReagentLot[] }>("/api/diag/reagent-lots"),
      ]);
      setOverview(ov);
      setEquipment(eq.equipment || []);
      setQcRuns(runs.runs || []);
      setQcHolds(holds.holds || []);
      setLots(lotRows.lots || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load Quality & Equipment data.");
    }
  }, [setNotice]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const expiringLots = useMemo(
    () => lots.filter((l) => l.status === "available" && l.expiry_date && new Date(l.expiry_date).getTime() - Date.now() < EXPIRY_WARNING_MS),
    [lots]
  );

  const openMaintenanceLog = async (e: Equipment) => {
    try {
      const d = await apiFetch<{ logs: MaintenanceLog[] }>(`/api/diag/equipment/${e.id}/maintenance`);
      setMaintEquipmentId(e.id);
      setMaintLogs(d.logs || []);
      setMaintModalOpen(true);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load maintenance history.");
    }
  };

  const returnToService = async (e: Equipment) => {
    if (await submitAction(setNotice, () => apiFetch(`/api/diag/equipment/${e.id}/return-to-service`, { method: "POST" }), "Could not return equipment to service.", `${e.name} returned to service.`)) {
      void loadAll();
    }
  };

  const setLotStatus = async (l: ReagentLot, status: "quarantined" | "available") => {
    if (await submitAction(setNotice, () => apiFetch(`/api/diag/reagent-lots/${l.id}/status`, { method: "POST", body: JSON.stringify({ status }) }), "Could not update lot status.")) {
      void loadAll();
    }
  };

  return (
    <div className="diag-page">
      <div className="diag-kpi-row">
        <div className="diag-kpi-tile"><span>Open QC reviews</span><strong>{overview?.open_qc_reviews ?? "..."}</strong></div>
        <div className="diag-kpi-tile"><span>Equipment available</span><strong>{overview ? `${overview.equipment_ready} / ${overview.equipment_total}` : "..."}</strong></div>
        <div className="diag-kpi-tile"><span>Maintenance due soon</span><strong>{overview?.maintenance_due_soon ?? "..."}</strong></div>
        <div className="diag-kpi-tile"><span>Expiring lots</span><strong>{overview?.expiring_lots ?? "..."}</strong></div>
      </div>

      {!!overview?.open_release_holds && (
        <div className="diag-alert-banner">
          <span>{overview.open_release_holds} failed QC check(s) require corrective action</span>
          <Button size="sm" variant="destructive" onClick={() => setTab("qc")}>Review hold</Button>
        </div>
      )}

      <Tabs>
        <TabsTrigger active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabsTrigger>
        <TabsTrigger active={tab === "qc"} onClick={() => setTab("qc")}>Quality control</TabsTrigger>
        <TabsTrigger active={tab === "equipment"} onClick={() => setTab("equipment")}>Equipment</TabsTrigger>
        <TabsTrigger active={tab === "reagents"} onClick={() => setTab("reagents")}>Reagents & lots</TabsTrigger>
      </Tabs>

      {tab === "overview" && (
        <div className="diag-split diag-split-even">
          <div className="diag-card">
            <div className="diag-card-header"><h3>Quality control runs</h3></div>
            <table className="diag-data-table">
              <thead><tr><th>Equipment</th><th>Outcome</th><th>Run at</th></tr></thead>
              <tbody>
                {qcRuns.slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    <td>{r.equipment_name}</td>
                    <td><span className={`diag-badge ${qcOutcomeBadgeClass(r.outcome)}`}>{r.outcome}</span></td>
                    <td>{new Date(r.run_at).toLocaleString()}</td>
                  </tr>
                ))}
                {qcRuns.length === 0 && <tr><td colSpan={3} className="diag-empty">No QC runs recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="diag-card">
            <div className="diag-card-header"><h3>Equipment readiness</h3></div>
            <table className="diag-data-table">
              <thead><tr><th>Equipment</th><th>Status</th><th>Maintenance due</th></tr></thead>
              <tbody>
                {equipment.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td><span className={`diag-badge ${equipmentStatusBadgeClass(e.operational_status)}`}>{e.operational_status.replace("_", " ")}</span></td>
                    <td>{e.next_maintenance_date || "-"}</td>
                  </tr>
                ))}
                {equipment.length === 0 && <tr><td colSpan={3} className="diag-empty">No equipment registered.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="diag-card diag-form-full" style={{ gridColumn: "1 / -1" }}>
            <div className="diag-card-header"><h3>Lots expiring within 14 days</h3></div>
            <table className="diag-data-table">
              <thead><tr><th>Item</th><th>Lot</th><th>Expiry</th></tr></thead>
              <tbody>
                {expiringLots.map((l) => <tr key={l.id}><td>{l.item_name}</td><td>{l.lot_no}</td><td>{l.expiry_date}</td></tr>)}
                {expiringLots.length === 0 && <tr><td colSpan={3} className="diag-empty">Nothing expiring soon.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "qc" && (
        <div className="diag-split diag-split-even">
          <div className="diag-card">
            <div className="diag-card-header"><h3>Open holds</h3><Button size="sm" variant="primary" onClick={() => setQcModalOpen(true)}>Record QC</Button></div>
            <table className="diag-data-table">
              <thead><tr><th>Equipment</th><th>Scope</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {qcHolds.map((h) => (
                  <tr key={h.id} className={selectedHold?.id === h.id ? "diag-row-active" : ""}>
                    <td>{h.equipment_name}</td>
                    <td>{h.scope}{h.service_name ? ` (${h.service_name})` : ""}</td>
                    <td><span className="diag-badge diag-badge-critical">{h.status.replace(/_/g, " ")}</span></td>
                    <td><Button size="sm" variant="secondary" onClick={() => setSelectedHold(h)}>Review</Button></td>
                  </tr>
                ))}
                {qcHolds.length === 0 && <tr><td colSpan={4} className="diag-empty">No open holds. All equipment clear.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="diag-card">
            {!selectedHold && <p className="muted">Select a hold to record corrective action, repeat QC, or release.</p>}
            {selectedHold && (
              <HoldReview
                hold={selectedHold}
                setNotice={setNotice}
                onChanged={async () => {
                  await loadAll();
                  setSelectedHold(null);
                }}
              />
            )}
          </div>
        </div>
      )}

      {tab === "equipment" && (
        <div className="diag-card">
          <div className="diag-card-header"><h3>Equipment</h3><Button size="sm" variant="primary" onClick={() => setEquipModalOpen(true)}>+ Add equipment</Button></div>
          <table className="diag-data-table">
            <thead><tr><th>Asset ID</th><th>Name</th><th>Type</th><th>Status</th><th>Responsible</th><th></th></tr></thead>
            <tbody>
              {equipment.map((e) => (
                <tr key={e.id}>
                  <td>{e.asset_id}</td>
                  <td>{e.name}</td>
                  <td>{e.type || "-"}</td>
                  <td><span className={`diag-badge ${equipmentStatusBadgeClass(e.operational_status)}`}>{e.operational_status.replace("_", " ")}</span></td>
                  <td>{e.responsible_staff || "-"}</td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    <Button size="sm" variant="ghost" onClick={() => openMaintenanceLog(e)}>Log maintenance</Button>
                    {e.operational_status === "maintenance" && <Button size="sm" variant="secondary" onClick={() => returnToService(e)}>Return to service</Button>}
                  </td>
                </tr>
              ))}
              {equipment.length === 0 && <tr><td colSpan={6} className="diag-empty">No equipment registered yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "reagents" && (
        <div className="diag-card">
          <div className="diag-card-header"><h3>Reagents & lots</h3><Button size="sm" variant="primary" onClick={() => setLotModalOpen(true)}>+ Receive lot</Button></div>
          <table className="diag-data-table">
            <thead><tr><th>Item</th><th>Lot</th><th>Quantity</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {lots.map((l) => (
                <tr key={l.id}>
                  <td>{l.item_name}</td>
                  <td>{l.lot_no}</td>
                  <td>{l.quantity} {l.unit || ""}</td>
                  <td>{l.expiry_date || "-"}</td>
                  <td><span className={`diag-badge ${lotStatusBadgeClass(l.status)}`}>{l.status}</span></td>
                  <td>
                    {l.status === "available" && <Button size="sm" variant="ghost" onClick={() => setLotStatus(l, "quarantined")}>Quarantine</Button>}
                    {l.status === "quarantined" && <Button size="sm" variant="ghost" onClick={() => setLotStatus(l, "available")}>Release</Button>}
                  </td>
                </tr>
              ))}
              {lots.length === 0 && <tr><td colSpan={6} className="diag-empty">No reagent lots recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={qcModalOpen} onClose={() => setQcModalOpen(false)} title="Record QC">
        <RecordQcForm equipment={equipment} setNotice={setNotice} onSaved={async () => { setQcModalOpen(false); await loadAll(); }} />
      </Modal>
      <Modal open={equipModalOpen} onClose={() => setEquipModalOpen(false)} title="Add equipment">
        <EquipmentForm setNotice={setNotice} onSaved={async () => { setEquipModalOpen(false); await loadAll(); }} />
      </Modal>
      <Modal open={maintModalOpen} onClose={() => setMaintModalOpen(false)} title="Log maintenance">
        {maintEquipmentId != null && <MaintenanceForm equipmentId={maintEquipmentId} logs={maintLogs} setNotice={setNotice} onSaved={async () => { setMaintModalOpen(false); await loadAll(); }} />}
      </Modal>
      <Modal open={lotModalOpen} onClose={() => setLotModalOpen(false)} title="Receive reagent lot">
        <ReagentLotForm setNotice={setNotice} onSaved={async () => { setLotModalOpen(false); await loadAll(); }} />
      </Modal>
    </div>
  );
}

function HoldReview({ hold, setNotice, onChanged }: { hold: QcHold; setNotice: Dispatch<SetStateAction<Notice | null>>; onChanged: () => void }) {
  const [correctiveAction, setCorrectiveAction] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [repeatOutcome, setRepeatOutcome] = useState("passed");

  const recordCorrectiveAction = async () => {
    if (
      await submitAction(
        setNotice,
        () => apiFetch(`/api/diag/qc/holds/${hold.id}/corrective-action`, { method: "POST", body: JSON.stringify({ corrective_action: correctiveAction, assigned_to: assignedTo }) }),
        "Could not record corrective action.",
        "Corrective action recorded."
      )
    ) {
      onChanged();
    }
  };

  const recordRepeatQc = async () => {
    if (
      await submitAction(
        setNotice,
        () => apiFetch(`/api/diag/qc/holds/${hold.id}/repeat-qc`, { method: "POST", body: JSON.stringify({ outcome: repeatOutcome }) }),
        "Could not record repeat QC.",
        "Repeat QC recorded."
      )
    ) {
      onChanged();
    }
  };

  const releaseHold = async () => {
    if (
      await submitAction(
        setNotice,
        () => apiFetch(`/api/diag/qc/holds/${hold.id}/release`, { method: "POST" }),
        "The repeat QC must pass before releasing this hold.",
        "Hold released -- equipment back in service."
      )
    ) {
      onChanged();
    }
  };

  // A repeat QC can fail too -- when it does, the hold must go back through
  // corrective action rather than dead-ending on a "Release hold" button the
  // backend will only ever reject (it hard-requires a *passing* repeat run).
  const repeatFailed = hold.status === "repeat_qc_pending" && hold.repeat_qc_outcome === "failed";
  const needsCorrectiveAction = (hold.status !== "corrective_action_recorded" && hold.status !== "repeat_qc_pending") || repeatFailed;

  return (
    <div>
      <div className="diag-detail-header">
        <div>
          <h3>{hold.equipment_name}</h3>
          <div className="diag-detail-meta"><span>{hold.scope}</span><span>Status: {hold.status.replace(/_/g, " ")}</span></div>
        </div>
      </div>
      {repeatFailed && (
        <div className="diag-note-box diag-note-critical">
          The repeat QC run failed -- this hold cannot be released. Record a new corrective action and run QC again.
        </div>
      )}
      {needsCorrectiveAction && (
        <div className="diag-form-grid">
          <div className="diag-form-full"><Label>Corrective action</Label><Textarea rows={2} value={correctiveAction} onChange={(e) => setCorrectiveAction(e.target.value)} /></div>
          <div><Label>Assigned to</Label><Input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} /></div>
          <div className="diag-form-full"><Button variant="primary" onClick={recordCorrectiveAction}>Record corrective action</Button></div>
        </div>
      )}
      {hold.status === "corrective_action_recorded" && (
        <div className="diag-form-grid">
          <div>
            <Label>Repeat QC outcome</Label>
            <Select value={repeatOutcome} onChange={(e) => setRepeatOutcome(e.target.value)}>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
            </Select>
          </div>
          <div className="diag-form-full"><Button variant="primary" onClick={recordRepeatQc}>Record repeat QC</Button></div>
        </div>
      )}
      {hold.status === "repeat_qc_pending" && !repeatFailed && (
        <div className="diag-form-actions">
          <Button variant="primary" onClick={releaseHold}>Release hold</Button>
        </div>
      )}
    </div>
  );
}

function RecordQcForm({ equipment, setNotice, onSaved }: { equipment: Equipment[]; setNotice: Dispatch<SetStateAction<Notice | null>>; onSaved: () => void }) {
  const [equipmentId, setEquipmentId] = useState<number | "">("");
  const [controlMaterial, setControlMaterial] = useState("");
  const [controlLot, setControlLot] = useState("");
  const [outcome, setOutcome] = useState("passed");
  const [notes, setNotes] = useState("");

  const save = async () => {
    if (!equipmentId) {
      setNotice({ type: "warning", message: "Select equipment." });
      return;
    }
    if (
      await submitAction(
        setNotice,
        () => apiFetch("/api/diag/qc/runs", { method: "POST", body: JSON.stringify({ equipment_id: equipmentId, control_material: controlMaterial, control_lot: controlLot, outcome, notes }) }),
        "Could not record QC run.",
        "QC run recorded."
      )
    ) {
      onSaved();
    }
  };

  return (
    <div className="diag-form-grid">
      <div className="diag-form-full">
        <Label>Equipment</Label>
        <Select value={equipmentId} onChange={(e) => setEquipmentId(Number(e.target.value))}>
          <option value="">-- Select --</option>
          {equipment.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.asset_id})</option>)}
        </Select>
      </div>
      <div><Label>Control material</Label><Input value={controlMaterial} onChange={(e) => setControlMaterial(e.target.value)} /></div>
      <div><Label>Control lot</Label><Input value={controlLot} onChange={(e) => setControlLot(e.target.value)} /></div>
      <div>
        <Label>Outcome</Label>
        <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
        </Select>
      </div>
      <div className="diag-form-full"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="diag-form-full"><Button variant="primary" onClick={save}>Save QC run</Button></div>
    </div>
  );
}

function EquipmentForm({ setNotice, onSaved }: { setNotice: Dispatch<SetStateAction<Notice | null>>; onSaved: () => void }) {
  const [assetId, setAssetId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [location, setLocation] = useState("");
  const [responsible, setResponsible] = useState("");

  const save = async () => {
    if (!assetId.trim() || !name.trim()) {
      setNotice({ type: "warning", message: "Asset ID and name are required." });
      return;
    }
    if (
      await submitAction(
        setNotice,
        () => apiFetch("/api/diag/equipment", { method: "POST", body: JSON.stringify({ asset_id: assetId, name, type, location, responsible_staff: responsible }) }),
        "Could not add equipment.",
        "Equipment added."
      )
    ) {
      onSaved();
    }
  };

  return (
    <div className="diag-form-grid">
      <div><Label>Asset ID</Label><Input value={assetId} onChange={(e) => setAssetId(e.target.value)} /></div>
      <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><Label>Type</Label><Input value={type} onChange={(e) => setType(e.target.value)} /></div>
      <div><Label>Location</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} /></div>
      <div><Label>Responsible staff</Label><Input value={responsible} onChange={(e) => setResponsible(e.target.value)} /></div>
      <div className="diag-form-full"><Button variant="primary" onClick={save}>Save equipment</Button></div>
    </div>
  );
}

function MaintenanceForm({ equipmentId, logs, setNotice, onSaved }: { equipmentId: number; logs: MaintenanceLog[]; setNotice: Dispatch<SetStateAction<Notice | null>>; onSaved: () => void }) {
  const [serviceType, setServiceType] = useState("");
  const [findings, setFindings] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [markUnavailable, setMarkUnavailable] = useState(false);

  const save = async () => {
    if (
      await submitAction(
        setNotice,
        () =>
          apiFetch("/api/diag/equipment/maintenance", {
            method: "POST",
            body: JSON.stringify({ equipment_id: equipmentId, service_type: serviceType, findings, work_performed: workPerformed, next_due_date: nextDue || null, mark_unavailable: markUnavailable }),
          }),
        "Could not log maintenance.",
        "Maintenance logged."
      )
    ) {
      onSaved();
    }
  };

  return (
    <div>
      {logs.length > 0 && (
        <table className="diag-data-table" style={{ marginBottom: "1rem" }}>
          <thead><tr><th>Date</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>{logs.slice(0, 5).map((l) => <tr key={l.id}><td>{l.service_date || "-"}</td><td>{l.service_type || "-"}</td><td>{l.completion_status}</td></tr>)}</tbody>
        </table>
      )}
      <div className="diag-form-grid">
        <div><Label>Service type</Label><Input value={serviceType} onChange={(e) => setServiceType(e.target.value)} placeholder="Preventive / Repair / Calibration" /></div>
        <div><Label>Next due date</Label><Input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></div>
        <div className="diag-form-full"><Label>Findings</Label><Textarea rows={2} value={findings} onChange={(e) => setFindings(e.target.value)} /></div>
        <div className="diag-form-full"><Label>Work performed</Label><Textarea rows={2} value={workPerformed} onChange={(e) => setWorkPerformed(e.target.value)} /></div>
        <div className="diag-checkbox-field">
          <label><Checkbox checked={markUnavailable} onChange={(e) => setMarkUnavailable(e.target.checked)} /> Take equipment out of service now</label>
        </div>
        <div className="diag-form-full"><Button variant="primary" onClick={save}>Save log</Button></div>
      </div>
    </div>
  );
}

function ReagentLotForm({ setNotice, onSaved }: { setNotice: Dispatch<SetStateAction<Notice | null>>; onSaved: () => void }) {
  const [itemName, setItemName] = useState("");
  const [lotNo, setLotNo] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [unit, setUnit] = useState("");
  const [expiry, setExpiry] = useState("");
  const [storage, setStorage] = useState("");

  const save = async () => {
    if (!itemName.trim() || !lotNo.trim()) {
      setNotice({ type: "warning", message: "Item name and lot number are required." });
      return;
    }
    if (
      await submitAction(
        setNotice,
        () => apiFetch("/api/diag/reagent-lots", { method: "POST", body: JSON.stringify({ item_name: itemName, lot_no: lotNo, quantity, unit, expiry_date: expiry || null, storage_location: storage }) }),
        "Could not add reagent lot.",
        "Lot received."
      )
    ) {
      onSaved();
    }
  };

  return (
    <div className="diag-form-grid">
      <div><Label>Item name</Label><Input value={itemName} onChange={(e) => setItemName(e.target.value)} /></div>
      <div><Label>Lot / batch no.</Label><Input value={lotNo} onChange={(e) => setLotNo(e.target.value)} /></div>
      <div><Label>Quantity</Label><Input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></div>
      <div><Label>Unit</Label><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
      <div><Label>Expiry date</Label><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
      <div><Label>Storage location</Label><Input value={storage} onChange={(e) => setStorage(e.target.value)} /></div>
      <div className="diag-form-full"><Button variant="primary" onClick={save}>Save lot</Button></div>
    </div>
  );
}
