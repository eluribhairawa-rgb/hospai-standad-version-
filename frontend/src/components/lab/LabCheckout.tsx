// Shared pieces of the Lab "common process": labels, money, payment dialog, invoice print.
// Used by the Orders & Billing order screen, Order History and the home-visit board.
import { brandTitle, escapeBrandText } from "../../lib/branding";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select } from "../ui";
import { apiFetch, reportError } from "../../lib/api";
import { printViaIframe } from "../../lib/printViaIframe";
import type { Notice } from "../../types";
import { formatPhone } from "../../lib/phone";

// ---------------------------------------------------------------- types --

export type ServiceType = "IN_HOUSE" | "EXTERNAL" | "OUTSOURCING" | "HOME_VISIT";
export type DiagService = { id: number; code: string; name: string; service_type: string; department?: string; rate: number };
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
  patient_phone?: string; walkin_name?: string; walkin_mobile?: string; walkin_country_code?: string | null; walkin_age?: string; walkin_gender?: string;
  referring_clinician?: string; invoice_id?: number | null; created_at: string; items: LabOrderItem[];
  home_visit_fee?: number; visit_address?: string | null; visit_scheduled_at?: string | null; visit_status?: string | null;
  outsource_vendor_id?: number | null;
};

// -------------------------------------------------------------- helpers --

export const money = (amount: number | null | undefined) => `Rs. ${Math.round((Number(amount) || 0) * 100) / 100}`;
export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  IN_HOUSE: "In-house", EXTERNAL: "External", OUTSOURCING: "Outsourcing", HOME_VISIT: "Home Visit",
};
export const SERVICE_TYPE_BADGE: Record<ServiceType, string> = {
  IN_HOUSE: "diag-badge-active", EXTERNAL: "diag-badge-info", OUTSOURCING: "diag-badge-warning", HOME_VISIT: "lab-badge-home",
};
export const ROUTING_LABELS: Record<string, string> = {
  in_house: "In-house", outsourced: "Outsourced", pending_vendor: "Needs partner lab",
};


// ------------------------------------------------------- orders --

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
    : `${esc(order.walkin_name)} &nbsp; <strong>Mobile:</strong> ${esc(formatPhone(order.walkin_country_code, order.walkin_mobile))}`;
  const visit = order.service_type === "HOME_VISIT"
    ? `<p><strong>Home visit:</strong> ${esc(order.visit_address)} &nbsp; <strong>Scheduled:</strong> ${esc(order.visit_scheduled_at ? new Date(order.visit_scheduled_at).toLocaleString() : "-")}</p>` : "";
  printViaIframe(`
    <html><head><title>Invoice ${esc(invoice?.invoice_no || order.order_no)}</title></head><body style="font-family:sans-serif;padding:24px;">
    <h2>${escapeBrandText(brandTitle())} -- Diagnostics Invoice (${esc(SERVICE_TYPE_LABELS[order.service_type] || order.service_type)})</h2>
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
