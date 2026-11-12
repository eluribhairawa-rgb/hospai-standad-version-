// Order History: every lab order (In-house, External, Outsourcing, Home Visit) in one table.
// Shown under the order screen on Orders & Billing.
import { forwardRef, useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { FiSearch } from "react-icons/fi";
import { Button, Input, Modal, Select } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { openReportForItem } from "../lib/diagReports";
import {
  PaymentModal, ROUTING_LABELS, SERVICE_TYPE_BADGE, SERVICE_TYPE_LABELS,
  loadOrderWithInvoice, money, printLabInvoice,
} from "../components/lab/LabCheckout";
import type { LabInvoice, LabOrder, LabOrderItem, ServiceType } from "../components/lab/LabCheckout";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
  /** Bumped by the order screen after a save so the table reloads. */
  refreshKey?: number;
  /** "View History" from Patient Details: search text plus a nonce so the same patient can be re-applied. */
  preset?: { query: string; nonce: number } | null;
};
type TypeTab = "ALL" | ServiceType;
type HistoryRow = {
  id: number; order_no: string; created_at: string; service_type: ServiceType; status: string; patient_id?: string | null;
  patient_name?: string; patient_phone?: string; invoice_no?: string | null; tests: string; total: number;
  paid_amount?: number | null; due_amount?: number | null; payment_status?: string | null; invoice_id?: number | null;
  payment_mode?: string | null;
  visit_status?: string | null; outsourced_count: number; items: LabOrderItem[];
};
type HistoryResponse = { orders: HistoryRow[]; counts: Record<TypeTab, number>; page: number; page_size: number; total: number };

const TABS: { key: TypeTab; label: string }[] = [
  { key: "ALL", label: "All" }, { key: "IN_HOUSE", label: "In-house" }, { key: "EXTERNAL", label: "External" },
  { key: "OUTSOURCING", label: "Outsourcing" }, { key: "HOME_VISIT", label: "Home Visits" },
];
const PAGE_SIZE = 10;
const CANCELLABLE = new Set(["ordered"]);

function statusLabel(r: { status: string; invoice_id?: number | null; payment_status?: string | null; paid_amount?: number | null }) {
  if (r.status === "cancelled") return { text: "Cancelled", cls: "diag-badge-muted" };
  if (r.status === "draft") return { text: "Draft", cls: "diag-badge-warning" };
  if (!r.invoice_id) return { text: "Billed at discharge", cls: "diag-badge-info" };
  if (r.payment_status === "paid") return { text: "Paid", cls: "diag-badge-active" };
  if (r.payment_status === "refunded") return { text: "Refunded", cls: "diag-badge-muted" };
  if ((r.paid_amount || 0) > 0) return { text: "Partly paid", cls: "diag-badge-warning" };
  return { text: "Due", cls: "diag-badge-critical" };
}

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

const LabOrderHistoryPage = forwardRef<HTMLDivElement, Props>(function LabOrderHistoryPage({ setNotice, onNavigate, refreshKey = 0, preset }, ref) {
  const [tab, setTab] = useState<TypeTab>("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [paymentMode, setPaymentMode] = useState("ALL");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ order: LabOrder; invoice: LabInvoice | null } | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [cancelItem, setCancelItem] = useState<LabOrderItem | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (preset) { setTab("ALL"); setSearch(preset.query); setDateFrom(""); setDateTo(""); setPaymentMode("ALL"); } }, [preset]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (tab !== "ALL") params.set("service_type", tab);
      if (paymentMode && paymentMode !== "ALL") params.set("payment_mode", paymentMode);
      if (search.trim()) params.set("q", search.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      setData(await apiFetch<HistoryResponse>(`/api/diag/order-history?${params.toString()}`));
    } catch (err: any) {
      reportError(setNotice, err, "Could not load order history.");
    } finally {
      setLoading(false);
    }
  }, [tab, search, dateFrom, dateTo, paymentMode, page, setNotice]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load, refreshKey]);
  useEffect(() => { setPage(1); }, [tab, search, dateFrom, dateTo, paymentMode]);

  const openDetail = async (id: number) => {
    try {
      setDetail(await loadOrderWithInvoice(id));
      setCancelItem(null); setConfirmDiscard(false);
    } catch (err: any) { reportError(setNotice, err, "Could not load the order."); }
  };
  const afterChange = async () => { if (detail) await openDetail(detail.order.id); void load(); };

  const run = async (fn: () => Promise<void>, failure: string) => {
    setBusy(true);
    try { await fn(); } catch (err: any) { reportError(setNotice, err, failure); } finally { setBusy(false); }
  };

  const confirmDraft = () => detail && run(async () => {
    const r = await apiFetch<{ subtotal: number }>(`/api/diag/orders/${detail.order.id}/confirm`, { method: "POST" });
    setNotice({ type: "success", message: `Invoice generated for ${detail.order.order_no}: ${money(r.subtotal)}.` });
    await afterChange();
  }, "Could not generate the invoice.");

  const discardDraft = () => detail && run(async () => {
    await apiFetch(`/api/diag/orders/${detail.order.id}/cancel`, { method: "POST" });
    setNotice({ type: "success", message: `Draft ${detail.order.order_no} discarded.` });
    await afterChange();
  }, "Could not discard the draft.");

  const cancelTest = () => cancelItem && run(async () => {
    const r = await apiFetch<{ refund_amount: number }>(`/api/diag/order-items/${cancelItem.id}/cancel`, {
      method: "POST", body: JSON.stringify({ reason: cancelReason }),
    });
    setNotice({ type: "success", message: `${cancelItem.service_name} cancelled.${r.refund_amount > 0 ? ` Refund ${money(r.refund_amount)} recorded.` : ""}` });
    setCancelItem(null); setCancelReason("");
    await afterChange();
  }, "Could not cancel the test.");

  const pages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;
  const order = detail?.order;

  return (
    <section className="diag-card lab-ob-history" ref={ref}>
      <div className="lab-ob-history-head">
        <h3>Order History</h3>
        <div className="lab-ob-chips" role="tablist" aria-label="Filter by service type">
          <span className="muted">Filter by:</span>
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              {t.label}{data ? ` (${data.counts[t.key] ?? 0})` : ""}
            </button>
          ))}
        </div>
        <div className="lab-ob-history-tools">
          <Input type="date" aria-label="From date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          <span className="muted">to</span>
          <Input type="date" aria-label="To date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          <Select
            aria-label="Filter by payment mode"
            value={paymentMode}
            onChange={(e) => setPaymentMode(e.target.value)}
            style={{ width: "auto", minWidth: 160 }}
          >
            <option value="ALL">All Payment Modes</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="upi">Online - UPI</option>
            <option value="bank">Bank Transfer</option>
            <option value="insurance">Insurance</option>
            <option value="unpaid">Unpaid / Due</option>
          </Select>
          <div className="lab-ob-search-box">
            <FiSearch aria-hidden />
            <Input className="search-input-with-icon" placeholder="Search by UHID, Patient Name or Invoice No." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="lab-ob-table-wrap" style={{ maxHeight: "none" }}>
        <table className="diag-data-table">
          <thead><tr><th>Date &amp; Time</th><th>Type</th><th>Patient Name</th><th>UHID</th><th>Tests</th><th>Total Amount</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {loading && !data && <tr><td colSpan={8} className="diag-empty">Loading...</td></tr>}
            {data && data.orders.length === 0 && <tr><td colSpan={8} className="diag-empty">No orders match these filters.</td></tr>}
            {data?.orders.map((r) => {
              const st = statusLabel(r);
              return (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.created_at)}<div className="muted" style={{ fontSize: 12 }}>{r.invoice_no || r.order_no}</div></td>
                  <td><span className={`diag-badge ${SERVICE_TYPE_BADGE[r.service_type]}`}>{SERVICE_TYPE_LABELS[r.service_type]}</span>
                    {r.outsourced_count > 0 && r.service_type !== "OUTSOURCING" && <div className="muted" style={{ fontSize: 12 }}>{r.outsourced_count} outsourced</div>}
                  </td>
                  <td>{r.patient_name || "-"}</td>
                  <td>{r.patient_id || "-"}</td>
                  <td style={{ maxWidth: 260 }}>{r.tests || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{money(r.total)}{(r.due_amount || 0) > 0 && r.payment_status !== "paid" && <div className="muted" style={{ fontSize: 12 }}>due {money(r.due_amount)}</div>}</td>
                  <td>
                    <span className={`diag-badge ${st.cls}`}>{st.text}</span>
                    {r.payment_mode && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2, textTransform: "capitalize", fontWeight: 500 }}>
                        {r.payment_mode === "upi" ? "UPI" : r.payment_mode}
                      </div>
                    )}
                  </td>
                  <td><Button size="sm" variant="secondary" onClick={() => void openDetail(r.id)}>View</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && data.total > PAGE_SIZE && (
        <div className="lab-ob-pager">
          <span className="muted">Page {page} of {pages} &middot; {data.total} orders</span>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={order ? `${order.order_no} - ${SERVICE_TYPE_LABELS[order.service_type]}` : ""}>
        {detail && order && (
          <>
            <div className="diag-detail-meta" style={{ marginBottom: "0.5rem" }}>
              <span>{order.patient_name || order.walkin_name}</span>
              {order.patient_id && <span>UHID {order.patient_id}</span>}
              <span>{fmtDateTime(order.created_at)}</span>
              {(() => {
                const st = statusLabel({ status: order.status, invoice_id: order.invoice_id, payment_status: detail.invoice?.payment_status, paid_amount: detail.invoice?.paid_amount });
                return <span className={`diag-badge ${st.cls}`}>{st.text}</span>;
              })()}
            </div>
            {order.visit_address && <p className="muted" style={{ margin: "0 0 0.5rem" }}>Home visit: {order.visit_address}{order.visit_scheduled_at ? `, ${new Date(order.visit_scheduled_at).toLocaleString()}` : ""}{order.visit_status ? ` (${order.visit_status})` : ""}</p>}
            <table className="diag-data-table">
              <thead><tr><th>Test</th><th>Amount</th><th>Status</th><th>Processed</th><th></th></tr></thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.service_name}</td><td>{money(i.amount)}</td>
                    <td><span className={`diag-badge ${i.cancelled_at ? "diag-badge-muted" : "diag-badge-info"}`}>{i.cancelled_at ? "cancelled" : i.progress_status}</span></td>
                    <td title={i.routing_reason || ""}>{i.routing ? ROUTING_LABELS[i.routing] || i.routing : "In-house"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {onNavigate && !i.cancelled_at && ["results_entered", "exam_completed", "authorized", "released"].includes(i.progress_status) && (
                        <Button size="sm" variant="ghost" onClick={() => { setDetail(null); void openReportForItem(i.id, i.department_type === "IMAGING" ? "IMAGING" : "LAB", onNavigate); }}>Report</Button>
                      )}
                      {order.status === "confirmed" && !i.cancelled_at && CANCELLABLE.has(i.progress_status) && (
                        <Button size="sm" variant="ghost" onClick={() => { setCancelItem(i); setCancelReason(""); }}>Cancel</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {Number(order.home_visit_fee || 0) > 0 && <tr><td>Home visit fee</td><td>{money(order.home_visit_fee)}</td><td /><td /><td /></tr>}
              </tbody>
            </table>

            {cancelItem && (
              <div className="diag-note-box" style={{ marginTop: "0.6rem" }}>
                <strong>Cancel {cancelItem.service_name}?</strong> Anything already paid for it is refunded.
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <Input placeholder="Reason *" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                  <Button size="sm" variant="destructive" disabled={busy || !cancelReason.trim()} onClick={() => void cancelTest()}>Cancel test</Button>
                  <Button size="sm" variant="ghost" onClick={() => setCancelItem(null)}>Keep</Button>
                </div>
              </div>
            )}

            {detail.invoice ? (
              <div className="diag-note-box" style={{ marginTop: "0.6rem" }}>
                Invoice {detail.invoice.invoice_no}: total {money(detail.invoice.total_amount)}, paid {money(detail.invoice.paid_amount)}, due {money(detail.invoice.due_amount)}
              </div>
            ) : order.status === "confirmed" && <div className="diag-note-box" style={{ marginTop: "0.6rem" }}>Billed on the inpatient discharge bill.</div>}

            <div className="lab-ob-actions" style={{ marginTop: "0.8rem" }}>
              {order.status === "draft" && (confirmDiscard ? (
                <>
                  <Button variant="destructive" disabled={busy} onClick={() => void discardDraft()}>Yes, discard draft</Button>
                  <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep draft</Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard draft</Button>
                  <Button variant="primary" disabled={busy} onClick={() => void confirmDraft()}>Generate Invoice</Button>
                </>
              ))}
              {order.status === "confirmed" && (
                <>
                  <Button variant="secondary" onClick={() => printLabInvoice(order, detail.invoice)}>{detail.invoice && detail.invoice.due_amount <= 0 ? "Print receipt" : "Print invoice"}</Button>
                  {detail.invoice && detail.invoice.due_amount > 0 && <Button variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>}
                </>
              )}
            </div>
          </>
        )}
      </Modal>
      <PaymentModal invoice={detail?.invoice || null} open={payOpen} onClose={() => setPayOpen(false)} setNotice={setNotice}
        onPaid={() => { setPayOpen(false); void afterChange(); }} />
    </section>
  );
});

export default LabOrderHistoryPage;
