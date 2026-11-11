import React, { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Button, Modal } from "../../components/ui";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";
import { splitStoredPhone, toWhatsAppNumber } from "../../lib/phone";
import "./billingTheme.css";

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

export default function PatientBillsPaymentsPage({ setNotice, onNavigate, selectedPatient, onSelectPatient }: Props) {
  const [patientSearch, setPatientSearch] = useState("");
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "paid" | "unpaid">("all");

  const [patientData, setPatientData] = useState<any>(null);
  const [selectedBills, setSelectedBills] = useState<Record<number, boolean>>({});
  const [expandedBillId, setExpandedBillId] = useState<number | null>(null);

  // Payment Form State
  const [amountReceived, setAmountReceived] = useState<string>("");
  const [paymentMode, setPaymentMode] = useState<string>("UPI");
  const [transactionRef, setTransactionRef] = useState<string>("");
  const [settlementNotes, setSettlementNotes] = useState<string>("");
  const [settling, setSettling] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<any>(null);

  // Quick fallback patients if user hasn't searched yet
  const [recentPatients, setRecentPatients] = useState<any[]>([]);

  // In-place info inspection modals (No redirection)
  const [journeyModalOpen, setJourneyModalOpen] = useState(false);
  const [journeyData, setJourneyData] = useState<any>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);

  const [advancesModalOpen, setAdvancesModalOpen] = useState(false);
  const [advancesModalData, setAdvancesModalData] = useState<any>(null);
  const [advancesLoading, setAdvancesLoading] = useState(false);

  const [patientDetailsModalOpen, setPatientDetailsModalOpen] = useState(false);

  const openJourneyModal = async () => {
    const pid = patientData?.patient?.patient_id || selectedPatient?.patient_id || patientSearch;
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
    const pid = patientData?.patient?.patient_id || selectedPatient?.patient_id || patientSearch;
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

  const openPatientDetailsModal = () => {
    setPatientDetailsModalOpen(true);
  };

  const fetchPatientBills = async (searchKey: string) => {
    if (!searchKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/billing/patient-bills/${encodeURIComponent(searchKey.trim())}`);
      if (res && res.patient) {
        setPatientData(res);
        localStorage.removeItem("selected_billing_patient");

        // Automatically select unpaid bills
        const unpaid = (res.bills || []).filter((b: any) => Number(b.due_amount ?? b.balance ?? 0) > 0);
        const sel: Record<number, boolean> = {};
        unpaid.forEach((b: any) => {
          const bId = Number(b.id ?? b.invoice_id);
          sel[bId] = true;
        });
        setSelectedBills(sel);

        const totalDue = unpaid.reduce((sum: number, b: any) => sum + Number(b.due_amount ?? b.balance ?? 0), 0);
        setAmountReceived(String(totalDue));
        if (unpaid.length > 0) {
          setExpandedBillId(Number(unpaid[0].id ?? unpaid[0].invoice_id));
        }
      } else {
        setError(`No billing records found for "${searchKey}".`);
        setPatientData(null);
      }
    } catch (err: any) {
      reportError(setNotice, err);
      setError(err.message || "Failed to load patient bills.");
      setPatientData(null);
    } finally {
      setLoading(false);
    }
  };

  // Load recent worklist on mount to provide fast patient picks if needed
  useEffect(() => {
    localStorage.removeItem("selected_billing_patient");
    const init = async () => {
      try {
        const wl = await apiFetch("/api/billing/worklist?tab=pending_payments");
        if (wl?.pending_payments?.length > 0) {
          setRecentPatients(wl.pending_payments.slice(0, 5));
        }
      } catch {
        // ignore
      }
    };
    init();
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchPatientBills(patientSearch);
  };

  const allBills = patientData?.bills || [];
  const unpaidBills = allBills.filter((b: any) => Number(b.due_amount ?? b.balance ?? 0) > 0);
  const paidBills = allBills.filter((b: any) => Number(b.due_amount ?? b.balance ?? 0) <= 0);

  const displayedBills =
    activeTab === "unpaid" ? unpaidBills : activeTab === "paid" ? paidBills : allBills;

  // Toggle selection
  const toggleSelectBill = (id: number) => {
    setSelectedBills((prev) => {
      const updated = { ...prev, [id]: !prev[id] };
      // Recalculate amount
      const nextTotal = unpaidBills
        .filter((b: any) => updated[Number(b.id ?? b.invoice_id)])
        .reduce((sum: number, b: any) => sum + Number(b.due_amount ?? b.balance ?? 0), 0);
      setAmountReceived(String(nextTotal));
      return updated;
    });
  };

  const toggleSelectAll = () => {
    const allSelected = unpaidBills.length > 0 && unpaidBills.every((b: any) => selectedBills[Number(b.id ?? b.invoice_id)]);
    if (allSelected) {
      setSelectedBills({});
      setAmountReceived("0");
    } else {
      const sel: Record<number, boolean> = {};
      let sum = 0;
      unpaidBills.forEach((b: any) => {
        const bId = Number(b.id ?? b.invoice_id);
        sel[bId] = true;
        sum += Number(b.due_amount ?? b.balance ?? 0);
      });
      setSelectedBills(sel);
      setAmountReceived(String(sum));
    }
  };

  const selectedCount = Object.values(selectedBills).filter(Boolean).length;
  const selectedTotal = unpaidBills
    .filter((b: any) => selectedBills[Number(b.id ?? b.invoice_id)])
    .reduce((sum: number, b: any) => sum + Number(b.due_amount ?? b.balance ?? 0), 0);

  // Settlement submission
  const handleRecordPayment = async () => {
    if (!patientData?.patient?.patient_id) {
      setNotice({ type: "warning", message: "Please select a patient first." });
      return;
    }

    const payVal = parseFloat(amountReceived);
    if (isNaN(payVal) || payVal <= 0) {
      setNotice({ type: "warning", message: "Please enter a valid positive payment amount." });
      return;
    }

    const selectedList = unpaidBills.filter((b: any) => selectedBills[Number(b.id ?? b.invoice_id)]);
    if (selectedList.length === 0) {
      setNotice({ type: "warning", message: "Please select at least one bill to settle." });
      return;
    }

    // Allocate payment proportionally across selected bills
    let remaining = payVal;
    const allocations: Array<{ invoice_id: number; amount: number }> = [];

    for (let i = 0; i < selectedList.length; i++) {
      const b = selectedList[i];
      if (remaining <= 0) break;
      const bDue = Number(b.due_amount ?? b.balance ?? 0);
      const alloc = Math.min(bDue, remaining);
      const bId = Number(b.id ?? b.invoice_id);
      allocations.push({ invoice_id: bId, amount: alloc });
      remaining -= alloc;
    }

    setSettling(true);
    try {
      const payload = {
        patient_id: patientData.patient.patient_id,
        allocations,
        payments: [
          {
            payment_mode: paymentMode.toLowerCase(),
            amount: payVal,
            transaction_ref: transactionRef || `${paymentMode}-COUNTER`,
          },
        ],
        notes: settlementNotes || "Counter payment settlement",
      };

      const res = await apiFetch("/api/billing/collect-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      setLastReceipt(res);
      setNotice({
        type: "success",
        message: `Payment recorded! Receipt ${res.receipt_no} generated for ₹${fmt(res.total_amount)}.`,
      });

      // Refresh patient bills
      fetchPatientBills(patientData.patient.patient_id);
      setTransactionRef("");
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to record payment." });
    } finally {
      setSettling(false);
    }
  };

  const handlePrintReceipt = (rcp: any) => {
    const html = buildPrintDocumentHtml({
      title: `Official Payment Receipt ${rcp.receipt_no}`,
      subtitleLines: [
        `HospAI · Billing Department`,
        `Receipt Date: ${rcp.created_at ? rcp.created_at.slice(0, 10) : targetDate} · ${rcp.time || ""}`,
        `Payment Mode: ${rcp.payment_mode || paymentMode}`,
      ],
      meta: [
        { label: "Receipt No", value: rcp.receipt_no },
        { label: "Patient UHID", value: patientData?.patient?.patient_id || "-" },
        { label: "Patient Name", value: patientData?.patient?.name || "-" },
        { label: "Payment Mode", value: rcp.payment_mode || paymentMode },
      ],
      columns: ["Bill / Service", "Description", "Amount (₹)"],
      rows: [
        [
          rcp.receipt_type || "Bill Payment",
          `Settlement for inpatient/outpatient hospital charges`,
          `₹${Number(rcp.total_amount || rcp.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        ],
      ],
      totals: [
        {
          label: "Total Paid",
          value: `₹${Number(rcp.total_amount || rcp.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
          grand: true,
        },
      ],
    });
    printViaIframe(html);
  };

  const handleShareWhatsAppReceipt = (rcp: any) => {
    const p = patientData?.patient;
    const rawPhone = p?.phone || p?.mobile || "";
    const rawCode = p?.phone_country_code || "+91";
    const parts = splitStoredPhone(rawPhone, rawCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital - Payment Receipt*`,
      `----------------------------------------`,
      `Receipt No: ${rcp.receipt_no}`,
      p?.name ? `Patient: ${p.name} (UHID: ${p.patient_id})` : "",
      `Date: ${rcp.created_at ? String(rcp.created_at).slice(0, 10) : targetDate}`,
      `Type: ${rcp.receipt_type || "Bill Settlement"}`,
      `Payment Mode: ${rcp.payment_mode || paymentMode}`,
      `Amount Paid: ₹${Number(rcp.total_amount || rcp.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      `----------------------------------------`,
      `Thank you for your payment. Keep this receipt for your records.`,
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

  const handleShareWhatsAppBill = (bill: any) => {
    const p = patientData?.patient;
    const rawPhone = p?.phone || p?.mobile || "";
    const rawCode = p?.phone_country_code || "+91";
    const parts = splitStoredPhone(rawPhone, rawCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital - Bill Details*`,
      `----------------------------------------`,
      `Invoice No: ${bill.invoice_no}`,
      `Module: ${bill.module}`,
      p?.name ? `Patient: ${p.name} (UHID: ${p.patient_id})` : "",
      `Total Amount: ₹${Number(bill.total_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      `Due Amount: ₹${Number(bill.due_amount ?? bill.balance ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      `Status: ${Number(bill.due_amount ?? bill.balance ?? 0) <= 0 ? "PAID" : "UNPAID"}`,
      `----------------------------------------`,
      `For any billing queries, visit HospAI Billing Counter.`,
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

  const expandedBill = allBills.find((b: any) => Number(b.id ?? b.invoice_id) === Number(expandedBillId));

  return (
    <div className="billing-page-wrapper">
      {/* 1. Breadcrumbs */}
      <div className="billing-breadcrumbs">
        <span className="breadcrumb-link" onClick={() => onNavigate?.("dashboard")}>
          HospAI
        </span>
        <span className="separator">/</span>
        <span className="current">Billing</span>
      </div>

      {/* 2. Top Header Bar */}
      <div className="billing-header-row">
        <div className="billing-title-block">
          <h1>Patient Bills & Payments</h1>
          <p>Find a patient, review bills and record payments.</p>
        </div>

        <div className="billing-header-actions">
          {/* Date Picker Pill */}
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

          {/* History Button */}
          <button
            type="button"
            className="billing-btn-outline"
            onClick={() => setActiveTab(activeTab === "paid" ? "unpaid" : "paid")}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            History
          </button>
        </div>
      </div>

      {/* 3. Search Bar */}
      <form onSubmit={handleSearchSubmit} className="billing-search-row">
        <div className="billing-search-input-box">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#94a3b8" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search name, UHID or bill number"
            value={patientSearch}
            onChange={(e) => setPatientSearch(e.target.value)}
          />
        </div>

        <button type="submit" className="billing-btn-teal" disabled={loading}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Search
        </button>
      </form>

      {/* 4. Patient Identity Strip */}
      {patientData?.patient ? (
        <div className="billing-identity-strip">
          <div className="billing-identity-left">
            <div className="billing-avatar-circle">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <div className="billing-identity-details">
              <h3>{patientData.patient.name} {patientData.patient.last_name || ""}</h3>
              <div className="billing-identity-meta">
                <span>{patientData.patient.patient_id}</span>
                <span className="meta-divider">|</span>
                <span>{patientData.patient.gender || "M"}, {patientData.patient.age || "-"} yrs</span>
                <span className="meta-divider">|</span>
                <span>Visit {patientData.patient.registered_date ? String(patientData.patient.registered_date).slice(0, 10) : targetDate}</span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="billing-btn-outline"
              onClick={openJourneyModal}
              title="View patient journey, timeline and clinical history without redirecting"
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
              onClick={openPatientDetailsModal}
              title="View full patient demographic & registration profile"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              View patient details
            </button>
          </div>
        </div>
      ) : loading ? (
        <div className="billing-skeleton" style={{ height: "70px", marginBottom: "1.25rem" }} />
      ) : error ? (
        <div className="billing-card" style={{ padding: "1.25rem", textAlign: "center" }}>
          <p style={{ color: "#dc2626", margin: "0 0 8px" }}>{error}</p>
          <button type="button" className="billing-retry-btn" onClick={() => fetchPatientBills(patientSearch)}>
            Retry
          </button>
        </div>
      ) : recentPatients.length > 0 ? (
        <div className="billing-card" style={{ padding: "1rem 1.25rem", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#64748b", marginBottom: "8px" }}>
            Select a patient with pending bills:
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {recentPatients.map((p) => (
              <button
                key={p.id}
                type="button"
                className="billing-btn-outline"
                style={{ fontSize: "0.8125rem" }}
                onClick={() => {
                  setPatientSearch(p.patient_id);
                  fetchPatientBills(p.patient_id);
                }}
              >
                <strong>{p.patient_name}</strong> ({p.patient_id}) · ₹{fmt(p.balance)} due
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 5. Main Two-Column Layout */}
      <div className="billing-two-col-layout">
        {/* Left Column: Bills for this visit & Expanded Bill Details */}
        <div className="billing-left-col">
          <div className="billing-card">
            <div className="billing-card-header" style={{ paddingBottom: 0 }}>
              <h2 className="billing-card-title">Bills for this visit</h2>
            </div>

            {/* Tabs */}
            <div className="billing-tabs-nav" style={{ marginTop: "8px" }}>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                All
              </button>

              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "paid" ? "active" : ""}`}
                onClick={() => setActiveTab("paid")}
              >
                Paid
              </button>

              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "unpaid" ? "active" : ""}`}
                onClick={() => setActiveTab("unpaid")}
              >
                Unpaid
                <span className="billing-tab-badge">{unpaidBills.length}</span>
              </button>
            </div>

            {/* Table */}
            <div className="billing-table-responsive">
              {loading ? (
                <div className="billing-state-box">
                  <div className="billing-skeleton" style={{ height: "30px", marginBottom: "8px" }} />
                  <div className="billing-skeleton" style={{ height: "30px" }} />
                </div>
              ) : !patientData ? (
                <div className="billing-state-box" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
                  <p style={{ margin: "0 0 6px", fontWeight: 600, color: "#334155" }}>No patient selected</p>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                    Search by patient name, UHID, or bill number above to view bills and record payments.
                  </p>
                </div>
              ) : displayedBills.length === 0 ? (
                <div className="billing-state-box">
                  <p style={{ margin: 0 }}>
                    {activeTab === "all" ? "No bills for this patient visit." : `No ${activeTab} bills for this patient visit.`}
                  </p>
                </div>
              ) : (
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th style={{ width: "40px" }}>
                        {activeTab === "unpaid" && (
                          <input
                            type="checkbox"
                            checked={unpaidBills.length > 0 && unpaidBills.every((b: any) => selectedBills[b.id])}
                            onChange={toggleSelectAll}
                            style={{ cursor: "pointer", width: "16px", height: "16px" }}
                          />
                        )}
                      </th>
                      <th>Bill / Service</th>
                      <th>Net bill</th>
                      <th>Applied</th>
                      <th>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedBills.map((b: any) => {
                      const bId = Number(b.id ?? b.invoice_id);
                      const bDue = Number(b.due_amount ?? b.balance ?? 0);
                      const bPaid = Number(b.paid_amount ?? b.applied ?? 0);
                      const bTotal = Number(b.total_amount ?? b.net_bill ?? 0);
                      const isChecked = !!selectedBills[bId];
                      return (
                        <tr
                          key={bId}
                          className={isChecked ? "selected" : ""}
                          onClick={() => setExpandedBillId(bId)}
                          style={{ cursor: "pointer" }}
                        >
                          <td onClick={(e) => e.stopPropagation()}>
                            {bDue > 0 ? (
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleSelectBill(bId)}
                                style={{ cursor: "pointer", width: "16px", height: "16px", accentColor: "#0d9488" }}
                              />
                            ) : (
                              <span style={{ color: "#10b981", fontSize: "0.85rem" }}>✓</span>
                            )}
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, color: "#0f172a" }}>{b.invoice_no}</div>
                            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                              {b.module || "General"} · {b.payment_status?.toUpperCase() || "OP"}
                            </div>
                          </td>
                          <td style={{ fontWeight: 600 }}>₹{fmt(bTotal)}</td>
                          <td style={{ color: "#64748b" }}>₹{fmt(bPaid)}</td>
                          <td style={{ fontWeight: 700, color: bDue > 0 ? "#0f172a" : "#10b981" }}>
                            ₹{fmt(bDue)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Selected Outstanding Total Strip */}
            {activeTab === "unpaid" && selectedCount > 0 && (
              <div style={{ padding: "0 1.25rem 0.5rem" }}>
                <div className="billing-selected-total-bar">
                  <span>Selected outstanding total ({selectedCount} {selectedCount === 1 ? "bill" : "bills"})</span>
                  <strong>₹{fmt(selectedTotal)}</strong>
                </div>
              </div>
            )}
          </div>

          {/* Subpanel: Expandable Bill Details */}
          {expandedBill && (
            <div className="billing-card">
              <div className="billing-card-header">
                <h3 className="billing-card-title">
                  {expandedBill.module} bill details ({expandedBill.invoice_no})
                </h3>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <span
                    style={{ fontSize: "0.8125rem", color: "#16a34a", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    onClick={() => handleShareWhatsAppBill(expandedBill)}
                  >
                    💬 WhatsApp Bill
                  </span>
                  <span
                    style={{ fontSize: "0.8125rem", color: "#0284c7", fontWeight: 600, cursor: "pointer" }}
                    onClick={() => handlePrintReceipt(expandedBill)}
                  >
                    View original bill ↗
                  </span>
                </div>
              </div>

              <div className="billing-table-responsive">
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>Service / Item</th>
                      <th>Quantity</th>
                      <th style={{ textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {expandedBill.module === "Pharmacy" ? "Prescribed Medicines & Supplies" : `${expandedBill.module} Clinical Service`}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                          Attending: {expandedBill.doctor_name || "Hospital Staff"}
                        </div>
                      </td>
                      <td>1</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>₹{fmt(expandedBill.total_amount)}</td>
                    </tr>
                    {expandedBill.paid_amount > 0 && (
                      <tr style={{ background: "#f8fafc" }}>
                        <td colSpan={2} style={{ textAlign: "right", color: "#64748b" }}>Previously Applied:</td>
                        <td style={{ textAlign: "right", color: "#16a34a", fontWeight: 600 }}>-₹{fmt(expandedBill.paid_amount)}</td>
                      </tr>
                    )}
                    <tr style={{ background: "#f8fafc", borderTop: "2px solid #e2e8f0" }}>
                      <td colSpan={2} style={{ textAlign: "right", fontWeight: 700 }}>Balance Due:</td>
                      <td style={{ textAlign: "right", fontWeight: 800, color: "#0f172a" }}>₹{fmt(expandedBill.due_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Record Payment Panel */}
        <div className="billing-right-col">
          <div className="billing-card">
            <div className="billing-card-header">
              <h2 className="billing-card-title">Record payment</h2>
            </div>

            <div className="billing-card-body">
              {!patientData ? (
                <div className="billing-state-box" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
                  <p style={{ margin: "0 0 6px", fontWeight: 600, color: "#334155" }}>No payment pending</p>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                    Search for a patient to load bills and collect payment.
                  </p>
                </div>
              ) : (
                <>
                  {/* Top Highlight Box */}
                  <div className="billing-highlight-box teal-emphasis">
                    <div>
                      <span className="box-label">Selected balance to be paid</span>
                    </div>
                    <span className="box-value">₹{fmt(selectedTotal)}</span>
                  </div>

                  {/* Form: Amount received */}
                  <div className="billing-form-group">
                    <label className="billing-form-label">Amount received *</label>
                    <div style={{ display: "flex", alignItems: "center", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "0 12px" }}>
                      <span style={{ fontWeight: 600, color: "#64748b", marginRight: "6px" }}>₹</span>
                      <input
                        type="number"
                        step="0.01"
                        className="billing-form-input"
                        style={{ border: "none", padding: "8px 0" }}
                        value={amountReceived}
                        onChange={(e) => setAmountReceived(e.target.value)}
                        placeholder="Enter amount"
                      />
                    </div>
                  </div>

                  {/* Form: Payment mode */}
                  <div className="billing-form-group">
                    <label className="billing-form-label">Payment mode *</label>
                    <select
                      className="billing-form-input"
                      value={paymentMode}
                      onChange={(e) => setPaymentMode(e.target.value)}
                    >
                      <option value="UPI">UPI</option>
                      <option value="Cash">Cash</option>
                      <option value="Card">Credit / Debit Card</option>
                      <option value="Bank Transfer">Bank Transfer (NEFT/RTGS)</option>
                      <option value="Cheque">Cheque</option>
                    </select>
                  </div>

                  {/* Form: Transaction reference */}
                  <div className="billing-form-group">
                    <label className="billing-form-label">Transaction reference</label>
                    <input
                      type="text"
                      className="billing-form-input"
                      placeholder="Enter reference (e.g. UTR / auth code)"
                      value={transactionRef}
                      onChange={(e) => setTransactionRef(e.target.value)}
                    />
                  </div>

                  {/* Warning Banner */}
                  <div className="billing-warning-banner">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    Payment confirmation required before recording.
                  </div>

                  {/* Action: Record payment & print receipt */}
                  <button
                    type="button"
                    className="billing-btn-teal"
                    style={{ width: "100%", padding: "10px", fontSize: "0.9375rem" }}
                    onClick={handleRecordPayment}
                    disabled={settling || selectedCount === 0}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 6 2 18 2 18 9" />
                      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                      <rect x="6" y="14" width="12" height="8" />
                    </svg>
                    {settling ? "Recording..." : "Record payment & print receipt"}
                  </button>

                  <div style={{ textAlign: "center", marginTop: "10px" }}>
                    <button
                      type="button"
                      style={{ background: "none", border: "none", color: "#0284c7", fontSize: "0.8125rem", fontWeight: 500, cursor: "pointer" }}
                      onClick={() => setNotice({ type: "info", message: "Bill selection preserved for this session." })}
                    >
                      Save for later
                    </button>
                  </div>

                  <div style={{ textAlign: "center", marginTop: "12px", fontSize: "0.75rem", color: "#64748b" }}>
                    ⓘ Receipt will be created after payment is recorded.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 6. Bottom Section: Recent Payments */}
      <div className="billing-card" style={{ marginTop: "1.25rem" }}>
        <div className="billing-card-header">
          <h2 className="billing-card-title">Recent payments</h2>
          <span style={{ fontSize: "0.8125rem", color: "#0284c7", fontWeight: 600, cursor: "pointer" }}>
            View all
          </span>
        </div>

        <div className="billing-table-responsive">
          {(!patientData || !patientData.receipts || patientData.receipts.length === 0) ? (
            <div className="billing-state-box">
              <p style={{ margin: 0 }}>
                {patientData ? "No recent payments recorded for this patient." : "Search for a patient to view payment history."}
              </p>
            </div>
          ) : (
            <table className="billing-table">
              <thead>
                <tr>
                  <th>Receipt no.</th>
                  <th>Date & time</th>
                  <th>Bill / Service</th>
                  <th>Mode</th>
                  <th>Amount</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {patientData.receipts.map((rcp: any) => (
                  <tr key={rcp.id}>
                    <td style={{ fontWeight: 600 }}>{rcp.receipt_no}</td>
                    <td style={{ color: "#64748b" }}>
                      {rcp.created_at ? String(rcp.created_at).slice(0, 16).replace("T", " ") : "-"}
                    </td>
                    <td>{rcp.receipt_type || "Bill Settlement"}</td>
                    <td>{rcp.payment_mode || "UPI"}</td>
                    <td style={{ fontWeight: 700 }}>₹{fmt(rcp.total_amount)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="billing-btn-table-outline"
                        onClick={() => handlePrintReceipt(rcp)}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="6 9 6 2 18 2 18 9" />
                          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                          <rect x="6" y="14" width="12" height="8" />
                        </svg>
                        Print receipt
                      </button>
                      <button
                        type="button"
                        className="billing-btn-table-outline"
                        style={{ color: "#16a34a", borderColor: "#86efac", marginLeft: "6px" }}
                        onClick={() => handleShareWhatsAppReceipt(rcp)}
                      >
                        💬 WhatsApp
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Modal 1: Patient Journey (In-place inspection without redirect) */}
      {journeyModalOpen && (
        <Modal
          open={journeyModalOpen}
          title={`Patient Journey & Clinical History: ${patientData?.patient?.name || ""} (${patientData?.patient?.patient_id || ""})`}
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
          title={`Patient Advances & Deposits: ${patientData?.patient?.name || ""} (${patientData?.patient?.patient_id || ""})`}
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
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 600 }}>Total Deposited</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#1e293b", marginTop: "2px" }}>
                      ₹{fmt(advancesModalData?.summary?.total_advances || 0)}
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
                      ₹{fmt(advancesModalData?.summary?.available_advance || 0)}
                    </div>
                  </div>
                </div>

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
                  ) : (
                    <div style={{ padding: "1rem", textAlign: "center", color: "#64748b", background: "#f8fafc", borderRadius: "6px" }}>
                      No advances currently on record for this patient.
                    </div>
                  )}
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

      {/* Modal 3: Patient Demographic & Full Details */}
      {patientDetailsModalOpen && (
        <Modal
          open={patientDetailsModalOpen}
          title={`Patient Details — ${patientData?.patient?.name || ""} (${patientData?.patient?.patient_id || ""})`}
          className="ui-modal-wide"
          onClose={() => setPatientDetailsModalOpen(false)}
        >
          <div style={{ padding: "0.5rem 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", background: "#f8fafc", padding: "1rem", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Full Name</span>
                <div style={{ fontWeight: 700, color: "#1e293b", fontSize: "0.9375rem" }}>
                  {patientData?.patient?.name} {patientData?.patient?.last_name || ""}
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>UHID / Patient ID</span>
                <div style={{ fontWeight: 700, color: "#0284c7", fontSize: "0.9375rem" }}>
                  {patientData?.patient?.patient_id}
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Age / Gender</span>
                <div style={{ fontWeight: 600, color: "#334155" }}>
                  {patientData?.patient?.age} Yrs / {patientData?.patient?.gender || "Not specified"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Mobile Number</span>
                <div style={{ fontWeight: 600, color: "#334155" }}>
                  {patientData?.patient?.phone || patientData?.patient?.mobile || "N/A"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Blood Group</span>
                <div style={{ fontWeight: 600, color: "#334155" }}>
                  {patientData?.patient?.blood_group || "Unknown"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Address</span>
                <div style={{ fontWeight: 500, color: "#334155" }}>
                  {patientData?.patient?.address || "N/A"}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem", gap: "8px" }}>
              {onNavigate && onSelectPatient && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onSelectPatient(patientData.patient);
                    setPatientDetailsModalOpen(false);
                    onNavigate("patients");
                  }}
                >
                  Open in Patients Directory ↗
                </Button>
              )}
              <Button variant="secondary" onClick={() => setPatientDetailsModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
