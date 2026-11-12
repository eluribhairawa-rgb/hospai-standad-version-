import { useEffect, useState } from "react";
import PhoneInput from "../components/PhoneInput";
import { cleanCountryCode, toWhatsAppNumber, validateMobileByCountry } from "../lib/phone";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Tabs, TabsTrigger, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { printViaIframe } from "../lib/printViaIframe";
import type { ReportRow, ReportDetail } from "../lib/diagReports";
import { IMAGING_FIELDS, PENDING_REPORT_KEY, patientName, buildReportPrintHtml, buildWhatsAppMessage } from "../lib/diagReports";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type CriticalAlert = {
  id: number; order_item_id: number; service_name: string; patient_id: string; order_no: string;
  patient_first_name?: string; patient_last_name?: string; raised_at: string; contacted_person?: string; ack_method?: string;
  escalated?: boolean; escalated_to?: string; escalated_at?: string;
};

const STATUS_OPTIONS = [
  { key: "pending_review", label: "For review" },
  { key: "draft", label: "Drafts" },
  { key: "released", label: "Released" },
  { key: "amended", label: "Amendments" },
  { key: "returned_for_correction", label: "Returned for correction" },
  { key: "authorized", label: "Authorized" },
];

const EDITABLE_STATUSES = new Set(["draft", "returned_for_correction"]);

type WhatsAppRecipient = "patient" | "doctor";

const FOUR_EYES_HINT = "You entered these results or drafted this report, so another authorized user must review and authorize it (four-eyes rule).";

export default function LabDiagnosticsReportsPage({ setNotice, onNavigate }: Props) {
  const [status, setStatus] = useState("pending_review");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReportDetail | null>(null);
  const [contentDraft, setContentDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [aiDrafting, setAiDrafting] = useState(false);

  const [alerts, setAlerts] = useState<CriticalAlert[]>([]);
  const [alertModal, setAlertModal] = useState<CriticalAlert | null>(null);
  const [contactedPerson, setContactedPerson] = useState("");
  const [ackMethod, setAckMethod] = useState("verbal_readback");
  const [escalatedTo, setEscalatedTo] = useState("");

  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [whatsAppRecipient, setWhatsAppRecipient] = useState<WhatsAppRecipient>("patient");
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [whatsAppPhoneCode, setWhatsAppPhoneCode] = useState("+91");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ reports: ReportRow[] }>(`/api/diag/reports?status=${status}`);
      setRows(data.reports || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load reports.");
    } finally {
      setLoading(false);
    }
  };

  const loadAlerts = async () => {
    try {
      const data = await apiFetch<{ alerts: CriticalAlert[] }>(`/api/diag/critical-alerts?open_only=true`);
      setAlerts(data.alerts || []);
    } catch {
      /* non-blocking */
    }
  };

  // Switching tabs must not leave a report from another tab open in the detail pane.
  const changeStatus = (key: string) => {
    setStatus(key);
    setSelected((prev) => (prev && prev.status === key ? prev : null));
  };

  useEffect(() => { void load(); }, [status]);
  useEffect(() => { void loadAlerts(); }, []);
  useEffect(() => {
    // Arrived via "Go to report" from Laboratory/Imaging/Orders -- open that report on its own status tab.
    let pending: string | null = null;
    try {
      pending = localStorage.getItem(PENDING_REPORT_KEY);
      localStorage.removeItem(PENDING_REPORT_KEY);
    } catch { /* storage unavailable */ }
    if (!pending) return;
    apiFetch<ReportDetail>(`/api/diag/reports/${pending}`)
      .then((detail) => {
        setSelected(detail);
        setContentDraft(detail.content || {});
        if (STATUS_OPTIONS.some((o) => o.key === detail.status)) setStatus(detail.status);
      })
      .catch(() => {});
  }, []);

  const openReport = async (reportId: number) => {
    try {
      const detail = await apiFetch<ReportDetail>(`/api/diag/reports/${reportId}`);
      setSelected(detail);
      setContentDraft(detail.content || {});
    } catch (err: any) {
      reportError(setNotice, err, "Could not load report.");
    }
  };

  const refresh = async () => {
    if (selected) await openReport(selected.id);
    void load();
    void loadAlerts();
  };

  // Shared wrapper for the report actions below: run the request, surface a
  // success notice, then refresh the worklist/detail. Errors are reported and
  // swallowed so the UI stays interactive.
  const runReportAction = async (action: () => Promise<void>, successMessage: string, errorMessage: string) => {
    try {
      await action();
      setNotice({ type: "success", message: successMessage });
      await refresh();
    } catch (err: any) {
      reportError(setNotice, err, errorMessage);
    }
  };

  const saveContent = (reportId: number) =>
    apiFetch(`/api/diag/reports/${reportId}`, { method: "PUT", body: JSON.stringify({ content: contentDraft }) });

  const updateDraftField = (field: string, value: string) => {
    setContentDraft((prev) => ({ ...prev, [field]: value }));
  };

  // Drafts the summary from the entered results; added below any existing text, never saved until the user saves.
  const draftSummaryWithAi = async () => {
    if (!selected) return;
    setAiDrafting(true);
    try {
      const res = await apiFetch<{ summary: string; source: "ai" | "rule" }>(`/api/diag/reports/${selected.id}/ai-summary`, { method: "POST" });
      setContentDraft((prev) => ({ ...prev, summary: prev.summary?.trim() ? `${prev.summary.trim()}\n${res.summary}` : res.summary }));
      setNotice({
        type: "info",
        message: res.source === "ai" ? "AI draft added to the summary. Review and edit it before submitting." : "All values are within range -- summary filled.",
      });
    } catch (err: any) {
      reportError(setNotice, err, "Could not draft the summary.");
    } finally {
      setAiDrafting(false);
    }
  };

  const saveDraft = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveContent(selected.id);
      setNotice({ type: "success", message: "Draft saved." });
      await refresh();
    } catch (err: any) {
      reportError(setNotice, err, "Could not save draft.");
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!selected) return;
    const reportId = selected.id;
    void runReportAction(
      async () => {
        await saveContent(reportId);
        await apiFetch(`/api/diag/reports/${reportId}/submit`, { method: "POST" });
      },
      "Submitted for review.",
      "Could not submit report."
    );
  };

  const returnForCorrection = () => {
    if (!selected) return;
    const reason = window.prompt("Reason for returning this report for correction:");
    if (!reason) return;
    const reportId = selected.id;
    void runReportAction(
      () => apiFetch(`/api/diag/reports/${reportId}/return`, { method: "POST", body: JSON.stringify({ reason }) }),
      "Returned for correction.",
      "Could not return report."
    );
  };

  const authorize = (alsoRelease: boolean) => {
    if (!selected) return;
    const reportId = selected.id;
    void runReportAction(
      () => apiFetch(`/api/diag/reports/${reportId}/authorize`, { method: "POST", body: JSON.stringify({ also_release: alsoRelease }) }),
      alsoRelease ? "Authorized and released." : "Authorized.",
      "Could not authorize report."
    );
  };

  const release = () => {
    if (!selected) return;
    const reportId = selected.id;
    void runReportAction(
      () => apiFetch(`/api/diag/reports/${reportId}/release`, { method: "POST" }),
      "Released.",
      "Could not release report."
    );
  };

  const amend = async () => {
    if (!selected) return;
    const reason = window.prompt("Reason for this amendment:");
    if (!reason) return;
    try {
      const res = await apiFetch<{ report_id: number }>(`/api/diag/reports/${selected.id}/amend`, {
        method: "POST",
        body: JSON.stringify({ reason, content: contentDraft }),
      });
      setNotice({ type: "success", message: `Amendment (version ${(selected.version || 1) + 1}) created as a new draft.` });
      const detail = await apiFetch<ReportDetail>(`/api/diag/reports/${res.report_id}`);
      setSelected(detail);
      setContentDraft(detail.content || {});
      void load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not create amendment.");
    }
  };

  const resolveAlert = async () => {
    if (!alertModal) return;
    if (!contactedPerson.trim()) {
      setNotice({ type: "warning", message: "Record who was contacted." });
      return;
    }
    try {
      await apiFetch(`/api/diag/critical-alerts/${alertModal.id}/contact`, {
        method: "POST",
        body: JSON.stringify({ contacted_person: contactedPerson, ack_method: ackMethod }),
      });
      await apiFetch(`/api/diag/critical-alerts/${alertModal.id}/resolve`, { method: "POST" });
      setNotice({ type: "success", message: "Critical result acknowledged and resolved." });
      setAlertModal(null);
      setContactedPerson("");
      setEscalatedTo("");
      void loadAlerts();
    } catch (err: any) {
      reportError(setNotice, err, "Could not resolve this alert.");
    }
  };

  // Used when the ordering clinician can't be reached directly -- escalates
  // to a supervisor/on-call/nursing-in-charge without marking the alert
  // resolved. Contact + resolve still has to happen once someone does answer.
  const escalateAlert = async () => {
    if (!alertModal) return;
    if (!escalatedTo.trim()) {
      setNotice({ type: "warning", message: "Record who this was escalated to." });
      return;
    }
    try {
      await apiFetch(`/api/diag/critical-alerts/${alertModal.id}/escalate`, {
        method: "POST",
        body: JSON.stringify({ escalated_to: escalatedTo }),
      });
      setNotice({ type: "warning", message: "Escalated. This alert still needs to be contacted & resolved once someone responds." });
      setAlertModal({ ...alertModal, escalated: true, escalated_to: escalatedTo, escalated_at: new Date().toISOString() });
      void loadAlerts();
    } catch (err: any) {
      reportError(setNotice, err, "Could not escalate this alert.");
    }
  };

  const printReport = () => {
    if (!selected) return;
    printViaIframe(buildReportPrintHtml(selected, contentDraft));
  };

  const openWhatsAppModal = () => {
    if (!selected) return;
    setWhatsAppRecipient("patient");
    setWhatsAppPhone(selected.order_item?.patient?.phone || "");
    setWhatsAppPhoneCode(cleanCountryCode(selected.order_item?.patient?.phone_country_code));
    setWhatsAppMessage(buildWhatsAppMessage(selected, contentDraft));
    setWhatsAppModalOpen(true);
  };

  const selectWhatsAppRecipient = (recipient: WhatsAppRecipient) => {
    setWhatsAppRecipient(recipient);
    setWhatsAppPhone(recipient === "patient" ? selected?.order_item?.patient?.phone || "" : "");
    setWhatsAppPhoneCode(recipient === "patient" ? cleanCountryCode(selected?.order_item?.patient?.phone_country_code) : "+91");
  };

  const sendWhatsApp = () => {
    const phoneError = validateMobileByCountry(whatsAppPhone, whatsAppPhoneCode, true);
    if (phoneError) {
      setNotice({ type: "warning", message: phoneError });
      return;
    }
    const countryCoded = toWhatsAppNumber(whatsAppPhoneCode, whatsAppPhone);
    window.open(`https://wa.me/${countryCoded}?text=${encodeURIComponent(whatsAppMessage)}`, "_blank");
    setNotice({ type: "success", message: "WhatsApp chat launched with report summary." });
    setWhatsAppModalOpen(false);
  };

  const isEditable = !!selected && EDITABLE_STATUSES.has(selected.status);
  const isLatestVersion = !!selected && selected.all_versions.every((v) => v.version <= selected.version);

  return (
    <div className="diag-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <Tabs>
          {STATUS_OPTIONS.map((t) => (
            <TabsTrigger
              key={t.key}
              active={status === t.key}
              onClick={() => changeStatus(t.key)}
            >
              {t.label}
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
              onClick={() => onNavigate("diag-reports-history")}
            >
              Reports History →
            </Button>
          )}
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="diag-alert-banner">
          <span>{alerts.length} critical result(s) awaiting acknowledgement</span>
          <Button size="sm" variant="destructive" onClick={() => { setAlertModal(alerts[0]); setContactedPerson(""); setAckMethod("verbal_readback"); setEscalatedTo(""); }}>Open alert</Button>
        </div>
      )}

      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Report worklist</h3></div>
          <Select value={status} onChange={(e) => changeStatus(e.target.value)}>
            {STATUS_OPTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
          <div style={{ marginTop: "0.75rem" }}>
            {loading && <p className="muted">Loading...</p>}
            {!loading && rows.length === 0 && <p className="muted">No reports in this state.</p>}
            {rows.map((r) => (
              <div key={r.id} className={`diag-worklist-row ${selected?.id === r.id ? "active" : ""}`} onClick={() => void openReport(r.id)}>
                <div className="diag-worklist-row-top">
                  <span>{patientName(r.patient_first_name, r.patient_last_name, r.patient_id)}</span>
                  {r.has_open_critical && <span className="diag-badge diag-badge-critical">Critical</span>}
                  {r.tat_status === "overdue" && <span className="diag-badge diag-badge-critical">Overdue</span>}
                  {r.tat_status === "near_due" && <span className="diag-badge diag-badge-warning">Near TAT</span>}
                </div>
                <div className="diag-worklist-row-meta"><span>{r.service_name}</span><span>{r.department_type}</span><span>v{r.version}</span></div>
              </div>
            ))}
          </div>
        </div>

        <div className="diag-card">
          {!selected && <p className="muted">Select a report to review.</p>}
          {selected && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{selected.service_name} <span className="diag-badge diag-badge-info">v{selected.version}</span></h3>
                  <div className="diag-detail-meta">
                    <span>UHID: {selected.patient_id}</span>
                    <span>Order: {selected.order_no}</span>
                    <span>Status: {selected.status.replace(/_/g, " ")}</span>
                    {selected.order_item?.priority && <span>{selected.order_item.priority}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {onNavigate && selected.report_type === "LAB" && (
                    <Button size="sm" variant="secondary" onClick={() => onNavigate("diag-laboratory")}>
                      View in Lab
                    </Button>
                  )}
                  {onNavigate && selected.report_type === "IMAGING" && (
                    <Button size="sm" variant="secondary" onClick={() => onNavigate("diag-imaging")}>
                      View in Imaging
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={printReport}>Open report preview</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={openWhatsAppModal}
                    style={{ background: "#25D366", color: "#fff", borderColor: "#25D366", fontWeight: 600 }}
                  >
                    Share via WhatsApp
                  </Button>
                </div>
              </div>

              {selected.status === "pending_review" && selected.four_eyes_blocked && <div className="diag-note-box">{FOUR_EYES_HINT}</div>}
              {selected.status === "returned_for_correction" && selected.return_reason && <div className="diag-note-box">Returned for correction: {selected.return_reason}</div>}
              {selected.amendment_reason && <div className="diag-note-box">Amendment reason: {selected.amendment_reason}</div>}
              {selected.report_type === "LAB" && isEditable && (
                <div className="diag-note-box">To correct result values, open this test in the Laboratory worklist, edit and finalize again, then submit here.</div>
              )}

              {selected.report_type === "LAB" && (
                <>
                  <div className="diag-section-title">Results</div>
                  <table className="diag-data-table">
                    <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference range</th><th>Flag</th></tr></thead>
                    <tbody>
                      {(selected.order_item?.results || []).map((r: any) => (
                        <tr key={r.id} className={r.flag && r.flag !== "normal" ? `diag-row-${r.flag}` : undefined}>
                          <td>{r.parameter_name}</td>
                          <td>{r.value_numeric ?? r.value_text ?? "-"}</td>
                          <td>{r.unit || "-"}</td>
                          <td>{r.ref_range_text || `${r.ref_low ?? ""}-${r.ref_high ?? ""}`}</td>
                          <td>{r.flag && <span className={`diag-flag-${r.flag}`}>{r.flag.replace("_", " ")}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="diag-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>Summary / interpretation</span>
                    {isEditable && (selected.order_item?.results || []).length > 0 && (
                      <Button size="sm" variant="secondary" disabled={aiDrafting} onClick={() => void draftSummaryWithAi()}>
                        {aiDrafting ? "Drafting…" : "✨ AI draft"}
                      </Button>
                    )}
                  </div>
                  <Textarea
                    rows={3}
                    value={contentDraft.summary || ""}
                    disabled={!isEditable}
                    onChange={(e) => updateDraftField("summary", e.target.value)}
                  />
                  {isEditable && <p className="diag-ai-hint">The AI draft is only a suggestion. Check it against the results before submitting.</p>}
                </>
              )}

              {selected.report_type === "IMAGING" && (
                <div className="diag-form-grid">
                  {IMAGING_FIELDS.map((field) => (
                    <div key={field} className="diag-form-full">
                      <Label>{field.replace(/_/g, " ")}</Label>
                      <Textarea
                        rows={field === "findings" ? 4 : 2}
                        value={contentDraft[field] || ""}
                        disabled={!isEditable}
                        onChange={(e) => updateDraftField(field, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="diag-form-actions">
                {isEditable && (
                  <>
                    <Button variant="secondary" disabled={saving} onClick={() => void saveDraft()}>Save draft</Button>
                    <Button variant="primary" disabled={saving} onClick={submit}>Submit for review</Button>
                  </>
                )}
                {selected.status === "pending_review" && (
                  <>
                    <Button variant="ghost" onClick={returnForCorrection}>Return for correction</Button>
                    <Button variant="secondary" disabled={!!selected.four_eyes_blocked} title={selected.four_eyes_blocked ? FOUR_EYES_HINT : undefined} onClick={() => authorize(false)}>Authorize</Button>
                    <Button variant="primary" disabled={!!selected.four_eyes_blocked} title={selected.four_eyes_blocked ? FOUR_EYES_HINT : undefined} onClick={() => authorize(true)}>Authorize & release</Button>
                  </>
                )}
                {selected.status === "authorized" && <Button variant="primary" onClick={release}>Release</Button>}
                {(selected.status === "released" || selected.status === "amended") && isLatestVersion && (
                  <Button variant="secondary" onClick={() => void amend()}>Create amendment</Button>
                )}
              </div>

              {selected.all_versions.length > 1 && (
                <>
                  <div className="diag-section-title">Version history</div>
                  <div className="diag-timeline">
                    {selected.all_versions.map((v) => (
                      <div key={v.id} className="diag-timeline-item"><span className="diag-timeline-dot" />Version {v.version} -- {v.status}</div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {alertModal && (
        <div className="diag-card" style={{ position: "fixed", inset: "10% 20%", zIndex: 50, overflowY: "auto" }}>
          <div className="diag-card-header">
            <h3>Critical result -- {alertModal.service_name}</h3>
            <Button variant="ghost" size="sm" onClick={() => setAlertModal(null)}>Close</Button>
          </div>
          <p>Patient: {patientName(alertModal.patient_first_name, alertModal.patient_last_name, alertModal.patient_id)} ({alertModal.patient_id}) -- Order {alertModal.order_no}</p>
          {alertModal.escalated && (
            <div className="diag-note-box diag-note-critical">
              Escalated to {alertModal.escalated_to} {alertModal.escalated_at ? `at ${new Date(alertModal.escalated_at).toLocaleString()}` : ""} -- still needs to be contacted &amp; resolved.
            </div>
          )}
          <div className="diag-form-grid">
            <div>
              <Label>Person contacted</Label>
              <Input value={contactedPerson} onChange={(e) => setContactedPerson(e.target.value)} placeholder="Dr. name / nurse station" />
            </div>
            <div>
              <Label>Acknowledgement method</Label>
              <Select value={ackMethod} onChange={(e) => setAckMethod(e.target.value)}>
                <option value="verbal_readback">Verbal read-back</option>
                <option value="written">Written</option>
                <option value="callback">Callback</option>
              </Select>
            </div>
            <div className="diag-form-full">
              <Button variant="primary" onClick={() => void resolveAlert()}>Record contact & resolve</Button>
            </div>
          </div>

          <div className="diag-section-title" style={{ marginTop: "1rem" }}>Can't reach the ordering clinician?</div>
          <div className="diag-form-grid">
            <div>
              <Label>Escalate to</Label>
              <Input value={escalatedTo} onChange={(e) => setEscalatedTo(e.target.value)} placeholder="On-call supervisor / nursing in-charge" />
            </div>
            <div className="diag-form-full">
              <Button variant="secondary" onClick={() => void escalateAlert()}>Escalate</Button>
            </div>
          </div>
        </div>
      )}

      <Modal open={whatsAppModalOpen} onClose={() => setWhatsAppModalOpen(false)} title="Share Diagnostic Report via WhatsApp">
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div>
            <Label>Recipient type</Label>
            <div style={{ display: "flex", gap: "0.625rem", marginTop: "0.25rem" }}>
              <Button
                type="button"
                variant={whatsAppRecipient === "patient" ? "primary" : "secondary"}
                size="sm"
                onClick={() => selectWhatsAppRecipient("patient")}
              >
                Patient
              </Button>
              <Button
                type="button"
                variant={whatsAppRecipient === "doctor" ? "primary" : "secondary"}
                size="sm"
                onClick={() => selectWhatsAppRecipient("doctor")}
              >
                Referring doctor
              </Button>
            </div>
          </div>

          <div>
            <Label>WhatsApp mobile number</Label>
            <PhoneInput required countryCode={whatsAppPhoneCode} value={whatsAppPhone}
              onChange={({ countryCode, value }) => { setWhatsAppPhoneCode(countryCode); setWhatsAppPhone(value); }} />
          </div>

          <div>
            <Label>Clinical report message preview</Label>
            <Textarea
              rows={8}
              value={whatsAppMessage}
              onChange={(e) => setWhatsAppMessage(e.target.value)}
              style={{ fontFamily: "monospace", fontSize: "0.75rem", lineHeight: 1.4 }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button variant="ghost" onClick={() => setWhatsAppModalOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={sendWhatsApp}
              style={{ background: "#25D366", borderColor: "#25D366", fontWeight: 700 }}
            >
              Launch WhatsApp chat
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
