import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Tabs, TabsTrigger, Textarea } from "../components/ui";
import PatientSearchPicker from "../components/PatientSearchPicker";
import PatientIdentityBanner from "../components/PatientIdentityBanner";
import { apiFetch, reportError } from "../lib/api";
import type { Notice, Patient } from "../types";
import { printViaIframe } from "../lib/printViaIframe";
import { openReportForItem } from "../lib/diagReports";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type OrdersTab = "new" | "orders" | "invoices";
type ServiceDept = "LAB" | "IMAGING";
type PaymentMode = "cash" | "card" | "upi" | "bank";
type ReferralDiscountType = "percent" | "flat";
type InvoiceStatusFilter = "all" | "due" | "paid";

type DiagService = { id: number; code: string; name: string; service_type: string; department?: string; rate: number };
type OrderItemDraft = {
  service_id: number; code: string; name: string; service_type: string; department?: string;
  quantity: number; rate: number; discount: number; duplicate_reason?: string;
};
type EncounterOption = { kind: "OP" | "EMERGENCY" | "IP"; id: number; label: string; doctor_name?: string };

type DiagOrderItem = {
  id: number; service_id: number; service_name: string; department_type: string; quantity: number;
  rate: number; discount: number; amount: number; progress_status: string; cancelled_at?: string | null; cancel_reason?: string | null;
};
type DiagOrder = {
  id: number; order_no: string; patient_id: string; patient_name?: string; encounter_type: string;
  appointment_id?: number; admission_id?: number; external_source?: string; referring_clinician?: string;
  priority: string; clinical_indication?: string; notes?: string; status: string; invoice_id?: number;
  created_at: string; items: DiagOrderItem[];
};
type DiagInvoice = {
  id: number; invoice_no: string; patient_id: string; total_amount: number; paid_amount: number;
  due_amount: number; payment_status: string; created_at?: string; order_no?: string;
};

const money = (amount: number) => `Rs. ${amount}`;
const lineAmount = (rate: number, quantity: number, discount: number) => Math.max(rate * quantity - discount, 0);

function orderStatusBadgeClass(status: string): string {
  if (status === "confirmed") return "diag-badge-active";
  if (status === "cancelled") return "diag-badge-muted";
  return "diag-badge-warning";
}

// Progress states at which the item has a report draft (results finalized / exam completed) or later.
const REPORT_STAGES = new Set(["results_entered", "exam_completed", "authorized", "released"]);

function hasReport(item: { progress_status: string }): boolean {
  return REPORT_STAGES.has(item.progress_status);
}

function invoiceStatusBadgeClass(status: string): string {
  if (status === "paid") return "diag-badge-active";
  if (status === "partial") return "diag-badge-warning";
  return "diag-badge-muted";
}

export default function LabDiagnosticsOrdersPage({ setNotice, onNavigate }: Props) {
  const [tab, setTab] = useState<OrdersTab>("new");

  // ---- New order state ----
  const [patient, setPatient] = useState<Patient | null>(null);
  const [encounters, setEncounters] = useState<EncounterOption[]>([]);
  const [encounterKey, setEncounterKey] = useState("");
  const [externalSource, setExternalSource] = useState("");
  const [referringClinician, setReferringClinician] = useState("");
  const [priority, setPriority] = useState("Routine");
  const [clinicalIndication, setClinicalIndication] = useState("");
  const [notes, setNotes] = useState("");
  const [referralDiscountType, setReferralDiscountType] = useState<ReferralDiscountType>("percent");
  const [referralDiscountVal, setReferralDiscountVal] = useState(0);

  const [services, setServices] = useState<DiagService[]>([]);
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceDeptTab, setServiceDeptTab] = useState<ServiceDept>("LAB");
  const [basket, setBasket] = useState<OrderItemDraft[]>([]);
  const [duplicateIds, setDuplicateIds] = useState<number[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [currentDraftOrder, setCurrentDraftOrder] = useState<DiagOrder | null>(null);
  // Payload the current draft was saved with -- if the form changes afterwards, the draft is replaced rather than confirmed stale.
  const [draftSignature, setDraftSignature] = useState("");

  // ---- Orders list state ----
  const [orders, setOrders] = useState<DiagOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderStatusFilter, setOrderStatusFilter] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<DiagOrder | null>(null);
  const [addServiceOpen, setAddServiceOpen] = useState(false);

  // ---- Invoices/payments state ----
  const [invoices, setInvoices] = useState<DiagInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<InvoiceStatusFilter>("all");
  const [payModal, setPayModal] = useState<DiagInvoice | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMode, setPayMode] = useState<PaymentMode>("cash");

  useEffect(() => {
    apiFetch<{ services: DiagService[] }>("/api/diag/services?active_only=true").then((d) => setServices(d.services || [])).catch(() => {});
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const params: Record<string, string> = {};
      if (orderStatusFilter) params.status = orderStatusFilter;
      const qs = new URLSearchParams(params).toString();
      const data = await apiFetch<{ orders: DiagOrder[] }>(`/api/diag/orders?${qs}`);
      setOrders(data.orders || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load orders.");
    } finally {
      setOrdersLoading(false);
    }
  }, [orderStatusFilter, setNotice]);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const data = await apiFetch<{ invoices: DiagInvoice[] }>("/api/diag/invoices");
      setInvoices(data.invoices || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load invoices.");
    } finally {
      setInvoicesLoading(false);
    }
  }, [setNotice]);

  useEffect(() => {
    if (tab === "orders") void loadOrders();
    if (tab === "invoices") void loadInvoices();
  }, [tab, loadOrders, loadInvoices]);

  // ---- Patient + encounter selection ----
  const onSelectPatient = useCallback(async (p: Patient) => {
    setPatient(p);
    setEncounters([]);
    setEncounterKey("");
    setBasket([]);
    try {
      const [appts, admissions] = await Promise.all([
        apiFetch<{ appointments: any[] }>(`/api/appointments?patient_id=${encodeURIComponent(p.patient_id)}`).catch(() => ({ appointments: [] })),
        apiFetch<{ admissions: any[] }>(`/api/patients/${encodeURIComponent(p.patient_id)}/admissions`).catch(() => ({ admissions: [] })),
      ]);
      const opts: EncounterOption[] = [];
      (appts.appointments || []).forEach((a) => {
        const kind = (a.visit_type || "").toLowerCase() === "emergency" ? "EMERGENCY" : "OP";
        opts.push({
          kind, id: a.id,
          label: `${kind === "EMERGENCY" ? "Emergency" : "OPD"} visit · ${a.department || ""} · ${new Date(a.appointment_date).toLocaleDateString()}`.trim(),
          doctor_name: a.doctor_name,
        });
      });
      (admissions.admissions || []).filter((a) => !a.discharge_date).forEach((a) => {
        opts.push({ kind: "IP", id: a.id, label: `Inpatient admission · ADM-${a.id} · since ${new Date(a.admission_date).toLocaleDateString()}` });
      });
      setEncounters(opts);

      // A currently-admitted patient is, by default, an inpatient order --
      // don't make staff manually re-select what the system already knows.
      // An active IP admission always wins over any OP/Emergency visit on
      // record, since that's this patient's current real status; if there's
      // no admission but exactly one other visit, that one is unambiguous
      // too. Multiple candidates of the same kind stay unselected so staff
      // picks the right one instead of the system guessing.
      const ipOpts = opts.filter((o) => o.kind === "IP");
      if (ipOpts.length === 1) {
        setEncounterKey(`${ipOpts[0].kind}-${ipOpts[0].id}`);
      } else if (ipOpts.length === 0 && opts.length === 1) {
        setEncounterKey(`${opts[0].kind}-${opts[0].id}`);
      }
    } catch {
      // encounter lookups failing shouldn't block patient selection
    }
  }, []);

  const changePatient = useCallback(() => {
    setPatient(null);
    setEncounters([]);
    setEncounterKey("");
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("selected_diag_patient");
    if (saved) {
      localStorage.removeItem("selected_diag_patient");
      apiFetch<{ patient?: Patient }>(`/api/patients/${encodeURIComponent(saved)}`)
        .then((res) => {
          if (res?.patient?.patient_id) void onSelectPatient(res.patient);
        })
        .catch(() => {});
    }
  }, [onSelectPatient]);

  const selectedEncounter = useMemo(() => encounters.find((e) => `${e.kind}-${e.id}` === encounterKey), [encounters, encounterKey]);

  useEffect(() => {
    if (selectedEncounter?.doctor_name) setReferringClinician(selectedEncounter.doctor_name);
  }, [encounterKey]);

  const filteredServices = useMemo(() => {
    const q = serviceSearch.trim().toLowerCase();
    return services.filter((s) => s.service_type === serviceDeptTab && (!q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)));
  }, [services, serviceDeptTab, serviceSearch]);

  // Re-checked whenever the basket, patient or visit changes, since "already ordered" is per encounter.
  const basketServiceKey = basket.map((b) => b.service_id).join(",");
  useEffect(() => {
    if (!patient || !basketServiceKey) { setDuplicateIds([]); return; }
    let cancelled = false;
    const params = new URLSearchParams({ patient_id: patient.patient_id });
    basketServiceKey.split(",").forEach((id) => params.append("service_id", id));
    if (selectedEncounter?.kind === "IP") params.set("admission_id", String(selectedEncounter.id));
    else if (selectedEncounter) params.set("appointment_id", String(selectedEncounter.id));
    apiFetch<{ duplicate_service_ids: number[] }>(`/api/diag/orders/check-duplicates?${params.toString()}`)
      .then((data) => { if (!cancelled) setDuplicateIds(data.duplicate_service_ids || []); })
      .catch(() => { /* non-blocking */ });
    return () => { cancelled = true; };
  }, [patient, selectedEncounter, basketServiceKey]);

  const addToBasket = useCallback((svc: DiagService) => {
    setBasket((prev) => {
      if (prev.some((b) => b.service_id === svc.id)) {
        setNotice({ type: "info", message: `${svc.name} is already in this order.` });
        return prev;
      }
      return [...prev, { service_id: svc.id, code: svc.code, name: svc.name, service_type: svc.service_type, department: svc.department, quantity: 1, rate: svc.rate, discount: 0 }];
    });
  }, [setNotice]);

  const removeFromBasket = useCallback((serviceId: number) => {
    setBasket((prev) => prev.filter((b) => b.service_id !== serviceId));
  }, []);

  const updateBasketItem = useCallback((serviceId: number, patch: Partial<OrderItemDraft>) => {
    setBasket((prev) => prev.map((x) => (x.service_id === serviceId ? { ...x, ...patch } : x)));
  }, []);

  const grossTotal = useMemo(() => basket.reduce((sum, b) => sum + b.rate * b.quantity, 0), [basket]);
  const basketDiscountTotal = useMemo(() => basket.reduce((sum, b) => sum + b.discount, 0), [basket]);
  const subtotalBeforeReferral = useMemo(() => basket.reduce((sum, b) => sum + lineAmount(b.rate, b.quantity, b.discount), 0), [basket]);
  const referralDiscountAmount = useMemo(() => {
    if (referralDiscountVal <= 0 || subtotalBeforeReferral <= 0) return 0;
    const raw = referralDiscountType === "percent" ? (subtotalBeforeReferral * referralDiscountVal) / 100 : referralDiscountVal;
    return Math.min(Math.round(raw), subtotalBeforeReferral);
  }, [subtotalBeforeReferral, referralDiscountVal, referralDiscountType]);
  const basketTotal = useMemo(() => Math.max(subtotalBeforeReferral - referralDiscountAmount, 0), [subtotalBeforeReferral, referralDiscountAmount]);

  const resetNewOrderForm = useCallback(() => {
    setPatient(null); setEncounters([]); setEncounterKey(""); setExternalSource("");
    setReferringClinician(""); setPriority("Routine"); setClinicalIndication(""); setNotes("");
    setBasket([]); setDuplicateIds([]); setCurrentDraftOrder(null); setDraftSignature("");
    setReferralDiscountType("percent"); setReferralDiscountVal(0);
  }, []);

  const buildOrderPayload = useCallback(() => {
    if (!patient) throw new Error("Select a patient first.");
    if (!selectedEncounter && !externalSource.trim()) throw new Error("Select the visit/admission, or mark this as an external order.");
    if (basket.length === 0) throw new Error("Add at least one service.");
    const missingReason = basket.find((b) => duplicateIds.includes(b.service_id) && !b.duplicate_reason?.trim());
    if (missingReason) throw new Error(`A reason is required to repeat ${missingReason.name} for this encounter.`);

    // Spread the referral discount proportionally across items so invoiced lines add up to the net total.
    const items = basket.map((b) => {
      const lineSubtotal = lineAmount(b.rate, b.quantity, b.discount);
      const referralShare = referralDiscountAmount > 0 && subtotalBeforeReferral > 0
        ? Math.round((lineSubtotal / subtotalBeforeReferral) * referralDiscountAmount)
        : 0;
      return {
        service_id: b.service_id, quantity: b.quantity, discount: b.discount + referralShare,
        is_duplicate_repeat: duplicateIds.includes(b.service_id), duplicate_reason: b.duplicate_reason,
      };
    });
    const referralNote = referralDiscountAmount > 0
      ? `Referral discount: ${money(referralDiscountAmount)} (${referralDiscountType === "percent" ? `${referralDiscountVal}%` : "flat"})`
      : "";

    return {
      patient_id: patient.patient_id,
      encounter_type: selectedEncounter ? selectedEncounter.kind : "EXTERNAL",
      appointment_id: selectedEncounter && selectedEncounter.kind !== "IP" ? selectedEncounter.id : undefined,
      admission_id: selectedEncounter?.kind === "IP" ? selectedEncounter.id : undefined,
      external_source: !selectedEncounter ? externalSource.trim() : undefined,
      referring_clinician: referringClinician,
      priority, clinical_indication: clinicalIndication,
      notes: [referralNote, notes].filter(Boolean).join(" | "),
      items,
    };
  }, [patient, selectedEncounter, externalSource, basket, duplicateIds, referringClinician, priority, clinicalIndication, notes, referralDiscountAmount, subtotalBeforeReferral, referralDiscountType, referralDiscountVal]);

  const openOrder = useCallback(async (orderId: number) => {
    try {
      setSelectedOrder(await apiFetch<DiagOrder>(`/api/diag/orders/${orderId}`));
    } catch (err: any) {
      reportError(setNotice, err, "Could not load order.");
    }
  }, [setNotice]);

  // Returns the draft order matching the current form, creating it -- and discarding a stale
  // draft saved before the patient, visit or basket changed -- when needed.
  const ensureDraftOrder = useCallback(async (): Promise<{ order: DiagOrder; created: boolean }> => {
    const payload = buildOrderPayload();
    const signature = JSON.stringify(payload);
    if (currentDraftOrder && signature === draftSignature) return { order: currentDraftOrder, created: false };
    if (currentDraftOrder) {
      await apiFetch(`/api/diag/orders/${currentDraftOrder.id}/cancel`, { method: "POST" }).catch(() => {});
    }
    const res = await apiFetch<{ order_id: number }>("/api/diag/orders", { method: "POST", body: JSON.stringify(payload) });
    const full = await apiFetch<DiagOrder>(`/api/diag/orders/${res.order_id}`);
    setCurrentDraftOrder(full);
    setDraftSignature(signature);
    return { order: full, created: true };
  }, [buildOrderPayload, currentDraftOrder, draftSignature]);

  const saveDraft = useCallback(async () => {
    setSavingOrder(true);
    try {
      const { order, created } = await ensureDraftOrder();
      setNotice(created
        ? { type: "success", message: `Draft order ${order.order_no} saved. No charge posted yet.` }
        : { type: "info", message: `Draft ${order.order_no} is already up to date.` });
    } catch (err: any) {
      reportError(setNotice, err, "Could not save draft.");
    } finally {
      setSavingOrder(false);
    }
  }, [ensureDraftOrder, setNotice]);

  const confirmOrder = useCallback(async () => {
    setSavingOrder(true);
    try {
      const { order } = await ensureDraftOrder();
      const result = await apiFetch<{ invoice_id: number | null; subtotal: number }>(`/api/diag/orders/${order.id}/confirm`, { method: "POST" });
      setNotice({
        type: "success",
        message: result.invoice_id
          ? `Order ${order.order_no} confirmed. Invoice posted for ${money(result.subtotal)}.`
          : `Order ${order.order_no} confirmed and added to the admission's running bill (${money(result.subtotal)}).`,
      });
      resetNewOrderForm();
      setTab("orders");
      void loadOrders();
      void openOrder(order.id);
    } catch (err: any) {
      reportError(setNotice, err, "Could not confirm order.");
    } finally {
      setSavingOrder(false);
    }
  }, [ensureDraftOrder, resetNewOrderForm, loadOrders, openOrder, setNotice]);

  const previewEstimate = useCallback(() => {
    if (!patient) { setNotice({ type: "warning", message: "Select a patient first." }); return; }
    const rows = basket.map((b) => `<tr><td>${b.name} (${b.code})</td><td>${b.quantity}</td><td>${money(b.rate)}</td><td>${money(b.discount)}</td><td>${money(lineAmount(b.rate, b.quantity, b.discount))}</td></tr>`).join("");
    const referralRow = referralDiscountAmount > 0
      ? `<div style="display:flex;justify-content:space-between;"><span>Referral discount (${referralDiscountType === "percent" ? `${referralDiscountVal}%` : "flat"})</span><strong>-${money(referralDiscountAmount)}</strong></div>`
      : "";
    printViaIframe(`
      <html><head><title>Estimate</title></head><body style="font-family:sans-serif;padding:24px;">
      <h2>HospAI -- Estimate (not a bill)</h2>
      <p>Patient: ${[patient.name, patient.last_name].filter(Boolean).join(" ")} (${patient.patient_id})</p>
      <p>Referring clinician: ${referringClinician || "-"}</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Service</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="max-width:280px;margin-left:auto;margin-top:12px;">
        <div style="display:flex;justify-content:space-between;"><span>Gross subtotal</span><strong>${money(grossTotal)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Item discounts</span><strong>-${money(basketDiscountTotal)}</strong></div>
        ${referralRow}
        <hr />
        <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;"><span>Estimated total</span><span>${money(basketTotal)}</span></div>
      </div>
      <p style="color:#888;font-size:12px;">This is a planning estimate only. Actual charges are posted on order confirmation.</p>
      </body></html>
    `);
  }, [patient, basket, basketTotal, grossTotal, basketDiscountTotal, referralDiscountAmount, referralDiscountType, referralDiscountVal, referringClinician, setNotice]);

  // ---- Orders list detail actions ----

  const cancelItem = useCallback(async (itemId: number) => {
    const reason = window.prompt("Reason for cancelling this service:");
    if (!reason) return;
    try {
      const res = await apiFetch<{ refund_amount?: number }>(`/api/diag/order-items/${itemId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      setNotice({
        type: "success",
        message: res.refund_amount ? `Service cancelled. Refund of ${money(res.refund_amount)} recorded against the invoice -- return it to the patient.` : "Service cancelled.",
      });
      if (selectedOrder) await openOrder(selectedOrder.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not cancel this service.");
    }
  }, [selectedOrder, openOrder, loadOrders, setNotice]);

  const confirmSelectedOrder = useCallback(async () => {
    if (!selectedOrder) return;
    try {
      const result = await apiFetch<{ invoice_id: number | null; subtotal: number }>(`/api/diag/orders/${selectedOrder.id}/confirm`, { method: "POST" });
      setNotice({
        type: "success",
        message: result.invoice_id
          ? `Order confirmed. Invoice posted for ${money(result.subtotal)}.`
          : `Order confirmed and added to the admission's running bill (${money(result.subtotal)}).`,
      });
      await openOrder(selectedOrder.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not confirm order.");
    }
  }, [selectedOrder, openOrder, loadOrders, setNotice]);

  const discardSelectedDraft = useCallback(async () => {
    if (!selectedOrder || !window.confirm(`Discard draft ${selectedOrder.order_no}? No charges were posted for it.`)) return;
    try {
      await apiFetch(`/api/diag/orders/${selectedOrder.id}/cancel`, { method: "POST" });
      setNotice({ type: "success", message: `Draft ${selectedOrder.order_no} discarded.` });
      if (currentDraftOrder?.id === selectedOrder.id) { setCurrentDraftOrder(null); setDraftSignature(""); }
      await openOrder(selectedOrder.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not discard the draft.");
    }
  }, [selectedOrder, currentDraftOrder, openOrder, loadOrders, setNotice]);

  const addServiceToSelectedOrder = useCallback(async (svc: DiagService, qty: number) => {
    if (!selectedOrder) return;
    try {
      await apiFetch(`/api/diag/orders/${selectedOrder.id}/items`, { method: "POST", body: JSON.stringify({ items: [{ service_id: svc.id, quantity: qty }] }) });
      setNotice({ type: "success", message: `${svc.name} added to ${selectedOrder.order_no}.` });
      setAddServiceOpen(false);
      await openOrder(selectedOrder.id);
      void loadOrders();
    } catch (err: any) {
      reportError(setNotice, err, "Could not add service.");
    }
  }, [selectedOrder, openOrder, loadOrders, setNotice]);

  const recordPayment = useCallback(async () => {
    if (!payModal) return;
    try {
      await apiFetch(`/api/diag/invoices/${payModal.id}/payments`, { method: "POST", body: JSON.stringify({ amount: payAmount, payment_mode: payMode }) });
      setNotice({ type: "success", message: "Payment recorded." });
      setPayModal(null);
      void loadInvoices();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record payment.");
    }
  }, [payModal, payAmount, payMode, loadInvoices, setNotice]);

  const printOrderSlip = useCallback((o: DiagOrder) => {
    const totalAmount = o.items.reduce((sum, i) => sum + (i.cancelled_at ? 0 : i.amount), 0);
    const rows = o.items.map((i) => `<tr><td>${i.service_name}</td><td>${i.department_type}</td><td>${money(i.amount)}</td><td>${i.cancelled_at ? "cancelled" : i.progress_status}</td></tr>`).join("");
    printViaIframe(`
      <html><head><title>Order ${o.order_no}</title></head><body style="font-family:sans-serif;padding:24px;">
      <h2>HospAI -- Diagnostic Order Slip</h2>
      <p><strong>Order:</strong> ${o.order_no} &nbsp; <strong>Patient UHID:</strong> ${o.patient_id} &nbsp; <strong>Priority:</strong> ${o.priority}</p>
      <p><strong>Referring clinician:</strong> ${o.referring_clinician || "-"} &nbsp; <strong>Clinical indication:</strong> ${o.clinical_indication || "-"}</p>
      ${o.notes ? `<p><strong>Notes:</strong> ${o.notes}</p>` : ""}
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Service</th><th>Department</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      <h3 style="text-align:right;">Total billable: ${money(totalAmount)}</h3>
      </body></html>
    `);
  }, []);

  const printInvoiceReceipt = useCallback((inv: DiagInvoice) => {
    printViaIframe(`
      <html><head><title>Receipt ${inv.invoice_no}</title></head><body style="font-family:sans-serif;padding:24px;">
      <h2>HospAI -- Payment Receipt</h2>
      <p><strong>Invoice:</strong> ${inv.invoice_no} &nbsp; <strong>Patient UHID:</strong> ${inv.patient_id} &nbsp; <strong>Status:</strong> ${inv.payment_status}</p>
      <div style="max-width:280px;margin-top:16px;">
        <div style="display:flex;justify-content:space-between;"><span>Total billed</span><strong>${money(inv.total_amount)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Amount paid</span><strong>${money(inv.paid_amount)}</strong></div>
        <hr />
        <div style="display:flex;justify-content:space-between;font-weight:700;"><span>Balance due</span><span>${money(inv.due_amount)}</span></div>
      </div>
      </body></html>
    `);
  }, []);

  const openPaymentModal = useCallback((inv: DiagInvoice) => {
    setPayModal(inv);
    setPayAmount(inv.due_amount);
  }, []);

  const invoiceTotals = useMemo(() => ({
    invoiced: invoices.reduce((sum, i) => sum + i.total_amount, 0),
    collected: invoices.reduce((sum, i) => sum + i.paid_amount, 0),
    due: invoices.reduce((sum, i) => sum + i.due_amount, 0),
  }), [invoices]);

  const filteredInvoices = useMemo(() => {
    if (invoiceStatusFilter === "due") return invoices.filter((i) => i.due_amount > 0);
    if (invoiceStatusFilter === "paid") return invoices.filter((i) => i.payment_status === "paid");
    return invoices;
  }, [invoices, invoiceStatusFilter]);

  return (
    <div className="diag-page">
      <Tabs>
        <TabsTrigger active={tab === "new"} onClick={() => setTab("new")}>New order</TabsTrigger>
        <TabsTrigger active={tab === "orders"} onClick={() => setTab("orders")}>Orders</TabsTrigger>
        <TabsTrigger active={tab === "invoices"} onClick={() => setTab("invoices")}>Invoices & payments</TabsTrigger>
      </Tabs>

      {tab === "new" && (
        <div className="diag-split diag-split-wide">
          <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
            <div className="diag-card">
              <div className="diag-card-header"><h3>Patient & encounter</h3></div>
              {!patient && <PatientSearchPicker onSelect={onSelectPatient} placeholder="Search UHID, patient name or phone" />}
              {patient && (
                <>
                  <PatientIdentityBanner patient={patient} />
                  <Button variant="ghost" size="sm" onClick={changePatient}>Change patient</Button>
                  <div className="diag-form-grid">
                    <div className="diag-form-full">
                      <Label>Visit / admission</Label>
                      <Select value={encounterKey} onChange={(e) => { setEncounterKey(e.target.value); setExternalSource(""); }}>
                        <option value="">-- Select --</option>
                        {encounters.map((e) => <option key={`${e.kind}-${e.id}`} value={`${e.kind}-${e.id}`}>{e.label}</option>)}
                        <option value="__external__">External / referred order (no internal visit)</option>
                      </Select>
                    </div>
                    {encounterKey === "__external__" && (
                      <div className="diag-form-full"><Label>Referring source</Label><Input value={externalSource} onChange={(e) => setExternalSource(e.target.value)} placeholder="Referring clinic / physician name" /></div>
                    )}
                    <div><Label>Referring clinician</Label><Input value={referringClinician} onChange={(e) => setReferringClinician(e.target.value)} /></div>
                    <div><Label>Priority</Label>
                      <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                        <option value="Routine">Routine</option>
                        <option value="Urgent">Urgent</option>
                        <option value="STAT">STAT</option>
                      </Select>
                    </div>
                    <div className="diag-form-full"><Label>Clinical indication</Label><Input value={clinicalIndication} onChange={(e) => setClinicalIndication(e.target.value)} placeholder="Reason for testing" /></div>
                    <div className="diag-form-full"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
                  </div>
                </>
              )}
            </div>

            <div className="diag-card">
              <div className="diag-card-header"><h3>Select services</h3></div>
              <div className="diag-filters-row">
                <Input placeholder="Search service name or code" value={serviceSearch} onChange={(e) => setServiceSearch(e.target.value)} />
              </div>
              <Tabs>
                <TabsTrigger active={serviceDeptTab === "LAB"} onClick={() => setServiceDeptTab("LAB")}>Laboratory</TabsTrigger>
                <TabsTrigger active={serviceDeptTab === "IMAGING"} onClick={() => setServiceDeptTab("IMAGING")}>Imaging</TabsTrigger>
              </Tabs>
              <div className="diag-table-card" style={{ maxHeight: 260, overflowY: "auto" }}>
                <table className="diag-data-table">
                  <thead><tr><th>Service</th><th>Department</th><th>Rate</th><th></th></tr></thead>
                  <tbody>
                    {filteredServices.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name} <span className="muted">({s.code})</span></td>
                        <td>{s.department || "-"}</td>
                        <td>{money(s.rate)}</td>
                        <td><Button size="sm" variant="secondary" onClick={() => addToBasket(s)}>+ Add</Button></td>
                      </tr>
                    ))}
                    {filteredServices.length === 0 && <tr><td colSpan={4} className="diag-empty">No services match.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="diag-section-title">Order basket</div>
              <table className="diag-data-table">
                <thead><tr><th>Service</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th><th></th></tr></thead>
                <tbody>
                  {basket.map((b) => (
                    <tr key={b.service_id}>
                      <td>
                        {b.name}
                        {duplicateIds.includes(b.service_id) && (
                          <div className="diag-note-box" style={{ margin: "4px 0 0" }}>
                            Already active for this encounter. <Input placeholder="Reason to repeat" value={b.duplicate_reason || ""} onChange={(e) => updateBasketItem(b.service_id, { duplicate_reason: e.target.value })} />
                          </div>
                        )}
                      </td>
                      <td><Input type="number" min={1} style={{ width: 60 }} value={b.quantity} onChange={(e) => updateBasketItem(b.service_id, { quantity: Number(e.target.value) || 1 })} /></td>
                      <td>{money(b.rate)}</td>
                      <td><Input type="number" min={0} style={{ width: 70 }} value={b.discount} onChange={(e) => updateBasketItem(b.service_id, { discount: Number(e.target.value) || 0 })} /></td>
                      <td>{money(lineAmount(b.rate, b.quantity, b.discount))}</td>
                      <td><Button size="sm" variant="ghost" onClick={() => removeFromBasket(b.service_id)}>Remove</Button></td>
                    </tr>
                  ))}
                  {basket.length === 0 && <tr><td colSpan={6} className="diag-empty">No services selected yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="diag-card diag-edit-panel">
            <div className="diag-card-header"><h3>Order summary</h3><span className="diag-badge diag-badge-warning">{currentDraftOrder ? `Draft ${currentDraftOrder.order_no}` : "New"}</span></div>

            <div className="diag-form-full" style={{ marginBottom: "0.75rem" }}>
              <Label>Referral doctor</Label>
              <Input value={referringClinician} onChange={(e) => setReferringClinician(e.target.value)} placeholder="Dr. name / clinic" />
            </div>

            <div className="diag-note-box" style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Referral discount</strong>
                <div style={{ display: "flex", gap: "0.3rem" }}>
                  <Button type="button" size="sm" variant={referralDiscountType === "percent" ? "primary" : "secondary"} onClick={() => setReferralDiscountType("percent")}>%</Button>
                  <Button type="button" size="sm" variant={referralDiscountType === "flat" ? "primary" : "secondary"} onClick={() => setReferralDiscountType("flat")}>Flat</Button>
                </div>
              </div>
              <Input
                type="number" min={0} max={referralDiscountType === "percent" ? 100 : grossTotal}
                value={referralDiscountVal || ""}
                onChange={(e) => setReferralDiscountVal(Math.max(Number(e.target.value) || 0, 0))}
                placeholder={referralDiscountType === "percent" ? "e.g. 10" : "e.g. 250"}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 8 }}><span>Gross subtotal</span><strong>{money(grossTotal)}</strong></div>
            {basketDiscountTotal > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}><span>Item discounts</span><strong>-{money(basketDiscountTotal)}</strong></div>
            )}
            {referralDiscountAmount > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
                <span>Referral discount ({referralDiscountType === "percent" ? `${referralDiscountVal}%` : "flat"})</span>
                <strong>-{money(referralDiscountAmount)}</strong>
              </div>
            )}
            <hr style={{ margin: "0.6rem 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800 }}><span>Total</span><span>{money(basketTotal)}</span></div>
            <div className="diag-note-box">
              {selectedEncounter?.kind === "IP"
                ? "For inpatient orders, charges are added to the selected admission's running bill -- no separate invoice is created until discharge."
                : "Confirming this order posts one invoice for the services above."}
            </div>
            <div className="diag-form-actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <Button variant="secondary" disabled={savingOrder} onClick={() => void saveDraft()}>Save draft</Button>
              <Button variant="primary" disabled={savingOrder} onClick={() => void confirmOrder()}>{savingOrder ? "Working..." : "Review & confirm order"}</Button>
              <Button variant="ghost" onClick={previewEstimate}>Preview estimate</Button>
              <Button variant="ghost" onClick={() => setTab("orders")}>Open order history</Button>
            </div>
          </div>
        </div>
      )}

      {tab === "orders" && (
        <div className="diag-worklist-shell">
          <div className="diag-card">
            <div className="diag-card-header"><h3>Orders</h3></div>
            <Select value={orderStatusFilter} onChange={(e) => setOrderStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
            <div style={{ marginTop: "0.75rem" }}>
              {ordersLoading && <p className="muted">Loading...</p>}
              {!ordersLoading && orders.length === 0 && <p className="muted">No orders found.</p>}
              {orders.map((o) => (
                <div key={o.id} className={`diag-worklist-row ${selectedOrder?.id === o.id ? "active" : ""}`} onClick={() => void openOrder(o.id)}>
                  <div className="diag-worklist-row-top"><span>{o.order_no} &middot; {o.patient_name || o.patient_id}</span><span className={`diag-badge ${orderStatusBadgeClass(o.status)}`}>{o.status}</span></div>
                  <div className="diag-worklist-row-meta"><span>{o.patient_id}</span><span>{o.encounter_type}</span><span>{o.priority}</span><span>{new Date(o.created_at).toLocaleDateString()}</span></div>
                </div>
              ))}
            </div>
          </div>
          <div className="diag-card">
            {!selectedOrder && <p className="muted">Select an order to view details.</p>}
            {selectedOrder && (
              <>
                <div className="diag-detail-header">
                  <div>
                    <h3>{selectedOrder.order_no}</h3>
                    <div className="diag-detail-meta">
                      <span>Patient: {selectedOrder.patient_name || selectedOrder.patient_id} ({selectedOrder.patient_id})</span>
                      <span>{selectedOrder.encounter_type}</span>
                      <span>Priority: {selectedOrder.priority}</span>
                      <span>Status: {selectedOrder.status}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    {selectedOrder.status !== "cancelled" && <Button size="sm" variant="secondary" onClick={() => setAddServiceOpen(true)}>Add service</Button>}
                    <Button size="sm" variant="ghost" onClick={() => printOrderSlip(selectedOrder)}>Print slip</Button>
                  </div>
                </div>
                <table className="diag-data-table">
                  <thead><tr><th>Service</th><th>Department</th><th>Amount</th><th>Clinical progress</th><th></th></tr></thead>
                  <tbody>
                    {selectedOrder.items.map((i) => (
                      <tr key={i.id}>
                        <td>{i.service_name}</td>
                        <td>{i.department_type}</td>
                        <td>{money(i.amount)}</td>
                        <td><span className={`diag-badge ${i.cancelled_at ? "diag-badge-muted" : "diag-badge-info"}`}>{i.cancelled_at ? "cancelled" : i.progress_status}</span></td>
                        <td>
                          <div style={{ display: "flex", gap: "0.35rem", justifyContent: "flex-end", flexWrap: "wrap", alignItems: "center" }}>
                            {/* Once a report exists (results finalized / exam completed onwards), "View Report" below
                                is the specific, correct destination -- showing "View in Lab/Imaging" too
                                would just be a second button for the same "go look at this item" action. */}
                            {onNavigate && i.department_type === "LAB" && !i.cancelled_at && !hasReport(i) && (
                              <Button size="sm" variant="secondary" onClick={() => onNavigate("diag-laboratory")}>View in Lab</Button>
                            )}
                            {onNavigate && i.department_type === "IMAGING" && !i.cancelled_at && !hasReport(i) && (
                              <Button size="sm" variant="secondary" onClick={() => onNavigate("diag-imaging")}>View in Imaging</Button>
                            )}
                            {onNavigate && hasReport(i) && (
                              <Button size="sm" variant="ghost" onClick={() => void openReportForItem(i.id, i.department_type === "IMAGING" ? "IMAGING" : "LAB", onNavigate)}>View Report</Button>
                            )}
                            {!i.cancelled_at && i.progress_status === "ordered" && <Button size="sm" variant="ghost" onClick={() => void cancelItem(i.id)}>Cancel</Button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedOrder.status === "draft" && (
                  <div className="diag-form-actions">
                    <Button variant="ghost" onClick={() => void discardSelectedDraft()}>Discard draft</Button>
                    <Button variant="primary" onClick={() => void confirmSelectedOrder()}>Confirm order</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === "invoices" && (
        <>
          <div className="diag-kpi-row">
            <div className={`diag-kpi-tile ${invoiceStatusFilter === "all" ? "active" : ""}`} onClick={() => setInvoiceStatusFilter("all")}>
              <span>Total invoiced ({invoices.length})</span><strong>{money(invoiceTotals.invoiced)}</strong>
            </div>
            <div className={`diag-kpi-tile ${invoiceStatusFilter === "paid" ? "active" : ""}`} onClick={() => setInvoiceStatusFilter("paid")}>
              <span>Total collected ({invoices.filter((i) => i.payment_status === "paid").length})</span><strong>{money(invoiceTotals.collected)}</strong>
            </div>
            <div className={`diag-kpi-tile ${invoiceStatusFilter === "due" ? "active" : ""}`} onClick={() => setInvoiceStatusFilter("due")}>
              <span>Outstanding due ({invoices.filter((i) => i.due_amount > 0).length})</span><strong>{money(invoiceTotals.due)}</strong>
            </div>
          </div>
          <div className="diag-card">
            <div className="diag-card-header"><h3>Invoices & payments</h3></div>
            <table className="diag-data-table">
              <thead><tr><th>Invoice</th><th>Patient</th><th>Date</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {invoicesLoading && <tr><td colSpan={8} className="diag-empty">Loading...</td></tr>}
                {!invoicesLoading && filteredInvoices.length === 0 && <tr><td colSpan={8} className="diag-empty">No invoices found.</td></tr>}
                {filteredInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.invoice_no}</td>
                    <td>{inv.patient_id}</td>
                    <td>{inv.created_at ? new Date(inv.created_at).toLocaleDateString() : "-"}</td>
                    <td>{money(inv.total_amount)}</td>
                    <td>{money(inv.paid_amount)}</td>
                    <td>{money(inv.due_amount)}</td>
                    <td><span className={`diag-badge ${invoiceStatusBadgeClass(inv.payment_status)}`}>{inv.payment_status}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                        <Button size="sm" variant="ghost" onClick={() => printInvoiceReceipt(inv)}>Print receipt</Button>
                        {inv.due_amount > 0 && <Button size="sm" variant="secondary" onClick={() => openPaymentModal(inv)}>Record payment</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal open={!!selectedOrder && addServiceOpen} onClose={() => setAddServiceOpen(false)} title="Add service to order">
        {selectedOrder && <AddServiceForm services={services} onAdd={addServiceToSelectedOrder} />}
      </Modal>

      <Modal open={!!payModal} onClose={() => setPayModal(null)} title={`Record payment -- ${payModal?.invoice_no || ""}`}>
        {payModal && (
          <div className="diag-form-grid">
            <div><Label>Amount</Label><Input type="number" value={payAmount} onChange={(e) => setPayAmount(Number(e.target.value))} /></div>
            <div><Label>Payment mode</Label>
              <Select value={payMode} onChange={(e) => setPayMode(e.target.value as PaymentMode)}>
                <option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="bank">Bank transfer</option>
              </Select>
            </div>
            <div className="diag-form-full">
              <Button variant="primary" onClick={() => void recordPayment()}>Confirm payment</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AddServiceForm({ services, onAdd }: { services: DiagService[]; onAdd: (svc: DiagService, qty: number) => void }) {
  const [serviceId, setServiceId] = useState<number | "">("");
  const [qty, setQty] = useState(1);
  const svc = services.find((s) => s.id === serviceId);
  return (
    <div className="diag-form-grid">
      <div className="diag-form-full">
        <Label>Service</Label>
        <Select value={serviceId} onChange={(e) => setServiceId(Number(e.target.value))}>
          <option value="">-- Select --</option>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code}) -- {money(s.rate)}</option>)}
        </Select>
      </div>
      <div><Label>Quantity</Label><Input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} /></div>
      <div className="diag-form-full"><Button variant="primary" disabled={!svc} onClick={() => svc && onAdd(svc, qty)}>Add to order</Button></div>
    </div>
  );
}
