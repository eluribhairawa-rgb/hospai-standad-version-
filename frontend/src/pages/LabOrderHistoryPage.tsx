import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { openReportForItem } from "../lib/diagReports";
import {
  PaymentModal, ROUTING_LABELS, SERVICE_TYPE_BADGE, SERVICE_TYPE_LABELS,
  loadOrderWithInvoice, money, printLabInvoice,
} from "../components/lab/LabCheckout";
import type { LabInvoice, LabOrder, LabOrderItem, ServiceType } from "../components/lab/LabCheckout";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>>; onNavigate?: (pageId: string) => void };
type TypeTab = "ALL" | ServiceType;
type HistoryRow = {
  id: number; order_no: string; created_at: string; service_type: ServiceType; status: string; patient_id?: string | null;
  patient_name?: string; patient_phone?: string; tests: string; total: number; paid_amount?: number | null; due_amount?: number | null;
  payment_status?: string | null; invoice_id?: number | null; visit_status?: string | null; outsourced_count: number; items: LabOrderItem[];
};
type HistoryResponse = { orders: HistoryRow[]; counts: Record<TypeTab, number>; page: number; page_size: number; total: number };

const TABS: { key: TypeTab; label: string }[] = [
  { key: "ALL", label: "All" }, { key: "IN_HOUSE", label: "In-house" }, { key: "EXTERNAL", label: "External" },
  { key: "OUTSOURCING", label: "Outsourcing" }, { key: "HOME_VISIT", label: "Home Visits" },
];
const PAGE_SIZE = 25;

function statusLabel(r: HistoryRow): { text: string; cls: string } {
  if (r.status === "cancelled") return { text: "Cancelled", cls: "diag-badge-muted" };
  if (r.status === "draft") return { text: "Draft", cls: "diag-badge-warning" };
  if (!r.invoice_id) return { text: "Billed at discharge", cls: "diag-badge-info" };
  if (r.payment_status === "paid") return { text: "Paid", cls: "diag-badge-active" };
  if (r.payment_status === "refunded") return { text: "Refunded", cls: "diag-badge-muted" };
  if ((r.paid_amount || 0) > 0) return { text: "Partly paid", cls: "diag-badge-warning" };
  return { text: "Due", cls: "diag-badge-critical" };
}

export default function LabOrderHistoryPage({ setNotice, onNavigate }: Props) {
  const [tab, setTab] = useState<TypeTab>("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ order: LabOrder; invoice: LabInvoice | null } | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (tab !== "ALL") params.set("service_type", tab);
      if (search.trim()) params.set("q", search.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      setData(await apiFetch<HistoryResponse>(`/api/diag/order-history?${params.toString()}`));
    } catch (err: any) {
      reportError(setNotice, err, "Could not load order history.");
    } finally {
      setLoading(false);
    }
  }, [tab, search, dateFrom, dateTo, page, setNotice]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);
  // Any filter change goes back to page 1.
  useEffect(() => { setPage(1); }, [tab, search, dateFrom, dateTo]);

  const openDetail = async (id: number) => {
    try { setDetail(await loadOrderWithInvoice(id)); } catch (err: any) { reportError(setNotice, err, "Could not load the order."); }
  };

  const setRange = (days: number | null) => {
    if (days === null) { setDateFrom(""); setDateTo(""); return; }
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDateFrom(iso(from)); setDateTo(iso(to));
  };

  const pages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  return (
    <div className="diag-page">
      <div className="diag-card">
        <div className="diag-card-header"><h3>Order history</h3></div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.75rem" }} role="tablist">
          {TABS.map((t) => (
            <Button key={t.key} size="sm" variant={tab === t.key ? "primary" : "secondary"} onClick={() => setTab(t.key)} role="tab" aria-selected={tab === t.key}>
              {t.label}{data ? ` (${data.counts[t.key] ?? 0})` : ""}
            </Button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "2 1 240px" }}><Label>Search</Label><Input placeholder="Patient, UHID, mobile, order no or test" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div style={{ flex: "1 1 140px" }}><Label>From</Label><Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></div>
          <div style={{ flex: "1 1 140px" }}><Label>To</Label><Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></div>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <Button size="sm" variant="ghost" onClick={() => setRange(0)}>Today</Button>
            <Button size="sm" variant="ghost" onClick={() => setRange(6)}>7 days</Button>
            <Button size="sm" variant="ghost" onClick={() => setRange(29)}>30 days</Button>
            <Button size="sm" variant="ghost" onClick={() => setRange(null)}>Any date</Button>
          </div>
        </div>

        <div className="diag-table-card" style={{ overflowX: "auto", marginTop: "0.75rem" }}>
          <table className="diag-data-table">
            <thead><tr><th>Date &amp; time</th><th>Service type</th><th>Patient</th><th>UHID</th><th>Tests ordered</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan={7} className="diag-empty">Loading...</td></tr>}
              {data && data.orders.length === 0 && <tr><td colSpan={7} className="diag-empty">No orders match these filters.</td></tr>}
              {data?.orders.map((r) => {
                const st = statusLabel(r);
                return (
                  <tr key={r.id} onClick={() => void openDetail(r.id)} style={{ cursor: "pointer" }} title="Open order">
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(r.created_at).toLocaleString()}<div className="muted">{r.order_no}</div></td>
                    <td><span className={`diag-badge ${SERVICE_TYPE_BADGE[r.service_type]}`}>{SERVICE_TYPE_LABELS[r.service_type]}</span>
                      {r.service_type === "HOME_VISIT" && r.visit_status && <div className="muted">{r.visit_status}</div>}
                      {r.outsourced_count > 0 && r.service_type !== "OUTSOURCING" && <div className="muted">{r.outsourced_count} outsourced</div>}
                    </td>
                    <td>{r.patient_name || "-"}{r.patient_phone && <div className="muted">{r.patient_phone}</div>}</td>
                    <td>{r.patient_id || <span className="muted">Walk-in</span>}</td>
                    <td style={{ maxWidth: 280 }}>{r.tests || <span className="muted">-</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{money(r.total)}{(r.due_amount || 0) > 0 && <div className="muted">due {money(r.due_amount)}</div>}</td>
                    <td><span className={`diag-badge ${st.cls}`}>{st.text}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.total > PAGE_SIZE && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
            <span className="muted">Page {page} of {pages} &middot; {data.total} orders</span>
            <div style={{ display: "flex", gap: "0.3rem" }}>
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.order.order_no} - ${SERVICE_TYPE_LABELS[detail.order.service_type]}` : ""}>
        {detail && (
          <>
            <div className="diag-detail-meta" style={{ marginBottom: "0.5rem" }}>
              <span>{detail.order.patient_name || detail.order.walkin_name}</span>
              {detail.order.patient_id && <span>UHID {detail.order.patient_id}</span>}
              <span>{new Date(detail.order.created_at).toLocaleString()}</span>
              {detail.order.visit_address && <span>Visit: {detail.order.visit_address}</span>}
            </div>
            <table className="diag-data-table">
              <thead><tr><th>Test</th><th>Amount</th><th>Status</th><th>Processed</th><th></th></tr></thead>
              <tbody>
                {detail.order.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.service_name}</td><td>{money(i.amount)}</td>
                    <td><span className={`diag-badge ${i.cancelled_at ? "diag-badge-muted" : "diag-badge-info"}`}>{i.cancelled_at ? "cancelled" : i.progress_status}</span></td>
                    <td title={i.routing_reason || ""}>{i.routing ? ROUTING_LABELS[i.routing] || i.routing : "In-house"}</td>
                    <td>{onNavigate && !i.cancelled_at && ["authorized", "released"].includes(i.progress_status) && (
                      <Button size="sm" variant="ghost" onClick={() => { setDetail(null); void openReportForItem(i.id, i.department_type === "IMAGING" ? "IMAGING" : "LAB", onNavigate); }}>Report</Button>
                    )}</td>
                  </tr>
                ))}
                {Number(detail.order.home_visit_fee || 0) > 0 && <tr><td>Home visit fee</td><td>{money(detail.order.home_visit_fee)}</td><td /><td /><td /></tr>}
              </tbody>
            </table>
            {detail.invoice ? (
              <div className="diag-note-box">
                Invoice {detail.invoice.invoice_no}: total {money(detail.invoice.total_amount)}, paid {money(detail.invoice.paid_amount)}, due {money(detail.invoice.due_amount)} ({detail.invoice.payment_status})
              </div>
            ) : detail.order.status === "confirmed" && <div className="diag-note-box">Billed on the inpatient discharge bill.</div>}
            <div className="diag-form-actions">
              {detail.order.status === "confirmed" && <Button variant="ghost" onClick={() => printLabInvoice(detail.order, detail.invoice)}>Print invoice</Button>}
              {detail.invoice && detail.invoice.due_amount > 0 && <Button variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>}
            </div>
          </>
        )}
      </Modal>
      <PaymentModal invoice={detail?.invoice || null} open={payOpen} onClose={() => setPayOpen(false)} setNotice={setNotice}
        onPaid={() => { setPayOpen(false); if (detail) void openDetail(detail.order.id); void load(); }} />
    </div>
  );
}
