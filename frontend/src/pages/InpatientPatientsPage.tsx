import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type OccupiedBed = {
  id: number;
  patient_id: string;
  patient_name: string;
  ward: string;
  room_no: string;
  bed_no: string;
  amount_per_day: number;
  total_days: number;
  total_amount: number;
  allocated_at: string;
  payer_type?: "self" | "insurance";
  insurance_provider?: string | null;
  insurance_policy_no?: string | null;
};

type Admission = { id: number; notes?: string; admission_date?: string; created_at?: string };

type DischargedAdmission = {
  admission_id: number;
  patient_id: string;
  name: string;
  last_name?: string;
  phone?: string;
  admission_date?: string;
  discharge_date?: string;
  discharged_at?: string;
  ward?: string;
  room_no?: string;
  bed_no?: string;
};

type DischargeBillPreview = {
  days_stayed: number;
  rate_per_day: number;
  bed_total: number;
  pharmacy_items: { id: number; medicine_name: string; amount: number }[];
  pharmacy_total: number;
  diag_items: { id: number; service_name: string; amount: number }[];
  diag_total: number;
  grand_total: number;
};

export default function InpatientPatientsPage({ setNotice, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<"admitted" | "discharged">("admitted");
  const [inpatients, setInpatients] = useState<OccupiedBed[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewPatient, setViewPatient] = useState<OccupiedBed | null>(null);
  const [viewAdmissions, setViewAdmissions] = useState<Admission[]>([]);
  const [loadingAdmissions, setLoadingAdmissions] = useState(false);

  // Discharged Patients history
  const [discharged, setDischarged] = useState<DischargedAdmission[]>([]);
  const [loadingDischarged, setLoadingDischarged] = useState(false);
  const [dischargedLoaded, setDischargedLoaded] = useState(false);
  const [dischargeSearch, setDischargeSearch] = useState("");
  const [dischargeFromDate, setDischargeFromDate] = useState("");
  const [dischargeToDate, setDischargeToDate] = useState("");

  // Discharge & Bill sub-view within the patient modal
  const [dischargeStep, setDischargeStep] = useState<"view" | "bill">("view");
  const [dischargePreview, setDischargePreview] = useState<DischargeBillPreview | null>(null);
  const [loadingDischargePreview, setLoadingDischargePreview] = useState(false);
  const [dischargeForm, setDischargeForm] = useState({
    discount: "0",
    advance_paid: "0",
    payment_mode: "cash",
    notes: "Discharged in stable condition",
  });
  const [submittingDischarge, setSubmittingDischarge] = useState(false);

  const loadInpatients = async () => {
    setLoading(true);
    try {
      // Currently admitted = currently occupying a real, allocated bed.
      const data = await apiFetch<{ occupied?: OccupiedBed[] }>("/api/bed/occupancy");
      setInpatients(data.occupied || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load inpatients.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInpatients();
  }, []);

  const loadDischarged = async () => {
    setLoadingDischarged(true);
    try {
      const params = new URLSearchParams();
      if (dischargeSearch.trim()) params.set("q", dischargeSearch.trim());
      if (dischargeFromDate) params.set("from_date", dischargeFromDate);
      if (dischargeToDate) params.set("to_date", dischargeToDate);
      const data = await apiFetch<{ discharged?: DischargedAdmission[] }>(`/api/admissions/discharged?${params.toString()}`);
      setDischarged(data.discharged || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load discharged patients.");
    } finally {
      setLoadingDischarged(false);
      setDischargedLoaded(true);
    }
  };

  useEffect(() => {
    if (activeTab === "discharged" && !dischargedLoaded) {
      void loadDischarged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const openView = async (bed: OccupiedBed) => {
    setViewPatient(bed);
    setDischargeStep("view");
    setDischargePreview(null);
    setLoadingAdmissions(true);
    try {
      const data = await apiFetch<{ admissions?: Admission[] }>(`/api/patients/${encodeURIComponent(bed.patient_id)}/admissions`);
      setViewAdmissions(data.admissions || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load admission history.");
    } finally {
      setLoadingAdmissions(false);
    }
  };

  // Step 1: preview the bed + unbilled pharmacy/diagnostics charges before
  // actually discharging -- see confirmDischargeBill for the real settlement.
  const openDischargeBill = async (bed: OccupiedBed) => {
    setDischargeStep("bill");
    setDischargePreview(null);
    setDischargeForm({
      discount: "0",
      advance_paid: "0",
      // An insured stay is billed to the insurer; nothing is collected from the patient by default.
      payment_mode: bed.payer_type === "insurance" ? "insurance" : "cash",
      notes: "Discharged in stable condition",
    });
    setLoadingDischargePreview(true);
    try {
      const preview = await apiFetch<DischargeBillPreview>(`/api/bed/allocations/${bed.id}/discharge-bill`);
      setDischargePreview(preview);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to compute the discharge bill.");
      setDischargeStep("view");
    } finally {
      setLoadingDischargePreview(false);
    }
  };

  const confirmDischargeBill = async (bed: OccupiedBed) => {
    setSubmittingDischarge(true);
    try {
      const res = await apiFetch<{ invoice_no: string; total_amount: number; paid_amount: number; billed_to_insurer?: boolean; insurer_name?: string | null; insurer_due?: number }>(
        `/api/bed/allocations/${bed.id}/discharge`,
        {
          method: "POST",
          body: JSON.stringify({
            discount: Number(dischargeForm.discount) || 0,
            advance_paid: Number(dischargeForm.advance_paid) || 0,
            payment_mode: dischargeForm.payment_mode,
            notes: dischargeForm.notes,
          }),
        }
      );
      setNotice({
        type: "success",
        message: res.billed_to_insurer
          ? `${bed.patient_name} discharged from ${bed.ward} / ${bed.room_no} / ${bed.bed_no}. Invoice ${res.invoice_no} for ₹${res.total_amount.toFixed(2)} billed to ${res.insurer_name || "the insurer"} (₹${Number(res.insurer_due || 0).toFixed(2)} due from the insurer, nothing collected now).`
          : `${bed.patient_name} discharged from ${bed.ward} / ${bed.room_no} / ${bed.bed_no}. Invoice ${res.invoice_no} generated for ₹${res.total_amount.toFixed(2)} (₹${res.paid_amount.toFixed(2)} collected now).`,
      });
      setViewPatient(null);
      setDischargeStep("view");
      setDischargePreview(null);
      await loadInpatients();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to settle the discharge bill.");
    } finally {
      setSubmittingDischarge(false);
    }
  };

  const filtered = inpatients.filter((b) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return b.patient_name.toLowerCase().includes(q) || b.patient_id.toLowerCase().includes(q) || b.ward.toLowerCase().includes(q);
  });

  return (
    <div className="bed-management-page" style={{ padding: "18px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#64748b", fontWeight: 500, marginBottom: "14px" }}>
        <span style={{ color: "#3b82f6", cursor: "pointer" }} onClick={() => window.history.back()}>HospAI</span>
        <span style={{ color: "#94a3b8" }}>/</span>
        <span>IP Management</span>
        <span style={{ color: "#94a3b8" }}>/</span>
        <span style={{ color: "#0f172a", fontWeight: 600 }}>Inpatient Patients</span>
      </div>

      <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.02em" }}>Inpatient Patients</h1>
          <p style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
            {activeTab === "admitted" ? "Patients currently occupying an allocated bed." : "Discharge history — who left, and when."}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button
            variant={activeTab === "admitted" ? "primary" : "ghost"}
            style={activeTab === "admitted" ? { background: "#00828a", borderColor: "#00828a" } : { background: "#ffffff", border: "1px solid #cbd5e1" }}
            onClick={() => setActiveTab("admitted")}
          >
            Currently Admitted
          </Button>
          <Button
            variant={activeTab === "discharged" ? "primary" : "ghost"}
            style={activeTab === "discharged" ? { background: "#00828a", borderColor: "#00828a" } : { background: "#ffffff", border: "1px solid #cbd5e1" }}
            onClick={() => setActiveTab("discharged")}
          >
            Discharged Patients
          </Button>
        </div>
      </div>

      {activeTab === "admitted" && (
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>Currently Admitted ({inpatients.length})</h2>
            <div style={{ width: "300px" }}>
              <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search by patient, UHID, or ward" />
            </div>
          </div>

          <table className="sent-rx-table" style={{ width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Ward / Room / Bed</th>
                <th>Admitted</th>
                <th style={{ textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem" }}>Loading…</td></tr>}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem", color: "#94a3b8" }}>No patients currently admitted.</td></tr>
              )}
              {!loading && filtered.map((b) => (
                <tr key={b.id} onClick={() => void openView(b)} style={{ cursor: "pointer" }} title="Click row to view details">
                  <td>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{b.patient_name}</div>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>{b.patient_id}</div>
                  </td>
                  <td style={{ color: "#334155" }}>{b.ward} / {b.room_no} / {b.bed_no}</td>
                  <td style={{ color: "#64748b" }}>{new Date(b.allocated_at).toLocaleString()}</td>
                  <td style={{ textAlign: "center" }}>
                    <Button variant="ghost" onClick={(e) => { e.stopPropagation(); void openView(b); }}>View</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "discharged" && (
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>Discharged Patients ({discharged.length})</h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <Input value={dischargeSearch} onChange={(e) => setDischargeSearch(e.target.value)} placeholder="Search by patient or UHID" style={{ width: "220px" }} />
              <Input type="date" value={dischargeFromDate} onChange={(e) => setDischargeFromDate(e.target.value)} style={{ width: "150px" }} />
              <span style={{ color: "#94a3b8", fontSize: "12px" }}>to</span>
              <Input type="date" value={dischargeToDate} onChange={(e) => setDischargeToDate(e.target.value)} style={{ width: "150px" }} />
              <Button variant="secondary" onClick={() => void loadDischarged()} disabled={loadingDischarged}>
                {loadingDischarged ? "Searching..." : "Search"}
              </Button>
            </div>
          </div>

          <table className="sent-rx-table" style={{ width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Ward / Room / Bed</th>
                <th>Admitted</th>
                <th>Discharged</th>
              </tr>
            </thead>
            <tbody>
              {loadingDischarged && <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem" }}>Loading…</td></tr>}
              {!loadingDischarged && discharged.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem", color: "#94a3b8" }}>No discharged patients found for this filter.</td></tr>
              )}
              {!loadingDischarged && discharged.map((d) => (
                <tr key={d.admission_id}>
                  <td>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{`${d.name || ""} ${d.last_name || ""}`.trim() || d.patient_id}</div>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>{d.patient_id}</div>
                  </td>
                  <td style={{ color: "#334155" }}>
                    {d.ward ? `${d.ward} / ${d.room_no || "-"} / ${d.bed_no || "-"}` : "-"}
                  </td>
                  <td style={{ color: "#64748b" }}>{d.admission_date ? new Date(d.admission_date).toLocaleString() : "-"}</td>
                  <td style={{ color: "#0f172a", fontWeight: 600 }}>
                    {d.discharged_at ? new Date(d.discharged_at).toLocaleString() : (d.discharge_date || "-")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!viewPatient} onClose={() => { setViewPatient(null); setDischargeStep("view"); }} title={viewPatient ? `${viewPatient.patient_name} (${viewPatient.patient_id})` : ""}>
        {viewPatient && dischargeStep === "view" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13.5 }}>
              <div><strong>Ward / Room / Bed:</strong> {viewPatient.ward} / {viewPatient.room_no} / {viewPatient.bed_no}</div>
              <div><strong>Rate / Day:</strong> ₹{Number(viewPatient.amount_per_day).toFixed(2)}</div>
              <div><strong>Allocated:</strong> {new Date(viewPatient.allocated_at).toLocaleString()}</div>
            </div>
            <div>
              <h4 style={{ margin: "6px 0" }}>Admission Notes</h4>
              {loadingAdmissions && <p className="muted">Loading…</p>}
              {!loadingAdmissions && viewAdmissions.length === 0 && <p className="muted">No admission notes recorded.</p>}
              {!loadingAdmissions && viewAdmissions.map((a) => (
                <div key={a.id} style={{ fontSize: 13, padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <div style={{ color: "#64748b", fontSize: 11 }}>{a.admission_date || a.created_at}</div>
                  <div>{a.notes || "-"}</div>
                </div>
              ))}
            </div>
            <Button variant="destructive" onClick={() => void openDischargeBill(viewPatient)}>Discharge</Button>
          </div>
        )}

        {viewPatient && dischargeStep === "bill" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {loadingDischargePreview && <p className="muted">Computing stay duration and unbilled charges...</p>}

            {!loadingDischargePreview && dischargePreview && (
              <>
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 14px", fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#64748b" }}>Bed charges ({dischargePreview.days_stayed} day{dischargePreview.days_stayed === 1 ? "" : "s"} × ₹{dischargePreview.rate_per_day.toFixed(2)}/day)</span>
                    <strong>₹{dischargePreview.bed_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#64748b" }}>Unbilled pharmacy ({dischargePreview.pharmacy_items.length} item{dischargePreview.pharmacy_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{dischargePreview.pharmacy_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#64748b" }}>Unbilled lab / imaging ({dischargePreview.diag_items.length} item{dischargePreview.diag_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{dischargePreview.diag_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ borderTop: "1px dashed #cbd5e1", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
                    <span style={{ fontWeight: 700, color: "#0f172a" }}>Grand Total</span>
                    <strong style={{ color: "#00828a" }}>₹{dischargePreview.grand_total.toFixed(2)}</strong>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <Label>Discount (₹)</Label>
                    <Input type="number" min={0} value={dischargeForm.discount} onChange={(e) => setDischargeForm((p) => ({ ...p, discount: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Advance already paid (₹)</Label>
                    <Input type="number" min={0} value={dischargeForm.advance_paid} onChange={(e) => setDischargeForm((p) => ({ ...p, advance_paid: e.target.value }))} />
                  </div>
                </div>

                <div>
                  <Label>{dischargeForm.payment_mode === "insurance" ? "Payment mode" : "Payment mode for balance collected now"}</Label>
                  <Select value={dischargeForm.payment_mode} onChange={(e) => setDischargeForm((p) => ({ ...p, payment_mode: e.target.value }))}>
                    <option value="insurance" disabled={viewPatient?.payer_type !== "insurance"}>
                      {viewPatient?.payer_type === "insurance"
                        ? `Insurance: bill ${viewPatient.insurance_provider || "the insurer"}`
                        : "Insurance (payer is Self-pay)"}
                    </option>
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                    <option value="upi">UPI</option>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cheque">Cheque</option>
                  </Select>
                </div>

                <div>
                  <Label>Discharge notes</Label>
                  <Input value={dischargeForm.notes} onChange={(e) => setDischargeForm((p) => ({ ...p, notes: e.target.value }))} />
                </div>

                <div style={{ background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#1e40af" }}>
                  {dischargeForm.payment_mode === "insurance" ? (
                    <>
                      Billed to {viewPatient?.insurance_provider || "the insurer"}
                      {viewPatient?.insurance_policy_no ? ` (Policy ${viewPatient.insurance_policy_no})` : ""}:{" "}
                      <strong>₹{Math.max(0, dischargePreview.grand_total - (Number(dischargeForm.discount) || 0) - (Number(dischargeForm.advance_paid) || 0)).toFixed(2)}</strong>.
                      Nothing is collected from the patient now; a claim is raised and the insurer's payment is recorded later in Insurance Claims.
                    </>
                  ) : (
                    <>Amount to collect now: <strong>₹{Math.max(0, dischargePreview.grand_total - (Number(dischargeForm.discount) || 0) - (Number(dischargeForm.advance_paid) || 0)).toFixed(2)}</strong>.</>
                  )}{" "}
                  Confirming will generate the final invoice, mark this admission discharged, and free the bed.
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <Button variant="ghost" onClick={() => setDischargeStep("view")}>Back</Button>
                  <Button
                    variant="primary"
                    disabled={submittingDischarge}
                    onClick={() => void confirmDischargeBill(viewPatient)}
                    style={{ background: "#00828a", borderColor: "#00828a" }}
                  >
                    {submittingDischarge ? "Settling..." : "Confirm Discharge & Generate Bill"}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
