import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Tabs, TabsTrigger } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { printViaIframe } from "../lib/printViaIframe";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };

type SaleTab = "new" | "history";
type ServiceDept = "LAB" | "IMAGING";
type DiscountType = "percent" | "flat";
type PaymentMode = "cash" | "card" | "upi" | "bank";

type DiagService = { id: number; code: string; name: string; service_type: string; department?: string; rate: number };
type BasketItem = { service_id: number; code: string; name: string; service_type: string; quantity: number; rate: number; discount: number };
type OrderItem = { id: number; service_name: string; department_type: string; quantity: number; rate: number; discount: number; amount: number; progress_status: string; cancelled_at?: string | null };
type SaleOrder = {
  id: number; order_no: string; patient_name?: string; walkin_name?: string; walkin_mobile?: string; walkin_age?: string; walkin_gender?: string;
  referring_clinician?: string; status: string; invoice_id?: number | null; created_at: string; items: OrderItem[];
};
type Invoice = { id: number; invoice_no: string; total_amount: number; paid_amount: number; due_amount: number; payment_status: string };

const money = (amount: number) => `Rs. ${amount}`;
const lineAmount = (rate: number, quantity: number, discount: number) => Math.max(rate * quantity - discount, 0);
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const badgeClass = (status: string) => (status === "confirmed" ? "diag-badge-active" : status === "cancelled" ? "diag-badge-muted" : "diag-badge-warning");

export default function LabDiagnosticsExternalSalePage({ setNotice }: Props) {
  const [tab, setTab] = useState<SaleTab>("new");

  // ---- Walk-in details ----
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [referringDoctor, setReferringDoctor] = useState("");

  // ---- Services / basket ----
  const [services, setServices] = useState<DiagService[]>([]);
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceDept, setServiceDept] = useState<ServiceDept>("LAB");
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [discountType, setDiscountType] = useState<DiscountType>("percent");
  const [discountVal, setDiscountVal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<SaleOrder | null>(null);
  const [draftSignature, setDraftSignature] = useState("");

  // ---- History ----
  const [orders, setOrders] = useState<SaleOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [selected, setSelected] = useState<SaleOrder | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState(0);
  const [payMode, setPayMode] = useState<PaymentMode>("cash");

  useEffect(() => {
    apiFetch<{ services: DiagService[] }>("/api/diag/services?active_only=true").then((d) => setServices(d.services || [])).catch(() => {});
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sale_type: "EXTERNAL" });
      if (statusFilter) params.set("status", statusFilter);
      if (historySearch.trim()) params.set("q", historySearch.trim());
      const data = await apiFetch<{ orders: SaleOrder[] }>(`/api/diag/orders?${params.toString()}`);
      setOrders(data.orders || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load external sales.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, historySearch, setNotice]);

  useEffect(() => {
    if (tab !== "history") return;
    const t = setTimeout(() => void loadOrders(), 250);
    return () => clearTimeout(t);
  }, [tab, loadOrders]);

  const filteredServices = useMemo(() => {
    const q = serviceSearch.trim().toLowerCase();
    return services.filter((s) => s.service_type === serviceDept && (!q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)));
  }, [services, serviceDept, serviceSearch]);

  const addToBasket = (svc: DiagService) => {
    setBasket((prev) => {
      if (prev.some((b) => b.service_id === svc.id)) {
        setNotice({ type: "info", message: `${svc.name} is already in this sale.` });
        return prev;
      }
      return [...prev, { service_id: svc.id, code: svc.code, name: svc.name, service_type: svc.service_type, quantity: 1, rate: svc.rate, discount: 0 }];
    });
  };
  const updateItem = (id: number, patch: Partial<BasketItem>) => setBasket((prev) => prev.map((b) => (b.service_id === id ? { ...b, ...patch } : b)));
  const removeItem = (id: number) => setBasket((prev) => prev.filter((b) => b.service_id !== id));

  const grossTotal = useMemo(() => basket.reduce((s, b) => s + b.rate * b.quantity, 0), [basket]);
  const itemDiscountTotal = useMemo(() => basket.reduce((s, b) => s + b.discount, 0), [basket]);
  const subtotal = useMemo(() => basket.reduce((s, b) => s + lineAmount(b.rate, b.quantity, b.discount), 0), [basket]);
  const billDiscount = useMemo(() => {
    if (discountVal <= 0 || subtotal <= 0) return 0;
    const raw = discountType === "percent" ? (subtotal * discountVal) / 100 : discountVal;
    return Math.min(Math.round(raw), subtotal);
  }, [subtotal, discountVal, discountType]);
  const total = Math.max(subtotal - billDiscount, 0);

  const resetForm = () => {
    setName(""); setMobile(""); setAge(""); setGender(""); setReferringDoctor("");
    setBasket([]); setDiscountType("percent"); setDiscountVal(0); setDraft(null); setDraftSignature("");
  };

  const buildPayload = () => {
    const digits = mobile.replace(/\D/g, "");
    if (!name.trim()) throw new Error("Enter the patient name.");
    if (digits.length !== 10) throw new Error("Enter a valid 10-digit mobile number.");
    if (age && (!/^\d{1,3}$/.test(age))) throw new Error("Age must be a number.");
    if (basket.length === 0) throw new Error("Add at least one test.");
    // Spread the bill-level discount across lines so invoiced items add up to the net total.
    const items = basket.map((b) => {
      const line = lineAmount(b.rate, b.quantity, b.discount);
      const share = billDiscount > 0 && subtotal > 0 ? Math.round((line / subtotal) * billDiscount) : 0;
      return { service_id: b.service_id, quantity: b.quantity, discount: b.discount + share };
    });
    return {
      sale_type: "EXTERNAL", walkin_name: name.trim(), walkin_mobile: digits, walkin_age: age || undefined, walkin_gender: gender || undefined,
      referring_clinician: referringDoctor.trim() || undefined,
      notes: billDiscount > 0 ? `Discount: ${money(billDiscount)} (${discountType === "percent" ? `${discountVal}%` : "flat"})` : undefined,
      items,
    };
  };

  const ensureDraft = async (): Promise<{ order: SaleOrder; created: boolean }> => {
    const payload = buildPayload();
    const signature = JSON.stringify(payload);
    if (draft && signature === draftSignature) return { order: draft, created: false };
    if (draft) await apiFetch(`/api/diag/orders/${draft.id}/cancel`, { method: "POST" }).catch(() => {});
    const res = await apiFetch<{ order_id: number }>("/api/diag/orders", { method: "POST", body: JSON.stringify(payload) });
    const full = await apiFetch<SaleOrder>(`/api/diag/orders/${res.order_id}`);
    setDraft(full);
    setDraftSignature(signature);
    return { order: full, created: true };
  };

  const saveDraft = async () => {
    setSaving(true);
    try {
      const { order, created } = await ensureDraft();
      setNotice(created
        ? { type: "success", message: `Draft ${order.order_no} saved. No invoice generated yet.` }
        : { type: "info", message: `Draft ${order.order_no} is already up to date.` });
    } catch (err: any) {
      reportError(setNotice, err, "Could not save draft.");
    } finally {
      setSaving(false);
    }
  };

  const openOrder = useCallback(async (orderId: number) => {
    try {
      const order = await apiFetch<SaleOrder>(`/api/diag/orders/${orderId}`);
      setSelected(order);
      setSelectedInvoice(order.invoice_id ? await apiFetch<Invoice>(`/api/diag/invoices/${order.invoice_id}`).catch(() => null) : null);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load sale.");
    }
  }, [setNotice]);

  const confirmAndInvoice = async (orderId: number, orderNo: string) => {
    const result = await apiFetch<{ invoice_id: number | null; subtotal: number }>(`/api/diag/orders/${orderId}/confirm`, { method: "POST" });
    setNotice({ type: "success", message: `Invoice generated for ${orderNo}: ${money(result.subtotal)}.` });
    return result;
  };

  const generateInvoice = async () => {
    setSaving(true);
    try {
      const { order } = await ensureDraft();
      await confirmAndInvoice(order.id, order.order_no);
      resetForm();
      setTab("history");
      void openOrder(order.id);
    } catch (err: any) {
      reportError(setNotice, err, "Could not generate invoice.");
    } finally {
      setSaving(false);
    }
  };

  const confirmSelected = async () => {
    if (!selected) return;
    try {
      await confirmAndInvoice(selected.id, selected.order_no);
      await openOrder(selected.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not generate invoice.");
    }
  };

  const discardSelected = async () => {
    if (!selected || !window.confirm(`Discard draft ${selected.order_no}?`)) return;
    try {
      await apiFetch(`/api/diag/orders/${selected.id}/cancel`, { method: "POST" });
      setNotice({ type: "success", message: `Draft ${selected.order_no} discarded.` });
      if (draft?.id === selected.id) { setDraft(null); setDraftSignature(""); }
      await openOrder(selected.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not discard the draft.");
    }
  };

  const recordPayment = async () => {
    if (!selectedInvoice || !selected) return;
    try {
      await apiFetch(`/api/diag/invoices/${selectedInvoice.id}/payments`, { method: "POST", body: JSON.stringify({ amount: payAmount, payment_mode: payMode }) });
      setNotice({ type: "success", message: "Payment recorded." });
      setPayOpen(false);
      await openOrder(selected.id);
    } catch (err: any) {
      reportError(setNotice, err, "Could not record payment.");
    }
  };

  const printInvoice = (o: SaleOrder, inv: Invoice | null) => {
    const active = o.items.filter((i) => !i.cancelled_at);
    const rows = active.map((i) => `<tr><td>${esc(i.service_name)}</td><td>${i.quantity}</td><td>${money(i.rate)}</td><td>${money(i.discount)}</td><td>${money(i.amount)}</td></tr>`).join("");
    const billed = active.reduce((s, i) => s + i.amount, 0);
    printViaIframe(`
      <html><head><title>Invoice ${esc(inv?.invoice_no || o.order_no)}</title></head><body style="font-family:sans-serif;padding:24px;">
      <h2>HospAI -- Diagnostics Invoice (External Sale)</h2>
      <p><strong>Invoice:</strong> ${esc(inv?.invoice_no || "-")} &nbsp; <strong>Order:</strong> ${esc(o.order_no)}</p>
      <p><strong>Patient:</strong> ${esc(o.walkin_name)} &nbsp; <strong>Mobile:</strong> ${esc(o.walkin_mobile)}
         ${o.walkin_age ? `&nbsp; <strong>Age:</strong> ${esc(o.walkin_age)}` : ""} ${o.walkin_gender ? `&nbsp; <strong>Gender:</strong> ${esc(o.walkin_gender)}` : ""}</p>
      ${o.referring_clinician ? `<p><strong>Referred by:</strong> ${esc(o.referring_clinician)}</p>` : ""}
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Test</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="max-width:280px;margin-left:auto;margin-top:12px;">
        <div style="display:flex;justify-content:space-between;"><span>Total</span><strong>${money(inv?.total_amount ?? billed)}</strong></div>
        ${inv ? `<div style="display:flex;justify-content:space-between;"><span>Paid</span><strong>${money(inv.paid_amount)}</strong></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;"><span>Balance due</span><span>${money(inv.due_amount)}</span></div>` : ""}
      </div>
      </body></html>
    `);
  };

  return (
    <div className="diag-page">
      <Tabs>
        <TabsTrigger active={tab === "new"} onClick={() => setTab("new")}>New external sale</TabsTrigger>
        <TabsTrigger active={tab === "history"} onClick={() => setTab("history")}>Order history</TabsTrigger>
      </Tabs>

      {tab === "new" && (
        <div className="diag-split diag-split-wide">
          <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
            <div className="diag-card">
              <div className="diag-card-header"><h3>Patient details (no UHID)</h3></div>
              <div className="diag-form-grid">
                <div><Label>Patient name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div><Label>Mobile number *</Label><Input inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))} placeholder="10-digit mobile" /></div>
                <div><Label>Age</Label><Input inputMode="numeric" maxLength={3} value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))} /></div>
                <div><Label>Gender</Label>
                  <Select value={gender} onChange={(e) => setGender(e.target.value)}>
                    <option value="">-- Select --</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option>
                  </Select>
                </div>
                <div className="diag-form-full"><Label>Referring doctor</Label><Input value={referringDoctor} onChange={(e) => setReferringDoctor(e.target.value)} placeholder="Dr. name / clinic (optional)" /></div>
              </div>
            </div>

            <div className="diag-card">
              <div className="diag-card-header"><h3>Select tests</h3></div>
              <div className="diag-filters-row">
                <Input placeholder="Search test name or code" value={serviceSearch} onChange={(e) => setServiceSearch(e.target.value)} />
              </div>
              <Tabs>
                <TabsTrigger active={serviceDept === "LAB"} onClick={() => setServiceDept("LAB")}>Laboratory</TabsTrigger>
                <TabsTrigger active={serviceDept === "IMAGING"} onClick={() => setServiceDept("IMAGING")}>Imaging</TabsTrigger>
              </Tabs>
              <div className="diag-table-card" style={{ maxHeight: 260, overflowY: "auto" }}>
                <table className="diag-data-table">
                  <thead><tr><th>Test</th><th>Department</th><th>Rate</th><th></th></tr></thead>
                  <tbody>
                    {filteredServices.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name} <span className="muted">({s.code})</span></td>
                        <td>{s.department || "-"}</td>
                        <td>{money(s.rate)}</td>
                        <td><Button size="sm" variant="secondary" onClick={() => addToBasket(s)}>+ Add</Button></td>
                      </tr>
                    ))}
                    {filteredServices.length === 0 && <tr><td colSpan={4} className="diag-empty">No tests match.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="diag-section-title">Selected tests</div>
              <table className="diag-data-table">
                <thead><tr><th>Test</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th><th></th></tr></thead>
                <tbody>
                  {basket.map((b) => (
                    <tr key={b.service_id}>
                      <td>{b.name}</td>
                      <td><Input type="number" min={1} style={{ width: 60 }} value={b.quantity} onChange={(e) => updateItem(b.service_id, { quantity: Math.max(Number(e.target.value) || 1, 1) })} /></td>
                      <td>{money(b.rate)}</td>
                      <td><Input type="number" min={0} style={{ width: 70 }} value={b.discount} onChange={(e) => updateItem(b.service_id, { discount: Math.max(Number(e.target.value) || 0, 0) })} /></td>
                      <td>{money(lineAmount(b.rate, b.quantity, b.discount))}</td>
                      <td><Button size="sm" variant="ghost" onClick={() => removeItem(b.service_id)}>Remove</Button></td>
                    </tr>
                  ))}
                  {basket.length === 0 && <tr><td colSpan={6} className="diag-empty">No tests selected yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="diag-card diag-edit-panel">
            <div className="diag-card-header"><h3>Billing summary</h3><span className="diag-badge diag-badge-warning">{draft ? `Draft ${draft.order_no}` : "New"}</span></div>
            <div className="diag-note-box" style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Bill discount</strong>
                <div style={{ display: "flex", gap: "0.3rem" }}>
                  <Button type="button" size="sm" variant={discountType === "percent" ? "primary" : "secondary"} onClick={() => setDiscountType("percent")}>%</Button>
                  <Button type="button" size="sm" variant={discountType === "flat" ? "primary" : "secondary"} onClick={() => setDiscountType("flat")}>Flat</Button>
                </div>
              </div>
              <Input type="number" min={0} max={discountType === "percent" ? 100 : subtotal} value={discountVal || ""}
                onChange={(e) => setDiscountVal(Math.max(Number(e.target.value) || 0, 0))} placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 250"} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 8 }}><span>Gross subtotal</span><strong>{money(grossTotal)}</strong></div>
            {itemDiscountTotal > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}><span>Item discounts</span><strong>-{money(itemDiscountTotal)}</strong></div>}
            {billDiscount > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}><span>Bill discount ({discountType === "percent" ? `${discountVal}%` : "flat"})</span><strong>-{money(billDiscount)}</strong></div>}
            <hr style={{ margin: "0.6rem 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800 }}><span>Total</span><span>{money(total)}</span></div>
            <div className="diag-note-box">Rates come from the lab service catalogue. Generating the invoice confirms the order and sends the tests to the lab/imaging worklists; payment can then be recorded from Order history.</div>
            <div className="diag-form-actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <Button variant="secondary" disabled={saving} onClick={() => void saveDraft()}>Save draft</Button>
              <Button variant="primary" disabled={saving} onClick={() => void generateInvoice()}>{saving ? "Working..." : "Generate invoice"}</Button>
              <Button variant="ghost" onClick={() => setTab("history")}>Open order history</Button>
            </div>
          </div>
        </div>
      )}

      {tab === "history" && (
        <div className="diag-worklist-shell">
          <div className="diag-card">
            <div className="diag-card-header"><h3>External sales</h3></div>
            <Input placeholder="Search name, mobile or order no" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} />
            <div style={{ marginTop: "0.5rem" }}>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option><option value="draft">Draft</option><option value="confirmed">Invoiced</option><option value="cancelled">Cancelled</option>
              </Select>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              {loading && <p className="muted">Loading...</p>}
              {!loading && orders.length === 0 && <p className="muted">No external sales found.</p>}
              {orders.map((o) => (
                <div key={o.id} className={`diag-worklist-row ${selected?.id === o.id ? "active" : ""}`} onClick={() => void openOrder(o.id)}>
                  <div className="diag-worklist-row-top"><span>{o.order_no} &middot; {o.patient_name || o.walkin_name}</span><span className={`diag-badge ${badgeClass(o.status)}`}>{o.status}</span></div>
                  <div className="diag-worklist-row-meta"><span>{o.walkin_mobile}</span><span>{o.items.length} test(s)</span><span>{new Date(o.created_at).toLocaleDateString()}</span></div>
                </div>
              ))}
            </div>
          </div>
          <div className="diag-card">
            {!selected && <p className="muted">Select a sale to view details.</p>}
            {selected && (
              <>
                <div className="diag-detail-header">
                  <div>
                    <h3>{selected.order_no}</h3>
                    <div className="diag-detail-meta">
                      <span>{selected.walkin_name}</span><span>{selected.walkin_mobile}</span>
                      {selected.walkin_age && <span>Age: {selected.walkin_age}</span>}
                      {selected.walkin_gender && <span>{selected.walkin_gender}</span>}
                      <span>Status: {selected.status}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    {selected.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => printInvoice(selected, selectedInvoice)}>Print invoice</Button>}
                    {selectedInvoice && selectedInvoice.due_amount > 0 && (
                      <Button size="sm" variant="secondary" onClick={() => { setPayAmount(selectedInvoice.due_amount); setPayOpen(true); }}>Record payment</Button>
                    )}
                  </div>
                </div>
                <table className="diag-data-table">
                  <thead><tr><th>Test</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {selected.items.map((i) => (
                      <tr key={i.id}>
                        <td>{i.service_name}</td><td>{i.quantity}</td><td>{money(i.rate)}</td><td>{money(i.discount)}</td><td>{money(i.amount)}</td>
                        <td><span className={`diag-badge ${i.cancelled_at ? "diag-badge-muted" : "diag-badge-info"}`}>{i.cancelled_at ? "cancelled" : i.progress_status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedInvoice && (
                  <div className="diag-note-box">
                    Invoice {selectedInvoice.invoice_no}: total {money(selectedInvoice.total_amount)}, paid {money(selectedInvoice.paid_amount)}, due {money(selectedInvoice.due_amount)} ({selectedInvoice.payment_status})
                  </div>
                )}
                {selected.status === "draft" && (
                  <div className="diag-form-actions">
                    <Button variant="ghost" onClick={() => void discardSelected()}>Discard draft</Button>
                    <Button variant="primary" onClick={() => void confirmSelected()}>Generate invoice</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title={`Record payment -- ${selectedInvoice?.invoice_no || ""}`}>
        <div className="diag-form-grid">
          <div><Label>Amount</Label><Input type="number" value={payAmount} onChange={(e) => setPayAmount(Number(e.target.value))} /></div>
          <div><Label>Payment mode</Label>
            <Select value={payMode} onChange={(e) => setPayMode(e.target.value as PaymentMode)}>
              <option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="bank">Bank transfer</option>
            </Select>
          </div>
          <div className="diag-form-full"><Button variant="primary" onClick={() => void recordPayment()}>Confirm payment</Button></div>
        </div>
      </Modal>
    </div>
  );
}
