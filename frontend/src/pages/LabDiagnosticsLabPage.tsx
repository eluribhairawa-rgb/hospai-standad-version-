import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Checkbox, Input, Label, Select, Tabs, TabsTrigger } from "../components/ui";
import { apiFetch, reportError, getHospitalCode } from "../lib/api";
import { API_BASE } from "../lib/constants";
import type { Notice } from "../types";
import { printViaIframe } from "../lib/printViaIframe";
import { openReportForItem } from "../lib/diagReports";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type WorklistRow = {
  id: number; order_id: number; service_id: number; service_name: string; department_type: string;
  progress_status: string; order_no: string; patient_id: string; encounter_type: string; admission_id?: number;
  priority: string; patient_first_name?: string; patient_last_name?: string;
  specimen_id?: number; specimen_no?: string; specimen_status?: string; rejection_reason?: string;
  tat_status?: "on_time" | "near_due" | "overdue" | null; elapsed_hours?: number; tat_target_hours?: number;
};

type ParamDef = { id: number; name: string; data_type: string; unit?: string; method?: string; ref_low?: number; ref_high?: number; ref_text?: string; critical_low?: number; critical_high?: number };
type ResultRow = { id: number; parameter_id: number; parameter_name: string; value_text?: string; value_numeric?: number; unit?: string; ref_range_text?: string; ref_low?: number; ref_high?: number; flag?: string; is_draft: boolean; equipment_id?: number; reagent_lot_id?: number };
type Specimen = { id: number; specimen_no: string; status: string; container_type?: string; collection_location?: string; collected_at?: string; received_at?: string; rejection_reason?: string };
type ItemDetail = {
  id: number; service_id: number; service_name: string; order_no: string; patient_id: string; priority: string;
  clinical_indication?: string; referring_clinician?: string; encounter_type: string;
  patient?: { name: string; last_name: string; dob?: string; age?: number; gender?: string; phone?: string };
  specimens: Specimen[];
  parameters: ParamDef[];
  results: ResultRow[];
  report_id?: number | null; report_status?: string | null;
  external_referrals?: ExternalReferral[];
};
type ExternalReferral = { id: number; vendor_name?: string; dispatched_at?: string; dispatched_by?: string; expected_turnaround?: string; received_report_at?: string | null; local_review_status: string };
type Vendor = { id: number; vendor_name: string };
type Equipment = { id: number; name: string; type?: string; operational_status?: string; next_calibration_date?: string };
type ReagentLot = { id: number; item_name: string; lot_no: string; expiry_date?: string; is_expired?: boolean };
type QcHold = { id: number; equipment_id: number; scope: string; service_id?: number; status: string };

const STAGES: { key: string; label: string }[] = [
  { key: "awaiting_collection", label: "To collect" },
  { key: "collected", label: "Collected" },
  { key: "received", label: "In lab" },
  { key: "for_review", label: "For review" },
  { key: "released", label: "Released" },
];

// Mirrors the backend's equipment checks in save_diag_results: why this analyzer can't be used, or null.
const UNAVAILABLE_EQUIPMENT_STATUSES = new Set(["maintenance", "down"]);
function equipmentBlockReason(eq: Equipment): string | null {
  if (UNAVAILABLE_EQUIPMENT_STATUSES.has(eq.operational_status || "")) return eq.operational_status || null;
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  if (eq.next_calibration_date && eq.next_calibration_date.slice(0, 10) < today) return `calibration overdue since ${eq.next_calibration_date.slice(0, 10)}`;
  return null;
}

// Results can be changed only while the report has not gone to review (or after it is returned / amended).
const RESULT_EDITABLE_REPORT_STATUSES = new Set(["draft", "returned_for_correction"]);

/** Mirrors the backend's _compute_result_flag so out-of-range values are flagged while typing. */
function computeFlag(p: ParamDef, raw: string | undefined): string | null {
  if (p.data_type !== "numeric" || raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (p.critical_low != null && v < p.critical_low) return "critical_low";
  if (p.critical_high != null && v > p.critical_high) return "critical_high";
  if (p.ref_low != null && v < p.ref_low) return "low";
  if (p.ref_high != null && v > p.ref_high) return "high";
  return p.ref_low != null || p.ref_high != null ? "normal" : null;
}

const EMPTY_COLLECT_FORM = { identity_verified: false, container_type: "", collection_quantity: "", collection_unit: "mL", collection_location: "", collection_notes: "" };
const EMPTY_RECEIVE_FORM = { accept: true, condition_on_receipt: "", rejection_reason: "" };

export default function LabDiagnosticsLabPage({ setNotice, onNavigate }: Props) {
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("awaiting_collection");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<WorklistRow | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});

  const [collectForm, setCollectForm] = useState(EMPTY_COLLECT_FORM);
  const [receiveForm, setReceiveForm] = useState(EMPTY_RECEIVE_FORM);
  const [resultValues, setResultValues] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [referralOpen, setReferralOpen] = useState(false);
  const [referralVendor, setReferralVendor] = useState<number | "">("");
  const [referralTat, setReferralTat] = useState("");
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [qcHolds, setQcHolds] = useState<QcHold[]>([]);
  const [selectedEquipment, setSelectedEquipment] = useState<number | "">("");
  const [reagentLots, setReagentLots] = useState<ReagentLot[]>([]);
  const [selectedLot, setSelectedLot] = useState<number | "">("");
  const [ocrScanning, setOcrScanning] = useState(false);
  const [ocrFileName, setOcrFileName] = useState("");
  // Parameters whose value came from the last OCR scan and has not been touched since -- highlighted until verified.
  const [ocrFilledIds, setOcrFilledIds] = useState<Set<number>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ stage, ...(search.trim() ? { q: search.trim() } : {}) });
      const data = await apiFetch<{ items: WorklistRow[] }>(`/api/diag/lab/worklist?${params}`);
      setRows(data.items || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load laboratory worklist.");
    } finally {
      setLoading(false);
    }
  };

  const loadStageCounts = async () => {
    try {
      const results = await Promise.all(STAGES.map((s) => apiFetch<{ items: WorklistRow[] }>(`/api/diag/lab/worklist?stage=${s.key}`)));
      const next: Record<string, number> = {};
      STAGES.forEach((s, idx) => { next[s.key] = (results[idx].items || []).length; });
      setStageCounts(next);
    } catch { /* KPI counts are supplementary; worklist itself still loads independently */ }
  };

  useEffect(() => { void load(); void loadStageCounts(); }, [stage]);
  useEffect(() => { const t = window.setTimeout(() => void load(), 300); return () => window.clearTimeout(t); }, [search]);
  useEffect(() => { apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list").then((d) => setVendors(d.vendors || [])).catch(() => {}); }, []);
  useEffect(() => { apiFetch<{ equipment: Equipment[] }>("/api/diag/equipment").then((d) => setEquipmentList(d.equipment || [])).catch(() => {}); }, []);
  useEffect(() => {
    apiFetch<{ lots: ReagentLot[] }>("/api/diag/reagent-lots?status=available")
      .then((d) => setReagentLots((d.lots || []).filter((l) => !l.is_expired)))
      .catch(() => {});
  }, []);
  useEffect(() => { apiFetch<{ holds: QcHold[] }>("/api/diag/qc/holds").then((d) => setQcHolds(d.holds || [])).catch(() => {}); }, []);

  const openItem = async (row: WorklistRow) => {
    setSelected(row);
    setResultValues({});
    setCollectForm(EMPTY_COLLECT_FORM);
    setReceiveForm(EMPTY_RECEIVE_FORM);
    setOcrFileName("");
    setOcrFilledIds(new Set());
    try {
      const d = await apiFetch<ItemDetail>(`/api/diag/lab/items/${row.id}`);
      setDetail(d);
      const vals: Record<number, string> = {};
      d.results.forEach((r) => { vals[r.parameter_id] = r.value_numeric != null ? String(r.value_numeric) : (r.value_text || ""); });
      setResultValues(vals);
      // A test panel runs on one analyzer -- re-derive the selection from
      // whatever equipment a previous draft save already recorded, rather
      // than losing it every time the item reloads after a mutation.
      const existingEquipmentId = d.results.find((r) => r.equipment_id)?.equipment_id;
      setSelectedEquipment(existingEquipmentId ?? "");
      setSelectedLot(d.results.find((r) => r.reagent_lot_id)?.reagent_lot_id ?? "");
    } catch (err: any) {
      reportError(setNotice, err, "Could not load test details.");
    }
  };

  const activeSpecimen = useMemo(() => detail?.specimens.find((s) => s.status !== "rejected"), [detail]);
  // Specimens come back newest first, so this is the one the active specimen replaced.
  const lastRejected = useMemo(() => detail?.specimens.find((s) => s.status === "rejected"), [detail]);
  const resultsLocked = !!detail?.report_status && !RESULT_EDITABLE_REPORT_STATUSES.has(detail.report_status);

  // Mirrors the backend's own QC-hold check (legacy_queries.py save_diag_results)
  // so staff see the block before they try to finalize, not just after the
  // server rejects it.
  const equipmentHold = useMemo(() => {
    if (!selectedEquipment || !detail) return null;
    return qcHolds.find(
      (h) => h.status !== "released" && h.equipment_id === selectedEquipment &&
        (h.scope === "equipment" || (h.scope === "assay" && h.service_id === detail.service_id))
    ) || null;
  }, [selectedEquipment, qcHolds, detail]);
  const unavailableEquipment = useMemo(() => {
    const eq = equipmentList.find((e) => e.id === selectedEquipment);
    const reason = eq ? equipmentBlockReason(eq) : null;
    return eq && reason ? { name: eq.name, reason } : null;
  }, [selectedEquipment, equipmentList]);
  const openReferral = detail?.external_referrals?.find((r) => !r.received_report_at) || null;

  // Re-pulls the open item plus the worklist and KPI counts after a mutation on it.
  const refreshAfterMutation = async () => {
    if (selected) await openItem(selected);
    void load();
    void loadStageCounts();
  };

  const printLabel = () => {
    if (!activeSpecimen || !detail) return;
    printViaIframe(`
      <html><head><title>Specimen label</title></head><body style="font-family:monospace;padding:12px;width:280px;">
      <div style="border:1px solid #000;padding:8px;">
        <div style="font-weight:bold;">${detail.patient ? `${detail.patient.name} ${detail.patient.last_name || ""}` : detail.patient_id}</div>
        <div>UHID: ${detail.patient_id}</div>
        <div>Specimen: ${activeSpecimen.specimen_no}</div>
        <div>Test: ${detail.service_name}</div>
        <div>Order: ${detail.order_no}</div>
      </div>
      </body></html>
    `);
  };

  const doCollect = async () => {
    if (!activeSpecimen) return;
    if (!collectForm.identity_verified) { setNotice({ type: "warning", message: "Verify patient identity before collection." }); return; }
    setSaving(true);
    try {
      const payload = {
        ...collectForm,
        collection_notes: [
          collectForm.collection_quantity ? `Qty: ${collectForm.collection_quantity} ${collectForm.collection_unit}` : "",
          collectForm.collection_notes,
        ].filter(Boolean).join(" | "),
      };
      await apiFetch(`/api/diag/lab/specimens/${activeSpecimen.id}/collect`, { method: "POST", body: JSON.stringify(payload) });
      setNotice({ type: "success", message: "Specimen collected." });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record collection.");
    } finally {
      setSaving(false);
    }
  };

  const doReceive = async () => {
    if (!activeSpecimen) return;
    if (!receiveForm.accept && !receiveForm.rejection_reason.trim()) { setNotice({ type: "warning", message: "A rejection reason is required." }); return; }
    setSaving(true);
    try {
      await apiFetch(`/api/diag/lab/specimens/${activeSpecimen.id}/receive`, { method: "POST", body: JSON.stringify(receiveForm) });
      setNotice({
        type: receiveForm.accept ? "success" : "warning",
        message: receiveForm.accept ? "Specimen received." : "Specimen rejected -- a replacement specimen is now awaiting collection.",
      });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record receipt.");
    } finally {
      setSaving(false);
    }
  };

  const saveResults = async (isDraft: boolean) => {
    if (!detail) return;
    if (resultsLocked) {
      setNotice({ type: "warning", message: `The report is ${detail.report_status?.replace(/_/g, " ")} -- results can no longer be changed here.` });
      return;
    }
    if (!isDraft && !selectedEquipment) {
      setNotice({ type: "warning", message: "Select the equipment/analyzer used before finalizing results." });
      return;
    }
    const invalid = detail.parameters.filter((p) => {
      const raw = (resultValues[p.id] || "").trim();
      return p.data_type === "numeric" && raw !== "" && !Number.isFinite(Number(raw));
    });
    if (invalid.length) {
      setNotice({ type: "warning", message: `Enter a number for: ${invalid.map((p) => p.name).join(", ")}.` });
      return;
    }
    if (!isDraft) {
      const missing = detail.parameters.filter((p) => !(resultValues[p.id] || "").trim());
      if (missing.length) {
        setNotice({ type: "warning", message: `Enter a value for every parameter before finalizing. Missing: ${missing.map((p) => p.name).join(", ")}.` });
        return;
      }
    }
    const equipment_id = selectedEquipment || undefined;
    const reagent_lot_id = selectedLot || undefined;
    const results = detail.parameters
      .map((p) => {
        const raw = (resultValues[p.id] || "").trim();
        return p.data_type === "numeric"
          ? { parameter_id: p.id, value_numeric: raw !== "" ? Number(raw) : null, equipment_id, reagent_lot_id }
          : { parameter_id: p.id, value_text: raw, equipment_id, reagent_lot_id };
      })
      .filter((r: any) => (r.value_numeric !== null && r.value_numeric !== undefined) || r.value_text);
    if (results.length === 0) { setNotice({ type: "warning", message: "Enter at least one result value." }); return; }
    setSaving(true);
    try {
      // Finalizing also creates the report draft on the server, so the test moves straight to Reports & Approval.
      const res = await apiFetch<{ critical_alerts_raised: number; critical_values: number }>(`/api/diag/lab/items/${detail.id}/results`, { method: "POST", body: JSON.stringify({ results, is_draft: isDraft }) });
      setNotice({
        type: !isDraft && res.critical_values ? "warning" : "success",
        message: isDraft
          ? "Results saved as draft."
          : res.critical_alerts_raised
            ? `Results finalized. ${res.critical_alerts_raised} critical value(s) flagged -- notify the clinician now.`
            : res.critical_values
              ? "Results finalized. Critical values are already awaiting acknowledgement in Reports & Approval."
              : "Results finalized and sent for report review.",
      });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not save results.");
    } finally {
      setSaving(false);
    }
  };

  // OCR auto-fill: upload an analyzer printout / result sheet, Qwen OCR maps the
  // printed values onto this test's parameters. Finalized values are never overwritten.
  const handleOcrUpload = async (file: File | undefined) => {
    if (!file || !detail) return;
    if (file.type && !file.type.startsWith("image/")) {
      setNotice({ type: "warning", message: "Please upload an image file (JPG, PNG, WEBP, TIFF, BMP, GIF...)." });
      return;
    }
    setOcrFileName(file.name);
    setOcrScanning(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const baseUrl = (API_BASE || "").replace(/\/+$/, "").replace(/\/api$/, "");
      const response = await fetch(`${baseUrl}/api/diag/lab/items/${detail.id}/ocr`, {
        method: "POST",
        body,
        credentials: "include",
        headers: { "X-Hospital-Code": getHospitalCode() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(data?.detail || data?.error || "OCR failed."), { status: response.status });
      }
      const { values, equipment, identity_warnings, skipped } = data as {
        values: { parameter_id: number; value: string }[]; equipment: string; identity_warnings?: string[];
        skipped?: { parameter_name: string; value: string }[];
      };
      const filled = resultsLocked ? [] : values;
      if (filled.length) {
        setResultValues((prev) => ({ ...prev, ...Object.fromEntries(filled.map((v) => [v.parameter_id, v.value])) }));
      }
      setOcrFilledIds(new Set(filled.map((v) => v.parameter_id)));
      let equipmentNote = "";
      if (equipment && !selectedEquipment) {
        const name = equipment.toLowerCase();
        const match = equipmentList.find((eq) => {
          const n = eq.name.toLowerCase();
          if (equipmentBlockReason(eq)) return false;
          return n === name || n.includes(name) || name.includes(n);
        });
        if (match) {
          setSelectedEquipment(match.id);
          equipmentNote = ` Analyzer set to ${match.name}.`;
        }
      }
      const identityNote = identity_warnings?.length ? ` CHECK IDENTITY: ${identity_warnings.join(" ")}` : "";
      const skippedNote = skipped?.length ? ` Enter manually: ${skipped.map((s) => `${s.parameter_name} (printed "${s.value}")`).join(", ")}.` : "";
      setNotice(
        filled.length
          ? { type: identityNote || skippedNote ? "warning" : "success", message: `OCR filled ${filled.length} of ${detail.parameters.length} parameter(s).${equipmentNote} Verify the highlighted values before saving.${skippedNote}${identityNote}` }
          : { type: "warning", message: `No values for this test's parameters could be filled from the image.${skippedNote || " Try a clearer photo."}${identityNote}` }
      );
    } catch (err: any) {
      reportError(setNotice, err, "Lab result OCR failed.");
    } finally {
      setOcrScanning(false);
    }
  };

  const goToReport = () => {
    if (!onNavigate || !detail) return;
    void openReportForItem(detail.id, "LAB", onNavigate);
  };

  const markReferralReceived = async (referralId: number) => {
    try {
      await apiFetch(`/api/diag/lab/external-referral/${referralId}`, { method: "PUT", body: JSON.stringify({ report_received: true, local_review_status: "reviewed" }) });
      setNotice({ type: "success", message: "External report marked received. Enter (or OCR) its values below and finalize." });
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not update external referral.");
    }
  };

  const sendExternalReferral = async () => {
    if (!referralVendor || !detail) return;
    try {
      await apiFetch(`/api/diag/lab/items/${detail.id}/external-referral`, { method: "POST", body: JSON.stringify({ vendor_id: referralVendor, expected_turnaround: referralTat }) });
      setNotice({ type: "success", message: "Sent to external laboratory." });
      setReferralOpen(false);
      await refreshAfterMutation();
    } catch (err: any) {
      reportError(setNotice, err, "Could not create external referral.");
    }
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
          <div className="diag-card-header"><h3>Laboratory worklist</h3></div>
          <Input placeholder="Search patient, UHID or specimen" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div style={{ marginTop: "0.75rem" }}>
            {loading && <p className="muted">Loading...</p>}
            {!loading && rows.length === 0 && <p className="muted">Nothing in this stage.</p>}
            {rows.map((r) => (
              <div key={r.id} className={`diag-worklist-row ${selected?.id === r.id ? "active" : ""}`} onClick={() => void openItem(r)}>
                <div className="diag-worklist-row-top">
                  <span>{[r.patient_first_name, r.patient_last_name].filter(Boolean).join(" ") || r.patient_id}</span>
                  {r.priority !== "Routine" && <span className="diag-badge diag-badge-critical">{r.priority}</span>}
                  {r.tat_status === "overdue" && <span className="diag-badge diag-badge-critical">Overdue</span>}
                  {r.tat_status === "near_due" && <span className="diag-badge diag-badge-warning">Near TAT</span>}
                </div>
                <div className="diag-worklist-row-meta">
                  <span>{r.service_name}</span><span>{r.encounter_type}</span>
                  {r.specimen_no && <span>{r.specimen_no}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="diag-card">
          {!detail && <p className="muted">Select a test to view collection, receipt or results.</p>}
          {detail && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{detail.service_name}</h3>
                  <div className="diag-detail-meta">
                    <span>{detail.patient ? `${detail.patient.name} ${detail.patient.last_name || ""}` : detail.patient_id}</span>
                    <span>UHID: {detail.patient_id}</span>
                    {detail.patient?.age != null && <span>Age {detail.patient.age}</span>}
                    {detail.patient?.gender && <span>{detail.patient.gender}</span>}
                    <span>Order: {detail.order_no}</span>
                    {detail.referring_clinician && <span>Dr. {detail.referring_clinician}</span>}
                  </div>
                </div>
                {activeSpecimen && <Button size="sm" variant="ghost" onClick={printLabel}>Print sample label</Button>}
              </div>

              {activeSpecimen?.status === "awaiting_collection" && (
                <div>
                  <div className="diag-section-title">Collection</div>
                  <div className="diag-note-box">Specimen ID: {activeSpecimen.specimen_no}</div>
                  <div className="diag-form-grid">
                    <div className="diag-checkbox-field">
                      <label>
                        <Checkbox checked={collectForm.identity_verified} onChange={(e) => setCollectForm({ ...collectForm, identity_verified: e.target.checked })} /> Patient identity verified
                      </label>
                    </div>
                    <div><Label>Container</Label><Input value={collectForm.container_type} onChange={(e) => setCollectForm({ ...collectForm, container_type: e.target.value })} placeholder="EDTA / Plain / Sterile" /></div>
                    <div><Label>Collection Quantity</Label><Input type="number" step="any" min={0} value={collectForm.collection_quantity} onChange={(e) => setCollectForm({ ...collectForm, collection_quantity: e.target.value })} placeholder="e.g. 5" /></div>
                    <div><Label>Collection Unit</Label>
                      <Select value={collectForm.collection_unit} onChange={(e) => setCollectForm({ ...collectForm, collection_unit: e.target.value })}>
                        <option value="mL">mL</option>
                        <option value="tubes">tubes</option>
                        <option value="swabs">swabs</option>
                        <option value="drops">drops</option>
                        <option value="containers">containers</option>
                      </Select>
                    </div>
                    <div><Label>Collection Location</Label><Input value={collectForm.collection_location} onChange={(e) => setCollectForm({ ...collectForm, collection_location: e.target.value })} placeholder="Ward / OPD room / Phlebotomy" /></div>
                    <div className="diag-form-full"><Label>Notes</Label><Input value={collectForm.collection_notes} onChange={(e) => setCollectForm({ ...collectForm, collection_notes: e.target.value })} placeholder="Collection observations or notes" /></div>
                    <div className="diag-form-full"><Button variant="primary" disabled={saving} onClick={() => void doCollect()}>Confirm collection</Button></div>
                  </div>
                </div>
              )}

              {activeSpecimen?.status === "collected" && (
                <div>
                  <div className="diag-section-title">Receipt in laboratory</div>
                  <div className="diag-form-grid">
                    <div><Label>Condition on receipt</Label><Input value={receiveForm.condition_on_receipt} onChange={(e) => setReceiveForm({ ...receiveForm, condition_on_receipt: e.target.value })} placeholder="Good / hemolyzed / clotted..." /></div>
                    <div><Label>Decision</Label>
                      <Select value={receiveForm.accept ? "accept" : "reject"} onChange={(e) => setReceiveForm({ ...receiveForm, accept: e.target.value === "accept" })}>
                        <option value="accept">Accept</option>
                        <option value="reject">Reject</option>
                      </Select>
                    </div>
                    {!receiveForm.accept && <div className="diag-form-full"><Label>Rejection reason</Label><Input value={receiveForm.rejection_reason} onChange={(e) => setReceiveForm({ ...receiveForm, rejection_reason: e.target.value })} /></div>}
                    <div className="diag-form-full"><Button variant="primary" disabled={saving} onClick={() => void doReceive()}>{receiveForm.accept ? "Confirm receipt" : "Reject specimen"}</Button></div>
                  </div>
                </div>
              )}

              {activeSpecimen?.status === "awaiting_collection" && lastRejected && (
                <div className="diag-note-box diag-note-critical">Previous specimen {lastRejected.specimen_no} was rejected: {lastRejected.rejection_reason || "no reason recorded"}. Collect the replacement specimen below.</div>
              )}

              {activeSpecimen?.status === "received" && (
                <div>
                  <div className="diag-section-title">Results</div>
                  {resultsLocked && (
                    <div className="diag-note-box">
                      The report is {detail.report_status?.replace(/_/g, " ")}, so results are locked. Return it for correction (or create an amendment once released) in Reports &amp; Approval to change them.
                    </div>
                  )}
                  <div className="diag-form-grid" style={{ marginBottom: "0.75rem" }}>
                    <div>
                      <Label>Equipment / Analyzer used</Label>
                      <Select value={selectedEquipment} disabled={resultsLocked} onChange={(e) => setSelectedEquipment(e.target.value ? Number(e.target.value) : "")}>
                        <option value="">-- Select equipment --</option>
                        {equipmentList.map((eq) => {
                          const blocked = equipmentBlockReason(eq);
                          return <option key={eq.id} value={eq.id} disabled={!!blocked && eq.id !== selectedEquipment}>{eq.name}{eq.type ? ` (${eq.type})` : ""}{blocked ? ` -- ${blocked}` : ""}</option>;
                        })}
                      </Select>
                    </div>
                    <div>
                      <Label>Reagent lot (optional)</Label>
                      <Select value={selectedLot} disabled={resultsLocked} onChange={(e) => setSelectedLot(e.target.value ? Number(e.target.value) : "")}>
                        <option value="">-- Not recorded --</option>
                        {reagentLots.map((l) => <option key={l.id} value={l.id}>{l.item_name} / {l.lot_no}{l.expiry_date ? ` (exp ${l.expiry_date})` : ""}</option>)}
                      </Select>
                    </div>
                  </div>
                  {detail.parameters.length > 0 && (
                    <div
                      className="diag-note-box"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!ocrScanning) void handleOcrUpload(e.dataTransfer.files?.[0]);
                      }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", border: "1.5px dashed #94a3b8", marginBottom: "0.75rem" }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <strong>Scan result printout to auto-fill</strong>
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {ocrScanning
                            ? `Reading ${ocrFileName} with OCR…`
                            : ocrFileName
                              ? `Last scanned: ${ocrFileName}`
                              : "Upload or drop an analyzer printout or lab report image (any image format) to fill the values below."}
                        </div>
                      </div>
                      <label className={`ui-button ${ocrScanning ? "secondary" : "primary"}`} style={{ cursor: ocrScanning ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                        {ocrScanning ? "Scanning…" : "⬆ Upload Image"}
                        <input
                          type="file"
                          accept="image/*,.tif,.tiff,.bmp,.webp,.gif"
                          disabled={ocrScanning}
                          style={{ display: "none" }}
                          onChange={(e) => {
                            void handleOcrUpload(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  )}
                  {equipmentHold && (
                    <div className="diag-note-box diag-note-critical">
                      This equipment has an open QC hold and cannot be used to finalize results until the hold is released from Quality &amp; Equipment.
                    </div>
                  )}
                  {unavailableEquipment && (
                    <div className="diag-note-box diag-note-critical">
                      {unavailableEquipment.name} cannot be used for results ({unavailableEquipment.reason}). Fix it in Quality &amp; Equipment or select another analyzer.
                    </div>
                  )}
                  <table className="diag-data-table">
                    <thead><tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Reference range</th><th>Flag</th></tr></thead>
                    <tbody>
                      {detail.parameters.map((p) => {
                        const existing = detail.results.find((r) => r.parameter_id === p.id);
                        const flag = computeFlag(p, resultValues[p.id]) ?? (p.data_type === "numeric" ? null : existing?.flag);
                        return (
                          <tr key={p.id} className={flag && flag !== "normal" ? `diag-row-${flag}` : undefined}>
                            <td>{p.name}</td>
                            <td>
                              <Input
                                value={resultValues[p.id] || ""}
                                className={ocrFilledIds.has(p.id) ? "diag-ocr-filled" : undefined}
                                title={ocrFilledIds.has(p.id) ? "Filled by OCR -- check against the printout" : undefined}
                                onChange={(e) => {
                                  setResultValues({ ...resultValues, [p.id]: e.target.value });
                                  if (ocrFilledIds.has(p.id)) setOcrFilledIds((prev) => { const next = new Set(prev); next.delete(p.id); return next; });
                                }}
                                disabled={resultsLocked}
                              />
                            </td>
                            <td>{p.unit || "-"}</td>
                            <td>{p.ref_text || (p.ref_low != null || p.ref_high != null ? `${p.ref_low ?? ""} - ${p.ref_high ?? ""}` : "-")}</td>
                            <td>{flag && <span className={`diag-flag-${flag}`}>{flag.replace("_", " ")}</span>}</td>
                          </tr>
                        );
                      })}
                      {detail.parameters.length === 0 && <tr><td colSpan={5} className="diag-empty">No parameters configured for this test in the catalogue.</td></tr>}
                    </tbody>
                  </table>
                  <div className="diag-form-actions">
                    <Button variant="secondary" disabled={saving || resultsLocked || !!unavailableEquipment} onClick={() => void saveResults(true)}>Save draft</Button>
                    <Button variant="primary" disabled={saving || resultsLocked || !!equipmentHold || !!unavailableEquipment} onClick={() => void saveResults(false)}>
                      {detail.results.some((r) => !r.is_draft) ? "Re-finalize results" : "Finalize results"}
                    </Button>
                    <Button variant="ghost" onClick={() => setReferralOpen((v) => !v)}>External lab tracking</Button>
                    {onNavigate && detail.report_id && <Button variant="ghost" onClick={goToReport}>Go to report</Button>}
                  </div>
                  {!!detail.external_referrals?.length && (
                    <table className="diag-data-table" style={{ marginTop: "0.75rem" }}>
                      <thead><tr><th>External lab</th><th>Dispatched</th><th>Expected TAT</th><th>Report</th><th></th></tr></thead>
                      <tbody>
                        {detail.external_referrals.map((r) => (
                          <tr key={r.id}>
                            <td>{r.vendor_name || "-"}</td>
                            <td>{r.dispatched_at ? new Date(r.dispatched_at).toLocaleString() : "-"}{r.dispatched_by ? ` by ${r.dispatched_by}` : ""}</td>
                            <td>{r.expected_turnaround || "-"}</td>
                            <td>{r.received_report_at ? `Received ${new Date(r.received_report_at).toLocaleString()}` : "Awaiting report"}</td>
                            <td>{!r.received_report_at && <Button size="sm" variant="ghost" onClick={() => void markReferralReceived(r.id)}>Mark report received</Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {referralOpen && openReferral && (
                    <div className="diag-note-box">Already dispatched to {openReferral.vendor_name || "an external lab"} -- mark that report received before sending again.</div>
                  )}
                  {referralOpen && !openReferral && (
                    <div className="diag-form-grid">
                      <div><Label>Referral laboratory</Label>
                        <Select value={referralVendor} onChange={(e) => setReferralVendor(e.target.value ? Number(e.target.value) : "")}>
                          <option value="">-- Select --</option>
                          {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                        </Select>
                      </div>
                      <div><Label>Expected turnaround</Label><Input value={referralTat} onChange={(e) => setReferralTat(e.target.value)} placeholder="e.g. 48 hours" /></div>
                      <div className="diag-form-full"><Button variant="primary" disabled={!referralVendor} onClick={() => void sendExternalReferral()}>Dispatch to external lab</Button></div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
