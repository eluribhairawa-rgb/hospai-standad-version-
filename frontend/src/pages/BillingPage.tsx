import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Button, Input, Label, Select, Table, TableCell, TableHead, TableRow } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { openRazorpayCheckout } from "../lib/razorpay";
import { fullPatientName, lookupPatientByUhid, normalizeUhidLookup } from "../lib/patientLookup";
import type { Notice } from "../types";
import { PRINT_BRAND_HEADER_DATA_URI } from "../lib/printBrand";
import { printViaIframe } from "../lib/printViaIframe";
import { generatePDFBlob, downloadPDF, patientFilename } from "../lib/exportService";

export type BillingView =
  | "aging"
  | "reconciliation"
  | "create-invoice"
  | "record-payment"
  | "insurance-claims"
  | "invoices"
  | "payment-mode-breakdown"
  | "collections-by-module";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  view?: BillingView;
};

type BillingSummary = {
  total_billed: number;
  total_collected: number;
  total_due: number;
  total_advance: number;
  total_refunded: number;
  doctor_payout_ready?: number;
  payment_mode_breakdown: { label: string; count: number }[];
  collections_by_module: { label: string; count: number }[];
  aging_buckets: {
    bucket_0_30: number;
    bucket_31_60: number;
    bucket_61_90: number;
    bucket_91_plus: number;
  };
  reconciliation_summary: {
    gateway_collected: number;
    converted_total: number;
  };
  conversion_breakdown: { label: string; count: number }[];
};

type Invoice = {
  id: number;
  invoice_no?: string;
  patient_id?: string;
  module?: string;
  doctor_name?: string;
  clinic_name?: string;
  referral_source?: string;
  total_amount?: number;
  paid_amount?: number;
  advance_amount?: number;
  refunded_amount?: number;
  due_amount?: number;
  payment_status?: string;
  created_at?: string;
};

type InsuranceClaim = {
  id: number;
  invoice_id: number;
  patient_id?: string | null;
  insurer_name: string;
  claim_amount?: number;
  approved_amount?: number;
  claim_status?: string;
  external_ref?: string | null;
  submitted_at?: string;
};

type RevenueWindow = "day" | "month";

const EMPTY_SUMMARY: BillingSummary = {
  total_billed: 0,
  total_collected: 0,
  total_due: 0,
  total_advance: 0,
  total_refunded: 0,
  doctor_payout_ready: 0,
  payment_mode_breakdown: [],
  collections_by_module: [],
  aging_buckets: {
    bucket_0_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    bucket_91_plus: 0,
  },
  reconciliation_summary: {
    gateway_collected: 0,
    converted_total: 0,
  },
  conversion_breakdown: [],
};

type InvoiceForm = {
  id: string;
  patient_id: string;
  module: string;
  total_amount: string;
  paid_amount: string;
  advance_amount: string;
  refunded_amount: string;
  doctor_name: string;
};

type PaymentForm = {
  invoice_id: string;
  patient_id: string;
  patient_name: string;
  payment_for: string;
  amount: string;
  payment_mode: string;
  gateway_ref: string;
  converted_from_mode: string;
  converted_to_mode: string;
};

type BillingFilters = {
  patient_id: string;
  module: string;
  status: string;
};

type ClaimForm = {
  id: string;
  invoice_id: string;
  patient_id: string;
  insurer_name: string;
  claim_amount: string;
  approved_amount: string;
  claim_status: string;
  external_ref: string;
};

const DEFAULT_INVOICE_FORM: InvoiceForm = {
  id: "",
  patient_id: "",
  module: "OP",
  total_amount: "0",
  paid_amount: "0",
  advance_amount: "0",
  refunded_amount: "0",
  doctor_name: "",
};

const DEFAULT_PAYMENT_FORM: PaymentForm = {
  invoice_id: "",
  patient_id: "",
  patient_name: "",
  payment_for: "",
  amount: "0",
  payment_mode: "cash",
  gateway_ref: "",
  converted_from_mode: "",
  converted_to_mode: "",
};

const DEFAULT_BILLING_FILTERS: BillingFilters = {
  patient_id: "",
  module: "",
  status: "",
};

const DEFAULT_CLAIM_FORM: ClaimForm = {
  id: "",
  invoice_id: "",
  patient_id: "",
  insurer_name: "",
  claim_amount: "0",
  approved_amount: "0",
  claim_status: "submitted",
  external_ref: "",
};

const BILLING_VIEW_CONFIG: Record<BillingView, { title: string; subtitle: string }> = {
  aging: {
    title: "Receivable Aging",
    subtitle: "Track due balances across aging buckets.",
  },
  reconciliation: {
    title: "Payment Reconciliation",
    subtitle: "Compare gateway collections and converted amounts.",
  },
  "create-invoice": {
    title: "Create Invoice",
    subtitle: "Create and update patient billing invoices.",
  },
  "record-payment": {
    title: "Payment Collection",
    subtitle: "Live revenue snapshot and collection summary.",
  },
  "insurance-claims": {
    title: "Insurance Claims",
    subtitle: "Create, track, and update insurance claim records.",
  },
  invoices: {
    title: "Invoices",
    subtitle: "Review invoice list with quick filtering and actions.",
  },
  "payment-mode-breakdown": {
    title: "Payment Mode Breakdown",
    subtitle: "Understand collection mix by payment method.",
  },
  "collections-by-module": {
    title: "Collections by Module",
    subtitle: "Monitor amount collected per billing module.",
  },
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toMonthInputValue(date: Date) {
  return date.toISOString().slice(0, 7);
}

function invoiceCollectedAmount(invoice: Invoice) {
  return Math.max(Number(invoice.paid_amount || 0) + Number(invoice.advance_amount || 0) - Number(invoice.refunded_amount || 0), 0);
}

function formatCurrencyShort(amount?: number) {
  const val = amount || 0;
  if (val >= 100000) return `₹${(val / 100000).toFixed(2)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K`;
  return `₹${val}`;
}

const safePrintText = (value: unknown) => String(value ?? "-")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

export default function BillingPage({ setNotice, view = "record-payment" }: Props) {
  const [summary, setSummary] = useState<BillingSummary>(EMPTY_SUMMARY);
  const [selectedRevenueSummary, setSelectedRevenueSummary] = useState<BillingSummary>(EMPTY_SUMMARY);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>(DEFAULT_INVOICE_FORM);
  const [invoicePatientName, setInvoicePatientName] = useState("");
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(DEFAULT_PAYMENT_FORM);
  // Patient ID last filled in automatically from an invoice (not typed by the user). The
  // "No patient found" warning is only for IDs the user entered, e.g. a walk-in invoice
  // pre-selected on page load has no patient record and must not raise a warning toast.
  const autoFilledPatientIdRef = useRef<string | null>(null);
  const [claimForm, setClaimForm] = useState<ClaimForm>(DEFAULT_CLAIM_FORM);
  const [filters, setFilters] = useState<BillingFilters>(DEFAULT_BILLING_FILTERS);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingClaim, setSavingClaim] = useState(false);
  const [isRazorpayReady, setIsRazorpayReady] = useState(true);
  const [revenueWindow, setRevenueWindow] = useState<RevenueWindow>("day");
  const [selectedRevenueDate, setSelectedRevenueDate] = useState(() => toDateInputValue(new Date()));
  const [selectedRevenueMonth, setSelectedRevenueMonth] = useState(() => toMonthInputValue(new Date()));
  const maxBreakdownValue = Math.max(1, ...summary.payment_mode_breakdown.map((row) => row.count || 0));
  const maxModuleCollectionValue = Math.max(1, ...summary.collections_by_module.map((row) => row.count || 0));
  const findCollectionAmount = (terms: string[]) => {
    const match = summary.collections_by_module.find((row) => {
      const label = row.label.toLowerCase();
      return terms.some((term) => label.includes(term));
    });
    return match?.count || 0;
  };
  const labRevenue = findCollectionAmount(["lab", "diagnostic"]);
  const todayRevenue = summary.total_collected;
  const monthlyRevenue = summary.total_collected;
  const pendingPayments = summary.total_due;
  const doctorPayoutReady = summary.doctor_payout_ready || 0;
  const needsInvoices = view === "create-invoice" || view === "record-payment" || view === "insurance-claims" || view === "invoices";
  const needsClaims = view === "insurance-claims";
  const selectedPaymentModeBreakdown = selectedRevenueSummary.payment_mode_breakdown.length
    ? selectedRevenueSummary.payment_mode_breakdown
    : [];
  const paymentCollectionTotal = selectedPaymentModeBreakdown.reduce((total, row) => total + Number(row.count || 0), 0);
  const paymentCollectionRows = selectedPaymentModeBreakdown.length
    ? selectedPaymentModeBreakdown
    : [{ label: "No collections recorded", count: 0 }];
  const selectedRevenueInvoices = useMemo(() => {
    return invoices.filter((invoice) => {
      const createdAt = String(invoice.created_at || "");
      if (!createdAt) return false;
      return revenueWindow === "day"
        ? createdAt.slice(0, 10) === selectedRevenueDate
        : createdAt.slice(0, 7) === selectedRevenueMonth;
    });
  }, [invoices, revenueWindow, selectedRevenueDate, selectedRevenueMonth]);
  const selectedRevenueTotal = Number(selectedRevenueSummary.total_collected || 0);
  const selectedRevenueDue = Number(selectedRevenueSummary.total_due || 0);
  const selectedRevenueLabel = revenueWindow === "day" ? "Daily Revenue" : "Monthly Revenue";
  const selectedRevenuePeriod = revenueWindow === "day" ? selectedRevenueDate : selectedRevenueMonth;

  const dueInvoices = useMemo(() => {
    return invoices.filter((invoice) => Number(invoice.due_amount || 0) > 0);
  }, [invoices]);

  const patientDueInvoices = useMemo(() => {
    const patientId = paymentForm.patient_id.trim().toLowerCase();
    if (!patientId) return dueInvoices;
    return dueInvoices.filter((invoice) => String(invoice.patient_id || "").trim().toLowerCase() === patientId);
  }, [dueInvoices, paymentForm.patient_id]);

  const markAutoFilledPatient = (patientId?: string | null) => {
    if (patientId) autoFilledPatientIdRef.current = String(patientId).trim();
    return patientId;
  };

  const applyInvoiceToPaymentForm = (invoice?: Invoice, options: { keepPatient?: boolean } = {}) => {
    if (!invoice) return;
    setPaymentForm((current) => ({
      ...current,
      invoice_id: String(invoice.id),
      patient_id: options.keepPatient ? current.patient_id : markAutoFilledPatient(invoice.patient_id) || current.patient_id,
      patient_name: invoice.clinic_name || current.patient_name,
      payment_for: invoice.referral_source || invoice.module || current.payment_for,
      amount: Number(invoice.due_amount || 0) > 0 ? String(invoice.due_amount || 0) : current.amount,
    }));
  };


  const normalizeBillingSummary = (summaryData: Partial<BillingSummary> = {}): BillingSummary => ({
    ...EMPTY_SUMMARY,
    ...summaryData,
    payment_mode_breakdown: summaryData.payment_mode_breakdown || [],
    collections_by_module: (() => {
      const raw = summaryData.collections_by_module || [];
      const map = new Map<string, number>();
      for (const item of raw) {
        let key = (item.label || "").trim();
        const lower = key.toLowerCase();
        if (lower === "pharmacy") key = "Pharmacy";
        else if (lower.includes("lab") || lower.includes("diag")) key = "Lab / Diagnostics";
        else if (lower.includes("op") || lower.includes("consult") || lower.includes("billing")) key = "OP / Billing";
        else if (lower.includes("ip") || lower.includes("inpatient") || lower.includes("bed")) key = "IP / Inpatient";
        map.set(key, (map.get(key) || 0) + Number(item.count || 0));
      }
      return Array.from(map.entries()).map(([label, count]) => ({ label, count }));
    })(),
    conversion_breakdown: summaryData.conversion_breakdown || [],
    aging_buckets: { ...EMPTY_SUMMARY.aging_buckets, ...(summaryData.aging_buckets || {}) },
    reconciliation_summary: { ...EMPTY_SUMMARY.reconciliation_summary, ...(summaryData.reconciliation_summary || {}) },
  });

  const buildSelectedRevenueSummaryPath = () => {
    const params = new URLSearchParams();
    if (revenueWindow === "day" && selectedRevenueDate) params.set("date", selectedRevenueDate);
    if (revenueWindow === "month" && selectedRevenueMonth) params.set("month", selectedRevenueMonth);
    return `/api/billing/revenue-summary?${params.toString()}`;
  };

  const loadSelectedRevenueSummary = async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<BillingSummary>(buildSelectedRevenueSummaryPath(), { signal });
      if (!signal?.aborted) {
        setSelectedRevenueSummary(normalizeBillingSummary(data));
      }
    } catch (error) {
      if (!signal?.aborted) {
        reportError(setNotice, error as { message?: string; status?: number }, "Unable to load selected payment summary.");
      }
    }
  };

  const buildInvoicePath = (nextFilters: BillingFilters) => {
    const params = new URLSearchParams();
    if (nextFilters.patient_id.trim()) params.set("patient_id", nextFilters.patient_id.trim());
    if (nextFilters.module) params.set("module", nextFilters.module);
    const query = params.toString();
    return query ? `/api/billing/invoices?${query}` : "/api/billing/invoices";
  };

  const loadBilling = async (nextFilters: BillingFilters = filters) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const summaryRequest = apiFetch<BillingSummary>("/api/billing/revenue-summary");
      const invoiceRequest = needsInvoices
        ? apiFetch<{ invoices?: Invoice[] }>(buildInvoicePath(nextFilters))
        : Promise.resolve({ invoices: [] as Invoice[] });
      const claimsRequest = needsClaims
        ? apiFetch<{ claims?: InsuranceClaim[] }>("/api/billing/claims")
        : Promise.resolve({ claims: [] as InsuranceClaim[] });

      const [summaryData, invoiceData, claimsData] = await Promise.all([summaryRequest, invoiceRequest, claimsRequest]);
      const fetchedInvoices = invoiceData.invoices || [];
      const fetchedClaims = claimsData.claims || [];
      setInvoices(fetchedInvoices);
      setClaims(fetchedClaims);
      setSummary(normalizeBillingSummary(summaryData));
      setPaymentForm((current) => {
        if (current.invoice_id) return current;
        const firstDueInvoice = fetchedInvoices.find((invoice) => Number(invoice.due_amount || 0) > 0);
        return firstDueInvoice
          ? {
              ...current,
              invoice_id: String(firstDueInvoice.id),
              patient_id: current.patient_id || markAutoFilledPatient(firstDueInvoice.patient_id) || "",
              patient_name: current.patient_name || firstDueInvoice.clinic_name || "",
              payment_for: current.payment_for || firstDueInvoice.referral_source || firstDueInvoice.module || "",
              amount: current.amount !== "0" ? current.amount : String(firstDueInvoice.due_amount || 0),
            }
          : current;
      });
      setClaimForm((current) => {
        if (current.invoice_id) return current;
        return {
          ...current,
          invoice_id: fetchedInvoices[0] ? String(fetchedInvoices[0].id) : "",
          patient_id: fetchedInvoices[0]?.patient_id || "",
        };
      });
    } catch (error) {
      const typedError = error as { message?: string; status?: number };
      setErrorMessage(typedError.message || "Unable to load billing data.");
      reportError(setNotice, typedError, "Unable to load billing data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBilling();
  }, [view]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSelectedRevenueSummary(controller.signal);
    return () => controller.abort();
  }, [revenueWindow, selectedRevenueDate, selectedRevenueMonth]);

  useEffect(() => {
    apiFetch<{ configured?: boolean }>("/api/payments/razorpay/config")
      .then((data) => setIsRazorpayReady(data.configured !== false))
      .catch(() => setIsRazorpayReady(true));
  }, []);

  const ensureRazorpayConfigured = async () => {
    try {
      const config = await apiFetch<{ configured?: boolean }>("/api/payments/razorpay/config");
      const configured = config.configured !== false;
      setIsRazorpayReady(configured);
      if (!configured) {
        setNotice({ type: "error", message: "Razorpay is not configured. Add keys in backend .env." });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const visibleInvoices = useMemo(() => {
    if (!filters.status) return invoices;
    return invoices.filter((invoice) => (invoice.payment_status || "due") === filters.status);
  }, [invoices, filters.status]);

  const handleFilterSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await loadBilling(filters);
  };

  const clearFilters = async () => {
    setFilters({ ...DEFAULT_BILLING_FILTERS });
    await loadBilling({ ...DEFAULT_BILLING_FILTERS });
  };

  const fillInvoicePatient = async (value: string) => {
    const lookup = normalizeUhidLookup(value);
    if (!lookup) {
      setInvoicePatientName("");
      return;
    }
    try {
      const patient = await lookupPatientByUhid(lookup);
      if (!patient) {
        setInvoicePatientName("");
        setNotice({ type: "warning", message: "No patient found for that UHID / last 4 digits." });
        return;
      }
      setInvoiceForm((current) => ({ ...current, patient_id: patient.patient_id }));
      setInvoicePatientName(fullPatientName(patient) || patient.patient_id);
      setNotice({ type: "success", message: `Patient auto-filled: ${fullPatientName(patient) || patient.patient_id}.` });
    } catch {
      setInvoicePatientName("");
      setNotice({ type: "error", message: "Unable to auto-fill patient details." });
    }
  };

  const fillPaymentPatient = async (value: string) => {
    const lookup = normalizeUhidLookup(value);
    if (!lookup) {
      setPaymentForm((current) => ({ ...current, patient_name: "", invoice_id: "" }));
      return;
    }
    try {
      const patient = await lookupPatientByUhid(lookup);
      if (!patient) {
        setPaymentForm((current) => ({ ...current, patient_name: "", invoice_id: "" }));
        if (autoFilledPatientIdRef.current !== value.trim()) {
          setNotice({ type: "warning", message: "No patient found for that Patient ID / UHID." });
        }
        return;
      }
      const canonicalPatientId = patient.patient_id;
      const patientName = fullPatientName(patient) || canonicalPatientId;
      const matchingDueInvoice = invoices.find((invoice) =>
        String(invoice.patient_id || "").trim().toLowerCase() === canonicalPatientId.trim().toLowerCase()
        && Number(invoice.due_amount || 0) > 0
      );

      setPaymentForm((current) => ({
        ...current,
        patient_id: canonicalPatientId,
        patient_name: patientName,
        invoice_id: matchingDueInvoice ? String(matchingDueInvoice.id) : "",
        payment_for: matchingDueInvoice?.referral_source || matchingDueInvoice?.module || current.payment_for,
        amount: matchingDueInvoice ? String(matchingDueInvoice.due_amount || 0) : current.amount,
      }));

      setNotice({
        type: "success",
        message: matchingDueInvoice
          ? `Patient auto-filled with pending due ${formatCurrency(matchingDueInvoice.due_amount)}.`
          : `Patient auto-filled: ${patientName}. No pending invoice due found.`,
      });
    } catch {
      setNotice({ type: "error", message: "Unable to auto-fill patient payment details." });
    }
  };

  useEffect(() => {
    const rawPatientId = paymentForm.patient_id.trim();
    if (!rawPatientId) return;
    const timer = window.setTimeout(() => {
      void fillPaymentPatient(rawPatientId);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [paymentForm.patient_id]);

  const handleCreateInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const totalAmount = Number(invoiceForm.total_amount) || 0;
    const paidAmount = Number(invoiceForm.paid_amount) || 0;
    const advanceAmount = Number(invoiceForm.advance_amount) || 0;
    const refundedAmount = Number(invoiceForm.refunded_amount) || 0;
    if (totalAmount <= 0) {
      setNotice({ type: "error", message: "Invoice total amount must be greater than zero." });
      return;
    }

    setSavingInvoice(true);
    try {
      const editingInvoiceId = Number(invoiceForm.id);
      const path = editingInvoiceId ? `/api/billing/invoices/${editingInvoiceId}` : "/api/billing/invoices";
      await apiFetch(path, {
        method: editingInvoiceId ? "PUT" : "POST",
        body: JSON.stringify({
          patient_id: invoiceForm.patient_id.trim() || undefined,
          module: invoiceForm.module,
          doctor_name: invoiceForm.doctor_name.trim() || undefined,
          total_amount: totalAmount,
          paid_amount: paidAmount,
          advance_amount: advanceAmount,
          refunded_amount: refundedAmount,
          payment_status:
            Math.max(paidAmount + advanceAmount - refundedAmount, 0) >= totalAmount
              ? "paid"
              : paidAmount > 0 || advanceAmount > 0
                ? "partial"
                : "due",
        }),
      });
      setInvoiceForm({ ...DEFAULT_INVOICE_FORM });
      setNotice({ type: "success", message: editingInvoiceId ? "Invoice updated successfully." : "Invoice created successfully." });
      await loadBilling(filters);
      await loadSelectedRevenueSummary();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create invoice.");
    } finally {
      setSavingInvoice(false);
    }
  };

  const handleEditInvoice = (invoice: Invoice) => {
    setInvoiceForm({
      id: String(invoice.id),
      patient_id: invoice.patient_id || "",
      module: invoice.module || "OP",
      total_amount: String(invoice.total_amount || 0),
      paid_amount: String(invoice.paid_amount || 0),
      advance_amount: String(invoice.advance_amount || 0),
      refunded_amount: String(invoice.refunded_amount || 0),
      doctor_name: "",
    });
  };

  const handleDeleteInvoice = async (invoice: Invoice) => {
    if (!window.confirm(`Delete ${invoice.invoice_no || `INV-${invoice.id}`}?`)) return;
    try {
      await apiFetch(`/api/billing/invoices/${invoice.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Invoice deleted." });
      await loadBilling(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete invoice.");
    }
  };

  const handlePrintInvoice = (invoice: Invoice) => {
    const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const paid = invoice.total_amount - invoice.due_amount;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${safePrintText(invoice.invoice_no || `INV-${invoice.id}`)} Invoice</title>
          <style>
            @media print {
              @page { margin: 15mm; }
              body { font-family: Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; color: #111; margin: 0; padding: 0; }
              .header { display: flex; align-items: center; border-bottom: 2px solid #222; padding-bottom: 10px; margin-bottom: 20px; }
              .brand-logo { width: 70px; height: auto; margin-right: 15px; }
              .brand-title { font-size: 22px; font-weight: bold; margin: 0; }
              .brand-line { font-size: 10px; color: #444; margin: 0; letter-spacing: 0.5px; }
              .meta { margin-left: auto; text-align: right; }
              .meta h1 { font-size: 20px; margin: 0 0 5px 0; }
              .meta p { font-size: 11px; margin: 2px 0; color: #444; }
              .summary { display: flex; justify-content: space-between; margin-bottom: 20px; padding: 15px; background: #f8f9fa; border: 1px solid #ddd; }
              .card { display: flex; flex-direction: column; }
              .card span { font-size: 10px; color: #555; text-transform: uppercase; margin-bottom: 4px; }
              .card strong { font-size: 13px; color: #000; }
              table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
              th { background: #eee; text-align: left; padding: 10px; font-size: 12px; border-bottom: 2px solid #ccc; }
              td { padding: 10px; font-size: 12px; border-bottom: 1px solid #eee; }
              .total { width: 250px; margin-left: auto; border: 1px solid #ddd; padding: 10px; }
              .total div { display: flex; justify-content: space-between; padding: 5px 0; font-size: 12px; }
              .total .grand { font-weight: bold; border-top: 1px solid #ddd; margin-top: 5px; padding-top: 10px; font-size: 14px; }
              .footer { position: fixed; bottom: 0; width: 100%; text-align: center; font-size: 10px; color: #777; border-top: 1px solid #ddd; padding-top: 10px; }
            }
            .journey-print-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .journey-print-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          </style>
        </head>
        <body>
          <main class="sheet">
            <header class="header">
              <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI" />
              <div>
                <p class="brand-title">HospAI</p>
                <p class="brand-line">POLYCLINIC &amp;</p>
                <p class="brand-line">DIAGNOSTICS</p>
              </div>
              <div class="meta"><h1>Invoice Receipt</h1><p><strong>Printed:</strong> ${safePrintText(printedAt)}</p><p><strong>Status:</strong> ${safePrintText(invoice.payment_status || "-")}</p></div>
            </header>
            <section class="content">
              <div class="summary">
                <div class="card"><span>Invoice No</span><strong>${safePrintText(invoice.invoice_no || `INV-${invoice.id}`)}</strong></div>
                <div class="card"><span>Patient UHID</span><strong>${safePrintText(invoice.patient_id || "-")}</strong></div>
                <div class="card"><span>Module</span><strong>${safePrintText(invoice.module || "-")}</strong></div>
                <div class="card"><span>Invoice Date</span><strong>${safePrintText(formatDateTime(invoice.created_at))}</strong></div>
              </div>
              <table>
                <thead><tr><th>Description</th><th>Amount</th><th>Paid / Advance</th><th>Refund</th><th>Due</th></tr></thead>
                <tbody>
                  <tr>
                    <td>${safePrintText(invoice.module || "Hospital Billing")} services</td>
                    <td>${safePrintText(formatCurrency(invoice.total_amount))}</td>
                    <td>${safePrintText(formatCurrency(paid))}</td>
                    <td>${safePrintText(formatCurrency(invoice.refunded_amount))}</td>
                    <td>${safePrintText(formatCurrency(invoice.due_amount))}</td>
                  </tr>
                </tbody>
              </table>
              <div class="total">
                <div><span>Total Amount</span><strong>${safePrintText(formatCurrency(invoice.total_amount))}</strong></div>
                <div><span>Total Collected</span><strong>${safePrintText(formatCurrency(paid))}</strong></div>
                <div class="grand"><span>Balance Due</span><strong>${safePrintText(formatCurrency(invoice.due_amount))}</strong></div>
              </div>
            </section>
            <footer class="footer">This invoice is generated from live HospAI billing records. Paid invoices remain available in Invoice Generation for audit and reprint.</footer>
          </main>
        </body>
      </html>
    `;
    printViaIframe(html);
  };

  const handleDownloadInvoicePdf = async (invoice: Invoice) => {
    try {
      const paid = invoice.total_amount - invoice.due_amount;
      // Invoices only carry the UHID; look the patient up for the name (PDF + file name).
      let patientName = "";
      if (invoice.patient_id) {
        try {
          const res = await apiFetch<{ patient?: { name?: string; last_name?: string } }>(`/api/patients/${encodeURIComponent(invoice.patient_id)}`);
          patientName = [res?.patient?.name, res?.patient?.last_name].filter(Boolean).join(" ");
        } catch {
          // walk-in / external invoice without a registered patient
        }
      }
      const payload = {
        title: "INVOICE",
        subtitle: `Generated for ${invoice.patient_id || "Patient"}`,
        filename: patientFilename(patientName, invoice.patient_id, invoice.invoice_no || `Invoice_${invoice.id}`),
        invoice_meta: {
          invoice_number: invoice.invoice_no || `INV-${invoice.id}`,
          invoice_date: formatDateTime(invoice.created_at),
        },
        patient_info: {
          patient_id: invoice.patient_id || "-",
          patient_name: patientName || "-",
        },
        totals: {
          subtotal: formatCurrency(invoice.total_amount),
          amount_received: formatCurrency(paid),
          balance: formatCurrency(invoice.due_amount),
        },
        sections: [
          {
            title: "",
            headers: ["Description", "Total Amount", "Paid / Advance", "Refund", "Due"],
            rows: [
              [
                `${invoice.module || "Hospital Billing"} services`,
                formatCurrency(invoice.total_amount),
                formatCurrency(paid),
                formatCurrency(invoice.refunded_amount),
                formatCurrency(invoice.due_amount),
              ],
            ],
          },
        ],
      };
      const { blob, filename } = await generatePDFBlob(payload, { dated: false });
      downloadPDF(blob, filename);
    } catch {
      setNotice({ type: "error", message: "Failed to generate Invoice PDF" });
    }
  };

  const handleRecordPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(paymentForm.amount) || 0;
    if (!paymentForm.patient_id.trim()) {
      setNotice({ type: "error", message: "Patient ID is required." });
      return;
    }
    if (!paymentForm.payment_for.trim()) {
      setNotice({ type: "error", message: "Enter what this due payment is for." });
      return;
    }
    if (amount <= 0) {
      setNotice({ type: "error", message: "Payment amount must be greater than zero." });
      return;
    }

    setSavingPayment(true);
    try {
      const selectedInvoiceId = Number(paymentForm.invoice_id);
      const paymentPayload = {
        patient_id: paymentForm.patient_id.trim(),
        patient_name: paymentForm.patient_name.trim() || undefined,
        payment_for: paymentForm.payment_for.trim(),
        amount,
        payment_mode: paymentForm.payment_mode,
        gateway_ref: paymentForm.gateway_ref.trim() || undefined,
        converted_from_mode: paymentForm.converted_from_mode || undefined,
        converted_to_mode: paymentForm.converted_to_mode || undefined,
      };

      if (selectedInvoiceId) {
        await apiFetch(`/api/billing/invoices/${selectedInvoiceId}/payments`, {
          method: "POST",
          body: JSON.stringify(paymentPayload),
        });
      } else {
        await apiFetch("/api/billing/direct-payment", {
          method: "POST",
          body: JSON.stringify(paymentPayload),
        });
      }
      setPaymentForm({ ...DEFAULT_PAYMENT_FORM });
      setNotice({ type: "success", message: "Payment recorded successfully." });
      window.dispatchEvent(new CustomEvent("dashboard:refresh"));
      await loadBilling(filters);
      await loadSelectedRevenueSummary();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to record payment.");
    } finally {
      setSavingPayment(false);
    }
  };

  const handleRazorpayBillingPayment = async () => {
    if (!(await ensureRazorpayConfigured())) {
      return;
    }
    const invoiceId = Number(paymentForm.invoice_id);
    const amount = Number(paymentForm.amount) || 0;
    if (!invoiceId) {
      setNotice({ type: "error", message: "Select a valid invoice." });
      return;
    }
    if (amount <= 0) {
      setNotice({ type: "error", message: "Payment amount must be greater than zero." });
      return;
    }

    const linkedInvoice = invoices.find((invoice) => invoice.id === invoiceId);
    setSavingPayment(true);
    try {
      const order = await apiFetch<{
        key_id: string;
        order_id: string;
        amount: number;
        currency: string;
      }>("/api/billing/razorpay/order", {
        method: "POST",
        body: JSON.stringify({
          invoice_id: invoiceId,
          amount,
          notes: {
            invoice_no: linkedInvoice?.invoice_no || `INV-${invoiceId}`,
            patient_id: linkedInvoice?.patient_id || "",
          },
        }),
      });

      const paymentResult = await openRazorpayCheckout({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency || "INR",
        name: "HospAI Billing",
        description: `Invoice ${linkedInvoice?.invoice_no || `INV-${invoiceId}`}`,
        order_id: order.order_id,
        prefill: {
          name: linkedInvoice?.patient_id || "",
        },
        notes: {
          invoice_id: String(invoiceId),
        },
        theme: {
          color: "#0f766e",
        },
      });

      await apiFetch("/api/billing/razorpay/verify", {
        method: "POST",
        body: JSON.stringify({
          invoice_id: invoiceId,
          amount,
          payment_mode: paymentForm.payment_mode,
          converted_from_mode: paymentForm.converted_from_mode || undefined,
          converted_to_mode: paymentForm.converted_to_mode || undefined,
          razorpay_order_id: paymentResult.razorpay_order_id,
          razorpay_payment_id: paymentResult.razorpay_payment_id,
          razorpay_signature: paymentResult.razorpay_signature,
        }),
      });

      setPaymentForm((current) => ({ ...DEFAULT_PAYMENT_FORM, invoice_id: current.invoice_id }));
      setNotice({ type: "success", message: "Razorpay payment recorded successfully." });
      window.dispatchEvent(new CustomEvent("dashboard:refresh"));
      await loadBilling(filters);
      await loadSelectedRevenueSummary();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to complete Razorpay payment.");
    } finally {
      setSavingPayment(false);
    }
  };

  const handleClaimSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invoiceId = Number(claimForm.invoice_id);
    const claimAmount = Number(claimForm.claim_amount) || 0;
    if (!invoiceId || !claimForm.insurer_name.trim() || claimAmount <= 0) {
      setNotice({ type: "error", message: "Invoice, insurer, and claim amount are required." });
      return;
    }

    setSavingClaim(true);
    try {
      const claimId = Number(claimForm.id);
      const path = claimId ? `/api/billing/claims/${claimId}` : "/api/billing/claims";
      await apiFetch(path, {
        method: claimId ? "PUT" : "POST",
        body: JSON.stringify({
          invoice_id: invoiceId,
          patient_id: claimForm.patient_id.trim() || undefined,
          insurer_name: claimForm.insurer_name.trim(),
          claim_amount: claimAmount,
          approved_amount: Number(claimForm.approved_amount) || 0,
          claim_status: claimForm.claim_status,
          external_ref: claimForm.external_ref.trim() || undefined,
        }),
      });
      setClaimForm((current) => ({
        ...DEFAULT_CLAIM_FORM,
        invoice_id: current.invoice_id,
        patient_id: current.patient_id,
      }));
      setNotice({ type: "success", message: claimId ? "Insurance claim updated." : "Insurance claim created." });
      await loadBilling(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save insurance claim.");
    } finally {
      setSavingClaim(false);
    }
  };

  const handleEditClaim = (claim: InsuranceClaim) => {
    setClaimForm({
      id: String(claim.id),
      invoice_id: String(claim.invoice_id),
      patient_id: claim.patient_id || "",
      insurer_name: claim.insurer_name,
      claim_amount: String(claim.claim_amount || 0),
      approved_amount: String(claim.approved_amount || 0),
      claim_status: claim.claim_status || "submitted",
      external_ref: claim.external_ref || "",
    });
  };

  const handleDeleteClaim = async (claim: InsuranceClaim) => {
    if (!window.confirm(`Delete claim ${claim.id}?`)) return;
    try {
      await apiFetch(`/api/billing/claims/${claim.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Insurance claim deleted." });
      await loadBilling(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete insurance claim.");
    }
  };

  const viewContent = (() => {
    if (view === "aging") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Receivable Aging</h3>
          </div>
          <div className="bar-chart">
            <div className="bar-row">
              <span>0-30 days</span>
              <div className="bar"><div style={{ width: `${Math.max(8, (summary.aging_buckets.bucket_0_30 / Math.max(summary.total_due, 1)) * 100)}%` }} /></div>
              <span>{formatCurrency(summary.aging_buckets.bucket_0_30)}</span>
            </div>
            <div className="bar-row">
              <span>31-60 days</span>
              <div className="bar"><div style={{ width: `${Math.max(8, (summary.aging_buckets.bucket_31_60 / Math.max(summary.total_due, 1)) * 100)}%` }} /></div>
              <span>{formatCurrency(summary.aging_buckets.bucket_31_60)}</span>
            </div>
            <div className="bar-row">
              <span>61-90 days</span>
              <div className="bar"><div style={{ width: `${Math.max(8, (summary.aging_buckets.bucket_61_90 / Math.max(summary.total_due, 1)) * 100)}%` }} /></div>
              <span>{formatCurrency(summary.aging_buckets.bucket_61_90)}</span>
            </div>
            <div className="bar-row">
              <span>91+ days</span>
              <div className="bar"><div style={{ width: `${Math.max(8, (summary.aging_buckets.bucket_91_plus / Math.max(summary.total_due, 1)) * 100)}%` }} /></div>
              <span>{formatCurrency(summary.aging_buckets.bucket_91_plus)}</span>
            </div>
          </div>
        </div>
      );
    }

    if (view === "reconciliation") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Payment Reconciliation</h3>
          </div>
          <div className="care-note-list">
            <div className="care-note-card">
              <strong>Gateway Collected</strong>
              <p>{formatCurrency(summary.reconciliation_summary.gateway_collected)}</p>
            </div>
            <div className="care-note-card">
              <strong>Converted Payments</strong>
              <p>{formatCurrency(summary.reconciliation_summary.converted_total)}</p>
            </div>
          </div>
          {summary.conversion_breakdown.length === 0 ? (
            <p className="muted">No converted payment entries yet.</p>
          ) : (
            <div className="bar-chart">
              {summary.conversion_breakdown.map((row) => (
                <div className="bar-row" key={row.label}>
                  <span>{row.label}</span>
                  <div className="bar"><div style={{ width: `${Math.max(8, (row.count / Math.max(summary.reconciliation_summary.converted_total, 1)) * 100)}%` }} /></div>
                  <span>{formatCurrency(row.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (view === "create-invoice") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Create Invoice</h3>
          </div>
          <form className="module-form-grid module-sales-grid" onSubmit={handleCreateInvoice}>
            <Label>
              UHID / Last 4 Digits (optional)
              <Input
                value={invoiceForm.patient_id}
                onChange={(event) => { setInvoiceForm((current) => ({ ...current, patient_id: event.target.value })); setInvoicePatientName(""); }}
                onBlur={(event) => void fillInvoicePatient(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void fillInvoicePatient((event.currentTarget as HTMLInputElement).value); } }}
                placeholder="Enter 1001 or full UHID"
                aria-label="Billing patient id"
              />
              {invoicePatientName ? <span className="muted">Patient: {invoicePatientName}</span> : null}
            </Label>
            <Label>
              Billing Module
              <Select
                value={invoiceForm.module}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, module: event.target.value }))}
                aria-label="Billing module"
              >
                <option value="OP">OP</option>
                <option value="IP">IP</option>
                <option value="LAB">Lab</option>
              </Select>
            </Label>
            <Label>
              Total Amount
              <Input
                type="number"
                min={0}
                value={invoiceForm.total_amount}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, total_amount: event.target.value }))}
                placeholder="Total amount"
                aria-label="Billing total amount"
              />
            </Label>
            <Label>
              Initial Paid Amount
              <Input
                type="number"
                min={0}
                value={invoiceForm.paid_amount}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, paid_amount: event.target.value }))}
                placeholder="Initial paid amount"
                aria-label="Billing paid amount"
              />
            </Label>
            <Label>
              Advance Amount
              <Input
                type="number"
                min={0}
                value={invoiceForm.advance_amount}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, advance_amount: event.target.value }))}
                placeholder="Advance amount"
                aria-label="Billing advance amount"
              />
            </Label>
            <Label>
              Refund Amount
              <Input
                type="number"
                min={0}
                value={invoiceForm.refunded_amount}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, refunded_amount: event.target.value }))}
                placeholder="Refund amount"
                aria-label="Billing refund amount"
              />
            </Label>
            <Label>
              Doctor Name
              <Input
                value={invoiceForm.doctor_name}
                onChange={(event) => setInvoiceForm((current) => ({ ...current, doctor_name: event.target.value }))}
                placeholder="Doctor name"
                aria-label="Billing doctor name"
              />
            </Label>
            <Button type="submit" disabled={savingInvoice}>{savingInvoice ? "Saving..." : "Create Invoice"}</Button>
            {invoiceForm.id ? (
              <Button type="button" variant="ghost" onClick={() => setInvoiceForm({ ...DEFAULT_INVOICE_FORM })}>
                Cancel Edit
              </Button>
            ) : null}
          </form>
        </div>
      );
    }

    if (view === "record-payment") {
      return (
        <div className="billing-payment-stack">
          <div className="panel">
            <div className="module-panel-head">
              <h3>Record Payment</h3>
            </div>
            <form className="module-form-grid billing-payment-form-grid" onSubmit={handleRecordPayment}>
              <Label>
                Patient ID
                <Input
                  value={paymentForm.patient_id}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, patient_id: event.target.value, invoice_id: "" }))}
                  onBlur={(event) => void fillPaymentPatient(event.target.value)}
                  placeholder="Patient ID / UHID"
                  aria-label="Billing payment patient ID"
                />
              </Label>
              <Label>
                Patient Name
                <Input
                  value={paymentForm.patient_name}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, patient_name: event.target.value }))}
                  placeholder="Patient name"
                  aria-label="Billing payment patient name"
                />
              </Label>
              <Label>
                Due Payment For
                <Input
                  value={paymentForm.payment_for}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, payment_for: event.target.value }))}
                  placeholder="Lab, Diagnostics, OP billing..."
                  aria-label="Billing payment for"
                />
              </Label>
              <Label>
                Invoice
                <Select
                  value={paymentForm.invoice_id}
                  onChange={(event) => {
                    const invoice = invoices.find((item) => String(item.id) === event.target.value);
                    setPaymentForm((current) => ({ ...current, invoice_id: event.target.value }));
                    if (invoice) applyInvoiceToPaymentForm(invoice);
                  }}
                  aria-label="Billing payment invoice"
                >
                  <option value="">No invoice selected - create direct payment</option>
                  {patientDueInvoices.map((invoice) => (
                    <option key={`payment-invoice-${invoice.id}`} value={invoice.id}>
                      {invoice.invoice_no || `INV-${invoice.id}`} · Due {formatCurrency(invoice.due_amount)}
                    </option>
                  ))}
                </Select>
              </Label>
              <Label>
                Due Amount Paying
                <Input
                  type="number"
                  min={0}
                  value={paymentForm.amount}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="Amount"
                  aria-label="Billing payment amount"
                />
              </Label>
              <Label>
                Payment Mode
                <Select
                  value={paymentForm.payment_mode}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, payment_mode: event.target.value }))}
                  aria-label="Billing payment mode"
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank">Bank Transfer</option>
                </Select>
              </Label>
              <Label>
                Gateway Reference
                <Input
                  value={paymentForm.gateway_ref}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, gateway_ref: event.target.value }))}
                  placeholder="Transaction ID"
                  aria-label="Billing payment gateway reference"
                />
              </Label>
              <Label>
                Convert From
                <Select
                  value={paymentForm.converted_from_mode}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, converted_from_mode: event.target.value }))}
                  aria-label="Billing converted from mode"
                >
                  <option value="">None</option>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank">Bank Transfer</option>
                </Select>
              </Label>
              <Label>
                Convert To
                <Select
                  value={paymentForm.converted_to_mode}
                  onChange={(event) => setPaymentForm((current) => ({ ...current, converted_to_mode: event.target.value }))}
                  aria-label="Billing converted to mode"
                >
                  <option value="">None</option>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank">Bank Transfer</option>
                </Select>
              </Label>
              <div className="module-inline-actions billing-payment-actions">
                <Button type="submit" variant="primary" disabled={savingPayment}>
                  {savingPayment ? "Saving..." : "Record Payment"}
                </Button>
                <Button type="button" variant="secondary" disabled={savingPayment || !isRazorpayReady || invoices.length === 0} onClick={() => void handleRazorpayBillingPayment()}>
                  Razorpay
                </Button>
              </div>
            </form>
          </div>

          <div className="billing-dashboard-snapshot billing-payment-full-width">
          <div className="panel billing-payment-summary-panel">
            <div className="module-panel-head">
              <div>
                <h3>Payment Summary</h3>
                <p className="muted">Review total collections and calendar-based daily or monthly revenue.</p>
              </div>
            </div>
            <div className="billing-revenue-calendar">
              <div className="billing-revenue-toggle" role="group" aria-label="Revenue period">
                <Button type="button" variant={revenueWindow === "day" ? "primary" : "secondary"} onClick={() => setRevenueWindow("day")}>Daily</Button>
                <Button type="button" variant={revenueWindow === "month" ? "primary" : "secondary"} onClick={() => setRevenueWindow("month")}>Monthly</Button>
              </div>
              <Label>
                {revenueWindow === "day" ? "Select Date" : "Select Month"}
                <Input
                  type={revenueWindow === "day" ? "date" : "month"}
                  value={revenueWindow === "day" ? selectedRevenueDate : selectedRevenueMonth}
                  onChange={(event) => {
                    if (revenueWindow === "day") setSelectedRevenueDate(event.target.value);
                    else setSelectedRevenueMonth(event.target.value);
                  }}
                  aria-label={revenueWindow === "day" ? "Select revenue date" : "Select revenue month"}
                />
              </Label>
              <div className="billing-revenue-period-card">
                <span>{selectedRevenueLabel}</span>
                <strong>{formatCurrency(selectedRevenueTotal)}</strong>
                <small>Actual collections recorded for {selectedRevenuePeriod || "-"}</small>
              </div>
              <div className="billing-revenue-period-card due">
                <span>Pending Due</span>
                <strong>{formatCurrency(selectedRevenueDue)}</strong>
                <small>Open balance in selected period</small>
              </div>
            </div>
            <div className="hosp-pay-list">
              {paymentCollectionRows.map((row) => (
                <div key={row.label} className="hosp-pay-row">
                  <span className="hosp-pay-icon">💳</span>
                  <span className="hosp-pay-label">{row.label}</span>
                  <span className="hosp-pay-value">{formatCurrency(row.count)}</span>
                </div>
              ))}
            </div>
            <div className="hosp-pay-total-row">
              <span>Total Collected</span>
              <span style={{ color: "#0891b2", fontWeight: 700 }}>{formatCurrency(paymentCollectionTotal)}</span>
            </div>
          </div>
          </div>
        </div>
      );
    }

    if (view === "insurance-claims") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Insurance Claims</h3>
          </div>
          <form className="module-form-grid module-sales-grid" onSubmit={handleClaimSubmit}>
            <Label>
              Invoice
              <Select
                value={claimForm.invoice_id}
                onChange={(event) => {
                  const nextInvoiceId = event.target.value;
                  const linked = invoices.find((invoice) => String(invoice.id) === nextInvoiceId);
                  setClaimForm((current) => ({
                    ...current,
                    invoice_id: nextInvoiceId,
                    patient_id: linked?.patient_id || current.patient_id,
                  }));
                }}
                aria-label="Billing claim invoice"
              >
                <option value="">Select invoice</option>
                {invoices.map((invoice) => (
                  <option key={`claim-invoice-${invoice.id}`} value={invoice.id}>
                    {invoice.invoice_no || `INV-${invoice.id}`}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Insurer
              <Input
                value={claimForm.insurer_name}
                onChange={(event) => setClaimForm((current) => ({ ...current, insurer_name: event.target.value }))}
                placeholder="Insurer"
                aria-label="Billing insurer"
              />
            </Label>
            <Label>
              Claim Amount
              <Input
                type="number"
                min={0}
                value={claimForm.claim_amount}
                onChange={(event) => setClaimForm((current) => ({ ...current, claim_amount: event.target.value }))}
                placeholder="Claim amount"
                aria-label="Billing claim amount"
              />
            </Label>
            <Label>
              Approved Amount
              <Input
                type="number"
                min={0}
                value={claimForm.approved_amount}
                onChange={(event) => setClaimForm((current) => ({ ...current, approved_amount: event.target.value }))}
                placeholder="Approved amount"
                aria-label="Billing approved amount"
              />
            </Label>
            <Label>
              Claim Status
              <Select
                value={claimForm.claim_status}
                onChange={(event) => setClaimForm((current) => ({ ...current, claim_status: event.target.value }))}
                aria-label="Billing claim status"
              >
                <option value="submitted">Submitted</option>
                <option value="under_review">Under Review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="settled">Settled</option>
              </Select>
            </Label>
            <Label>
              Claim Reference
              <Input
                value={claimForm.external_ref}
                onChange={(event) => setClaimForm((current) => ({ ...current, external_ref: event.target.value }))}
                placeholder="Claim reference"
                aria-label="Billing claim reference"
              />
            </Label>
            <Button type="submit" disabled={savingClaim || invoices.length === 0}>
              {savingClaim ? "Saving..." : claimForm.id ? "Update Claim" : "Create Claim"}
            </Button>
            {claimForm.id ? (
              <Button type="button" variant="ghost" onClick={() => setClaimForm({ ...DEFAULT_CLAIM_FORM })}>
                Cancel Edit
              </Button>
            ) : null}
          </form>

          {claims.length === 0 ? (
            <p className="muted">No insurance claims recorded yet.</p>
          ) : (
            <>
              <Table className="module-table" role="table" aria-label="Billing insurance claims table">
                <TableHead>
                  <TableCell>Invoice</TableCell>
                  <TableCell>Insurer</TableCell>
                  <TableCell>Claimed</TableCell>
                  <TableCell>Approved</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Actions</TableCell>
                </TableHead>
                {claims.slice(0, 10).map((claim) => (
                  <TableRow key={claim.id}>
                    <TableCell>{invoices.find((invoice) => invoice.id === claim.invoice_id)?.invoice_no || `INV-${claim.invoice_id}`}</TableCell>
                    <TableCell>{claim.insurer_name}</TableCell>
                    <TableCell>{formatCurrency(claim.claim_amount)}</TableCell>
                    <TableCell>{formatCurrency(claim.approved_amount)}</TableCell>
                    <TableCell>{claim.claim_status || "-"}</TableCell>
                    <TableCell>
                      <div className="module-inline-actions">
                        <Button type="button" size="sm" onClick={() => handleEditClaim(claim)}>Edit</Button>
                        <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteClaim(claim)}>Delete</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </>
          )}
        </div>
      );
    }

    if (view === "invoices") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Invoices</h3>
          </div>

          <form className="module-form-grid module-filter-grid" onSubmit={handleFilterSubmit}>
            <Label>
              Filter by Patient ID
              <Input
                value={filters.patient_id}
                onChange={(event) => setFilters((current) => ({ ...current, patient_id: event.target.value }))}
                placeholder="Patient ID"
                aria-label="Billing filter patient"
              />
            </Label>
            <Label>
              Module
              <Select
                value={filters.module}
                onChange={(event) => setFilters((current) => ({ ...current, module: event.target.value }))}
                aria-label="Billing filter module"
              >
                <option value="">All Modules</option>
                <option value="OP">OP</option>
                <option value="IP">IP</option>
                <option value="LAB">Lab</option>
              </Select>
            </Label>
            <Label>
              Payment Status
              <Select
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
                aria-label="Billing filter status"
              >
                <option value="">All Statuses</option>
                <option value="due">Due</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
              </Select>
            </Label>
            <div className="module-inline-actions">
              <Button type="submit">Apply</Button>
              <Button type="button" variant="ghost" onClick={() => void clearFilters()}>Clear</Button>
            </div>
          </form>

          {loading ? <p className="muted">Loading billing records...</p> : null}
          {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
          {!loading && !errorMessage && visibleInvoices.length === 0 ? <p className="muted">No invoices available for this filter.</p> : null}

          {!loading && !errorMessage && visibleInvoices.length > 0 ? (
            <>
              <Table className="module-table module-table-billing" role="table" aria-label="Billing invoices table">
                <TableHead>
                  <TableCell>Invoice</TableCell>
                  <TableCell>Patient</TableCell>
                  <TableCell>Module</TableCell>
                  <TableCell>Total</TableCell>
                  <TableCell>Advance</TableCell>
                  <TableCell>Refund</TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Actions</TableCell>
                </TableHead>
                {visibleInvoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell>{invoice.invoice_no || `INV-${invoice.id}`}</TableCell>
                    <TableCell>{invoice.patient_id || "-"}</TableCell>
                    <TableCell>{invoice.module || "-"}</TableCell>
                    <TableCell>{formatCurrency(invoice.total_amount)}</TableCell>
                    <TableCell>{formatCurrency(invoice.advance_amount)}</TableCell>
                    <TableCell>{formatCurrency(invoice.refunded_amount)}</TableCell>
                    <TableCell>{formatCurrency(invoice.due_amount)}</TableCell>
                    <TableCell>{invoice.payment_status || "-"}</TableCell>
                    <TableCell>
                      <div className="module-inline-actions">
                        <Button type="button" size="sm" onClick={() => handleEditInvoice(invoice)}>Edit</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => handlePrintInvoice(invoice)}>Print</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => handleDownloadInvoicePdf(invoice)}>PDF</Button>
                        <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteInvoice(invoice)}>Delete</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>

              <div className="module-mobile-list" aria-label="Billing invoices cards">
                {visibleInvoices.map((invoice) => (
                  <article className="module-mobile-card" key={`mobile-${invoice.id}`}>
                    <h4>{invoice.invoice_no || `INV-${invoice.id}`}</h4>
                    <p><strong>Patient:</strong> {invoice.patient_id || "-"}</p>
                    <p><strong>Module:</strong> {invoice.module || "-"}</p>
                    <p><strong>Total:</strong> {formatCurrency(invoice.total_amount)}</p>
                    <p><strong>Advance:</strong> {formatCurrency(invoice.advance_amount)}</p>
                    <p><strong>Refund:</strong> {formatCurrency(invoice.refunded_amount)}</p>
                    <p><strong>Due:</strong> {formatCurrency(invoice.due_amount)}</p>
                    <p><strong>Status:</strong> {invoice.payment_status || "-"}</p>
                    <div className="module-card-actions">
                      <Button type="button" size="sm" onClick={() => handleEditInvoice(invoice)}>Edit</Button>
                      <Button type="button" size="sm" variant="secondary" onClick={() => handlePrintInvoice(invoice)}>Print</Button>
                      <Button type="button" size="sm" variant="secondary" onClick={() => handleDownloadInvoicePdf(invoice)}>PDF</Button>
                      <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteInvoice(invoice)}>Delete</Button>
                    </div>
                    <p className="muted"><strong>Created:</strong> {formatDateTime(invoice.created_at)}</p>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </div>
      );
    }

    if (view === "payment-mode-breakdown") {
      return (
        <div className="panel">
          <div className="module-panel-head">
            <h3>Payment Mode Breakdown</h3>
          </div>
          {summary.payment_mode_breakdown.length === 0 ? (
            <p className="muted">No payment mode records available.</p>
          ) : (
            <div className="bar-chart">
              {summary.payment_mode_breakdown.map((row) => (
                <div className="bar-row" key={row.label}>
                  <span>{row.label}</span>
                  <div className="bar"><div style={{ width: `${Math.max(8, (row.count / maxBreakdownValue) * 100)}%` }} /></div>
                  <span>{formatCurrency(row.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        {view !== "collections-by-module" && (
          <div className="panel">
            <div className="module-panel-head">
              <h3>Collections by Module</h3>
            </div>
            {summary.collections_by_module.length === 0 ? (
              <p className="muted">No collection data available.</p>
            ) : (
              <div className="bar-chart">
                {summary.collections_by_module.map((row) => (
                  <div className="bar-row" key={row.label}>
                    <span>{row.label}</span>
                    <div className="bar"><div style={{ width: `${Math.max(8, (row.count / maxModuleCollectionValue) * 100)}%` }} /></div>
                    <span>{formatCurrency(row.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="panel hosp-section-card reports-snapshot-card-exact">
          <div className="reports-snapshot-card-head">
            <h3>Revenue Snapshot (Today)</h3>
          </div>
          <div className="hosp-rev-list">
            {[
              { label: "Today Revenue", icon: "🏥", value: todayRevenue },
              { label: "Lab & Diagnostic Billing", icon: "🧪", value: labRevenue },
              { label: "Pending Payments", icon: "⚠️", value: pendingPayments },
              { label: "Doctor Payout Ready", icon: "👨‍⚕️", value: doctorPayoutReady },
            ].map((row) => (
              <div key={row.label} className="hosp-rev-row reports-snapshot-row-exact">
                <span className="hosp-rev-icon">{row.icon}</span>
                <span className="hosp-rev-label">{row.label}</span>
                <span className="hosp-rev-value">{formatCurrencyShort(row.value)}</span>
              </div>
            ))}
          </div>
          <div className="hosp-rev-total-row">
            <span>Total Revenue</span>
            <span>{formatCurrencyShort(todayRevenue)}</span>
          </div>
          <div className="hosp-rev-due-row">
            <span>Outstanding Amount</span>
            <span style={{ color: "#dc2626" }}>{formatCurrencyShort(pendingPayments)}</span>
          </div>
        </div>
      </>
    );
  })();

  const meta = BILLING_VIEW_CONFIG[view];

  return (
    <section className="module-page billing-page">
      {view !== "collections-by-module" && (
        <div className="module-panel-head">
          <div>
            <h3>{meta.title}</h3>
            <p className="muted">{meta.subtitle}</p>
          </div>
        </div>
      )}

      {view !== "collections-by-module" && (
        <div className="stat-grid module-stat-grid">
          <StatCard label="Total Billed" value={formatCurrency(summary.total_billed)} />
          <StatCard label="Collected" value={formatCurrency(summary.total_collected)} />
          <StatCard label="Pending Due" value={formatCurrency(summary.total_due)} />
        </div>
      )}

      {viewContent}
    </section>
  );
}
