import React, { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Button, Modal } from "../../components/ui";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";
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

export default function AdvancesRefundsPage({ setNotice, onNavigate, selectedPatient, onSelectPatient }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [patientInfo, setPatientInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transactions" | "refund_requests" | "allocations">("transactions");

  // Summary KPIs
  const [summary, setSummary] = useState({
    total_advances: 0,
    applied_to_bills: 0,
    refunded: 0,
    available_advance: 0,
    reserved_refund: 0,
  });

  const [advances, setAdvances] = useState<any[]>([]);
  const [refundHistory, setRefundHistory] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);

  // Request Refund form state
  const [selectedAdvanceId, setSelectedAdvanceId] = useState<string>("");
  const [refundAmount, setRefundAmount] = useState<string>("");
  const [refundReason, setRefundReason] = useState<string>("Excess advance");
  const [refundMethod, setRefundMethod] = useState<string>("Cash");
  const [refundNotes, setRefundNotes] = useState<string>("Patient requested discharge excess return");
  const [submittingRefund, setSubmittingRefund] = useState(false);

  // Modal actions
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [advPatientId, setAdvPatientId] = useState("");
  const [advAmount, setAdvAmount] = useState("5000");
  const [advMode, setAdvMode] = useState("UPI");
  const [advRef, setAdvRef] = useState("");
  const [advNotes, setAdvNotes] = useState("Security advance against IP admission");
  const [savingAdv, setSavingAdv] = useState(false);

  // Reject / Pay modal state
  const [actionModal, setActionModal] = useState<{
    type: "reject" | "pay";
    refund: any;
  } | null>(null);
  const [modalInput, setModalInput] = useState("");
  const [processingAction, setProcessingAction] = useState(false);

  const loadAdvancesData = async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qParam = query && query.trim() ? `?patient_id=${encodeURIComponent(query.trim())}` : "";
      const res = await apiFetch(`/api/billing/advances${qParam}`);
      if (res) {
        setPatientInfo(res.patient || null);
        if (res.summary) {
          setSummary({
            total_advances: Number(res.summary.total_advances || 0),
            applied_to_bills: Number(res.summary.applied_to_bills || 0),
            refunded: Number(res.summary.refunded || 0),
            available_advance: Number(res.summary.available_advance || 0),
            reserved_refund: Number(res.summary.reserved_refund || 0),
          });
        }
        const advList = res.advances || [];
        setAdvances(advList);
        setRefundHistory(res.refund_history || []);
        setAllocations(res.allocations || []);

        // Pick first available advance for refund form
        const availableAdv = advList.find(
          (a: any) =>
            Number(a.amount || 0) -
              Number(a.allocated_amount || 0) -
              Number(a.refunded_amount || 0) -
              Number(a.reserved_refund_amount || 0) >
            0
        );
        if (availableAdv) {
          setSelectedAdvanceId(String(availableAdv.id));
          const maxAvail =
            Number(availableAdv.amount || 0) -
            Number(availableAdv.allocated_amount || 0) -
            Number(availableAdv.refunded_amount || 0) -
            Number(availableAdv.reserved_refund_amount || 0);
          setRefundAmount(String(Math.min(1000, maxAvail)));
        } else if (advList.length > 0) {
          setSelectedAdvanceId(String(advList[0].id));
          setRefundAmount("");
        } else {
          setSelectedAdvanceId("");
          setRefundAmount("");
        }
      }
    } catch (err: any) {
      reportError(setNotice, err);
      setError(err.message || "Failed to load patient advances.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    localStorage.removeItem("selected_billing_patient");
    loadAdvancesData("");
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadAdvancesData(searchQuery);
  };

  const handleRecordAdvance = async () => {
    if (!advPatientId.trim()) {
      setNotice({ type: "warning", message: "Patient UHID is required." });
      return;
    }
    const amt = parseFloat(advAmount);
    if (isNaN(amt) || amt <= 0) {
      setNotice({ type: "warning", message: "Enter a valid positive advance amount." });
      return;
    }

    setSavingAdv(true);
    try {
      const res = await apiFetch("/api/billing/advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: advPatientId.trim(),
          amount: amt,
          payment_mode: advMode.toLowerCase(),
          transaction_ref: advRef || `${advMode}-ADVANCE`,
          notes: advNotes,
        }),
      });
      setShowAdvanceModal(false);
      setNotice({ type: "success", message: `Advance deposit ${res.advance_no} recorded successfully.` });
      setSearchQuery(advPatientId.trim());
      loadAdvancesData(advPatientId.trim());
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to record advance." });
    } finally {
      setSavingAdv(false);
    }
  };

  // Selected advance details
  const activeSelectedAdv = useMemo(() => {
    return advances.find((a) => String(a.id) === selectedAdvanceId);
  }, [advances, selectedAdvanceId]);

  const selectedAdvAvailable = useMemo(() => {
    if (!activeSelectedAdv) return summary.available_advance;
    const tot = Number(activeSelectedAdv.amount || 0);
    const alloc = Number(activeSelectedAdv.allocated_amount || 0);
    const ref = Number(activeSelectedAdv.refunded_amount || 0);
    const res = Number(activeSelectedAdv.reserved_refund_amount || 0);
    return Math.max(0, tot - alloc - ref - res);
  }, [activeSelectedAdv, summary.available_advance]);

  const handleSubmitRefund = async () => {
    const amt = parseFloat(refundAmount);
    if (isNaN(amt) || amt <= 0) {
      setNotice({ type: "warning", message: "Enter a valid positive refund amount." });
      return;
    }
    if (!selectedAdvanceId) {
      setNotice({ type: "warning", message: "Please select a source advance deposit." });
      return;
    }
    if (amt > selectedAdvAvailable) {
      setNotice({
        type: "error",
        message: `Amount exceeds available balance of ₹${fmt(selectedAdvAvailable)} on selected advance.`,
      });
      return;
    }

    setSubmittingRefund(true);
    try {
      const advId = parseInt(selectedAdvanceId, 10);
      const res = await apiFetch("/api/billing/refunds/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advance_id: advId,
          amount: amt,
          refund_method: refundMethod.toLowerCase(),
          reason: `${refundReason}: ${refundNotes}`.trim(),
          notes: refundNotes,
        }),
      });
      setNotice({
        type: "success",
        message: `Refund request ${res.refund_no} submitted for supervisor approval.`,
      });
      setActiveTab("refund_requests");
      loadAdvancesData(searchQuery);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to submit refund request." });
    } finally {
      setSubmittingRefund(false);
    }
  };

  const handleApproveRefund = async (refundId: number) => {
    try {
      const res = await apiFetch(`/api/billing/refunds/${refundId}/approve`, {
        method: "POST",
      });
      setNotice({
        type: "success",
        message: `Refund request #${refundId} approved successfully! Ready for payout.`,
      });
      loadAdvancesData(searchQuery);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to approve refund." });
    }
  };

  const handleExecuteModalAction = async () => {
    if (!actionModal) return;
    setProcessingAction(true);
    try {
      if (actionModal.type === "reject") {
        await apiFetch(`/api/billing/refunds/${actionModal.refund.id}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: modalInput || "Rejected by supervisor" }),
        });
        setNotice({ type: "success", message: `Refund request #${actionModal.refund.id} rejected.` });
      } else {
        const res = await apiFetch(`/api/billing/refunds/${actionModal.refund.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_ref: modalInput || "DISBURSED-CASH" }),
        });
        setNotice({
          type: "success",
          message: `Refund disbursed! Voucher ${res.voucher_no || ""} created for ₹${fmt(res.amount || actionModal.refund.amount)}.`,
        });
      }
      setActionModal(null);
      setModalInput("");
      loadAdvancesData(searchQuery);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Action failed." });
    } finally {
      setProcessingAction(false);
    }
  };

  const printStatement = () => {
    const pName = patientInfo?.name || "All Patients";
    const pUhid = patientInfo?.patient_id || "All Records";
    const html = buildPrintDocumentHtml({
      title: `Patient Advance & Deposit Statement`,
      subtitleLines: [
        `HospAI · Billing & Accounts`,
        `Patient: ${pName} (${pUhid})`,
        `Generated: ${new Date().toLocaleDateString("en-IN")}`,
      ],
      meta: [
        { label: "Total Advances", value: `₹${fmt(summary.total_advances)}` },
        { label: "Applied to Bills", value: `₹${fmt(summary.applied_to_bills)}` },
        { label: "Disbursed Refunds", value: `₹${fmt(summary.refunded)}` },
        { label: "Reserved / Pending", value: `₹${fmt(summary.reserved_refund)}` },
        { label: "Available Balance", value: `₹${fmt(summary.available_advance)}` },
      ],
      columns: ["Date", "Advance No", "Payment Mode", "Total (₹)", "Allocated (₹)", "Available (₹)"],
      rows: advances.map((a) => [
        a.created_at ? String(a.created_at).slice(0, 10) : "-",
        a.advance_no,
        (a.payment_mode || "CASH").toUpperCase(),
        `₹${fmt(a.amount)}`,
        `₹${fmt(a.allocated_amount)}`,
        `₹${fmt(a.amount - a.allocated_amount - (a.refunded_amount || 0))}`,
      ]),
      totals: [
        { label: "Net Available Advance", value: `₹${fmt(summary.available_advance)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const printAdvanceReceipt = (adv: any) => {
    const html = buildPrintDocumentHtml({
      title: `Advance Deposit Receipt`,
      subtitleLines: [
        `HospAI · Central Cashier Desk`,
        `Receipt Reference: ${adv.advance_no}`,
        `Date: ${adv.created_at ? String(adv.created_at).slice(0, 19).replace("T", " ") : "Today"}`,
      ],
      meta: [
        { label: "Advance No", value: adv.advance_no },
        { label: "Patient UHID", value: adv.patient_id },
        { label: "Payment Mode", value: (adv.payment_mode || "CASH").toUpperCase() },
        { label: "Transaction Ref", value: adv.transaction_ref || "-" },
      ],
      columns: ["Description", "Purpose", "Amount Received (₹)"],
      rows: [
        [
          `Security / Treatment Advance Deposit`,
          adv.notes || "General medical care advance",
          `₹${Number(adv.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        ],
      ],
      totals: [
        {
          label: "Total Advance Deposited",
          value: `₹${Number(adv.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
          grand: true,
        },
      ],
    });
    printViaIframe(html);
  };

  const printRefundVoucher = (rf: any) => {
    const html = buildPrintDocumentHtml({
      title: `Refund Payment Voucher`,
      subtitleLines: [
        `HospAI · Billing Department`,
        `Refund Reference: ${rf.refund_no}`,
        `Paid On: ${rf.paid_at ? String(rf.paid_at).slice(0, 19).replace("T", " ") : "Completed"}`,
      ],
      meta: [
        { label: "Refund No", value: rf.refund_no },
        { label: "Patient UHID", value: rf.patient_id },
        { label: "Reason", value: rf.reason || "Discharge excess return" },
        { label: "Authorised By", value: rf.approved_by || "Supervisor" },
        { label: "Disbursed By", value: rf.paid_by || "Cashier" },
      ],
      columns: ["Disbursement Description", "Refund Method", "Amount Refunded (₹)"],
      rows: [
        [
          `Excess Advance Return (${rf.reason || "Patient discharge settlement"})`,
          (rf.refund_method || "CASH").toUpperCase(),
          `₹${Number(rf.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        ],
      ],
      totals: [
        {
          label: "Total Amount Refunded",
          value: `₹${Number(rf.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
          grand: true,
        },
      ],
    });
    printViaIframe(html);
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
        <span className="current">Advances & Refunds</span>
      </div>

      {/* 2. Top Header Bar */}
      <div className="billing-header-row">
        <div className="billing-title-block">
          <h1>Advances & Refunds</h1>
          <p>Track patient deposits, allocations, reservations and approved refunds.</p>
        </div>

        <div className="billing-header-actions">
          <button type="button" className="billing-btn-outline" onClick={printStatement}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Print statement
          </button>

          <button
            type="button"
            className="billing-btn-teal"
            onClick={() => setShowAdvanceModal(true)}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Record advance
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
            placeholder="Search patient name, UHID or admission ID (leave empty for all)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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

      {/* 4. Patient Identity Banner */}
      <div className="billing-identity-strip">
        <div className="billing-identity-left">
          <div className="billing-avatar-circle">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div className="billing-identity-details">
            <h3>{patientInfo ? patientInfo.name : "Hospital Patient Advances"}</h3>
            <div className="billing-identity-meta">
              {patientInfo ? (
                <>
                  <span style={{ fontWeight: 600 }}>{patientInfo.patient_id}</span>
                  {patientInfo.gender && (
                    <>
                      <span className="meta-divider">|</span>
                      <span>{patientInfo.gender}</span>
                    </>
                  )}
                  {patientInfo.age && (
                    <>
                      <span className="meta-divider">|</span>
                      <span>{patientInfo.age} yrs</span>
                    </>
                  )}
                </>
              ) : (
                <span>All registered patients & counter deposits</span>
              )}
            </div>
          </div>
        </div>

        {onNavigate && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {patientInfo && (
              <button
                type="button"
                className="billing-btn-outline"
                onClick={() => {
                  localStorage.setItem("selected_journey_patient", patientInfo.patient_id);
                  onNavigate("patient-journey");
                }}
              >
                🗺️ Journey
              </button>
            )}
            <button
              type="button"
              className="billing-btn-outline"
              onClick={() => {
                const target = patientInfo?.patient_id || searchQuery;
                if (target) localStorage.setItem("selected_billing_patient", target);
                onNavigate("billing-patient-bills");
              }}
            >
              💳 Patient Bills
            </button>
            <button
              type="button"
              className="billing-btn-outline"
              onClick={() => {
                const target = patientInfo?.patient_id || searchQuery;
                if (target) localStorage.setItem("selected_discharge_admission", target);
                onNavigate("billing-ip-discharge");
              }}
            >
              🛏️ IP Discharge
            </button>
          </div>
        )}
      </div>

      {/* 5. Four KPI Summary Cards */}
      <div className="billing-kpi-grid-4">
        {/* Total advances */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#eff6ff", color: "#2563eb" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <circle cx="16" cy="12" r="2" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Total advances</span>
            <span className="billing-kpi-value">₹{fmt(summary.total_advances)}</span>
          </div>
        </div>

        {/* Applied to bills */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#f0fdf4", color: "#16a34a" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <polyline points="9 15 11 17 15 13" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Applied to bills</span>
            <span className="billing-kpi-value">₹{fmt(summary.applied_to_bills)}</span>
          </div>
        </div>

        {/* Refunded */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#fef2f2", color: "#dc2626" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Refunded</span>
            <span className="billing-kpi-value">₹{fmt(summary.refunded)}</span>
            {summary.reserved_refund > 0 && (
              <span style={{ fontSize: "0.75rem", color: "#d97706", fontWeight: 600 }}>
                (₹{fmt(summary.reserved_refund)} pending)
              </span>
            )}
          </div>
        </div>

        {/* Available advance */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#e0f2fe", color: "#0284c7" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Available advance</span>
            <span className="billing-kpi-value">₹{fmt(summary.available_advance)}</span>
          </div>
        </div>
      </div>

      {/* 6. Main Two-Column Layout */}
      <div className="billing-two-col-layout">
        {/* Left Column: Ledger & Dynamic Tabs */}
        <div className="billing-left-col">
          {/* Card: Patient Advance Ledger */}
          <div className="billing-card">
            <div className="billing-card-header" style={{ paddingBottom: 0 }}>
              <h2 className="billing-card-title">Patient advance ledger</h2>
            </div>

            {/* Dynamic Tabs */}
            <div className="billing-tabs-nav" style={{ marginTop: "8px" }}>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "transactions" ? "active" : ""}`}
                onClick={() => setActiveTab("transactions")}
              >
                Transactions ({advances.length})
              </button>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "refund_requests" ? "active" : ""}`}
                onClick={() => setActiveTab("refund_requests")}
              >
                Refund requests ({refundHistory.length})
              </button>
              <button
                type="button"
                className={`billing-tab-btn ${activeTab === "allocations" ? "active" : ""}`}
                onClick={() => setActiveTab("allocations")}
              >
                Allocation history ({allocations.length})
              </button>
            </div>

            <div className="billing-table-responsive">
              {/* TAB 1: Transactions */}
              {activeTab === "transactions" && (
                advances.length === 0 ? (
                  <div className="billing-state-box">
                    <p style={{ margin: 0 }}>No advance deposits found for this selection.</p>
                    <button
                      type="button"
                      className="billing-btn-teal"
                      style={{ marginTop: "10px" }}
                      onClick={() => setShowAdvanceModal(true)}
                    >
                      + Record Advance Now
                    </button>
                  </div>
                ) : (
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Reference</th>
                        <th>Patient</th>
                        <th>Payment Mode</th>
                        <th>Received</th>
                        <th>Allocated</th>
                        <th>Refunded</th>
                        <th>Available</th>
                        <th style={{ textAlign: "right" }}>Receipt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {advances.map((a) => {
                        const avail = Math.max(
                          0,
                          Number(a.amount || 0) -
                            Number(a.allocated_amount || 0) -
                            Number(a.refunded_amount || 0)
                        );
                        return (
                          <tr key={a.id}>
                            <td style={{ color: "#64748b" }}>
                              {a.created_at ? String(a.created_at).slice(0, 10) : "Today"}
                            </td>
                            <td style={{ fontWeight: 600 }}>{a.advance_no}</td>
                            <td>
                              <span style={{ fontWeight: 600 }}>{a.patient_id}</span>
                            </td>
                            <td>
                              <span style={{ background: "#f1f5f9", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                                {(a.payment_mode || "CASH").toUpperCase()}
                              </span>
                            </td>
                            <td style={{ fontWeight: 600, color: "#16a34a" }}>₹{fmt(a.amount)}</td>
                            <td style={{ color: "#2563eb" }}>
                              {Number(a.allocated_amount) > 0 ? `₹${fmt(a.allocated_amount)}` : "—"}
                            </td>
                            <td style={{ color: "#dc2626" }}>
                              {Number(a.refunded_amount) > 0 ? `₹${fmt(a.refunded_amount)}` : "—"}
                            </td>
                            <td style={{ fontWeight: 700, color: avail > 0 ? "#0284c7" : "#64748b" }}>
                              ₹{fmt(avail)}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <button
                                type="button"
                                className="billing-btn-table-outline"
                                onClick={() => printAdvanceReceipt(a)}
                                title="Print official advance deposit receipt"
                              >
                                🖨️ Receipt
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              )}

              {/* TAB 2: Refund Requests */}
              {activeTab === "refund_requests" && (
                refundHistory.length === 0 ? (
                  <div className="billing-state-box">
                    <p style={{ margin: 0 }}>No refund requests registered yet.</p>
                  </div>
                ) : (
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Refund No</th>
                        <th>Requested Date</th>
                        <th>Patient</th>
                        <th>Amount</th>
                        <th>Reason</th>
                        <th>Status</th>
                        <th style={{ textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {refundHistory.map((rf) => {
                        const st = (rf.status || "awaiting_approval").toLowerCase();
                        return (
                          <tr key={rf.id}>
                            <td style={{ fontWeight: 600 }}>{rf.refund_no}</td>
                            <td style={{ color: "#64748b" }}>
                              {rf.created_at ? String(rf.created_at).slice(0, 10) : "Today"}
                            </td>
                            <td style={{ fontWeight: 600 }}>{rf.patient_id}</td>
                            <td style={{ fontWeight: 700, color: "#dc2626" }}>₹{fmt(rf.amount)}</td>
                            <td style={{ color: "#475569", maxWidth: "220px" }}>{rf.reason || "Excess return"}</td>
                            <td>
                              <span
                                className={
                                  st === "approved"
                                    ? "billing-badge-settled"
                                    : st === "paid"
                                    ? "billing-badge-settled"
                                    : st === "rejected"
                                    ? "billing-badge-due"
                                    : "billing-badge-review"
                                }
                              >
                                {st === "awaiting_approval"
                                  ? "Awaiting Approval"
                                  : st === "approved"
                                  ? "Approved (Ready)"
                                  : st === "paid"
                                  ? "Disbursed"
                                  : "Rejected"}
                              </span>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end" }}>
                                {st === "awaiting_approval" && (
                                  <>
                                    <button
                                      type="button"
                                      className="billing-btn-collect"
                                      style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                                      onClick={() => handleApproveRefund(rf.id)}
                                    >
                                      ✓ Approve
                                    </button>
                                    <button
                                      type="button"
                                      className="billing-btn-outline"
                                      style={{ padding: "3px 8px", fontSize: "0.75rem", color: "#dc2626", borderColor: "#fca5a5" }}
                                      onClick={() => {
                                        setActionModal({ type: "reject", refund: rf });
                                        setModalInput("Excess claimed / Not eligible");
                                      }}
                                    >
                                      ✕ Reject
                                    </button>
                                  </>
                                )}
                                {st === "approved" && (
                                  <button
                                    type="button"
                                    className="billing-btn-teal"
                                    style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                                    onClick={() => {
                                      setActionModal({ type: "pay", refund: rf });
                                      setModalInput("CASH-VOUCHER-" + rf.id);
                                    }}
                                  >
                                    💵 Disburse / Pay
                                  </button>
                                )}
                                {st === "paid" && (
                                  <button
                                    type="button"
                                    className="billing-btn-table-outline"
                                    onClick={() => printRefundVoucher(rf)}
                                  >
                                    🖨️ Voucher
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              )}

              {/* TAB 3: Allocation History */}
              {activeTab === "allocations" && (
                allocations.length === 0 ? (
                  <div className="billing-state-box">
                    <p style={{ margin: 0 }}>No advance allocations to invoices recorded yet.</p>
                  </div>
                ) : (
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Allocated Date</th>
                        <th>Source Advance</th>
                        <th>Applied To Invoice</th>
                        <th>Module</th>
                        <th>Allocated By</th>
                        <th style={{ textAlign: "right" }}>Amount Allocated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((al) => (
                        <tr key={al.id}>
                          <td style={{ color: "#64748b" }}>
                            {al.allocated_at ? String(al.allocated_at).slice(0, 10) : "Today"}
                          </td>
                          <td style={{ fontWeight: 600 }}>{al.advance_no}</td>
                          <td style={{ fontWeight: 600, color: "#0284c7" }}>{al.invoice_no}</td>
                          <td>
                            <span style={{ background: "#f1f5f9", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem" }}>
                              {al.invoice_module || "OP"}
                            </span>
                          </td>
                          <td style={{ color: "#64748b" }}>{al.allocated_by || "System"}</td>
                          <td style={{ textAlign: "right", fontWeight: 700, color: "#16a34a" }}>
                            ₹{fmt(al.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
          </div>

          {/* Bottom Info Banner */}
          <div className="billing-info-banner">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            Advance deposits, bill allocations and refund vouchers are atomically reconciled under row locks. Approvals preserve audit trails.
          </div>
        </div>

        {/* Right Column: Dynamic Request Refund Form */}
        <div className="billing-right-col">
          <div className="billing-card">
            <div className="billing-card-header">
              <h2 className="billing-card-title">Request refund</h2>
            </div>

            <div className="billing-card-body">
              {/* Source advance */}
              <div className="billing-form-group">
                <label className="billing-form-label">Source advance deposit</label>
                {advances.length === 0 ? (
                  <div style={{ padding: "8px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", fontSize: "0.85rem", color: "#64748b" }}>
                    No advances available for this patient.
                  </div>
                ) : (
                  <select
                    className="billing-form-input"
                    value={selectedAdvanceId}
                    onChange={(e) => {
                      setSelectedAdvanceId(e.target.value);
                      const adv = advances.find((a) => String(a.id) === e.target.value);
                      if (adv) {
                        const av = Math.max(
                          0,
                          Number(adv.amount || 0) -
                            Number(adv.allocated_amount || 0) -
                            Number(adv.refunded_amount || 0) -
                            Number(adv.reserved_refund_amount || 0)
                        );
                        setRefundAmount(String(Math.min(1000, av)));
                      }
                    }}
                  >
                    {advances.map((a) => {
                      const av = Math.max(
                        0,
                        Number(a.amount || 0) -
                          Number(a.allocated_amount || 0) -
                          Number(a.refunded_amount || 0) -
                          Number(a.reserved_refund_amount || 0)
                      );
                      return (
                        <option key={a.id} value={a.id}>
                          {a.advance_no} — ₹{fmt(a.amount)} (Avail: ₹{fmt(av)})
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>

              {/* Available balance */}
              <div className="billing-form-group">
                <label className="billing-form-label">Available balance on advance</label>
                <div style={{ background: "#f1f5f9", padding: "8px 12px", borderRadius: "8px", fontWeight: 700, color: "#0f172a", fontSize: "0.9375rem" }}>
                  ₹{fmt(selectedAdvAvailable)}
                </div>
              </div>

              {/* Refund amount */}
              <div className="billing-form-group">
                <label className="billing-form-label">Refund amount (₹)</label>
                <div style={{ display: "flex", alignItems: "center", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "0 12px" }}>
                  <span style={{ fontWeight: 600, color: "#64748b", marginRight: "4px" }}>₹</span>
                  <input
                    type="number"
                    step="0.01"
                    className="billing-form-input"
                    style={{ border: "none", padding: "8px 0" }}
                    placeholder="Enter amount"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                </div>
              </div>

              {/* Reason */}
              <div className="billing-form-group">
                <label className="billing-form-label">Reason</label>
                <select
                  className="billing-form-input"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                >
                  <option value="Excess advance">Excess advance</option>
                  <option value="Procedure cancelled">Procedure cancelled</option>
                  <option value="Early discharge">Early discharge</option>
                  <option value="Billing adjustment">Billing adjustment</option>
                </select>
              </div>

              {/* Refund method */}
              <div className="billing-form-group">
                <label className="billing-form-label">Disbursement method</label>
                <select
                  className="billing-form-input"
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                >
                  <option value="Cash">Cash (from Cashier Drawer)</option>
                  <option value="UPI">UPI Transfer</option>
                  <option value="Bank transfer">Bank transfer / NEFT</option>
                  <option value="Card">Card reverse</option>
                </select>
              </div>

              {/* Notes */}
              <div className="billing-form-group">
                <label className="billing-form-label">Notes</label>
                <textarea
                  className="billing-form-input"
                  rows={2}
                  value={refundNotes}
                  onChange={(e) => setRefundNotes(e.target.value)}
                  placeholder="Notes for supervisor review"
                />
              </div>

              {/* Submit Button */}
              <button
                type="button"
                className="billing-btn-teal"
                style={{ width: "100%", padding: "10px", marginTop: "8px" }}
                disabled={submittingRefund || selectedAdvAvailable <= 0}
                onClick={handleSubmitRefund}
              >
                {submittingRefund ? "Submitting..." : "Submit refund for approval"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL 1: Record Advance Deposit */}
      {showAdvanceModal && (
        <Modal
          open={showAdvanceModal}
          onClose={() => setShowAdvanceModal(false)}
          title="Record Patient Advance Deposit"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Patient UHID *
              </label>
              <input
                type="text"
                className="billing-form-input"
                placeholder="e.g. PAT-20260923-0058"
                value={advPatientId}
                onChange={(e) => setAdvPatientId(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Advance Amount (₹) *
              </label>
              <input
                type="number"
                step="1"
                className="billing-form-input"
                placeholder="5000"
                value={advAmount}
                onChange={(e) => setAdvAmount(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Payment Mode
              </label>
              <select
                className="billing-form-input"
                value={advMode}
                onChange={(e) => setAdvMode(e.target.value)}
              >
                <option value="UPI">UPI</option>
                <option value="Cash">Cash</option>
                <option value="Card">Card</option>
                <option value="Bank transfer">Bank transfer</option>
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Transaction Reference
              </label>
              <input
                type="text"
                className="billing-form-input"
                placeholder="UPI ref / Cash counter ref"
                value={advRef}
                onChange={(e) => setAdvRef(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Notes / Purpose
              </label>
              <input
                type="text"
                className="billing-form-input"
                value={advNotes}
                onChange={(e) => setAdvNotes(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "10px" }}>
              <button
                type="button"
                className="billing-btn-outline"
                onClick={() => setShowAdvanceModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="billing-btn-teal"
                disabled={savingAdv}
                onClick={handleRecordAdvance}
              >
                {savingAdv ? "Recording..." : "Record & Issue Receipt"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* MODAL 2: Reject / Disburse Refund Modal */}
      {actionModal && (
        <Modal
          open={true}
          onClose={() => setActionModal(null)}
          title={
            actionModal.type === "reject"
              ? `Reject Refund Request #${actionModal.refund.refund_no}`
              : `Disburse Refund Payment (${actionModal.refund.refund_no})`
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ fontSize: "0.875rem", color: "#475569", margin: 0 }}>
              {actionModal.type === "reject"
                ? `You are rejecting the refund of ₹${fmt(actionModal.refund.amount)}. The reserved balance will immediately be released back to the patient's active advance balance.`
                : `You are disbursing ₹${fmt(actionModal.refund.amount)} (${actionModal.refund.refund_method || "cash"}). This will generate an official refund voucher receipt and deduct cash from your drawer if paid in cash.`}
            </p>

            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                {actionModal.type === "reject" ? "Reason for Rejection *" : "Payment Reference / Voucher ID *"}
              </label>
              <input
                type="text"
                className="billing-form-input"
                value={modalInput}
                onChange={(e) => setModalInput(e.target.value)}
                placeholder={actionModal.type === "reject" ? "e.g. Duplicate request" : "e.g. CASH-PAID-001"}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "10px" }}>
              <button
                type="button"
                className="billing-btn-outline"
                onClick={() => setActionModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={actionModal.type === "reject" ? "billing-btn-outline" : "billing-btn-teal"}
                style={actionModal.type === "reject" ? { color: "#dc2626", borderColor: "#fca5a5" } : {}}
                disabled={processingAction}
                onClick={handleExecuteModalAction}
              >
                {processingAction
                  ? "Processing..."
                  : actionModal.type === "reject"
                  ? "Confirm Rejection"
                  : "Confirm & Disburse"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
