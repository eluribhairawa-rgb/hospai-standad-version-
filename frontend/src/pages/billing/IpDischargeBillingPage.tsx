import React, { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Button, Modal } from "../../components/ui";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";
import { splitStoredPhone, toWhatsAppNumber } from "../../lib/phone";
import "./billingTheme.css";
import AdmissionPayerFields, { EMPTY_PAYER, payerError, payerLabel } from "../../components/AdmissionPayerFields";
import type { AdmissionPayer } from "../../components/AdmissionPayerFields";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
  selectedPatient?: any;
  onSelectPatient?: (p: any) => void;
};

const fmt = (n: number) =>
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const formatDateTime = (dtStr?: string) => {
  if (!dtStr) return "-";
  try {
    const d = new Date(dtStr);
    if (isNaN(d.getTime())) return String(dtStr).slice(0, 16).replace("T", " ");
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(dtStr).slice(0, 16).replace("T", " ");
  }
};

export default function IpDischargeBillingPage({
  setNotice,
  onNavigate,
  selectedPatient,
  onSelectPatient,
}: Props) {
  const [searchInput, setSearchInput] = useState<string>(() => {
    return (
      localStorage.getItem("selected_discharge_admission") ||
      selectedPatient?.admission_id ||
      selectedPatient?.patient_id ||
      ""
    );
  });
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active Tab: summary | itemised | payments | adjustments
  const [activeTab, setActiveTab] = useState<"summary" | "itemised" | "payments" | "adjustments">("summary");
  // Itemised sub-filter
  const [itemisedFilter, setItemisedFilter] = useState<"all" | "beds" | "pharmacy" | "laboratory" | "imaging" | "consultations">("all");

  const [dischargeData, setDischargeData] = useState<any>(null);
  const [dischargeQueue, setDischargeQueue] = useState<any[]>([]);

  // Settlement Finalisation modal state
  const [finaliseModalOpen, setFinaliseModalOpen] = useState(false);
  const [payerModalOpen, setPayerModalOpen] = useState(false);
  const [payerDraft, setPayerDraft] = useState<AdmissionPayer>(EMPTY_PAYER);
  const [savingPayer, setSavingPayer] = useState(false);
  const [discountAmount, setDiscountAmount] = useState<string>("500");
  const [paymentMode, setPaymentMode] = useState<string>("UPI");
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [transactionRef, setTransactionRef] = useState<string>("");
  const [dischargeNotes, setDischargeNotes] = useState<string>("Routine discharge settlement");
  const [settling, setSettling] = useState(false);

  // In-place info inspection modals (No redirection)
  const [journeyModalOpen, setJourneyModalOpen] = useState(false);
  const [journeyData, setJourneyData] = useState<any>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);

  const [advancesModalOpen, setAdvancesModalOpen] = useState(false);
  const [advancesModalData, setAdvancesModalData] = useState<any>(null);
  const [advancesLoading, setAdvancesLoading] = useState(false);

  const [bedsModalOpen, setBedsModalOpen] = useState(false);
  const [bedsLoading, setBedsLoading] = useState(false);

  const openJourneyModal = async () => {
    const pid = dischargeData?.patient?.patient_id || selectedPatient?.patient_id || searchInput;
    if (!pid) return;
    setJourneyModalOpen(true);
    setJourneyLoading(true);
    try {
      const res = await apiFetch(`/api/patients/${encodeURIComponent(pid)}/journey`);
      setJourneyData(res);
    } catch (err: any) {
      reportError(setNotice, err);
    } finally {
      setJourneyLoading(false);
    }
  };

  const openAdvancesModal = async () => {
    const pid = dischargeData?.patient?.patient_id || selectedPatient?.patient_id || searchInput;
    if (!pid) return;
    setAdvancesModalOpen(true);
    setAdvancesLoading(true);
    try {
      const res = await apiFetch(`/api/billing/advances?patient_id=${encodeURIComponent(pid)}`);
      setAdvancesModalData(res);
    } catch (err: any) {
      reportError(setNotice, err);
    } finally {
      setAdvancesLoading(false);
    }
  };

  const openBedsModal = () => {
    setBedsModalOpen(true);
  };

  // Fetch discharge details
  const fetchDischarge = async (admIdOrKey: string) => {
    const cleanKey = (admIdOrKey || "").trim();
    if (!cleanKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/billing/ip-discharge/${encodeURIComponent(cleanKey)}`);
      if (res && res.admission) {
        setDischargeData(res);
        const summ = res.charges_summary || {};
        setDiscountAmount(String(summ.approved_discount ?? 0));
        setPaymentAmount(String(summ.balance_to_collect ?? 0));
        if (onSelectPatient && res.patient) {
          onSelectPatient(res.patient);
        }
      } else {
        setError(`Admission / Patient "${admIdOrKey}" not found.`);
        setDischargeData(null);
      }
    } catch (err: any) {
      reportError(setNotice, err);
      setError(err.message || "Failed to load IP discharge details.");
      setDischargeData(null);
    } finally {
      setLoading(false);
    }
  };

  // Load discharge queue for fallback/quick selection
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const saved =
          localStorage.getItem("selected_discharge_admission") ||
          selectedPatient?.admission_id ||
          selectedPatient?.patient_id;
        if (saved) {
          setSearchInput(String(saved));
          await fetchDischarge(String(saved));
          return;
        }
        const wl = await apiFetch("/api/billing/worklist?tab=discharge_review");
        if (wl?.discharge_review?.length > 0) {
          setDischargeQueue(wl.discharge_review);
          const first = wl.discharge_review[0];
          const firstKey = String(first.raw_id || first.admission_id || first.patient_id || 1);
          setSearchInput(firstKey);
          await fetchDischarge(firstKey);
        }
        // Nothing awaiting discharge review: stay empty until staff search -- never
        // auto-load an arbitrary admission (it would show some other patient's bill).
      } catch {
        // ignore
      }
    };
    fetchQueue();
  }, [selectedPatient?.patient_id, selectedPatient?.admission_id]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchDischarge(searchInput);
  };

  const charges = dischargeData?.charges_summary || {
    bed_nursing: 0,
    consultations: 0,
    pharmacy: 0,
    laboratory: 0,
    imaging: 0,
    procedures: 0,
    gross_charges: 0,
    approved_discount: 0,
    net_bill: 0,
    advance_applied: 0,
    balance_to_collect: 0,
  };

  // Once the stay is discharged and billed, the figures come from its discharge invoice(s) (what was
  // really billed and paid). Before that they are a live calculation from the charges.
  const isSettled = Boolean(charges.settled);
  const discVal = isSettled ? Number(charges.billed_discount || 0) : Math.max(0, parseFloat(discountAmount) || 0);
  const grossShown = isSettled ? Number(charges.billed_gross ?? charges.gross_charges) : charges.gross_charges;
  const liveNetBill = isSettled ? Number(charges.net_bill || 0) : Math.max(0, charges.gross_charges - discVal);
  const liveBalance = isSettled
    ? Number(charges.balance_to_collect || 0)
    : Math.max(0, liveNetBill - (charges.advance_applied || 0));
  const amountPaid = Number(charges.amount_paid || 0);

  const handleFinaliseSubmit = async () => {
    if (!dischargeData?.admission?.id) return;
    setSettling(true);
    try {
      const tenderAmt = parseFloat(paymentAmount) || 0;
      const payments = [];
      if (tenderAmt > 0) {
        payments.push({
          payment_mode: paymentMode.toLowerCase(),
          amount: tenderAmt,
          transaction_ref: transactionRef || `${paymentMode}-DISCHARGE`,
        });
      }

      const payload = {
        admission_id: dischargeData.admission.id,
        discount_amount: discVal,
        charges_version: dischargeData.charges_version,
        payments,
        notes: dischargeNotes,
      };

      const res = await apiFetch("/api/billing/ip-discharge/finalise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      setFinaliseModalOpen(false);
      setNotice({
        type: "success",
        message: `Discharge bill finalized successfully for Admission #${res.admission_id}! Invoice ${res.invoice_no || ""}`,
      });
      fetchDischarge(String(res.admission_id));
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to finalise discharge bill." });
    } finally {
      setSettling(false);
    }
  };

  const printEstimate = () => {
    const p = dischargeData?.patient || {};
    const a = dischargeData?.admission || {};
    const html = buildPrintDocumentHtml({
      title: `IP Discharge Bill Estimate`,
      subtitleLines: [
        `HospAI · Inpatient (IPD) Department`,
        `Admission: IP-${String(a.id || 0).padStart(4, "0")} · Generated: ${targetDate}`,
      ],
      meta: [
        { label: "Patient UHID", value: p.patient_id || "N/A" },
        { label: "Patient Name", value: `${p.name || "Patient"} ${p.last_name || ""}`.trim() },
        { label: "Ward / Bed", value: a.ward ? `${a.ward} · Bed ${a.bed_no || "-"}` : "No bed allocated" },
        { label: "Admitted Date", value: a.admission_date ? String(a.admission_date).slice(0, 10) : "N/A" },
      ],
      columns: ["Department / Service", "Charge Details", "Amount (₹)"],
      rows: [
        ["Bed & Nursing Care", "Stay charges", `₹${fmt(charges.bed_nursing)}`],
        ["Doctor Consultations", "Doctor visits", `₹${fmt(charges.consultations)}`],
        ["Pharmacy Dispensing", "Issued medicines", `₹${fmt(charges.pharmacy)}`],
        ["Clinical Laboratory", "Completed services", `₹${fmt(charges.laboratory)}`],
        ["Radiology & Imaging", "Completed services", `₹${fmt(charges.imaging)}`],
        ["Procedures & Care", "Recorded services", `₹${fmt(charges.procedures)}`],
      ],
      totals: [
        { label: "Gross IP Charges", value: `₹${fmt(charges.gross_charges)}` },
        { label: "Approved Discount", value: `-₹${fmt(discVal)}` },
        { label: "Net Bill", value: `₹${fmt(liveNetBill)}` },
        { label: "Advance Applied", value: `-₹${fmt(charges.advance_applied)}` },
        { label: "Balance to Collect", value: `₹${fmt(liveBalance)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const printDetailedBill = () => {
    const p = dischargeData?.patient || {};
    const a = dischargeData?.admission || {};
    const pharmItems = itemised.pharmacy || [];
    const pharmRows = pharmItems.map((it: any) => [
      formatDateTime(it.sale_date),
      `💊 ${it.medicine_name}`,
      it.batch_number || "BATCH",
      String(it.quantity),
      `₹${fmt(it.unit_price)}`,
      `₹${fmt(it.amount)}`,
    ]);

    const bedRows = (itemised.beds || []).map((b: any) => [
      b.allocated_at ? String(b.allocated_at).slice(0, 10) : "-",
      `🛏️ Bed Stay (${b.ward || "Ward"} - ${b.bed_no || "-"})`,
      b.room_no || "-",
      `${b.days || 1} day(s)`,
      `₹${fmt(b.daily_rate)}`,
      `₹${fmt(b.total)}`,
    ]);

    const labRows = (itemised.laboratory || []).map((l: any) => [
      l.order_date ? String(l.order_date).slice(0, 10) : "-",
      `🧪 Lab: ${l.item_name}`,
      l.order_no || "-",
      "1 test",
      `₹${fmt(l.amount)}`,
      `₹${fmt(l.amount)}`,
    ]);

    const imagingRows = (itemised.imaging || []).map((im: any) => [
      im.order_date ? String(im.order_date).slice(0, 10) : "-",
      `🩻 Imaging: ${im.item_name}`,
      im.order_no || "-",
      "1 scan",
      `₹${fmt(im.amount)}`,
      `₹${fmt(im.amount)}`,
    ]);

    const allItemRows = [
      ...bedRows,
      ...pharmRows,
      ...labRows,
      ...imagingRows,
    ];

    const html = buildPrintDocumentHtml({
      title: `Consolidated IP Itemised Discharge Bill`,
      subtitleLines: [
        `HospAI · Inpatient (IPD) Department`,
        `Admission: IP-${String(a.id || 0).padStart(4, "0")} · Generated: ${new Date().toLocaleString("en-IN")}`,
      ],
      meta: [
        { label: "Patient UHID", value: p.patient_id || "N/A" },
        { label: "Patient Name", value: `${p.name || "Patient"} ${p.last_name || ""}`.trim() },
        { label: "Ward / Bed", value: a.ward ? `${a.ward} · Bed ${a.bed_no || "-"}` : "No bed allocated" },
        { label: "Admitted Date", value: a.admission_date ? String(a.admission_date).slice(0, 16).replace("T", " ") : "N/A" },
        { label: "Discharge Status", value: dischargeData?.status === "finalised" ? "Discharge Settled" : "Financial Review / Inpatient" },
      ],
      columns: ["Date & Time", "Service / Medication", "Batch / Ref", "Qty / Duration", "Unit Rate (₹)", "Amount (₹)"],
      rows: allItemRows.length > 0 ? allItemRows : [["-", "No itemised charges recorded", "-", "-", "-", "₹0"]],
      totals: [
        { label: "Total Medicines Dispensed", value: `₹${fmt(charges.pharmacy)}` },
        { label: "Total Bed & Nursing Charges", value: `₹${fmt(charges.bed_nursing)}` },
        { label: "Total Clinical Lab Charges", value: `₹${fmt(charges.laboratory)}` },
        { label: "Total Radiology Charges", value: `₹${fmt(charges.imaging)}` },
        { label: "Total Consultations", value: `₹${fmt(charges.consultations)}` },
        { label: "Gross IP Charges", value: `₹${fmt(charges.gross_charges)}` },
        { label: "Approved Discount", value: `-₹${fmt(discVal)}` },
        { label: "Net Bill Amount", value: `₹${fmt(liveNetBill)}` },
        { label: "Advance Deposited & Applied", value: `-₹${fmt(charges.advance_applied)}` },
        { label: "Final Balance to Settle", value: `₹${fmt(liveBalance)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const printReceipt = (rec: any) => {
    const p = dischargeData?.patient || {};
    const html = buildPrintDocumentHtml({
      title: `Payment Receipt — ${rec.receipt_no || "REC"}`,
      subtitleLines: [
        `HospAI · Inpatient Billing Cashier`,
        `Receipt Date: ${rec.created_at ? String(rec.created_at).slice(0, 19).replace("T", " ") : targetDate}`,
      ],
      meta: [
        { label: "Patient UHID", value: p.patient_id || "N/A" },
        { label: "Patient Name", value: `${p.name || "Patient"} ${p.last_name || ""}`.trim() },
        { label: "Receipt No", value: rec.receipt_no || "REC-N/A" },
        { label: "Payment Mode", value: (rec.payment_mode || "CASH").toUpperCase() },
      ],
      columns: ["Description", "Notes / Reference", "Amount (₹)"],
      rows: [
        [
          rec.receipt_type || "IP Bill Payment",
          rec.notes || "Discharge settlement collection",
          `₹${fmt(rec.total_amount || 0)}`,
        ],
      ],
      totals: [
        { label: "Total Paid", value: `₹${fmt(rec.total_amount || 0)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const handleShareWhatsAppBill = () => {
    const p = dischargeData?.patient || {};
    const a = dischargeData?.admission || {};
    const rawPhone = p.phone || p.mobile || "";
    const rawCode = p.phone_country_code || "+91";
    const parts = splitStoredPhone(rawPhone, rawCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital - Inpatient Discharge Bill Summary*`,
      `----------------------------------------`,
      `Patient: ${p.name || "Patient"} ${p.last_name || ""} (UHID: ${p.patient_id || "-"})`,
      `Admission: IP-${String(a.id || 0).padStart(4, "0")}`,
      a.ward ? `Ward / Bed: ${a.ward} · Bed ${a.bed_no || "-"}` : "",
      `Gross Charges: ₹${fmt(charges.gross_charges)}`,
      discVal > 0 ? `Discount: -₹${fmt(discVal)}` : "",
      `Net Bill Amount: ₹${fmt(liveNetBill)}`,
      charges.advance_applied > 0 ? `Advance Applied: -₹${fmt(charges.advance_applied)}` : "",
      `*Balance Payable: ₹${fmt(liveBalance)}*`,
      `Status: ${dischargeData?.status === "finalised" ? "Settled & Finalised" : "Pending Settlement"}`,
      `----------------------------------------`,
      `For billing inquiries, contact HospAI Billing Cashier Desk.`,
    ].filter(Boolean);

    const text = lines.join("\n");
    const url = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setNotice({
      type: "success",
      message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened.",
    });
  };

  const handleShareWhatsAppReceipt = (rec: any) => {
    const p = dischargeData?.patient || {};
    const rawPhone = p.phone || p.mobile || "";
    const rawCode = p.phone_country_code || "+91";
    const parts = splitStoredPhone(rawPhone, rawCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital - Inpatient Payment Receipt*`,
      `----------------------------------------`,
      `Receipt No: ${rec.receipt_no || "REC"}`,
      `Patient: ${p.name || "Patient"} ${p.last_name || ""} (UHID: ${p.patient_id || "-"})`,
      `Date: ${rec.created_at ? String(rec.created_at).slice(0, 10) : targetDate}`,
      `Payment Mode: ${(rec.payment_mode || "CASH").toUpperCase()}`,
      `Amount Paid: ₹${fmt(rec.total_amount || 0)}`,
      `----------------------------------------`,
      `Thank you for your payment at HospAI Hospital.`,
    ].filter(Boolean);

    const text = lines.join("\n");
    const url = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setNotice({
      type: "success",
      message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened.",
    });
  };

  const patient = dischargeData?.patient;
  const admission = dischargeData?.admission;
  const itemised = dischargeData?.itemised || {};
  const payments = dischargeData?.payments || [];
  const advances = dischargeData?.advances || [];

  const isInsurancePayer = admission?.payer_type === "insurance";
  const isDischarged = Boolean(admission?.discharge_date);

  const openPayerModal = () => {
    setPayerDraft({
      payer_type: isInsurancePayer ? "insurance" : "self",
      insurance_provider: admission?.insurance_provider || (isInsurancePayer ? "" : patient?.insurance_provider || ""),
      insurance_policy_no: admission?.insurance_policy_no || (isInsurancePayer ? "" : patient?.insurance_policy_no || ""),
      insurance_preauth_no: admission?.insurance_preauth_no || "",
    });
    setPayerModalOpen(true);
  };

  const savePayer = async () => {
    if (!admission?.id) return;
    const problem = payerError(payerDraft);
    if (problem) {
      setNotice({ type: "warning", message: problem });
      return;
    }
    setSavingPayer(true);
    try {
      await apiFetch(`/api/admissions/${admission.id}/payer`, {
        method: "PUT",
        body: JSON.stringify(payerDraft),
      });
      setNotice({ type: "success", message: `Payer for admission #${admission.id} set to ${payerLabel(payerDraft)}.` });
      setPayerModalOpen(false);
      await fetchDischarge(String(admission.id));
    } catch (err: any) {
      reportError(setNotice, err, "Could not update the payer.");
    } finally {
      setSavingPayer(false);
    }
  };

  const jumpToItemised = (category: "beds" | "pharmacy" | "laboratory" | "imaging" | "consultations") => {
    setActiveTab("itemised");
    setItemisedFilter(category);
  };

  return (
    <div className="billing-page-wrapper">
      {/* 1. Breadcrumbs */}
      <div className="billing-breadcrumbs">
        <span className="breadcrumb-link" onClick={() => onNavigate?.("dashboard")}>
          HospAI
        </span>
        <span className="separator">/</span>
        <span className="breadcrumb-link" onClick={() => onNavigate?.("billing-overview")}>
          Billing
        </span>
        <span className="separator">/</span>
        <span className="current">IP Discharge Billing</span>
      </div>

      {/* 2. Top Header Bar */}
      <div className="billing-header-row">
        <div className="billing-title-block">
          <h1>IP Discharge Billing</h1>
          <p>Review admission charges and settle the final bill.</p>
        </div>

        <div className="billing-header-actions">
          {/* Quick patient switcher if queue available */}
          {dischargeQueue.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <select
                className="billing-filter-select"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  fetchDischarge(e.target.value);
                }}
              >
                <option value="">-- Admitted Patients ({dischargeQueue.length}) --</option>
                {dischargeQueue.map((q) => (
                  <option key={q.raw_id || q.patient_id} value={String(q.raw_id || q.admission_id || q.patient_id)}>
                    {q.patient_name || q.name} ({q.patient_id || q.uhid}) {q.ward ? `[${q.ward} · ${q.bed_no || "-"}]` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Date Picker */}
          <div className="billing-date-dropdown">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
            <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>▾</span>
          </div>

          <button type="button" className="billing-btn-outline" onClick={printEstimate} title="Print brief summary statement">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Print summary
          </button>

          <button
            type="button"
            className="billing-btn-outline"
            style={{ borderColor: "#00828a", color: "#00828a", fontWeight: 700, background: "#f0fdfa" }}
            onClick={printDetailedBill}
            title="Print complete itemised statement with all dispensed medicines, batches, dates & times"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            🖨️ Detailed Bill (with Medicines)
          </button>

          <button
            type="button"
            className="billing-btn-outline"
            style={{ borderColor: "#25D366", color: "#16a34a", fontWeight: 700, background: "#f0fdf4" }}
            onClick={handleShareWhatsAppBill}
            title="Share bill details to patient's WhatsApp"
          >
            💬 Share via WhatsApp
          </button>
        </div>
      </div>

      {/* 3. Search Bar & Quick Patient Selection Chips */}
      <form onSubmit={handleSearchSubmit} className="billing-search-row">
        <div className="billing-search-input-box">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#94a3b8" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search admission ID, patient name, or UHID"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <button type="submit" className="billing-btn-teal" disabled={loading}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Quick Inpatient Chips */}
      {dischargeQueue.length > 0 && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginBottom: "1rem" }}>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#64748b" }}>Quick Select Admitted:</span>
          {dischargeQueue.slice(0, 8).map((q) => {
            const val = String(q.raw_id || q.admission_id || q.patient_id);
            const isSelected = searchInput === val || dischargeData?.admission?.id === q.raw_id;
            return (
              <button
                key={val}
                type="button"
                style={{
                  padding: "3px 10px",
                  borderRadius: "16px",
                  fontSize: "0.75rem",
                  fontWeight: isSelected ? 800 : 600,
                  cursor: "pointer",
                  border: isSelected ? "1.5px solid #00828a" : "1px solid #cbd5e1",
                  background: isSelected ? "#f0fdfa" : "#ffffff",
                  color: isSelected ? "#00828a" : "#334155",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
                onClick={() => {
                  setSearchInput(val);
                  fetchDischarge(val);
                }}
              >
                {q.patient_name || q.name} ({q.admission_id || `IP-${q.raw_id}`}) {q.bed_no ? `· ${q.bed_no}` : ""}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            padding: "10px 16px",
            borderRadius: "8px",
            color: "#b91c1c",
            marginBottom: "1rem",
            fontSize: "0.875rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* 4. Patient Identity Strip */}
      {patient && admission && (
        <div className="billing-identity-strip">
          <div className="billing-identity-left">
            <div className="billing-avatar-circle">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <div className="billing-identity-details">
              <h3>
                {patient.name} {patient.last_name || ""}
              </h3>
              <div className="billing-identity-meta">
                <span style={{ fontWeight: 600 }}>{patient.patient_id}</span>
                <span className="meta-divider">|</span>
                <span style={{ fontWeight: 600 }}>IP-{String(admission.id).padStart(4, "0")}</span>
                <span className="meta-divider">|</span>
                {admission.ward || admission.bed_no ? (
                  <span>
                    {admission.ward || "Ward"} · {admission.bed_no || "Bed"}
                  </span>
                ) : admission.discharge_date ? (
                  <span style={{ color: "#15803d", fontWeight: 600 }}>Discharged · bed released</span>
                ) : (
                  <span style={{ color: "#d97706", fontWeight: 600 }}>
                    ⚠️ No Bed Allocated
                  </span>
                )}
              </div>
              <div style={{ fontSize: "0.775rem", color: "#64748b", marginTop: "2px" }}>
                Admitted:{" "}
                {admission.admission_date
                  ? String(admission.admission_date).slice(0, 16).replace("T", " ")
                  : "N/A"}{" "}
                | {admission.discharge_date ? `Discharged: ${String(admission.discharge_date).slice(0, 10)}` : `Discharge Review: ${targetDate}`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="billing-btn-outline"
              onClick={openJourneyModal}
              title="View patient journey, timeline and clinical milestones without leaving this page"
            >
              🗺️ Patient Journey
            </button>
            <button
              type="button"
              className="billing-btn-outline"
              onClick={openAdvancesModal}
              title="View advance deposits, ledger & allocation breakdown"
            >
              🔄 Advances
            </button>
            <button
              type="button"
              className="billing-btn-outline"
              onClick={openBedsModal}
              title="View bed allocation, ward, room & stay days"
            >
              🛏️ Beds
            </button>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: dischargeData.status === "finalised" ? "#f0fdf4" : "#fff7ed",
                border: `1px solid ${dischargeData.status === "finalised" ? "#bbf7d0" : "#fed7aa"}`,
                padding: "6px 12px",
                borderRadius: "8px",
                color: dischargeData.status === "finalised" ? "#166534" : "#c2410c",
                fontWeight: 600,
                fontSize: "0.8125rem",
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {dischargeData.status === "finalised" ? "Discharge Settled" : "Financial review"}
            </div>
          </div>
        </div>
      )}

      {/* 5. Main Two-Column Layout */}
      <div className="billing-two-col-layout">
        {/* Left Column: Admission Charges & Tabs */}
        <div className="billing-left-col">
          {/* Card: Admission Charges Container */}
          <div className="billing-card">
            <div className="billing-card-header" style={{ paddingBottom: 0 }}>
              <h2 className="billing-card-title">Admission charges</h2>
            </div>

            {/* Interactive Tabs */}
            <div className="billing-tabs-nav" style={{ marginTop: "8px" }}>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "summary" ? "active" : ""}`}
                onClick={() => setActiveTab("summary")}
              >
                Charge summary
              </button>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "itemised" ? "active" : ""}`}
                onClick={() => setActiveTab("itemised")}
              >
                Itemised charges
              </button>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "payments" ? "active" : ""}`}
                onClick={() => setActiveTab("payments")}
              >
                Payments ({payments.length})
              </button>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "adjustments" ? "active" : ""}`}
                onClick={() => setActiveTab("adjustments")}
              >
                Adjustments
              </button>
            </div>

            {/* TAB CONTENT 1: CHARGE SUMMARY */}
            {activeTab === "summary" && (
              <div className="billing-table-responsive">
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Details</th>
                      <th>Amount</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
                            <circle cx="6" cy="11" r="2" />
                          </svg>
                          <strong>Bed & nursing</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>
                        {itemised.beds?.length ? `${itemised.beds.length} allocation(s)` : "Stay charges"}
                      </td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.bed_nursing)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-outline"
                          style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                          onClick={() => jumpToItemised("beds")}
                        >
                          View stay details →
                        </button>
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
                            <path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4" />
                            <circle cx="20" cy="10" r="2" />
                          </svg>
                          <strong>Consultations</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>
                        {itemised.consultations?.length ? `${itemised.consultations.length} doctor visit(s)` : "Doctor visits"}
                      </td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.consultations)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-outline"
                          style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                          onClick={() => jumpToItemised("consultations")}
                        >
                          View consultation records →
                        </button>
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
                            <path d="m8.5 8.5 7 7" />
                          </svg>
                          <strong>Pharmacy</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>
                        {itemised.pharmacy?.length ? `${itemised.pharmacy.length} dispensed item(s)` : "Issued medicines"}
                        {Number(charges.pharmacy_insurance || 0) > 0 && (
                          <div style={{ fontSize: "0.75rem", color: "#6d28d9", marginTop: "2px" }}>
                            + ₹{fmt(charges.pharmacy_insurance)} billed to insurance (Due on pharmacy claim, not charged to patient)
                          </div>
                        )}
                        {Number(charges.insurance_shortfall_due || 0) > 0 && (
                          <div style={{ fontSize: "0.75rem", color: "#b91c1c", marginTop: "2px", fontWeight: 600 }}>
                            ₹{fmt(charges.insurance_shortfall_due)} from rejected / short-closed insurance claims is payable by the patient (collect in Pharmacy › Insurance Claims)
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.pharmacy)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-outline"
                          style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                          onClick={() => jumpToItemised("pharmacy")}
                        >
                          View pharmacy records →
                        </button>
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <path d="M10 3v5l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3.5L14 8V3" />
                            <path d="M8.5 13h7" />
                          </svg>
                          <strong>Laboratory</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>
                        {itemised.laboratory?.length ? `${itemised.laboratory.length} test(s)` : "Completed services"}
                      </td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.laboratory)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-outline"
                          style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                          onClick={() => jumpToItemised("laboratory")}
                        >
                          View lab reports →
                        </button>
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <strong>Imaging</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>
                        {itemised.imaging?.length ? `${itemised.imaging.length} scan(s)` : "Completed services"}
                      </td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.imaging)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-outline"
                          style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                          onClick={() => jumpToItemised("imaging")}
                        >
                          View imaging records →
                        </button>
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
                            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                            <rect x="8" y="2" width="8" height="4" rx="1" />
                          </svg>
                          <strong>Procedures</strong>
                        </div>
                      </td>
                      <td style={{ color: "#64748b" }}>OT / Clinical procedures</td>
                      <td style={{ fontWeight: 600 }}>₹{fmt(charges.procedures)}</td>
                      <td style={{ textAlign: "right" }}>
                        <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>Included</span>
                      </td>
                    </tr>

                    <tr style={{ background: "#f8fafc", borderTop: "2px solid #e2e8f0" }}>
                      <td style={{ fontWeight: 700 }}>Total Gross Charges</td>
                      <td></td>
                      <td style={{ fontWeight: 800, fontSize: "1rem", color: "#0f172a" }}>₹{fmt(charges.gross_charges)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="billing-btn-teal"
                          style={{ padding: "4px 10px", fontSize: "0.75rem" }}
                          onClick={() => setActiveTab("itemised")}
                        >
                          View All Items
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* TAB CONTENT 2: ITEMISED CHARGES */}
            {activeTab === "itemised" && (
              <div style={{ padding: "1rem 1.25rem" }}>
                {/* Category filter pills */}
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "1rem" }}>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "all" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "all" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "all" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "all" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("all")}
                  >
                    All Items
                  </button>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "beds" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "beds" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "beds" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "beds" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("beds")}
                  >
                    🛏️ Beds ({itemised.beds?.length || 0})
                  </button>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "pharmacy" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "pharmacy" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "pharmacy" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "pharmacy" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("pharmacy")}
                  >
                    💊 Pharmacy ({itemised.pharmacy?.length || 0})
                  </button>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "laboratory" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "laboratory" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "laboratory" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "laboratory" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("laboratory")}
                  >
                    🧪 Laboratory ({itemised.laboratory?.length || 0})
                  </button>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "imaging" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "imaging" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "imaging" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "imaging" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("imaging")}
                  >
                    🩻 Imaging ({itemised.imaging?.length || 0})
                  </button>
                  <button
                    type="button"
                    className={`billing-btn-outline ${itemisedFilter === "consultations" ? "active" : ""}`}
                    style={{
                      background: itemisedFilter === "consultations" ? "#0d9488" : "#ffffff",
                      color: itemisedFilter === "consultations" ? "#ffffff" : "#0f172a",
                      borderColor: itemisedFilter === "consultations" ? "#0d9488" : "#e2e8f0",
                    }}
                    onClick={() => setItemisedFilter("consultations")}
                  >
                    🩺 Consultations ({itemised.consultations?.length || 0})
                  </button>
                </div>

                {/* Sub-sections */}
                {(itemisedFilter === "all" || itemisedFilter === "beds") && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h4 style={{ margin: 0, fontSize: "0.9375rem", color: "#0f172a" }}>🛏️ Bed & Nursing Care</h4>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.bed_nursing)}</span>
                    </div>
                    {itemised.beds?.length > 0 ? (
                      <table className="billing-table" style={{ fontSize: "0.8125rem" }}>
                        <thead>
                          <tr>
                            <th>Ward / Room</th>
                            <th>Bed No</th>
                            <th>Allocated</th>
                            <th>Released</th>
                            <th>Days</th>
                            <th>Daily Rate</th>
                            <th>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itemised.beds.map((b: any, idx: number) => (
                            <tr key={b.id || idx}>
                              <td>{b.ward} ({b.room_no})</td>
                              <td style={{ fontWeight: 600 }}>{b.bed_no}</td>
                              <td>{b.allocated_at || "Start"}</td>
                              <td>{b.released_at || "Active"}</td>
                              <td>{b.days} day(s)</td>
                              <td>₹{fmt(b.daily_rate)}</td>
                              <td style={{ fontWeight: 700 }}>₹{fmt(b.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", fontSize: "0.8125rem" }}>
                        No bed allocations recorded. Click "🛏️ Beds" above to allocate a bed in Bed Management.
                      </div>
                    )}
                  </div>
                )}

                {(itemisedFilter === "all" || itemisedFilter === "pharmacy") && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h4 style={{ margin: 0, fontSize: "0.9375rem", color: "#0f172a" }}>💊 Pharmacy Dispensing</h4>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.pharmacy)}</span>
                    </div>
                    {itemised.pharmacy?.length > 0 ? (
                      <table className="billing-table" style={{ fontSize: "0.8125rem" }}>
                        <thead>
                          <tr>
                            <th>Date & Time</th>
                            <th>Medicine</th>
                            <th>Batch No</th>
                            <th>Qty</th>
                            <th>Unit Price</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itemised.pharmacy.map((p: any, idx: number) => (
                            <tr key={p.id || idx}>
                              <td style={{ whiteSpace: "nowrap", color: "#334155" }}>{formatDateTime(p.sale_date)}</td>
                              <td style={{ fontWeight: 700, color: "#0f172a" }}>💊 {p.medicine_name}</td>
                              <td><span style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>{p.batch_number || "BATCH"}</span></td>
                              <td style={{ fontWeight: 600 }}>{p.quantity}</td>
                              <td>₹{fmt(p.unit_price)}</td>
                              <td style={{ fontWeight: 700, color: "#00828a" }}>₹{fmt(p.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", fontSize: "0.8125rem" }}>
                        No pharmacy medications dispensed for this admission.
                      </div>
                    )}
                  </div>
                )}

                {(itemisedFilter === "all" || itemisedFilter === "laboratory") && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h4 style={{ margin: 0, fontSize: "0.9375rem", color: "#0f172a" }}>🧪 Clinical Laboratory</h4>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.laboratory)}</span>
                    </div>
                    {itemised.laboratory?.length > 0 ? (
                      <table className="billing-table" style={{ fontSize: "0.8125rem" }}>
                        <thead>
                          <tr>
                            <th>Order No</th>
                            <th>Order Date</th>
                            <th>Investigation</th>
                            <th>Status</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itemised.laboratory.map((l: any, idx: number) => (
                            <tr key={l.id || idx}>
                              <td>{l.order_no || "-"}</td>
                              <td>{l.order_date ? String(l.order_date).slice(0, 10) : "-"}</td>
                              <td style={{ fontWeight: 600 }}>{l.item_name}</td>
                              <td>
                                <span className="billing-badge-applied">{l.status || "Completed"}</span>
                              </td>
                              <td style={{ fontWeight: 700 }}>₹{fmt(l.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", fontSize: "0.8125rem" }}>
                        No laboratory investigations charged for this admission.
                      </div>
                    )}
                  </div>
                )}

                {(itemisedFilter === "all" || itemisedFilter === "imaging") && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h4 style={{ margin: 0, fontSize: "0.9375rem", color: "#0f172a" }}>🩻 Radiology & Imaging</h4>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.imaging)}</span>
                    </div>
                    {itemised.imaging?.length > 0 ? (
                      <table className="billing-table" style={{ fontSize: "0.8125rem" }}>
                        <thead>
                          <tr>
                            <th>Order No</th>
                            <th>Order Date</th>
                            <th>Scan / Modality</th>
                            <th>Status</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itemised.imaging.map((im: any, idx: number) => (
                            <tr key={im.id || idx}>
                              <td>{im.order_no || "-"}</td>
                              <td>{im.order_date ? String(im.order_date).slice(0, 10) : "-"}</td>
                              <td style={{ fontWeight: 600 }}>{im.item_name}</td>
                              <td>
                                <span className="billing-badge-applied">{im.status || "Completed"}</span>
                              </td>
                              <td style={{ fontWeight: 700 }}>₹{fmt(im.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", fontSize: "0.8125rem" }}>
                        No radiology or imaging services charged for this admission.
                      </div>
                    )}
                  </div>
                )}

                {(itemisedFilter === "all" || itemisedFilter === "consultations") && (
                  <div style={{ marginBottom: "1rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h4 style={{ margin: 0, fontSize: "0.9375rem", color: "#0f172a" }}>🩺 Doctor Consultations</h4>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.consultations)}</span>
                    </div>
                    {itemised.consultations?.length > 0 ? (
                      <table className="billing-table" style={{ fontSize: "0.8125rem" }}>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Doctor</th>
                            <th>Reason / Speciality</th>
                            <th>Status</th>
                            <th>Fee</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itemised.consultations.map((c: any, idx: number) => (
                            <tr key={c.id || idx}>
                              <td>{c.appointment_date ? String(c.appointment_date).slice(0, 16).replace("T", " ") : "-"}</td>
                              <td style={{ fontWeight: 600 }}>{c.doctor_name || "Doctor Visit"}</td>
                              <td>{c.reason || "IP Consultation"}</td>
                              <td>
                                <span className="billing-badge-applied">{c.status || "Completed"}</span>
                              </td>
                              <td style={{ fontWeight: 700 }}>₹{fmt(c.consultation_fee)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", fontSize: "0.8125rem" }}>
                        No extra doctor consultation fees recorded during admission.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT 3: PAYMENTS */}
            {activeTab === "payments" && (
              <div style={{ padding: "1rem 1.25rem" }}>
                <h4 style={{ margin: "0 0 10px", fontSize: "0.9375rem", color: "#0f172a" }}>
                  Receipts & Payment History
                </h4>
                {payments.length > 0 ? (
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Receipt No</th>
                        <th>Date & Time</th>
                        <th>Type</th>
                        <th>Payment Mode</th>
                        <th>Amount</th>
                        <th style={{ textAlign: "right" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((rec: any) => (
                        <tr key={rec.id}>
                          <td style={{ fontWeight: 600 }}>{rec.receipt_no}</td>
                          <td style={{ color: "#64748b" }}>
                            {rec.created_at ? String(rec.created_at).slice(0, 19).replace("T", " ") : "-"}
                          </td>
                          <td>
                            <span className="billing-badge-applied">{rec.receipt_type || "IP Bill"}</span>
                          </td>
                          <td style={{ fontWeight: 500 }}>{rec.payment_mode || "UPI"}</td>
                          <td style={{ fontWeight: 700, color: "#16a34a" }}>₹{fmt(rec.total_amount)}</td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              className="billing-btn-outline"
                              style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                              onClick={() => printReceipt(rec)}
                            >
                              Print Receipt
                            </button>
                            <button
                              type="button"
                              className="billing-btn-outline"
                              style={{ padding: "3px 8px", fontSize: "0.75rem", color: "#16a34a", borderColor: "#86efac", marginLeft: "4px" }}
                              onClick={() => handleShareWhatsAppReceipt(rec)}
                            >
                              💬 WhatsApp
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ background: "#f8fafc", padding: "16px", borderRadius: "8px", textAlign: "center", color: "#64748b" }}>
                    {isSettled
                      ? "No payment collections were recorded for this discharge."
                      : 'No payment collections recorded yet for this admission. Click "Review & finalise bill" to record settlement payment.'}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT 4: ADJUSTMENTS */}
            {activeTab === "adjustments" && (
              <div style={{ padding: "1rem 1.25rem" }}>
                <h4 style={{ margin: "0 0 12px", fontSize: "0.9375rem", color: "#0f172a" }}>
                  Bill Adjustments & Concessions
                </h4>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "1rem", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.8125rem", color: "#64748b", marginBottom: "4px" }}>Total Gross Charges</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "#0f172a" }}>₹{fmt(charges.gross_charges)}</div>
                  </div>

                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "1rem", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.8125rem", color: "#64748b", marginBottom: "4px" }}>Advances Available</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "#16a34a" }}>₹{fmt(charges.advance_applied)}</div>
                  </div>
                </div>

                <div className="billing-form-group">
                  <label className="billing-form-label">Approved Discount / Concession (₹)</label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="number"
                      step="0.01"
                      className="billing-form-input"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(e.target.value)}
                    />
                    <button
                      type="button"
                      className="billing-btn-teal"
                      onClick={() => {
                        setNotice({
                          type: "info",
                          message: `Discount updated to ₹${fmt(discVal)}. Net bill recalculated to ₹${fmt(liveNetBill)}.`,
                        });
                      }}
                    >
                      Update
                    </button>
                  </div>
                  <small style={{ color: "#64748b", marginTop: "4px", display: "block" }}>
                    Discounts apply against gross stay and clinical charges prior to settlement.
                  </small>
                </div>

                <div className="billing-highlight-box" style={{ marginTop: "1rem" }}>
                  <div>
                    <span className="box-label">Adjusted Net Payable Amount</span>
                  </div>
                  <span className="box-value">₹{fmt(liveBalance)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Panel: Before Finalisation Checklist */}
          <div className="billing-card" style={{ padding: "1.25rem" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: "0.9375rem", fontWeight: 700, color: "#0f172a" }}>
              Before finalisation checklist
            </h3>

            <div className="billing-checklist">
              <div className="billing-check-item">
                <span>✓</span> Department charges reviewed ({charges.gross_charges > 0 ? `₹${fmt(charges.gross_charges)}` : "Verified"})
              </div>
              <div className="billing-check-item">
                <span>✓</span> Pharmacy issues & returns reconciled ({itemised.pharmacy?.length || 0} item(s))
              </div>
              <div className="billing-check-item">
                <span>✓</span> Advance allocation verified (₹{fmt(charges.advance_applied)} applied)
              </div>
            </div>

            <div className="billing-info-banner" style={{ marginTop: "10px" }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              Clinical discharge and medical summary are managed by the care team in Discharge Summary.
            </div>
          </div>
        </div>

        {/* Right Column: Settlement Summary & Admission Payment */}
        <div className="billing-right-col">
          {/* Card: Settlement Summary */}
          <div className="billing-card">
            <div className="billing-card-header">
              <h2 className="billing-card-title">Settlement summary</h2>
            </div>

            <div className="billing-card-body">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>{isSettled ? "Gross charges (billed)" : "Gross charges"}</span>
                <span style={{ fontWeight: 600 }}>₹{fmt(grossShown)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>Approved discount</span>
                <span style={{ color: "#dc2626", fontWeight: 600 }}>-₹{fmt(discVal)}</span>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "8px",
                  fontSize: "0.875rem",
                  borderTop: "1px dashed #e2e8f0",
                  paddingTop: "8px",
                }}
              >
                <span style={{ fontWeight: 600 }}>Net bill</span>
                <span style={{ fontWeight: 700 }}>₹{fmt(liveNetBill)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: isSettled ? "8px" : "16px", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>Advance applied</span>
                <span style={{ color: "#16a34a", fontWeight: 600 }}>-₹{fmt(charges.advance_applied)}</span>
              </div>

              {isSettled && Math.abs(Number(charges.billed_vs_charges_difference || 0)) >= 0.01 && (
                <div style={{ marginBottom: "12px", padding: "8px 10px", borderRadius: "8px", background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: "0.78rem", lineHeight: 1.4 }}>
                  Charges on record today (₹{fmt(charges.gross_charges)}) differ from what was billed (₹{fmt(grossShown)}) by ₹{fmt(Math.abs(Number(charges.billed_vs_charges_difference)))}
                  {Number(charges.invoice_count || 0) > 1 ? `. This stay has ${charges.invoice_count} discharge invoices.` : "."} Check the itemised charges and the discharge invoice(s).
                </div>
              )}

              {isSettled && (
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>
                    Amount paid
                    {charges.settlement_invoices?.length ? ` (${charges.settlement_invoices.map((i: any) => i.invoice_no).join(", ")})` : ""}
                  </span>
                  <span style={{ color: "#16a34a", fontWeight: 600 }}>-₹{fmt(amountPaid)}</span>
                </div>
              )}

              {/* Highlight Box: Balance to Collect */}
              <div className="billing-highlight-box teal-emphasis">
                <div>
                  <span className="box-label">{isSettled ? (liveBalance > 0 ? "Balance due" : "Balance due · settled in full") : "Balance to collect"}</span>
                </div>
                <span className="box-value">₹{fmt(liveBalance)}</span>
              </div>

              {/* Payer status row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", color: "#64748b" }}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  Patient payer
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span
                    title={isInsurancePayer ? `Policy ${admission?.insurance_policy_no || "-"}${admission?.insurance_preauth_no ? ` · Pre-auth ${admission.insurance_preauth_no}` : ""}` : undefined}
                    style={{
                      background: isInsurancePayer ? "#ede9fe" : "#e0f2fe",
                      color: isInsurancePayer ? "#6d28d9" : "#0284c7",
                      borderRadius: "9999px",
                      padding: "2px 10px",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                    }}
                  >
                    {payerLabel(admission)}
                  </span>
                  {admission?.id && !isDischarged && (
                    <button
                      type="button"
                      onClick={openPayerModal}
                      style={{ background: "none", border: "none", color: "#00828a", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer", padding: 0 }}
                    >
                      Change
                    </button>
                  )}
                </div>
              </div>
              {isInsurancePayer && (
                <div style={{ marginTop: "-10px", marginBottom: "16px", fontSize: "0.78rem", color: "#64748b", textAlign: "right" }}>
                  Policy {admission?.insurance_policy_no || "-"}
                  {admission?.insurance_preauth_no ? ` · Pre-auth ${admission.insurance_preauth_no}` : ""}
                </div>
              )}

              {/* Action Buttons */}
              {isSettled && liveBalance <= 0 ? (
                <div style={{ marginBottom: "10px", padding: "10px 12px", borderRadius: "8px", background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", fontSize: "0.82rem", fontWeight: 600, textAlign: "center" }}>
                  ✓ Discharge bill settled in full. Nothing left to collect.
                </div>
              ) : (
                <button
                  type="button"
                  className="billing-btn-teal"
                  style={{ width: "100%", padding: "10px", marginBottom: "10px" }}
                  onClick={() => setFinaliseModalOpen(true)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <polyline points="9 15 11 17 15 13" />
                  </svg>
                  {isSettled ? "Collect balance" : "Review & finalise bill"}
                </button>
              )}

              <button
                type="button"
                className="billing-btn-outline"
                style={{ width: "100%", padding: "9px" }}
                onClick={printEstimate}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                {isSettled ? "Print final bill" : "Print estimate"}
              </button>
            </div>
          </div>

          {/* Card: Admission Advances */}
          <div className="billing-card">
            <div className="billing-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 className="billing-card-title">Admission advances</h2>
              {onNavigate && (
                <button
                  type="button"
                  className="billing-btn-outline"
                  style={{ fontSize: "0.75rem", padding: "3px 8px" }}
                  onClick={() => {
                    if (patient?.patient_id) localStorage.setItem("selected_billing_patient", patient.patient_id);
                    onNavigate("billing-advances-refunds");
                  }}
                >
                  + Add Advance
                </button>
              )}
            </div>

            <div className="billing-table-responsive">
              {advances.length > 0 ? (
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>Receipt no.</th>
                      <th>Amount</th>
                      <th style={{ textAlign: "right" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advances.map((adv: any) => (
                      <tr key={adv.id}>
                        <td style={{ fontWeight: 600 }}>{adv.advance_no}</td>
                        <td style={{ fontWeight: 700 }}>₹{fmt(adv.amount)}</td>
                        <td style={{ textAlign: "right" }}>
                          <span className="billing-badge-applied">
                            {parseFloat(adv.allocated_amount) > 0 ? "Applied" : "Available"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: "1rem 1.25rem", color: "#64748b", fontSize: "0.8125rem", textAlign: "center" }}>
                  No advance deposits recorded for this admission.
                </div>
              )}
            </div>

            <div style={{ padding: "0.75rem 1.25rem", fontSize: "0.75rem", color: "#64748b", borderTop: "1px solid #f1f5f9" }}>
              ⓘ Advances automatically apply against the final discharge settlement.
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Review & Finalise Bill */}
      {payerModalOpen && (
        <Modal open={payerModalOpen} title="Payer for this Admission" onClose={() => setPayerModalOpen(false)}>
          <div style={{ padding: "0.5rem 0" }}>
            <AdmissionPayerFields value={payerDraft} onChange={setPayerDraft} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "18px" }}>
              <Button variant="secondary" onClick={() => setPayerModalOpen(false)} disabled={savingPayer}>Cancel</Button>
              <Button onClick={() => void savePayer()} disabled={savingPayer}>{savingPayer ? "Saving..." : "Save Payer"}</Button>
            </div>
          </div>
        </Modal>
      )}

      {finaliseModalOpen && (
        <Modal
          open={finaliseModalOpen}
          title="Review & Finalise Discharge Settlement"
          onClose={() => setFinaliseModalOpen(false)}
        >
          <div style={{ padding: "0.5rem 0" }}>
            <div className="billing-highlight-box teal-emphasis">
              <div>
                <span className="box-label">Net Balance to Collect</span>
              </div>
              <span className="box-value">₹{fmt(liveBalance)}</span>
            </div>

            <div className="billing-form-group">
              <label className="billing-form-label">Approved Hospital Discount (₹)</label>
              <input
                type="number"
                step="0.01"
                className="billing-form-input"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
              />
            </div>

            <div className="billing-form-group">
              <label className="billing-form-label">Payment Amount Tendered (₹)</label>
              <input
                type="number"
                step="0.01"
                className="billing-form-input"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />
            </div>

            <div className="billing-form-group">
              <label className="billing-form-label">Payment Mode</label>
              <select
                className="billing-form-input"
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value)}
              >
                <option value="UPI">UPI</option>
                <option value="Cash">Cash</option>
                <option value="Card">Card</option>
                <option value="Bank Transfer">Bank Transfer</option>
              </select>
            </div>

            <div className="billing-form-group">
              <label className="billing-form-label">Transaction Reference</label>
              <input
                type="text"
                className="billing-form-input"
                placeholder="Enter payment reference (e.g. UPI Ref / Card Last 4)"
                value={transactionRef}
                onChange={(e) => setTransactionRef(e.target.value)}
              />
            </div>

            <div className="billing-form-group">
              <label className="billing-form-label">Discharge Notes</label>
              <textarea
                className="billing-form-input"
                rows={2}
                value={dischargeNotes}
                onChange={(e) => setDischargeNotes(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "1rem" }}>
              <Button variant="secondary" onClick={() => setFinaliseModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={settling} onClick={handleFinaliseSubmit}>
                {settling ? "Finalising..." : "Confirm & Clear Discharge"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 1: Patient Journey (In-place inspection without redirect) */}
      {journeyModalOpen && (
        <Modal
          open={journeyModalOpen}
          title={`Patient Journey & Clinical History: ${patient?.name || dischargeData?.patient?.name || ""} (${patient?.patient_id || dischargeData?.patient?.patient_id || ""})`}
          className="ui-modal-wide"
          onClose={() => setJourneyModalOpen(false)}
        >
          <div style={{ padding: "0.5rem 0", maxHeight: "72vh", overflowY: "auto" }}>
            {journeyLoading ? (
              <div style={{ padding: "2.5rem", textAlign: "center", color: "#64748b" }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>⏳</div>
                Loading clinical journey & timeline events...
              </div>
            ) : journeyData ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {/* Encounters overview pills */}
                {Array.isArray(journeyData.encounters) && journeyData.encounters.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", background: "#f8fafc", padding: "10px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                    <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#64748b", alignSelf: "center", textTransform: "uppercase" }}>Encounters:</span>
                    {journeyData.encounters.map((enc: any, i: number) => (
                      <span
                        key={i}
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: "6px",
                          background: enc.status === "Active" ? "#ecfdf5" : "#f1f5f9",
                          color: enc.status === "Active" ? "#047857" : "#475569",
                          border: `1px solid ${enc.status === "Active" ? "#a7f3d0" : "#cbd5e1"}`
                        }}
                      >
                        {enc.label || `${enc.encounter_type} #${enc.encounter_id}`} {enc.ward ? `(${enc.ward} ${enc.bed_no || ""})` : ""}
                      </span>
                    ))}
                  </div>
                )}

                {/* Timeline Events List */}
                <div style={{ position: "relative", paddingLeft: "1.5rem", borderLeft: "2px solid #e2e8f0", marginLeft: "0.75rem" }}>
                  {Array.isArray(journeyData.events) && journeyData.events.length > 0 ? (
                    journeyData.events.map((evt: any, idx: number) => (
                      <div key={idx} style={{ position: "relative", marginBottom: "1.25rem" }}>
                        <div
                          style={{
                            position: "absolute",
                            left: "-1.9rem",
                            top: "2px",
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            background: evt.event_type === "admission" ? "#0284c7" : evt.event_type === "prescription" ? "#10b981" : evt.event_type === "discharge" ? "#f59e0b" : "#6366f1",
                            border: "2px solid #fff",
                            boxShadow: "0 0 0 2px #cbd5e1"
                          }}
                        />
                        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 14px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "#1e293b" }}>
                                {evt.title || evt.event_type?.toUpperCase() || "Milestone"}
                              </span>
                              {evt.doctor_name && (
                                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>• Dr. {evt.doctor_name}</span>
                              )}
                              {evt.department && (
                                <span style={{ fontSize: "0.75rem", background: "#f1f5f9", padding: "1px 6px", borderRadius: "4px", color: "#475569" }}>
                                  {evt.department}
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: "0.75rem", color: "#94a3b8", fontWeight: 500 }}>
                              {evt.created_at ? new Date(evt.created_at).toLocaleString("en-IN") : ""}
                            </span>
                          </div>
                          {evt.description && (
                            <div style={{ fontSize: "0.8125rem", color: "#334155", marginTop: "4px", whiteSpace: "pre-line" }}>
                              {evt.description}
                            </div>
                          )}
                          {evt.notes && (
                            <div style={{ fontSize: "0.75rem", color: "#64748b", fontStyle: "italic", marginTop: "4px" }}>
                              {evt.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: "1rem", color: "#64748b", fontSize: "0.875rem" }}>
                      No timeline events logged for this patient record yet.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: "1rem", color: "#64748b" }}>Unable to load journey history.</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem", borderTop: "1px solid #f1f5f9", paddingTop: "0.75rem" }}>
              <Button variant="secondary" onClick={() => setJourneyModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 2: Advances & Deposits (In-place inspection without redirect) */}
      {advancesModalOpen && (
        <Modal
          open={advancesModalOpen}
          title={`Patient Advances & Deposits: ${patient?.name || dischargeData?.patient?.name || ""} (${patient?.patient_id || dischargeData?.patient?.patient_id || ""})`}
          className="ui-modal-wide"
          onClose={() => setAdvancesModalOpen(false)}
        >
          <div style={{ padding: "0.5rem 0", maxHeight: "72vh", overflowY: "auto" }}>
            {advancesLoading ? (
              <div style={{ padding: "2.5rem", textAlign: "center", color: "#64748b" }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>⏳</div>
                Loading advance deposits and allocations...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                {/* 4 Metric Summary Cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 600 }}>Total Deposited</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#1e293b", marginTop: "2px" }}>
                      ₹{fmt(advancesModalData?.summary?.total_advances ?? charges.advance_applied ?? 0)}
                    </div>
                  </div>
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 600 }}>Applied to Bills</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#0284c7", marginTop: "2px" }}>
                      ₹{fmt(advancesModalData?.summary?.applied_to_bills || 0)}
                    </div>
                  </div>
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 600 }}>Refunded</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#c2410c", marginTop: "2px" }}>
                      ₹{fmt(advancesModalData?.summary?.refunded || 0)}
                    </div>
                  </div>
                  <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.75rem", color: "#047857", fontWeight: 700 }}>Available Balance</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 900, color: "#065f46", marginTop: "2px" }}>
                      ₹{fmt(advancesModalData?.summary?.available_advance ?? charges.advance_applied ?? 0)}
                    </div>
                  </div>
                </div>

                {/* Table of Advance Receipts */}
                <div>
                  <h4 style={{ fontSize: "0.875rem", fontWeight: 700, color: "#334155", marginBottom: "8px" }}>
                    Advance Deposit Receipts
                  </h4>
                  {Array.isArray(advancesModalData?.advances) && advancesModalData.advances.length > 0 ? (
                    <table className="billing-table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                      <thead>
                        <tr>
                          <th>Advance / Receipt No</th>
                          <th>Date</th>
                          <th>Payment Mode</th>
                          <th style={{ textAlign: "right" }}>Amount</th>
                          <th style={{ textAlign: "right" }}>Allocated</th>
                          <th style={{ textAlign: "center" }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advancesModalData.advances.map((adv: any, i: number) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{adv.advance_no || `ADV-${adv.id}`}</td>
                            <td style={{ color: "#64748b" }}>{adv.created_at ? String(adv.created_at).slice(0, 16).replace("T", " ") : "-"}</td>
                            <td><span style={{ textTransform: "uppercase", fontSize: "0.75rem", fontWeight: 600 }}>{adv.payment_mode || "CASH"}</span></td>
                            <td style={{ textAlign: "right", fontWeight: 700 }}>₹{fmt(adv.amount)}</td>
                            <td style={{ textAlign: "right", color: "#0284c7" }}>₹{fmt(adv.allocated_amount || 0)}</td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  padding: "2px 8px",
                                  borderRadius: "4px",
                                  background: adv.status === "active" ? "#ecfdf5" : "#f1f5f9",
                                  color: adv.status === "active" ? "#047857" : "#475569"
                                }}
                              >
                                {adv.status || "active"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : advances && advances.length > 0 ? (
                    <table className="billing-table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                      <thead>
                        <tr>
                          <th>Advance No</th>
                          <th style={{ textAlign: "right" }}>Amount</th>
                          <th style={{ textAlign: "center" }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advances.map((adv: any, i: number) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{adv.advance_no}</td>
                            <td style={{ textAlign: "right", fontWeight: 700 }}>₹{fmt(adv.amount)}</td>
                            <td style={{ textAlign: "center" }}>
                              <span className="billing-badge-applied">
                                {parseFloat(adv.allocated_amount || 0) > 0 ? "Applied" : "Available"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: "1rem", textAlign: "center", color: "#64748b", background: "#f8fafc", borderRadius: "6px" }}>
                      No advances currently on record for this patient.
                    </div>
                  )}
                </div>

                {/* Footnote */}
                <div style={{ fontSize: "0.75rem", color: "#64748b", background: "#f8fafc", padding: "8px 12px", borderRadius: "6px", border: "1px dashed #cbd5e1" }}>
                  ⓘ Advances are automatically accounted for and deducted from the discharge bill total during final settlement.
                </div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem", borderTop: "1px solid #f1f5f9", paddingTop: "0.75rem" }}>
              <Button variant="secondary" onClick={() => setAdvancesModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 3: Beds & Inpatient Stay (In-place inspection without redirect) */}
      {bedsModalOpen && (
        <Modal
          open={bedsModalOpen}
          title={`Bed Allocation & Inpatient Stay: ${patient?.name || dischargeData?.patient?.name || ""} (${patient?.patient_id || dischargeData?.patient?.patient_id || ""})`}
          className="ui-modal-wide"
          onClose={() => setBedsModalOpen(false)}
        >
          <div style={{ padding: "0.5rem 0", maxHeight: "72vh", overflowY: "auto" }}>
            {bedsLoading ? (
              <div style={{ padding: "2.5rem", textAlign: "center", color: "#64748b" }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>⏳</div>
                Loading bed occupancy and stay history...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                {/* Active Stay Card */}
                <div style={{ background: "linear-gradient(135deg, #f0fdf4 0%, #e0f2fe 100%)", border: "1px solid #bae6fd", padding: "1rem 1.25rem", borderRadius: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px" }}>
                    <div>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Current Inpatient Allocation
                      </span>
                      <h3 style={{ fontSize: "1.25rem", fontWeight: 800, color: "#0f172a", margin: "4px 0" }}>
                        {dischargeData?.admission?.ward || "Ward"}: Bed {dischargeData?.admission?.bed_no || dischargeData?.charges?.bed_items?.[0]?.bed_no || "Allotted"}
                      </h3>
                      <div style={{ fontSize: "0.8125rem", color: "#334155" }}>
                        Admitting Doctor: <strong>{dischargeData?.admission?.admitting_doctor || dischargeData?.admission?.doctor_name || "General Medicine"}</strong>
                      </div>
                    </div>
                    <span
                      style={{
                        padding: "4px 10px",
                        borderRadius: "20px",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        background: dischargeData?.status === "finalised" ? "#f1f5f9" : "#dcfce7",
                        color: dischargeData?.status === "finalised" ? "#475569" : "#15803d",
                        border: `1px solid ${dischargeData?.status === "finalised" ? "#cbd5e1" : "#86efac"}`
                      }}
                    >
                      {dischargeData?.status === "finalised" ? "Discharged" : "● Currently Admitted"}
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px", marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Admission Date</div>
                      <div style={{ fontWeight: 700, color: "#1e293b", fontSize: "0.875rem" }}>
                        {dischargeData?.admission?.admission_date ? String(dischargeData.admission.admission_date).slice(0, 10) : "-"}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Stay Duration</div>
                      <div style={{ fontWeight: 700, color: "#1e293b", fontSize: "0.875rem" }}>
                        {dischargeData?.charges_summary?.total_days || dischargeData?.charges?.bed_items?.reduce((acc: number, b: any) => acc + (b.days || 1), 0) || 1} Days
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Daily Bed Tariff</div>
                      <div style={{ fontWeight: 700, color: "#1e293b", fontSize: "0.875rem" }}>
                        ₹{fmt(dischargeData?.charges?.bed_items?.[0]?.daily_rate || 1200)} / day
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Bed Charges</div>
                      <div style={{ fontWeight: 800, color: "#0284c7", fontSize: "0.875rem" }}>
                        ₹{fmt(dischargeData?.charges_summary?.bed_charges || dischargeData?.charges?.bed_items?.reduce((acc: number, b: any) => acc + (b.total || 0), 0) || 0)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bed Stay History Breakdown */}
                <div>
                  <h4 style={{ fontSize: "0.875rem", fontWeight: 700, color: "#334155", marginBottom: "8px" }}>
                    Bed Stay Breakdown & Transfers
                  </h4>
                  {Array.isArray(dischargeData?.charges?.bed_items) && dischargeData.charges.bed_items.length > 0 ? (
                    <table className="billing-table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                      <thead>
                        <tr>
                          <th>Ward</th>
                          <th>Room & Bed</th>
                          <th>Allocated On</th>
                          <th>Released On</th>
                          <th style={{ textAlign: "center" }}>Days</th>
                          <th style={{ textAlign: "right" }}>Daily Rate</th>
                          <th style={{ textAlign: "right" }}>Total Charge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dischargeData.charges.bed_items.map((b: any, i: number) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{b.ward || "General Ward"}</td>
                            <td><span style={{ fontWeight: 700, color: "#0284c7" }}>{b.bed_no || "Bed"}</span> ({b.room_no || "-"})</td>
                            <td style={{ color: "#64748b" }}>{b.allocated_at || dischargeData?.admission?.admission_date?.slice(0, 10) || "-"}</td>
                            <td style={{ color: "#64748b" }}>{b.released_at || (dischargeData.status === "finalised" ? "Discharged" : "Current")}</td>
                            <td style={{ textAlign: "center", fontWeight: 600 }}>{b.days || 1}</td>
                            <td style={{ textAlign: "right" }}>₹{fmt(b.daily_rate || 0)}</td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#0f172a" }}>₹{fmt(b.total || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: "1rem", textAlign: "center", color: "#64748b", background: "#f8fafc", borderRadius: "6px" }}>
                      No bed charge lines recorded for this stay.
                    </div>
                  )}
                </div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem", borderTop: "1px solid #f1f5f9", paddingTop: "0.75rem" }}>
              <Button variant="secondary" onClick={() => setBedsModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
