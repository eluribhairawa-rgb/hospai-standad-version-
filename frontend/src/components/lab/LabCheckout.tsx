// Shared pieces of the Lab "common process": select tests -> calculate bill -> payment -> invoice.
// Used by the Outsourcing and Home Visit order pages.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Tabs, TabsTrigger } from "../ui";
import PatientSearchPicker from "../PatientSearchPicker";
import { apiFetch, reportError } from "../../lib/api";
import { printViaIframe } from "../../lib/printViaIframe";
import type { Notice, Patient } from "../../types";

// ---------------------------------------------------------------- types --

export type ServiceType = "IN_HOUSE" | "EXTERNAL" | "OUTSOURCING" | "HOME_VISIT";
export type DiagService = { id: number; code: string; name: string; service_type: string; department?: string; rate: number };
export type BasketItem = {
  service_id: number; code: string; name: string; service_type: string;
  quantity: number; rate: number; discount: number; vendor_id?: number | null;
};
export type Vendor = { id: number; vendor_name: string; status?: string };
export type LabInvoice = {
  id: number; invoice_no: string; total_amount: number; paid_amount: number; due_amount: number; payment_status: string;
};
export type LabOrderItem = {
  id: number; service_id: number; service_name: string; department_type: string; quantity: number; rate: number;
  discount: number; amount: number; progress_status: string; cancelled_at?: string | null;
  routing?: string | null; routing_reason?: string | null; routing_vendor_id?: number | null; routing_vendor_name?: string | null;
};
export type LabOrder = {
  id: number; order_no: string; service_type: ServiceType; status: string; patient_id?: string | null; patient_name?: string;
  patient_phone?: string; walkin_name?: string; walkin_mobile?: string; walkin_age?: string; walkin_gender?: string;
  referring_clinician?: string; invoice_id?: number | null; created_at: string; items: LabOrderItem[];
  home_visit_fee?: number; visit_address?: string | null; visit_scheduled_at?: string | null; visit_status?: string | null;
  outsource_vendor_id?: number | null;
};
export type PatientChoice =
  | { mode: "registered"; patient: Patient | null }
  | { mode: "walkin"; name: string; mobile: string; age: string; gender: string };

// -------------------------------------------------------------- helpers --

export const money = (amount: number | null | undefined) => `Rs. ${Math.round((Number(amount) || 0) * 100) / 100}`;
export const lineAmount = (rate: number, quantity: number, discount: number) => Math.max(rate * quantity - discount, 0);
export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  IN_HOUSE: "In-house", EXTERNAL: "External", OUTSOURCING: "Outsourcing", HOME_VISIT: "Home Visit",
};
export const SERVICE_TYPE_BADGE: Record<ServiceType, string> = {
  IN_HOUSE: "diag-badge-active", EXTERNAL: "diag-badge-info", OUTSOURCING: "diag-badge-warning", HOME_VISIT: "diag-badge-critical",
};
export const ROUTING_LABELS: Record<string, string> = {
  in_house: "In-house", outsourced: "Outsourced", pending_vendor: "Needs partner lab",
};

export function patientLabel(o: Pick<LabOrder, "patient_name" | "walkin_name">) {
  return o.patient_name || o.walkin_name || "-";
}

/** Validates the patient section and returns the API fields for it. */
export function patientFields(choice: PatientChoice): Record<string, string | undefined> {
  if (choice.mode === "registered") {
    if (!choice.patient) throw new Error("Search and select the registered patient (UHID or name).");
    return { patient_id: choice.patient.patient_id };
  }
  const digits = choice.mobile.replace(/\D/g, "");
  if (!choice.name.trim()) throw new Error("Enter the patient name.");
  if (digits.length !== 10) throw new Error("Enter a valid 10-digit mobile number.");
  if (choice.age && !/^\d{1,3}$/.test(choice.age)) throw new Error("Age must be a number.");
  return {
    walkin_name: choice.name.trim(), walkin_mobile: digits,
    walkin_age: choice.age || undefined, walkin_gender: choice.gender || undefined,
  };
}

// ------------------------------------------------------ patient chooser --

export function PatientChooser({ value, onChange, title = "Patient" }: {
  value: PatientChoice; onChange: (v: PatientChoice) => void; title?: string;
}) {
  const setMode = (mode: PatientChoice["mode"]) =>
    onChange(mode === "registered" ? { mode, patient: null } : { mode, name: "", mobile: "", age: "", gender: "" });
  return (
    <div className="diag-card">
      <div className="diag-card-header"><h3>{title}</h3></div>
      <Tabs>
        <TabsTrigger active={value.mode === "registered"} onClick={() => setMode("registered")}>Registered (UHID)</TabsTrigger>
        <TabsTrigger active={value.mode === "walkin"} onClick={() => setMode("walkin")}>Walk-in (no UHID)</TabsTrigger>
      </Tabs>
      {value.mode === "registered" ? (
        <div style={{ marginTop: "0.6rem" }}>
          <PatientSearchPicker placeholder="Search by UHID or patient name" onSelect={(patient) => onChange({ mode: "registered", patient })} />
          {value.patient && (
            <div className="diag-note-box" style={{ marginTop: "0.5rem" }}>
              <strong>{[value.patient.name, value.patient.last_name].filter(Boolean).join(" ")}</strong>
              {" "}&middot; UHID {value.patient.patient_id}
              {value.patient.phone ? ` · ${value.patient.phone}` : ""}
              {value.patient.gender ? ` · ${value.patient.gender}` : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="diag-form-grid" style={{ marginTop: "0.6rem" }}>
          <div><Label>Patient name *</Label><Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></div>
          <div><Label>Mobile number *</Label>
            <Input inputMode="numeric" maxLength={10} value={value.mobile} placeholder="10-digit mobile"
              onChange={(e) => onChange({ ...value, mobile: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div><Label>Age</Label>
            <Input inputMode="numeric" maxLength={3} value={value.age} onChange={(e) => onChange({ ...value, age: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div><Label>Gender</Label>
            <Select value={value.gender} onChange={(e) => onChange({ ...value, gender: e.target.value })}>
              <option value="">-- Select --</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ test basket --

export function useTestBasket(setNotice: Dispatch<SetStateAction<Notice | null>>) {
  const [services, setServices] = useState<DiagService[]>([]);
  const [basket, setBasket] = useState<BasketItem[]>([]);

  useEffect(() => {
    apiFetch<{ services: DiagService[] }>("/api/diag/services?active_only=true")
      .then((d) => setServices(d.services || []))
      .catch((err) => reportError(setNotice, err, "Could not load the test catalogue."));
  }, [setNotice]);

  const add = useCallback((svc: DiagService) => {
    setBasket((prev) => {
      if (prev.some((b) => b.service_id === svc.id)) {
        setNotice({ type: "info", message: `${svc.name} is already selected.` });
        return prev;
      }
      return [...prev, { service_id: svc.id, code: svc.code, name: svc.name, service_type: svc.service_type, quantity: 1, rate: svc.rate, discount: 0 }];
    });
  }, [setNotice]);
  const update = useCallback((id: number, patch: Partial<BasketItem>) =>
    setBasket((prev) => prev.map((b) => (b.service_id === id ? { ...b, ...patch } : b))), []);
  const remove = useCallback((id: number) => setBasket((prev) => prev.filter((b) => b.service_id !== id)), []);
  const clear = useCallback(() => setBasket([]), []);
  return { services, basket, add, update, remove, clear };
}

export function TestPicker({ services, onAdd, labOnly = false }: {
  services: DiagService[]; onAdd: (svc: DiagService) => void; labOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState<"LAB" | "IMAGING">("LAB");
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const want = labOnly ? "LAB" : dept;
    return services.filter((s) => s.service_type === want && (!q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)));
  }, [services, dept, search, labOnly]);
  return (
    <>
      <div className="diag-filters-row">
        <Input placeholder="Search test name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!labOnly && (
        <Tabs>
          <TabsTrigger active={dept === "LAB"} onClick={() => setDept("LAB")}>Laboratory</TabsTrigger>
          <TabsTrigger active={dept === "IMAGING"} onClick={() => setDept("IMAGING")}>Imaging</TabsTrigger>
        </Tabs>
      )}
      <div className="diag-table-card" style={{ maxHeight: 260, overflowY: "auto" }}>
        <table className="diag-data-table">
          <thead><tr><th>Test</th><th>Department</th><th>Rate</th><th></th></tr></thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{s.name} <span className="muted">({s.code})</span></td>
                <td>{s.department || "-"}</td>
                <td>{money(s.rate)}</td>
                <td><Button size="sm" variant="secondary" onClick={() => onAdd(s)}>+ Add</Button></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={4} className="diag-empty">No tests match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function BasketTable({ basket, onUpdate, onRemove, extraHeader, renderExtra }: {
  basket: BasketItem[];
  onUpdate: (id: number, patch: Partial<BasketItem>) => void;
  onRemove: (id: number) => void;
  extraHeader?: ReactNode;
  renderExtra?: (item: BasketItem) => ReactNode;
}) {
  const cols = 6 + (renderExtra ? 1 : 0);
  return (
    <table className="diag-data-table">
      <thead><tr><th>Test</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th>{renderExtra && <th>{extraHeader}</th>}<th></th></tr></thead>
      <tbody>
        {basket.map((b) => (
          <tr key={b.service_id}>
            <td>{b.name}</td>
            <td><Input type="number" min={1} style={{ width: 60 }} value={b.quantity}
              onChange={(e) => onUpdate(b.service_id, { quantity: Math.max(Number(e.target.value) || 1, 1) })} /></td>
            <td>{money(b.rate)}</td>
            <td><Input type="number" min={0} style={{ width: 70 }} value={b.discount}
              onChange={(e) => onUpdate(b.service_id, { discount: Math.max(Number(e.target.value) || 0, 0) })} /></td>
            <td>{money(lineAmount(b.rate, b.quantity, b.discount))}</td>
            {renderExtra && <td>{renderExtra(b)}</td>}
            <td><Button size="sm" variant="ghost" onClick={() => onRemove(b.service_id)}>Remove</Button></td>
          </tr>
        ))}
        {basket.length === 0 && <tr><td colSpan={cols} className="diag-empty">No tests selected yet.</td></tr>}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ bill summary --

export type BillTotals = { gross: number; itemDiscounts: number; subtotal: number; billDiscount: number; fee: number; total: number };

export function useBillTotals(basket: BasketItem[], fee = 0) {
  const [discountType, setDiscountType] = useState<"percent" | "flat">("percent");
  const [discountVal, setDiscountVal] = useState(0);
  const totals: BillTotals = useMemo(() => {
    const gross = basket.reduce((s, b) => s + b.rate * b.quantity, 0);
    const itemDiscounts = basket.reduce((s, b) => s + b.discount, 0);
    const subtotal = basket.reduce((s, b) => s + lineAmount(b.rate, b.quantity, b.discount), 0);
    const raw = discountVal <= 0 || subtotal <= 0 ? 0 : discountType === "percent" ? (subtotal * discountVal) / 100 : discountVal;
    const billDiscount = Math.min(Math.round(raw), subtotal);
    const safeFee = Math.max(Number(fee) || 0, 0);
    return { gross, itemDiscounts, subtotal, billDiscount, fee: safeFee, total: Math.max(subtotal - billDiscount, 0) + safeFee };
  }, [basket, discountType, discountVal, fee]);

  /** Order items for the API, with the bill discount spread across lines so invoiced lines add up. */
  const itemsForApi = useCallback(() => basket.map((b) => {
    const line = lineAmount(b.rate, b.quantity, b.discount);
    const share = totals.billDiscount > 0 && totals.subtotal > 0 ? Math.round((line / totals.subtotal) * totals.billDiscount) : 0;
    return { service_id: b.service_id, quantity: b.quantity, discount: b.discount + share, ...(b.vendor_id ? { vendor_id: b.vendor_id } : {}) };
  }), [basket, totals]);

  const discountNote = totals.billDiscount > 0
    ? `Discount: ${money(totals.billDiscount)} (${discountType === "percent" ? `${discountVal}%` : "flat"})` : undefined;
  const reset = () => { setDiscountType("percent"); setDiscountVal(0); };
  return { totals, discountType, setDiscountType, discountVal, setDiscountVal, itemsForApi, discountNote, reset };
}

export function BillSummary({ bill, feeLabel, feeEditor, badge, note, children }: {
  bill: ReturnType<typeof useBillTotals>; feeLabel?: string; feeEditor?: ReactNode; badge?: ReactNode; note?: ReactNode; children?: ReactNode;
}) {
  const { totals, discountType, setDiscountType, discountVal, setDiscountVal } = bill;
  const row = (label: ReactNode, value: ReactNode, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: strong ? 18 : 14, fontWeight: strong ? 800 : undefined, marginTop: 4 }}>
      <span>{label}</span>{strong ? <span>{value}</span> : <strong>{value}</strong>}
    </div>
  );
  return (
    <div className="diag-card diag-edit-panel">
      <div className="diag-card-header"><h3>Bill</h3>{badge}</div>
      <div className="diag-note-box" style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Bill discount</strong>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <Button type="button" size="sm" variant={discountType === "percent" ? "primary" : "secondary"} onClick={() => setDiscountType("percent")}>%</Button>
            <Button type="button" size="sm" variant={discountType === "flat" ? "primary" : "secondary"} onClick={() => setDiscountType("flat")}>Flat</Button>
          </div>
        </div>
        <Input type="number" min={0} max={discountType === "percent" ? 100 : totals.subtotal} value={discountVal || ""}
          onChange={(e) => setDiscountVal(Math.max(Number(e.target.value) || 0, 0))} placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 250"} />
      </div>
      {feeEditor}
      {row("Tests (gross)", money(totals.gross))}
      {totals.itemDiscounts > 0 && row("Item discounts", `-${money(totals.itemDiscounts)}`)}
      {totals.billDiscount > 0 && row("Bill discount", `-${money(totals.billDiscount)}`)}
      {feeLabel && row(feeLabel, money(totals.fee))}
      <hr style={{ margin: "0.6rem 0" }} />
      {row("Total", money(totals.total), true)}
      {note && <div className="diag-note-box">{note}</div>}
      <div className="diag-form-actions" style={{ flexDirection: "column", alignItems: "stretch" }}>{children}</div>
    </div>
  );
}

// ------------------------------------------------------- draft + checkout --

/** Creates (or reuses) the draft order, confirms it to raise the invoice, and loads the result. */
export function useDraftCheckout(createPath: string) {
  const [draft, setDraft] = useState<{ id: number; signature: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const checkout = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const signature = JSON.stringify(payload);
      let orderId = draft && draft.signature === signature ? draft.id : null;
      if (!orderId) {
        // A previous attempt left a draft for different details: discard it rather than leave it orphaned.
        if (draft) await apiFetch(`/api/diag/orders/${draft.id}/cancel`, { method: "POST" }).catch(() => {});
        const res = await apiFetch<{ order_id: number }>(createPath, { method: "POST", body: JSON.stringify(payload) });
        orderId = res.order_id;
        setDraft({ id: orderId, signature });
      }
      await apiFetch(`/api/diag/orders/${orderId}/confirm`, { method: "POST" });
      setDraft(null);
      return await loadOrderWithInvoice(orderId);
    } finally {
      setBusy(false);
    }
  }, [createPath, draft]);

  return { checkout, busy, resetDraft: () => setDraft(null) };
}

export async function loadOrderWithInvoice(orderId: number): Promise<{ order: LabOrder; invoice: LabInvoice | null }> {
  const order = await apiFetch<LabOrder>(`/api/diag/orders/${orderId}`);
  const invoice = order.invoice_id ? await apiFetch<LabInvoice>(`/api/diag/invoices/${order.invoice_id}`).catch(() => null) : null;
  return { order, invoice };
}

// ------------------------------------------------------- payment + invoice --

export const PAYMENT_MODES: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "Online - UPI" },
  { value: "bank", label: "Online - Bank transfer" },
];

export function PaymentModal({ invoice, open, onClose, onPaid, setNotice }: {
  invoice: LabInvoice | null; open: boolean; onClose: () => void; onPaid: () => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
}) {
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState("cash");
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && invoice) { setAmount(invoice.due_amount); setMode("cash"); setRef(""); }
  }, [open, invoice]);
  const pay = async () => {
    if (!invoice) return;
    if (!(amount > 0)) { setNotice({ type: "warning", message: "Enter the amount received." }); return; }
    if (amount > invoice.due_amount + 0.005) { setNotice({ type: "warning", message: `Amount exceeds the balance due (${money(invoice.due_amount)}).` }); return; }
    setSaving(true);
    try {
      await apiFetch(`/api/diag/invoices/${invoice.id}/payments`, {
        method: "POST", body: JSON.stringify({ amount, payment_mode: mode, gateway_ref: ref.trim() || undefined }),
      });
      setNotice({ type: "success", message: `Payment of ${money(amount)} recorded (${PAYMENT_MODES.find((m) => m.value === mode)?.label}).` });
      onPaid();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record payment.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Record payment - ${invoice?.invoice_no || ""}`}>
      <div className="diag-form-grid">
        <div><Label>Amount (due {money(invoice?.due_amount)})</Label><Input type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        <div><Label>Payment mode</Label>
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </div>
        {mode !== "cash" && (
          <div className="diag-form-full"><Label>Transaction / reference no.</Label><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Card slip, UPI or bank reference (optional)" /></div>
        )}
        <div className="diag-form-full"><Button variant="primary" disabled={saving} onClick={() => void pay()}>{saving ? "Saving..." : "Confirm payment"}</Button></div>
      </div>
    </Modal>
  );
}

export function printLabInvoice(order: LabOrder, invoice: LabInvoice | null) {
  const active = order.items.filter((i) => !i.cancelled_at);
  const rows = active.map((i) =>
    `<tr><td>${esc(i.service_name)}</td><td>${i.quantity}</td><td>${money(i.rate)}</td><td>${money(i.discount)}</td><td>${money(i.amount)}</td></tr>`).join("");
  const fee = Number(order.home_visit_fee || 0);
  const feeRow = fee > 0 ? `<tr><td colspan="4">Home visit convenience fee</td><td>${money(fee)}</td></tr>` : "";
  const billed = active.reduce((s, i) => s + i.amount, 0) + fee;
  const patient = order.patient_id
    ? `${esc(order.patient_name)} &nbsp; <strong>UHID:</strong> ${esc(order.patient_id)}`
    : `${esc(order.walkin_name)} &nbsp; <strong>Mobile:</strong> ${esc(order.walkin_mobile)}`;
  const visit = order.service_type === "HOME_VISIT"
    ? `<p><strong>Home visit:</strong> ${esc(order.visit_address)} &nbsp; <strong>Scheduled:</strong> ${esc(order.visit_scheduled_at ? new Date(order.visit_scheduled_at).toLocaleString() : "-")}</p>` : "";
  printViaIframe(`
    <html><head><title>Invoice ${esc(invoice?.invoice_no || order.order_no)}</title></head><body style="font-family:sans-serif;padding:24px;">
    <h2>HospAI -- Diagnostics Invoice (${esc(SERVICE_TYPE_LABELS[order.service_type] || order.service_type)})</h2>
    <p><strong>Invoice:</strong> ${esc(invoice?.invoice_no || "-")} &nbsp; <strong>Order:</strong> ${esc(order.order_no)} &nbsp; <strong>Date:</strong> ${esc(new Date(order.created_at).toLocaleString())}</p>
    <p><strong>Patient:</strong> ${patient}</p>
    ${visit}
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Test</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th></tr></thead><tbody>${rows}${feeRow}</tbody></table>
    <div style="max-width:280px;margin-left:auto;margin-top:12px;">
      <div style="display:flex;justify-content:space-between;"><span>Total</span><strong>${money(invoice?.total_amount ?? billed)}</strong></div>
      ${invoice ? `<div style="display:flex;justify-content:space-between;"><span>Paid</span><strong>${money(invoice.paid_amount)}</strong></div>
      <div style="display:flex;justify-content:space-between;font-weight:700;"><span>Balance due</span><span>${money(invoice.due_amount)}</span></div>` : ""}
    </div>
    </body></html>
  `);
}

/** Shown after checkout: invoice status with Pay / Print, plus each test's routing. */
export function OrderResultPanel({ result, onReload, onNew, setNotice }: {
  result: { order: LabOrder; invoice: LabInvoice | null };
  onReload: () => void; onNew: () => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
}) {
  const { order, invoice } = result;
  const [payOpen, setPayOpen] = useState(false);
  return (
    <div className="diag-card">
      <div className="diag-detail-header">
        <div>
          <h3>{order.order_no} <span className={`diag-badge ${SERVICE_TYPE_BADGE[order.service_type]}`}>{SERVICE_TYPE_LABELS[order.service_type]}</span></h3>
          <div className="diag-detail-meta">
            <span>{patientLabel(order)}</span>{order.patient_id && <span>UHID {order.patient_id}</span>}
            {order.visit_scheduled_at && <span>Visit {new Date(order.visit_scheduled_at).toLocaleString()}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button size="sm" variant="ghost" onClick={() => printLabInvoice(order, invoice)}>Print invoice</Button>
          {invoice && invoice.due_amount > 0 && <Button size="sm" variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>}
          <Button size="sm" variant="secondary" onClick={onNew}>New order</Button>
        </div>
      </div>
      <table className="diag-data-table">
        <thead><tr><th>Test</th><th>Amount</th><th>Status</th><th>Processing</th></tr></thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id}>
              <td>{i.service_name}</td><td>{money(i.amount)}</td>
              <td><span className={`diag-badge ${i.cancelled_at ? "diag-badge-muted" : "diag-badge-info"}`}>{i.cancelled_at ? "cancelled" : i.progress_status}</span></td>
              <td>{i.routing ? ROUTING_LABELS[i.routing] || i.routing : order.service_type === "HOME_VISIT" ? "Decided when sample reaches the lab" : "-"}</td>
            </tr>
          ))}
          {Number(order.home_visit_fee || 0) > 0 && <tr><td>Home visit convenience fee</td><td>{money(order.home_visit_fee)}</td><td /><td /></tr>}
        </tbody>
      </table>
      {invoice && (
        <div className="diag-note-box">
          Invoice {invoice.invoice_no}: total {money(invoice.total_amount)}, paid {money(invoice.paid_amount)}, due {money(invoice.due_amount)} ({invoice.payment_status})
        </div>
      )}
      <PaymentModal invoice={invoice} open={payOpen} onClose={() => setPayOpen(false)} setNotice={setNotice}
        onPaid={() => { setPayOpen(false); onReload(); }} />
    </div>
  );
}
