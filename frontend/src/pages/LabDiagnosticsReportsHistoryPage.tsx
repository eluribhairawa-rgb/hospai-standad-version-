import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { printViaIframe } from "../lib/printViaIframe";
import type { ReportRow, ReportDetail } from "../lib/diagReports";
import { IMAGING_FIELDS, patientName, buildReportPrintHtml, buildWhatsAppMessage } from "../lib/diagReports";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

// A patient's real reports live across two statuses depending on whether an
// amendment was ever needed -- "History" means the finalized record, so this
// covers both by default. A separate "All statuses" scope is offered for
// audits that need drafts/returned/in-progress reports too.
const SCOPE_FINALIZED = "released,amended";
const SCOPE_OPTIONS = [
  { key: SCOPE_FINALIZED, label: "Finalized reports (Released & Amended)" },
  { key: "", label: "All statuses" },
];

const TYPE_OPTIONS = [
  { key: "", label: "Lab & Imaging" },
  { key: "LAB", label: "Laboratory only" },
  { key: "IMAGING", label: "Imaging only" },
];

const EDITABLE_STATUSES = new Set(["draft", "pending_review", "returned_for_correction", "authorized"]);

function statusBadgeClass(status: string): string {
  if (status === "released" || status === "amended") return "diag-badge-active";
  if (status === "returned_for_correction") return "diag-badge-critical";
  if (status === "authorized" || status === "pending_review") return "diag-badge-warning";
  return "diag-badge-info";
}

function reportDate(r: ReportRow): string {
  const raw = r.released_at || r.authorized_at || r.created_at;
  return raw ? new Date(raw).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-";
}

type WhatsAppRecipient = "patient" | "doctor";

export default function LabDiagnosticsReportsHistoryPage({ setNotice, onNavigate }: Props) {
  const [scope, setScope] = useState(SCOPE_FINALIZED);
  const [reportType, setReportType] = useState("");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReportDetail | null>(null);

  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [whatsAppRecipient, setWhatsAppRecipient] = useState<WhatsAppRecipient>("patient");
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (scope) params.set("status", scope);
      if (reportType) params.set("report_type", reportType);
      if (search.trim()) params.set("q", search.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const data = await apiFetch<{ reports: ReportRow[] }>(`/api/diag/reports?${params}`);
      setRows(data.reports || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load report history.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope, reportType]);
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 350);
    return () => window.clearTimeout(t);
  }, [search, dateFrom, dateTo]);

  const openReport = async (reportId: number) => {
    try {
      const detail = await apiFetch<ReportDetail>(`/api/diag/reports/${reportId}`);
      setSelected(detail);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load report.");
    }
  };

  const printReport = () => {
    if (!selected) return;
    printViaIframe(buildReportPrintHtml(selected, selected.content || {}));
  };

  const openWhatsAppModal = () => {
    if (!selected) return;
    setWhatsAppRecipient("patient");
    setWhatsAppPhone(selected.order_item?.patient?.phone || "");
    setWhatsAppMessage(buildWhatsAppMessage(selected, selected.content || {}));
    setWhatsAppModalOpen(true);
  };

  const selectWhatsAppRecipient = (recipient: WhatsAppRecipient) => {
    setWhatsAppRecipient(recipient);
    setWhatsAppPhone(recipient === "patient" ? selected?.order_item?.patient?.phone || "" : "");
  };

  const sendWhatsApp = () => {
    const digits = whatsAppPhone.replace(/[^0-9]/g, "");
    if (digits.length < 10) {
      setNotice({ type: "warning", message: "Enter a valid 10-digit mobile number." });
      return;
    }
    const countryCoded = digits.length === 10 ? `91${digits}` : digits;
    window.open(`https://wa.me/${countryCoded}?text=${encodeURIComponent(whatsAppMessage)}`, "_blank");
    setNotice({ type: "success", message: "WhatsApp chat launched with report summary." });
    setWhatsAppModalOpen(false);
  };

  const content: Record<string, string> = selected?.content || {};

  return (
    <div className="diag-page">
      <div className="diag-card" style={{ marginBottom: "1rem" }}>
        <div className="diag-card-header"><h3>Search report history</h3></div>
        <div className="diag-form-grid">
          <div className="diag-form-full">
            <Label>Patient name, UHID, or order number</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
          </div>
          <div>
            <Label>Report type</Label>
            <Select value={reportType} onChange={(e) => setReportType(e.target.value)}>
              {TYPE_OPTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </Select>
          </div>
          <div>
            <Label>Scope</Label>
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPE_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </div>
          <div>
            <Label>From date</Label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <Label>To date</Label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="diag-worklist-shell">
        <div className="diag-card">
          <div className="diag-card-header"><h3>Reports ({rows.length})</h3></div>
          <div style={{ marginTop: "0.75rem" }}>
            {loading && <p className="muted">Loading...</p>}
            {!loading && rows.length === 0 && <p className="muted">No reports match these filters.</p>}
            {rows.map((r) => (
              <div key={r.id} className={`diag-worklist-row ${selected?.id === r.id ? "active" : ""}`} onClick={() => void openReport(r.id)}>
                <div className="diag-worklist-row-top">
                  <span>{patientName(r.patient_first_name, r.patient_last_name, r.patient_id)}</span>
                  <span className={`diag-badge ${statusBadgeClass(r.status)}`}>{r.status.replace(/_/g, " ")}</span>
                </div>
                <div className="diag-worklist-row-meta">
                  <span>{r.service_name}</span>
                  <span>{r.report_type === "IMAGING" ? "Imaging" : "Lab"}</span>
                  <span>v{r.version}</span>
                  <span>{reportDate(r)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="diag-card">
          {!selected && <p className="muted">Select a report to view its full result, print it, or share it.</p>}
          {selected && (
            <>
              <div className="diag-detail-header">
                <div>
                  <h3>{selected.service_name} <span className="diag-badge diag-badge-info">v{selected.version}</span></h3>
                  <div className="diag-detail-meta">
                    <span>{patientName(selected.order_item?.patient?.name, selected.order_item?.patient?.last_name, selected.patient_id)}</span>
                    <span>UHID: {selected.patient_id}</span>
                    <span>Order: {selected.order_no}</span>
                    <span className={`diag-badge ${statusBadgeClass(selected.status)}`}>{selected.status.replace(/_/g, " ")}</span>
                    <span>{selected.report_type === "IMAGING" ? "Imaging" : "Laboratory"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <Button size="sm" variant="ghost" onClick={printReport}>Print / Preview</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={openWhatsAppModal}
                    style={{ background: "#25D366", color: "#fff", borderColor: "#25D366", fontWeight: 600 }}
                  >
                    Share via WhatsApp
                  </Button>
                  {onNavigate && EDITABLE_STATUSES.has(selected.status) && (
                    <Button size="sm" variant="ghost" onClick={() => onNavigate("diag-reports-approval")}>Continue in Reports &amp; Approval</Button>
                  )}
                </div>
              </div>

              {selected.authorized_by && (
                <div className="diag-note-box">
                  Authorized by {selected.authorized_by}{selected.authorized_at ? ` on ${new Date(selected.authorized_at).toLocaleString()}` : ""}
                  {selected.released_at ? ` -- released ${new Date(selected.released_at).toLocaleString()}` : ""}
                </div>
              )}
              {selected.status === "amended" && selected.amendment_reason && (
                <div className="diag-note-box">Amendment reason: {selected.amendment_reason}</div>
              )}
              {selected.status === "returned_for_correction" && selected.return_reason && (
                <div className="diag-note-box diag-note-critical">Returned for correction: {selected.return_reason}</div>
              )}

              {selected.report_type === "LAB" ? (
                <>
                  <div className="diag-section-title">Results</div>
                  <table className="diag-data-table">
                    <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference range</th><th>Flag</th></tr></thead>
                    <tbody>
                      {(selected.order_item?.results || []).map((r: any) => (
                        <tr key={r.id}>
                          <td>{r.parameter_name}</td>
                          <td>{r.value_numeric ?? r.value_text ?? "-"}</td>
                          <td>{r.unit || "-"}</td>
                          <td>{r.ref_range_text || `${r.ref_low ?? ""}-${r.ref_high ?? ""}`}</td>
                          <td>{r.flag && <span className={`diag-flag-${r.flag}`}>{r.flag.replace("_", " ")}</span>}</td>
                        </tr>
                      ))}
                      {(!selected.order_item?.results || selected.order_item.results.length === 0) && (
                        <tr><td colSpan={5} className="diag-empty">No results recorded on this report.</td></tr>
                      )}
                    </tbody>
                  </table>
                  {content.summary && (
                    <>
                      <div className="diag-section-title">Summary / interpretation</div>
                      <Textarea rows={3} value={content.summary} disabled readOnly />
                    </>
                  )}
                </>
              ) : (
                <div className="diag-form-grid">
                  {IMAGING_FIELDS.map((field) => (
                    <div key={field} className="diag-form-full">
                      <Label>{field.replace(/_/g, " ")}</Label>
                      <Textarea rows={field === "findings" ? 4 : 2} value={content[field] || "-"} disabled readOnly />
                    </div>
                  ))}
                </div>
              )}

              {selected.all_versions.length > 1 && (
                <>
                  <div className="diag-section-title">Version history</div>
                  <div className="diag-timeline">
                    {selected.all_versions.map((v) => (
                      <div key={v.id} className="diag-timeline-item"><span className="diag-timeline-dot" />Version {v.version} -- {v.status.replace(/_/g, " ")}</div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <Modal open={whatsAppModalOpen} onClose={() => setWhatsAppModalOpen(false)} title="Share Diagnostic Report via WhatsApp">
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div>
            <Label>Recipient type</Label>
            <div style={{ display: "flex", gap: "0.625rem", marginTop: "0.25rem" }}>
              <Button type="button" variant={whatsAppRecipient === "patient" ? "primary" : "secondary"} size="sm" onClick={() => selectWhatsAppRecipient("patient")}>Patient</Button>
              <Button type="button" variant={whatsAppRecipient === "doctor" ? "primary" : "secondary"} size="sm" onClick={() => selectWhatsAppRecipient("doctor")}>Referring doctor</Button>
            </div>
          </div>
          <div>
            <Label>WhatsApp number</Label>
            <Input value={whatsAppPhone} onChange={(e) => setWhatsAppPhone(e.target.value)} placeholder="10-digit mobile number" />
          </div>
          <div>
            <Label>Message preview</Label>
            <Textarea rows={8} value={whatsAppMessage} onChange={(e) => setWhatsAppMessage(e.target.value)} />
          </div>
          <Button type="button" variant="primary" onClick={sendWhatsApp} style={{ background: "#25D366", borderColor: "#25D366" }}>Open WhatsApp</Button>
        </div>
      </Modal>
    </div>
  );
}
