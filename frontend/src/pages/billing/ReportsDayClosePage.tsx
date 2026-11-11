import React, { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Modal } from "../../components/ui";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";
import { splitStoredPhone, toWhatsAppNumber } from "../../lib/phone";
import "./billingTheme.css";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type Tab = "daily" | "monthly" | "department" | "history";

const fmt = (n: number) =>
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate = () => new Date().toISOString().slice(0, 10);

export default function ReportsDayClosePage({ setNotice, onNavigate }: Props) {
  const [targetDate, setTargetDate] = useState(currentDate);
  const [selectedCashier, setSelectedCashier] = useState("All cashiers");
  const [selectedCounter, setSelectedCounter] = useState("Counter 1 - Main OPD");
  const [activeTab, setActiveTab] = useState<Tab>("daily");

  // Daily Data
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportData, setReportData] = useState<any>({
    kpis: { receipts: 0, refunds: 0, net_collections: 0, lab_diagnostic_collections: 0 },
    collections_breakdown: [],
    receipt_register: [],
    session: null,
  });

  // Receipt Register search & filter
  const [receiptSearch, setReceiptSearch] = useState("");
  const [receiptModeFilter, setReceiptModeFilter] = useState("ALL");
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);

  // Reconciliation form
  const [countedCash, setCountedCash] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [closingShift, setClosingShift] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);

  // Department report
  const [deptFromDate, setDeptFromDate] = useState(currentDate);
  const [deptToDate, setDeptToDate] = useState(currentDate);
  const [deptData, setDeptData] = useState<any>(null);
  const [deptLoading, setDeptLoading] = useState(false);

  // Monthly summary
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [monthData, setMonthData] = useState<any>(null);
  const [monthLoading, setMonthLoading] = useState(false);

  // Day Close History
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadDailyData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/billing/reports/data?date=${targetDate}`);
      if (res) {
        setReportData(res);
        if (res.session && res.session.status === "open") {
          setCountedCash(String(res.session.expected_cash ?? ""));
        }
      }
    } catch (err: any) {
      reportError(setNotice, err);
      setError(err.message || "Failed to load daily reports data.");
      setNotice({ type: "error", message: err.message || "Failed to load daily data." });
    } finally {
      setLoading(false);
    }
  };

  const loadDeptData = async () => {
    setDeptLoading(true);
    try {
      const res = await apiFetch(
        `/api/billing/reports/department?date=${deptFromDate}&end_date=${deptToDate}`
      );
      setDeptData(res);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to load department data." });
    } finally {
      setDeptLoading(false);
    }
  };

  const loadMonthlyData = async () => {
    setMonthLoading(true);
    try {
      const res = await apiFetch(`/api/billing/reports/monthly?month=${selectedMonth}`);
      setMonthData(res);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to load monthly data." });
    } finally {
      setMonthLoading(false);
    }
  };

  const loadHistoryData = async () => {
    setHistoryLoading(true);
    try {
      const res = await apiFetch("/api/billing/reports/day-close-history?limit=30");
      setHistoryData(Array.isArray(res) ? res : []);
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to load day close history." });
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadDailyData();
  }, [targetDate]);

  useEffect(() => {
    if (activeTab === "department") loadDeptData();
    if (activeTab === "monthly") loadMonthlyData();
    if (activeTab === "history") loadHistoryData();
  }, [activeTab]);

  const handleCloseShift = async () => {
    const sess = reportData.session;
    if (!sess?.id) return;
    const counted = parseFloat(countedCash);
    if (isNaN(counted) || counted < 0) {
      setNotice({ type: "warning", message: "Enter a valid non-negative cash amount." });
      return;
    }
    setClosingShift(true);
    try {
      const res = await apiFetch("/api/billing/cashier-session/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sess.id,
          counted_cash: counted,
          notes: closeNotes || "End of day shift close",
        }),
      });
      setNotice({
        type: "success",
        message: `Session ${sess.session_code} closed. Variance: ₹${Number(res.variance ?? 0) >= 0 ? "+" : ""}${Number(res.variance ?? 0).toFixed(2)}`,
      });
      setShowConfirmClose(false);
      loadDailyData();
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to close session." });
    } finally {
      setClosingShift(false);
    }
  };

  // Print Daily Report
  const printDayClose = () => {
    printViaIframe(
      buildPrintDocumentHtml({
        title: "Daily Collection & Day Close Report",
        subtitleLines: [
          `HospAI · Date: ${targetDate}`,
          `Cashier: ${selectedCashier} · Counter: ${selectedCounter}`,
        ],
        meta: [
          { label: "Gross Receipts", value: `₹${fmt(reportData.kpis?.receipts ?? 0)}` },
          { label: "Refunds", value: `₹${fmt(reportData.kpis?.refunds ?? 0)}` },
          { label: "Net Collections", value: `₹${fmt(reportData.kpis?.net_collections ?? 0)}` },
        ],
        columns: ["Method", "Receipts (₹)", "Refunds (₹)", "Net Amount (₹)"],
        rows: (reportData.collections_breakdown || []).map((c: any) => [
          c.method,
          `₹${fmt(c.receipts)}`,
          `₹${fmt(c.refunds)}`,
          `₹${fmt(c.net)}`,
        ]),
        totals: [
          {
            label: "Total Net Collections",
            value: `₹${fmt(reportData.kpis?.net_collections ?? 0)}`,
            grand: true,
          },
        ],
      })
    );
  };

  // Print Monthly Report
  const printMonthly = () => {
    if (!monthData) return;
    printViaIframe(
      buildPrintDocumentHtml({
        title: `Monthly Collections Summary — ${selectedMonth}`,
        subtitleLines: ["HospAI · Accounts & Finance"],
        meta: [
          { label: "Net Billed", value: `₹${fmt(monthData.totals?.net_billed ?? 0)}` },
          { label: "Net Collections", value: `₹${fmt(monthData.totals?.net_collections ?? 0)}` },
        ],
        columns: ["Date", "Receipts (₹)", "Refunds (₹)", "Net (₹)", "Txns"],
        rows: (monthData.daily_breakdown || []).map((d: any) => [
          d.date,
          `₹${fmt(d.receipts)}`,
          `₹${fmt(d.refunds)}`,
          `₹${fmt(d.net_collections)}`,
          String(d.transactions),
        ]),
        totals: [
          {
            label: "Month Net Collections",
            value: `₹${fmt(monthData.totals?.net_collections ?? 0)}`,
            grand: true,
          },
        ],
      })
    );
  };

  // Print Reconciliation Slip
  const printReconciliation = () => {
    const sess = reportData.session;
    if (!sess) return;
    const counted = parseFloat(countedCash) || 0;
    const expected = Number(sess.expected_cash ?? 0);
    const variance = counted - expected;
    printViaIframe(
      buildPrintDocumentHtml({
        title: "Cashier Shift Reconciliation Slip",
        subtitleLines: [
          `HospAI · Session: ${sess.session_code}`,
          `Status: ${sess.status?.toUpperCase()} · Date: ${targetDate}`,
        ],
        meta: [
          { label: "Opening Float", value: `₹${fmt(sess.opening_float ?? 0)}` },
          { label: "Cash Received", value: `+₹${fmt(sess.cash_received ?? 0)}` },
          { label: "Cash Refunded", value: `-₹${fmt(sess.cash_refunded ?? 0)}` },
          { label: "Expected Cash", value: `₹${fmt(expected)}` },
          { label: "Physical Counted", value: `₹${fmt(counted)}` },
          {
            label: "Variance",
            value: `${variance >= 0 ? "+" : ""}₹${fmt(variance)} (${Math.abs(variance) < 0.01 ? "BALANCED" : variance > 0 ? "EXCESS" : "SHORTAGE"})`,
          },
        ],
        columns: ["Parameter", "Amount (₹)"],
        rows: [
          ["Opening Cash Float", `₹${fmt(sess.opening_float ?? 0)}`],
          ["Cash Receipts (+)", `₹${fmt(sess.cash_received ?? 0)}`],
          ["Cash Refunds (-)", `₹${fmt(sess.cash_refunded ?? 0)}`],
          ["Cash Handover (-)", `₹${fmt(sess.cash_handover ?? 0)}`],
          ["Expected Drawer Total", `₹${fmt(expected)}`],
          ["Actual Counted Cash", `₹${fmt(counted)}`],
        ],
      })
    );
  };

  // Print Single Receipt
  const printReceipt = (r: any) => {
    printViaIframe(
      buildPrintDocumentHtml({
        title: "Payment Receipt",
        subtitleLines: [
          "HospAI · Main Hospital & Diagnostic Centre",
          `Receipt No: ${r.receipt_no} · Date: ${r.time || targetDate}`,
        ],
        meta: [
          { label: "Receipt No", value: r.receipt_no },
          { label: "Payment Mode", value: r.payment_mode },
          { label: "Amount Paid", value: `₹${fmt(r.amount)}` },
        ],
        columns: ["Description", "Mode", "Amount (₹)"],
        rows: [["Medical / Hospital Services Payment", r.payment_mode, `₹${fmt(r.amount)}`]],
        totals: [{ label: "Total Paid", value: `₹${fmt(r.amount)}`, grand: true }],
      })
    );
  };

  const handleShareWhatsAppReceipt = (r: any) => {
    const rawPhone = r.phone || r.mobile || "";
    const parts = splitStoredPhone(rawPhone);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital - Payment Receipt*`,
      `----------------------------------------`,
      `Receipt No: ${r.receipt_no}`,
      `Date: ${r.time || targetDate}`,
      `Payment Mode: ${r.payment_mode}`,
      `Amount Paid: ₹${fmt(r.amount)}`,
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

  const kpis = reportData.kpis ?? {};
  const sess = reportData.session;

  // Filtered receipts
  const filteredReceipts = useMemo(() => {
    return (reportData.receipt_register || []).filter((r: any) => {
      const matchSearch =
        !receiptSearch ||
        r.receipt_no.toLowerCase().includes(receiptSearch.toLowerCase()) ||
        (r.payment_mode && r.payment_mode.toLowerCase().includes(receiptSearch.toLowerCase()));
      const matchMode =
        receiptModeFilter === "ALL" ||
        r.payment_mode?.toUpperCase() === receiptModeFilter.toUpperCase();
      return matchSearch && matchMode;
    });
  }, [reportData.receipt_register, receiptSearch, receiptModeFilter]);

  // Breakdown calculation
  const totalGross = useMemo(() => {
    return (reportData.collections_breakdown || []).reduce(
      (sum: number, c: any) => sum + (c.receipts || 0),
      0
    );
  }, [reportData.collections_breakdown]);

  const totalRefunds = useMemo(() => {
    return (reportData.collections_breakdown || []).reduce(
      (sum: number, c: any) => sum + (c.refunds || 0),
      0
    );
  }, [reportData.collections_breakdown]);

  const totalNet = useMemo(() => {
    return (reportData.collections_breakdown || []).reduce(
      (sum: number, c: any) => sum + (c.net || 0),
      0
    );
  }, [reportData.collections_breakdown]);

  // Cashier variance
  const countedNum = parseFloat(countedCash);
  const expectedCashNum = Number(sess?.expected_cash ?? 0);
  const variance = !isNaN(countedNum) ? countedNum - expectedCashNum : 0;
  const isBalanced = Math.abs(variance) < 0.01;

  const totalRefundsCount = (reportData.collections_breakdown || []).reduce(
    (s: number, c: any) => s + (c.refunds > 0 ? 1 : 0),
    0
  );

  return (
    <div className="billing-page-wrapper">
      {/* 1. Breadcrumbs */}
      <div className="billing-breadcrumbs">
        <span
          className="breadcrumb-link"
          onClick={() => onNavigate?.("dashboard")}
        >
          HospAI
        </span>
        <span className="separator">/</span>
        <span
          className="breadcrumb-link"
          onClick={() => onNavigate?.("billing-overview")}
        >
          Billing
        </span>
        <span className="separator">/</span>
        <span className="current">Reports & Day Close</span>
      </div>

      {/* 2. Top Header Bar */}
      <div className="billing-header-row" style={{ alignItems: "center" }}>
        <div className="billing-title-block">
          <h1>Reports & Day Close</h1>
          <p>Review collections and reconcile cashier sessions.</p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
          {/* Top Row: Date, Cashier, Counter */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* Date Picker */}
            <div className="billing-date-dropdown">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                title="Select report date"
              />
            </div>

            {/* Cashier Select */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Cashier</span>
              <select
                className="billing-filter-select"
                value={selectedCashier}
                onChange={(e) => setSelectedCashier(e.target.value)}
              >
                <option>All cashiers</option>
                <option>Ramesh Kumar</option>
                <option>Admin Cashier</option>
                <option>Priya Sharma</option>
                <option>K. Rajesh</option>
              </select>
            </div>

            {/* Counter Select */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Counter</span>
              <select
                className="billing-filter-select"
                value={selectedCounter}
                onChange={(e) => setSelectedCounter(e.target.value)}
              >
                <option>Main Billing</option>
                <option>Counter 1 - Main OPD</option>
                <option>Counter 2 - Emergency</option>
                <option>Counter 3 - IP Desk</option>
              </select>
            </div>
          </div>

          {/* Bottom Row: Action Buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="billing-btn-teal"
              onClick={loadDailyData}
              style={{ padding: "6px 14px", fontSize: "13px" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="7" y1="12" x2="17" y2="12" />
                <line x1="10" y1="18" x2="14" y2="18" />
              </svg>
              Apply filters
            </button>

            <button
              type="button"
              className="billing-btn-outline"
              onClick={() => window.open(`/api/billing/reports/export?date=${targetDate}`, "_blank")}
              style={{ padding: "6px 12px", fontSize: "13px" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export
            </button>

            <button
              type="button"
              className="billing-btn-outline"
              onClick={printDayClose}
              style={{ padding: "6px 12px", fontSize: "13px" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              Print
            </button>
          </div>
        </div>
      </div>

      {/* 3. Navigation Tabs Bar */}
      <div className="billing-tabs-nav" style={{ marginBottom: "1.25rem", borderBottom: "1px solid #e2e8f0", padding: "0 4px", background: "transparent" }}>
        <button
          type="button"
          className={`billing-tab-btn ${activeTab === "daily" ? "active" : ""}`}
          onClick={() => setActiveTab("daily")}
        >
          Daily collections
        </button>
        <button
          type="button"
          className={`billing-tab-btn ${activeTab === "monthly" ? "active" : ""}`}
          onClick={() => setActiveTab("monthly")}
        >
          Monthly summary
        </button>
        <button
          type="button"
          className={`billing-tab-btn ${activeTab === "department" ? "active" : ""}`}
          onClick={() => setActiveTab("department")}
        >
          Department report
        </button>
        <button
          type="button"
          className={`billing-tab-btn ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          Day close history
        </button>
      </div>

      {/* TAB 1: DAILY COLLECTIONS & DAY CLOSE (Matching Reference Image 2) */}
      {activeTab === "daily" && (
        <>
          {/* 3 KPI Cards */}
          <div className="billing-kpi-grid-3">
            {/* KPI 1: Receipts */}
            <div className="billing-kpi-card">
              <div className="billing-kpi-icon-wrap" style={{ background: "#ecfdf5", color: "#059669" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <div className="billing-kpi-info">
                <span className="billing-kpi-label">Receipts</span>
                <span className="billing-kpi-value">₹{fmt(kpis.receipts ?? 0)}</span>
                <span className="billing-kpi-subtitle" style={{ color: "#059669", fontWeight: 600 }}>
                  {reportData.receipt_register?.length ?? 0} transactions
                </span>
              </div>
            </div>

            {/* KPI 2: Refunds */}
            <div className="billing-kpi-card">
              <div className="billing-kpi-icon-wrap" style={{ background: "#fef2f2", color: "#dc2626" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </div>
              <div className="billing-kpi-info">
                <span className="billing-kpi-label">Refunds</span>
                <span className="billing-kpi-value" style={{ color: "#dc2626" }}>
                  ₹{fmt(kpis.refunds ?? 0)}
                </span>
                <span className="billing-kpi-subtitle" style={{ color: "#dc2626", fontWeight: 600 }}>
                  {totalRefundsCount} refunds recorded
                </span>
              </div>
            </div>

            {/* KPI 3: Net Collections */}
            <div className="billing-kpi-card">
              <div className="billing-kpi-icon-wrap" style={{ background: "#f0fdfa", color: "#0d9488" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              </div>
              <div className="billing-kpi-info">
                <span className="billing-kpi-label">Net collections</span>
                <span className="billing-kpi-value" style={{ color: "#0f766e" }}>
                  ₹{fmt(kpis.net_collections ?? 0)}
                </span>
                <span className="billing-kpi-subtitle" style={{ color: sess?.status === "open" ? "#0d9488" : "#64748b", fontWeight: 600 }}>
                  {sess?.status === "open" ? "Shift active" : "Shift closed"}
                </span>
              </div>
            </div>

            {/* KPI 4: Lab & Diagnostic Collections */}
            <div className="billing-kpi-card">
              <div className="billing-kpi-icon-wrap" style={{ background: "#eff6ff", color: "#2563eb" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 2v6l-5 10a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-10V2" />
                  <line x1="9" y1="2" x2="15" y2="2" />
                </svg>
              </div>
              <div className="billing-kpi-info">
                <span className="billing-kpi-label">Lab &amp; diagnostic collections</span>
                <span className="billing-kpi-value" style={{ color: "#2563eb" }}>
                  ₹{fmt(kpis.lab_diagnostic_collections ?? 0)}
                </span>
                <span className="billing-kpi-subtitle" style={{ color: "#64748b", fontWeight: 600 }}>
                  Included in net collections above
                </span>
              </div>
            </div>
          </div>

          {/* Loading / Error States */}
          {loading && (
            <div style={{ textAlign: "center", padding: "3rem", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", color: "#64748b" }}>
              <div style={{ display: "inline-block", width: "28px", height: "28px", border: "3px solid #cbd5e1", borderTopColor: "#0d9488", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: "8px" }} />
              <div style={{ fontWeight: 500 }}>Loading daily collections and shift data...</div>
            </div>
          )}

          {error && !loading && (
            <div className="billing-warning-banner" style={{ justifyContent: "space-between" }}>
              <span>{error}</span>
              <button type="button" className="billing-btn-collect" onClick={loadDailyData}>
                Retry
              </button>
            </div>
          )}

          {!loading && !error && (
            <div className="billing-two-col-layout">
              {/* LEFT COLUMN: Collections by method + Receipt register */}
              <div>
                {/* 1. Collections by payment method Card */}
                <div className="billing-card">
                  <div className="billing-card-header">
                    <h3 className="billing-card-title">Collections by payment method</h3>
                  </div>
                  <div className="billing-table-responsive">
                    <table className="billing-table">
                      <thead>
                        <tr>
                          <th>Payment method</th>
                          <th style={{ textAlign: "right" }}>Transactions</th>
                          <th style={{ textAlign: "right" }}>Gross amount</th>
                          <th style={{ textAlign: "right" }}>Refunds</th>
                          <th style={{ textAlign: "right" }}>Net amount</th>
                          <th style={{ textAlign: "right" }}>Share %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!(reportData.collections_breakdown?.length) && (
                          <tr>
                            <td colSpan={6} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                              No collections recorded for {targetDate}.
                            </td>
                          </tr>
                        )}
                        {(reportData.collections_breakdown || []).map((row: any, i: number) => {
                          const grossShare = totalGross > 0 ? ((row.receipts / totalGross) * 100).toFixed(1) : "0.0";
                          const isCash = row.method?.toLowerCase().includes("cash");
                          const isUpi = row.method?.toLowerCase().includes("upi");
                          return (
                            <tr key={i}>
                              <td style={{ fontWeight: 600, color: "#0f172a" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                  {isCash && (
                                    <span style={{ width: "24px", height: "24px", borderRadius: "4px", background: "#ecfdf5", color: "#059669", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /></svg>
                                    </span>
                                  )}
                                  {isUpi && (
                                    <span style={{ width: "24px", height: "24px", borderRadius: "4px", background: "#eff6ff", color: "#2563eb", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
                                    </span>
                                  )}
                                  {!isCash && !isUpi && (
                                    <span style={{ width: "24px", height: "24px", borderRadius: "4px", background: "#fdf4ff", color: "#a855f7", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
                                    </span>
                                  )}
                                  {row.method}
                                </div>
                              </td>
                              <td style={{ textAlign: "right", color: "#64748b" }}>
                                {(reportData.receipt_register || []).filter((r: any) => r.payment_mode?.toUpperCase() === row.method?.toUpperCase()).length || "-"}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 600, color: "#059669" }}>
                                ₹{fmt(row.receipts)}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 600, color: row.refunds > 0 ? "#dc2626" : "#64748b" }}>
                                {row.refunds > 0 ? `-₹${fmt(row.refunds)}` : "₹0.00"}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                                ₹{fmt(row.net)}
                              </td>
                              <td style={{ textAlign: "right", color: "#64748b", fontWeight: 500 }}>
                                {grossShare}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {!!(reportData.collections_breakdown?.length) && (
                        <tfoot>
                          <tr style={{ background: "#f8fafc", borderTop: "2px solid #e2e8f0", fontWeight: 700 }}>
                            <td style={{ color: "#0f172a" }}>Total</td>
                            <td style={{ textAlign: "right", color: "#64748b" }}>
                              {reportData.receipt_register?.length ?? 0}
                            </td>
                            <td style={{ textAlign: "right", color: "#059669" }}>
                              ₹{fmt(totalGross)}
                            </td>
                            <td style={{ textAlign: "right", color: totalRefunds > 0 ? "#dc2626" : "#64748b" }}>
                              {totalRefunds > 0 ? `-₹${fmt(totalRefunds)}` : "₹0.00"}
                            </td>
                            <td style={{ textAlign: "right", color: "#0f766e", fontSize: "0.95rem" }}>
                              ₹{fmt(totalNet)}
                            </td>
                            <td style={{ textAlign: "right", color: "#64748b" }}>100%</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>

                {/* 2. Receipt register Card */}
                <div className="billing-card">
                  <div className="billing-card-header">
                    <div>
                      <h3 className="billing-card-title">Receipt register</h3>
                      <div className="billing-card-subtitle" style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                        Showing {filteredReceipts.length} of {reportData.receipt_register?.length ?? 0} receipts
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      {/* Search box */}
                      <div className="billing-search-input-box" style={{ minWidth: "200px", padding: "6px 10px" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                          type="text"
                          placeholder="Search receipt no..."
                          value={receiptSearch}
                          onChange={(e) => setReceiptSearch(e.target.value)}
                        />
                      </div>
                      {/* Filter dropdown */}
                      <select
                        className="billing-filter-select"
                        value={receiptModeFilter}
                        onChange={(e) => setReceiptModeFilter(e.target.value)}
                        style={{ padding: "5px 10px", fontSize: "0.8125rem" }}
                      >
                        <option value="ALL">All payment methods</option>
                        <option value="CASH">Cash</option>
                        <option value="UPI">UPI / QR</option>
                        <option value="CARD">Card</option>
                      </select>
                    </div>
                  </div>

                  <div className="billing-table-responsive">
                    <table className="billing-table">
                      <thead>
                        <tr>
                          <th>Receipt no</th>
                          <th>Time</th>
                          <th>Payment method</th>
                          <th style={{ textAlign: "right" }}>Amount</th>
                          <th style={{ textAlign: "center" }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredReceipts.length === 0 ? (
                          <tr>
                            <td colSpan={5} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                              No receipts matching filter.
                            </td>
                          </tr>
                        ) : (
                          filteredReceipts.map((r: any, idx: number) => {
                            const isCash = r.payment_mode === "CASH";
                            const isUpi = r.payment_mode === "UPI";
                            return (
                              <tr key={idx}>
                                <td style={{ fontFamily: "monospace", fontWeight: 700, color: "#0f172a" }}>
                                  {r.receipt_no}
                                </td>
                                <td style={{ color: "#64748b", fontSize: "0.85rem" }}>{r.time}</td>
                                <td>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      padding: "2px 8px",
                                      borderRadius: "9999px",
                                      fontSize: "0.75rem",
                                      fontWeight: 600,
                                      background: isCash ? "#fef9c3" : isUpi ? "#dbeafe" : "#f3e8ff",
                                      color: isCash ? "#854d0e" : isUpi ? "#1e40af" : "#7e22ce",
                                    }}
                                  >
                                    {r.payment_mode}
                                  </span>
                                </td>
                                <td style={{ textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                                  ₹{fmt(r.amount)}
                                </td>
                                <td style={{ textAlign: "center" }}>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedReceipt(r)}
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#0d9488",
                                      cursor: "pointer",
                                      fontSize: "0.85rem",
                                      fontWeight: 600,
                                      padding: "4px 8px",
                                      textDecoration: "underline",
                                    }}
                                  >
                                    View
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: Day Close & Cashier Reconciliation */}
              <div>
                <div className="billing-card" style={{ position: "sticky", top: "1rem" }}>
                  <div className="billing-card-header">
                    <div>
                      <h3 className="billing-card-title">Day close & Cashier reconciliation</h3>
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
                        <span style={{ fontSize: "0.8rem", color: "#64748b", fontFamily: "monospace", fontWeight: 600 }}>
                          {sess?.session_code || "No active session"}
                        </span>
                        {sess && (
                          <span className={sess.status === "open" ? "billing-badge-open" : "billing-badge-closed"}>
                            {sess.status === "open" ? "Open" : "Closed"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="billing-card-body">
                    {sess ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                        {/* Cashier Info Card */}
                        <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "10px 12px", border: "1px solid #e2e8f0", fontSize: "0.85rem" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                            <span style={{ color: "#64748b" }}>Cashier:</span>
                            <span style={{ fontWeight: 600, color: "#0f172a" }}>{selectedCashier}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                            <span style={{ color: "#64748b" }}>Counter:</span>
                            <span style={{ fontWeight: 600, color: "#0f172a" }}>{selectedCounter}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ color: "#64748b" }}>Shift Opened:</span>
                            <span style={{ fontWeight: 600, color: "#0f172a" }}>
                              {sess.opened_at ? new Date(sess.opened_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "08:30 AM"}
                            </span>
                          </div>
                        </div>

                        {/* Drawer Cash Breakdown Box */}
                        <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px", background: "#ffffff" }}>
                          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", fontWeight: 700, color: "#64748b", marginBottom: "8px" }}>
                            Drawer Cash Breakdown
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "4px 0", color: "#334155" }}>
                            <span>Opening cash float</span>
                            <span style={{ fontWeight: 600 }}>₹{fmt(sess.opening_float ?? 0)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "4px 0", color: "#059669" }}>
                            <span>Cash received</span>
                            <span style={{ fontWeight: 600 }}>+₹{fmt(sess.cash_received ?? 0)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "4px 0", color: "#dc2626" }}>
                            <span>Cash refunded</span>
                            <span style={{ fontWeight: 600 }}>-₹{fmt(sess.cash_refunded ?? 0)}</span>
                          </div>
                          {Number(sess.cash_handover ?? 0) > 0 && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "4px 0", color: "#dc2626" }}>
                              <span>Cash handed over</span>
                              <span style={{ fontWeight: 600 }}>-₹{fmt(sess.cash_handover ?? 0)}</span>
                            </div>
                          )}
                          <div style={{ borderTop: "1px dashed #cbd5e1", margin: "8px 0 6px" }} />
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.95rem", fontWeight: 700, color: "#0f766e", background: "#f0fdfa", padding: "6px 8px", borderRadius: "6px" }}>
                            <span>Expected drawer cash</span>
                            <span>₹{fmt(sess.expected_cash ?? 0)}</span>
                          </div>
                        </div>

                        {/* Physical count form */}
                        {sess.status === "open" ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <div className="billing-form-group">
                              <label className="billing-form-label">Physical counted cash (₹)</label>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                className="billing-form-input"
                                style={{ fontSize: "1.1rem", fontWeight: 700, borderColor: "#0d9488" }}
                                value={countedCash}
                                onChange={(e) => setCountedCash(e.target.value)}
                                placeholder="Enter counted amount"
                              />
                            </div>

                            {/* Difference Banner */}
                            {countedCash !== "" && !isNaN(countedNum) && (
                              <div
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: "6px",
                                  fontSize: "0.85rem",
                                  fontWeight: 600,
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  background: isBalanced ? "#ecfdf5" : variance > 0 ? "#fffbeb" : "#fef2f2",
                                  color: isBalanced ? "#065f46" : variance > 0 ? "#92400e" : "#991b1b",
                                  border: `1px solid ${isBalanced ? "#a7f3d0" : variance > 0 ? "#fde68a" : "#fecaca"}`,
                                }}
                              >
                                {isBalanced ? (
                                  <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    <span>Difference: ₹0.00 • Drawer balanced</span>
                                  </>
                                ) : variance > 0 ? (
                                  <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                    <span>Excess: +₹{fmt(variance)} • Discrepancy noted</span>
                                  </>
                                ) : (
                                  <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                    <span>Shortage: -₹{fmt(Math.abs(variance))} • Discrepancy noted</span>
                                  </>
                                )}
                              </div>
                            )}

                            <div className="billing-form-group">
                              <label className="billing-form-label">Closing notes / handover remarks</label>
                              <textarea
                                rows={2}
                                className="billing-form-input"
                                placeholder="Notes on shift handover, denominations..."
                                value={closeNotes}
                                onChange={(e) => setCloseNotes(e.target.value)}
                              />
                            </div>

                            <button
                              type="button"
                              className="billing-btn-teal"
                              onClick={() => setShowConfirmClose(true)}
                              disabled={closingShift || !countedCash}
                              style={{ width: "100%", justifyContent: "center" }}
                            >
                              Review & close session
                            </button>

                            <button
                              type="button"
                              className="billing-btn-outline"
                              onClick={printReconciliation}
                              style={{ width: "100%", justifyContent: "center" }}
                            >
                              Print reconciliation
                            </button>
                          </div>
                        ) : (
                          <div style={{ textAlign: "center", padding: "1.25rem 0" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#ecfdf5", color: "#059669", padding: "6px 14px", borderRadius: "20px", fontWeight: 700, fontSize: "0.85rem" }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                              Shift Closed
                            </div>
                            <div style={{ marginTop: "10px", fontSize: "0.85rem", color: "#64748b" }}>
                              Counted: <strong>₹{fmt(Number(sess.counted_cash ?? 0))}</strong>
                            </div>
                            <div style={{ fontSize: "0.85rem", color: Number(sess.variance ?? 0) === 0 ? "#059669" : "#dc2626", marginTop: "2px" }}>
                              Variance: <strong>{Number(sess.variance ?? 0) >= 0 ? "+" : ""}₹{fmt(Number(sess.variance ?? 0))}</strong>
                            </div>
                            <div style={{ marginTop: "14px" }}>
                              <button type="button" className="billing-btn-outline" onClick={printReconciliation} style={{ width: "100%", justifyContent: "center" }}>
                                Print reconciliation slip
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: "center", padding: "2.5rem 1rem", color: "#94a3b8" }}>
                        No active cashier session found for {targetDate}.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* TAB 2: MONTHLY SUMMARY */}
      {activeTab === "monthly" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div className="billing-card" style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 600, color: "#0f172a" }}>Select Month:</label>
                <div className="billing-date-dropdown">
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                  />
                </div>
                <button type="button" className="billing-btn-teal" onClick={loadMonthlyData}>
                  Load Report
                </button>
              </div>
              {monthData && (
                <button type="button" className="billing-btn-outline" onClick={printMonthly}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 6 2 18 2 18 9" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    <rect x="6" y="14" width="12" height="8" />
                  </svg>
                  Print Monthly Summary
                </button>
              )}
            </div>
          </div>

          {monthLoading && (
            <div style={{ textAlign: "center", padding: "3rem", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", color: "#64748b" }}>
              <div style={{ display: "inline-block", width: "28px", height: "28px", border: "3px solid #cbd5e1", borderTopColor: "#0d9488", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: "8px" }} />
              <div style={{ fontWeight: 500 }}>Loading monthly collections breakdown...</div>
            </div>
          )}

          {!monthLoading && monthData && (
            <>
              {/* Monthly KPI 4-Grid */}
              <div className="billing-kpi-grid-4">
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Net Billed</span>
                    <span className="billing-kpi-value" style={{ color: "#0f172a" }}>₹{fmt(monthData.totals?.net_billed ?? 0)}</span>
                    <span className="billing-kpi-subtitle">Total Invoiced</span>
                  </div>
                </div>
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Gross Receipts</span>
                    <span className="billing-kpi-value" style={{ color: "#059669" }}>₹{fmt(monthData.totals?.receipts ?? 0)}</span>
                    <span className="billing-kpi-subtitle">Bills & Advances</span>
                  </div>
                </div>
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Disbursed Refunds</span>
                    <span className="billing-kpi-value" style={{ color: "#dc2626" }}>-₹{fmt(monthData.totals?.refunds ?? 0)}</span>
                    <span className="billing-kpi-subtitle">Approved Vouchers</span>
                  </div>
                </div>
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Net Collections</span>
                    <span className="billing-kpi-value" style={{ color: "#0f766e" }}>₹{fmt(monthData.totals?.net_collections ?? 0)}</span>
                    <span className="billing-kpi-subtitle">Banked Net Total</span>
                  </div>
                </div>
              </div>

              {/* Monthly Daily Breakdown Table */}
              <div className="billing-card">
                <div className="billing-card-header">
                  <h3 className="billing-card-title">Daily Breakdown — {selectedMonth}</h3>
                </div>
                <div className="billing-table-responsive">
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th style={{ textAlign: "right" }}>Receipts (₹)</th>
                        <th style={{ textAlign: "right" }}>Refunds (₹)</th>
                        <th style={{ textAlign: "right" }}>Net Collections (₹)</th>
                        <th style={{ textAlign: "right" }}>Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!(monthData.daily_breakdown?.length) ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                            No transactions recorded for {selectedMonth}.
                          </td>
                        </tr>
                      ) : (
                        monthData.daily_breakdown.map((d: any, idx: number) => (
                          <tr key={idx}>
                            <td style={{ fontWeight: 600, color: "#0f172a" }}>{d.date}</td>
                            <td style={{ textAlign: "right", color: "#059669", fontWeight: 600 }}>₹{fmt(d.receipts)}</td>
                            <td style={{ textAlign: "right", color: d.refunds > 0 ? "#dc2626" : "#64748b", fontWeight: 600 }}>
                              {d.refunds > 0 ? `-₹${fmt(d.refunds)}` : "₹0.00"}
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#0f172a" }}>₹{fmt(d.net_collections)}</td>
                            <td style={{ textAlign: "right", color: "#64748b" }}>{d.transactions}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {!!(monthData.daily_breakdown?.length) && (
                      <tfoot>
                        <tr style={{ background: "#f8fafc", borderTop: "2px solid #e2e8f0", fontWeight: 700 }}>
                          <td style={{ color: "#0f172a" }}>Total — {selectedMonth}</td>
                          <td style={{ textAlign: "right", color: "#059669" }}>₹{fmt(monthData.totals?.receipts ?? 0)}</td>
                          <td style={{ textAlign: "right", color: "#dc2626" }}>-₹{fmt(monthData.totals?.refunds ?? 0)}</td>
                          <td style={{ textAlign: "right", color: "#0f766e", fontSize: "0.95rem" }}>₹{fmt(monthData.totals?.net_collections ?? 0)}</td>
                          <td style={{ textAlign: "right", color: "#64748b" }}>
                            {monthData.daily_breakdown.reduce((s: number, d: any) => s + (d.transactions || 0), 0)}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 3: DEPARTMENT REPORT */}
      {activeTab === "department" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div className="billing-card" style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#64748b" }}>From:</span>
                <div className="billing-date-dropdown">
                  <input
                    type="date"
                    value={deptFromDate}
                    onChange={(e) => setDeptFromDate(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#64748b" }}>To:</span>
                <div className="billing-date-dropdown">
                  <input
                    type="date"
                    value={deptToDate}
                    onChange={(e) => setDeptToDate(e.target.value)}
                  />
                </div>
              </div>
              <button type="button" className="billing-btn-teal" onClick={loadDeptData}>
                Fetch Department Report
              </button>
            </div>
          </div>

          {deptLoading && (
            <div style={{ textAlign: "center", padding: "3rem", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", color: "#64748b" }}>
              <div style={{ display: "inline-block", width: "28px", height: "28px", border: "3px solid #cbd5e1", borderTopColor: "#0d9488", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: "8px" }} />
              <div style={{ fontWeight: 500 }}>Aggregating collections across hospital departments...</div>
            </div>
          )}

          {!deptLoading && deptData && (
            <>
              {/* Department Totals */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Total Department Collected</span>
                    <span className="billing-kpi-value" style={{ color: "#059669" }}>₹{fmt(deptData.totals?.collected ?? 0)}</span>
                  </div>
                </div>
                <div className="billing-kpi-card">
                  <div className="billing-kpi-info">
                    <span className="billing-kpi-label">Total Outstanding Dues</span>
                    <span className="billing-kpi-value" style={{ color: "#dc2626" }}>₹{fmt(deptData.totals?.outstanding ?? 0)}</span>
                  </div>
                </div>
              </div>

              {/* Department Table */}
              <div className="billing-card">
                <div className="billing-card-header">
                  <h3 className="billing-card-title">Department Revenue & Outstanding Summary</h3>
                </div>
                <div className="billing-table-responsive">
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Department</th>
                        <th style={{ textAlign: "right" }}>Invoices</th>
                        <th style={{ textAlign: "right" }}>Collected (₹)</th>
                        <th style={{ textAlign: "right" }}>Outstanding (₹)</th>
                        <th style={{ textAlign: "right" }}>Collection Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!(deptData.by_department?.length) ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                            No department collections found for this date range.
                          </td>
                        </tr>
                      ) : (
                        deptData.by_department.map((dept: any, idx: number) => {
                          const total = dept.collected + dept.outstanding;
                          const rate = total > 0 ? ((dept.collected / total) * 100).toFixed(1) : "100.0";
                          return (
                            <tr key={idx}>
                              <td style={{ fontWeight: 600, color: "#0f172a" }}>
                                <span style={{ padding: "2px 8px", borderRadius: "9999px", background: "#e0f2fe", color: "#0369a1", fontSize: "0.8rem", fontWeight: 600 }}>
                                  {dept.department}
                                </span>
                              </td>
                              <td style={{ textAlign: "right", color: "#64748b" }}>{dept.invoice_count}</td>
                              <td style={{ textAlign: "right", fontWeight: 700, color: "#059669" }}>₹{fmt(dept.collected)}</td>
                              <td style={{ textAlign: "right", fontWeight: 600, color: dept.outstanding > 0 ? "#dc2626" : "#64748b" }}>
                                ₹{fmt(dept.outstanding)}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 600, color: Number(rate) > 85 ? "#059669" : "#eab308" }}>
                                {rate}%
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 4: DAY CLOSE HISTORY */}
      {activeTab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div className="billing-card">
            <div className="billing-card-header">
              <div>
                <h3 className="billing-card-title">Day Close & Cashier Shift History</h3>
                <div className="billing-card-subtitle" style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                  Audited historical records of cashier sessions, drawer variances, and closures
                </div>
              </div>
              <button type="button" className="billing-btn-outline" onClick={loadHistoryData}>
                Refresh History
              </button>
            </div>

            {historyLoading && (
              <div style={{ textAlign: "center", padding: "3rem", background: "#ffffff", color: "#64748b" }}>
                <div style={{ display: "inline-block", width: "28px", height: "28px", border: "3px solid #cbd5e1", borderTopColor: "#0d9488", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: "8px" }} />
                <div style={{ fontWeight: 500 }}>Loading cashier session history...</div>
              </div>
            )}

            {!historyLoading && (
              <div className="billing-table-responsive">
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>Session Code</th>
                      <th>Counter</th>
                      <th>Opened At</th>
                      <th>Closed At</th>
                      <th style={{ textAlign: "right" }}>Opening Float</th>
                      <th style={{ textAlign: "right" }}>Expected Cash</th>
                      <th style={{ textAlign: "right" }}>Counted Cash</th>
                      <th style={{ textAlign: "right" }}>Variance</th>
                      <th style={{ textAlign: "center" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "2.5rem", color: "#94a3b8" }}>
                          No historical sessions recorded.
                        </td>
                      </tr>
                    ) : (
                      historyData.map((s: any, idx: number) => {
                        const isVarZero = Math.abs(Number(s.variance ?? 0)) < 0.01;
                        return (
                          <tr key={idx}>
                            <td style={{ fontFamily: "monospace", fontWeight: 700, color: "#0f172a" }}>
                              {s.session_code}
                            </td>
                            <td style={{ color: "#64748b" }}>{s.counter_name || "Main Counter"}</td>
                            <td style={{ color: "#64748b", fontSize: "0.85rem" }}>
                              {s.opened_at ? new Date(s.opened_at).toLocaleString() : "-"}
                            </td>
                            <td style={{ color: "#64748b", fontSize: "0.85rem" }}>
                              {s.closed_at ? new Date(s.closed_at).toLocaleString() : "Active / Open"}
                            </td>
                            <td style={{ textAlign: "right", color: "#64748b" }}>₹{fmt(s.opening_float)}</td>
                            <td style={{ textAlign: "right", fontWeight: 600, color: "#0f172a" }}>
                              ₹{fmt(s.expected_cash ?? 0)}
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                              {s.counted_cash !== null ? `₹${fmt(s.counted_cash)}` : "-"}
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                fontWeight: 700,
                                color: isVarZero ? "#059669" : "#dc2626",
                              }}
                            >
                              {s.variance !== null ? `${Number(s.variance) >= 0 ? "+" : ""}₹${fmt(s.variance)}` : "-"}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span className={s.status === "open" ? "billing-badge-open" : "billing-badge-closed"}>
                                {s.status === "open" ? "Open" : "Closed"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: VIEW RECEIPT DETAILS */}
      {selectedReceipt && (
        <Modal
          open={!!selectedReceipt}
          title="Payment Receipt Details"
          onClose={() => setSelectedReceipt(null)}
        >
          <div style={{ padding: "0.5rem 0" }}>
            <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
              <span style={{ display: "inline-block", background: "#f0fdfa", color: "#0d9488", fontSize: "0.85rem", fontWeight: 700, padding: "4px 14px", borderRadius: "9999px", border: "1px solid #ccfbf1" }}>
                {selectedReceipt.receipt_no}
              </span>
              <div style={{ fontSize: "1.875rem", fontWeight: 800, color: "#0f172a", marginTop: "8px" }}>
                ₹{fmt(selectedReceipt.amount)}
              </div>
              <div style={{ fontSize: "0.8rem", color: "#64748b" }}>Payment Received</div>
            </div>

            <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "14px", border: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>Payment Method:</span>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{selectedReceipt.payment_mode}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>Timestamp:</span>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{selectedReceipt.time}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "0.875rem" }}>
                <span style={{ color: "#64748b" }}>Date:</span>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{targetDate}</span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "1.25rem" }}>
              <button type="button" className="billing-btn-outline" onClick={() => setSelectedReceipt(null)}>
                Close
              </button>
              <button type="button" className="billing-btn-teal" onClick={() => printReceipt(selectedReceipt)}>
                Print Receipt
              </button>
              <button
                type="button"
                className="billing-btn-teal"
                style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
                onClick={() => handleShareWhatsAppReceipt(selectedReceipt)}
              >
                💬 WhatsApp
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* MODAL: CONFIRM CLOSE SESSION */}
      {showConfirmClose && sess && (
        <Modal
          open={showConfirmClose}
          title="Confirm Shift Closure"
          onClose={() => setShowConfirmClose(false)}
        >
          <div style={{ padding: "0.5rem 0" }}>
            <p style={{ fontSize: "0.9rem", color: "#334155", margin: "0 0 1rem" }}>
              You are about to close cashier shift <strong>{sess.session_code}</strong>. Once closed, no more payments can be taken under this session code.
            </p>
            <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "12px", border: "1px solid #e2e8f0", marginBottom: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "3px 0" }}>
                <span style={{ color: "#64748b" }}>Expected Drawer:</span>
                <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(expectedCashNum)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "3px 0" }}>
                <span style={{ color: "#64748b" }}>Counted Cash:</span>
                <span style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(countedNum)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "3px 0" }}>
                <span style={{ color: "#64748b" }}>Variance:</span>
                <span style={{ fontWeight: 800, color: isBalanced ? "#059669" : "#dc2626" }}>
                  {variance >= 0 ? "+" : ""}₹{fmt(variance)} ({isBalanced ? "MATCH" : variance > 0 ? "EXCESS" : "SHORTAGE"})
                </span>
              </div>
            </div>
            {!isBalanced && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", padding: "10px", color: "#991b1b", fontSize: "0.85rem", marginBottom: "1rem" }}>
                <strong>Attention:</strong> A drawer cash variance of ₹{fmt(variance)} exists. Handover notes will be recorded for audit.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" className="billing-btn-outline" onClick={() => setShowConfirmClose(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="billing-btn-teal"
                style={{ background: "#dc2626", borderColor: "#dc2626" }}
                onClick={handleCloseShift}
                disabled={closingShift}
              >
                {closingShift ? "Closing shift..." : "Confirm & Finalise Close"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

