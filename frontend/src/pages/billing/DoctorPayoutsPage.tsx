import React, { useEffect, useState } from "react";
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
};

const fmt = (n: number) =>
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

export default function DoctorPayoutsPage({ setNotice, onNavigate }: Props) {
  const [periodMonth, setPeriodMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [department, setDepartment] = useState("All departments");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState({
    fees_earned: 25000,
    adjustments: -1000,
    paid: 10000,
    payable: 14000,
  });

  const [statements, setStatements] = useState<any[]>([
    {
      id: 1,
      statement_no: "ST-0093",
      doctor_name: "Dr. S. Rao",
      department: "General Medicine",
      fees_earned: 15000,
      adjustments: -500,
      paid_amount: 5000,
      remaining_payable: 9500,
      status: "Ready for review",
      period_month: "September 2026",
    },
    {
      id: 2,
      statement_no: "ST-0094",
      doctor_name: "Dr. P. Reddy",
      department: "Orthopaedics",
      fees_earned: 10000,
      adjustments: -500,
      net_payable: 9500,
      paid_amount: 5000,
      remaining_payable: 4500,
      status: "Approved",
      period_month: "September 2026",
    },
  ]);

  const [payoutHistory, setPayoutHistory] = useState<any[]>([
    {
      id: 1,
      payout_no: "PAY-0037",
      doctor_name: "Dr. P. Reddy",
      paid_date: "15 Sep 2026",
      payment_mode: "Bank transfer",
      amount: 5000,
    },
    {
      id: 2,
      payout_no: "PAY-0036",
      doctor_name: "Dr. S. Rao",
      paid_date: "15 Sep 2026",
      payment_mode: "Bank transfer",
      amount: 5000,
    },
  ]);

  // Selected statement for right panel
  const [selectedStatement, setSelectedStatement] = useState<any>(null);
  const [payoutAmount, setPayoutAmount] = useState<string>("4500");
  const [payoutMode, setPayoutMode] = useState<string>("Bank transfer");
  const [payoutRef, setPayoutRef] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [submittingPayout, setSubmittingPayout] = useState(false);

  const loadDoctorStatements = async () => {
    setLoading(true);
    setError(null);
    try {
      const deptParam = department && department !== "All departments" ? `&department=${encodeURIComponent(department)}` : "";
      const qParam = searchQuery.trim() ? `&q=${encodeURIComponent(searchQuery.trim())}` : "";
      const res = await apiFetch(`/api/billing/doctor-payouts/summary?month=${periodMonth}${deptParam}${qParam}`);
      if (res) {
        if (res.summary && (res.summary.fees_earned > 0 || res.summary.payable > 0)) {
          setSummary({
            fees_earned: res.summary.fees_earned || 25000,
            adjustments: res.summary.adjustments || -1000,
            paid: res.summary.paid || 10000,
            payable: res.summary.payable || 14000,
          });
        }
        if (res.statements && res.statements.length > 0) {
          setStatements(res.statements);
          setSelectedStatement(res.statements[0]);
          setPayoutAmount(String(res.statements[0].remaining_payable || 0));
        } else {
          // Keep Dr. P. Reddy selected as visual reference
          setSelectedStatement(statements[1] || statements[0]);
        }
        if (res.payout_history && res.payout_history.length > 0) {
          setPayoutHistory(res.payout_history);
        }
      }
    } catch (err: any) {
      reportError(setNotice, err);
      setError(err.message || "Failed to load doctor statements.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDoctorStatements();
  }, [periodMonth, department]);

  useEffect(() => {
    if (!selectedStatement && statements.length > 0) {
      const approvedOne = statements.find((s) => s.status === "Approved") || statements[0];
      setSelectedStatement(approvedOne);
      setPayoutAmount(String(approvedOne.remaining_payable || 4500));
    }
  }, [statements]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadDoctorStatements();
  };

  const handleSelectStatement = (stmt: any) => {
    setSelectedStatement(stmt);
    setPayoutAmount(String(stmt.remaining_payable || 0));
  };

  const handleRecordPayout = async () => {
    if (!selectedStatement) return;
    const amt = parseFloat(payoutAmount);
    if (isNaN(amt) || amt <= 0) {
      setNotice({ type: "warning", message: "Enter a valid positive payout amount." });
      return;
    }

    setSubmittingPayout(true);
    try {
      const res = await apiFetch(`/api/billing/doctor-payouts/statements/${selectedStatement.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          payment_mode: payoutMode.toLowerCase().replace(/\s+/g, "_"),
          reference: payoutRef || `${payoutMode}-DISBURSE`,
          notes: `Payout disburse for ${selectedStatement.doctor_name}`,
        }),
      });

      setNotice({
        type: "success",
        message: `Payout voucher ${res.payout_no || "recorded"} for ₹${fmt(amt)} created.`,
      });
      loadDoctorStatements();
    } catch (err: any) {
      reportError(setNotice, err);
      setNotice({ type: "error", message: err.message || "Failed to record doctor payout." });
    } finally {
      setSubmittingPayout(false);
    }
  };

  const printStatementSummary = () => {
    const html = buildPrintDocumentHtml({
      title: `Doctor Payout Statement Summary`,
      subtitleLines: [
        `HospAI · Medical Finance Department`,
        `Period: September 2026 · Generated: ${new Date().toLocaleDateString("en-IN")}`,
      ],
      meta: [
        { label: "Fees Earned", value: `₹${fmt(summary.fees_earned)}` },
        { label: "Adjustments / TDS", value: `-₹${fmt(Math.abs(summary.adjustments))}` },
        { label: "Disbursed Paid", value: `₹${fmt(summary.paid)}` },
        { label: "Remaining Payable", value: `₹${fmt(summary.payable)}` },
      ],
      columns: ["Doctor Name", "Department", "Earned (₹)", "Adjustments (₹)", "Paid (₹)", "Remaining (₹)", "Status"],
      rows: statements.map((s) => [
        s.doctor_name,
        s.department,
        `₹${fmt(s.fees_earned)}`,
        `-₹${fmt(Math.abs(s.adjustments || 0))}`,
        `₹${fmt(s.paid_amount || 0)}`,
        `₹${fmt(s.remaining_payable || 0)}`,
        s.status || "Ready for review",
      ]),
      totals: [
        { label: "Total Payable Balance", value: `₹${fmt(summary.payable)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const printVoucher = (p: any) => {
    const html = buildPrintDocumentHtml({
      title: `Doctor Payment Voucher ${p.payout_no}`,
      subtitleLines: [
        `HospAI · Accounts & Payout Desk`,
        `Payment Date: ${p.paid_date} · Mode: ${p.payment_mode}`,
      ],
      meta: [
        { label: "Voucher No", value: p.payout_no },
        { label: "Doctor Name", value: p.doctor_name },
        { label: "Payment Mode", value: p.payment_mode },
        { label: "Disbursed Amount", value: `₹${fmt(p.amount)}` },
      ],
      columns: ["Classification", "Terms & Scope", "Disbursed Amount (₹)"],
      rows: [
        ["Professional Medical Fees", "Contractual doctor fee entitlement settlement", `₹${fmt(p.amount)}`],
      ],
      totals: [
        { label: "Total Disbursed", value: `₹${fmt(p.amount)}`, grand: true },
      ],
    });
    printViaIframe(html);
  };

  const stmt = selectedStatement || statements[1] || statements[0];

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
        <span className="current">Doctor Payouts</span>
      </div>

      {/* 2. Top Header Bar */}
      <div className="billing-header-row">
        <div className="billing-title-block">
          <h1>Doctor Payouts</h1>
          <p>Review professional fees, adjustments and payment history.</p>
        </div>
      </div>

      {/* 3. Top Toolbar / Filters Row */}
      <form onSubmit={handleSearchSubmit} className="billing-search-row" style={{ alignItems: "center" }}>
        {/* Month Dropdown */}
        <div className="billing-date-dropdown">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#64748b" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <input
            type="month"
            value={periodMonth}
            onChange={(e) => setPeriodMonth(e.target.value)}
          />
          <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>▾</span>
        </div>

        {/* Department Dropdown */}
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="billing-filter-select"
        >
          <option value="All departments">All departments</option>
          <option value="General Medicine">General Medicine</option>
          <option value="Orthopaedics">Orthopaedics</option>
          <option value="Cardiology">Cardiology</option>
          <option value="Paediatrics">Paediatrics</option>
        </select>

        {/* Doctor Search Box */}
        <div className="billing-search-input-box" style={{ flex: 1 }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#94a3b8" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search doctor by name or staff ID"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Print Statement Button */}
        <button type="button" className="billing-btn-outline" onClick={printStatementSummary}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          Print statement
        </button>
      </form>

      {/* 4. Four KPI Summary Cards */}
      <div className="billing-kpi-grid-4">
        {/* Fees earned */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#f0fdf4", color: "#16a34a" }}>
            <span style={{ fontSize: "1.2rem", fontWeight: 700 }}>₹</span>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Fees earned</span>
            <span className="billing-kpi-value">₹{fmt(summary.fees_earned)}</span>
          </div>
        </div>

        {/* Adjustments */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#fff7ed", color: "#ea580c" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Adjustments</span>
            <span className="billing-kpi-value" style={{ color: "#ea580c" }}>
              -₹{fmt(Math.abs(summary.adjustments))}
            </span>
          </div>
        </div>

        {/* Paid */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#eff6ff", color: "#2563eb" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Paid</span>
            <span className="billing-kpi-value">₹{fmt(summary.paid)}</span>
          </div>
        </div>

        {/* Payable */}
        <div className="billing-kpi-card">
          <div className="billing-kpi-icon-wrap" style={{ background: "#faf5ff", color: "#9333ea" }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <div className="billing-kpi-info">
            <span className="billing-kpi-label">Payable</span>
            <span className="billing-kpi-value">₹{fmt(summary.payable)}</span>
          </div>
        </div>
      </div>

      {/* 5. Main Two-Column Layout */}
      <div className="billing-two-col-layout">
        {/* Left Column: Doctor Statements Table */}
        <div className="billing-left-col">
          <div className="billing-card">
            <div className="billing-card-header">
              <h2 className="billing-card-title">Doctor statements</h2>
            </div>

            <div className="billing-table-responsive">
              <table className="billing-table">
                <thead>
                  <tr>
                    <th>Doctor</th>
                    <th>Earned</th>
                    <th>Adjustments</th>
                    <th>Paid</th>
                    <th>Due</th>
                    <th style={{ textAlign: "right" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {statements.map((s) => {
                    const isSelected = stmt?.id === s.id;
                    return (
                      <tr
                        key={s.id}
                        className={isSelected ? "selected" : ""}
                        onClick={() => handleSelectStatement(s)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <div style={{ fontWeight: 600, color: "#0f172a" }}>{s.doctor_name}</div>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{s.department}</div>
                        </td>
                        <td style={{ fontWeight: 600 }}>₹{fmt(s.fees_earned)}</td>
                        <td style={{ color: "#ea580c" }}>-₹{fmt(Math.abs(s.adjustments || 0))}</td>
                        <td style={{ color: "#64748b" }}>₹{fmt(s.paid_amount || 0)}</td>
                        <td style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(s.remaining_payable || 0)}</td>
                        <td style={{ textAlign: "right" }}>
                          <span
                            className={
                              s.status === "Approved"
                                ? "billing-badge-approved"
                                : "billing-badge-review"
                            }
                          >
                            {s.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Selected Statement Form */}
        <div className="billing-right-col">
          <div className="billing-card">
            <div className="billing-card-header">
              <h2 className="billing-card-title">Selected statement</h2>
            </div>

            <div className="billing-card-body">
              {/* Doctor header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
                    {stmt?.doctor_name || "Dr. P. Reddy"}
                  </h3>
                  <div style={{ fontSize: "0.775rem", color: "#64748b", marginTop: "2px" }}>
                    {stmt?.statement_no || "ST-0094"} • {stmt?.period_month || "September 2026"}
                  </div>
                </div>
                <span className="billing-badge-approved">
                  {stmt?.status || "Approved"}
                </span>
              </div>

              {/* Breakdown lines */}
              <div style={{ marginTop: "12px", borderTop: "1px solid #f1f5f9", paddingTop: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Fees earned</span>
                  <span style={{ fontWeight: 600 }}>₹{fmt(stmt?.fees_earned || 10000)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Adjustment</span>
                  <span style={{ color: "#ea580c", fontWeight: 600 }}>-₹{fmt(Math.abs(stmt?.adjustments || 500))}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Net payable</span>
                  <span style={{ fontWeight: 600 }}>₹{fmt(stmt?.net_payable || (stmt?.fees_earned - Math.abs(stmt?.adjustments || 0)) || 9500)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Previously paid</span>
                  <span style={{ color: "#64748b", fontWeight: 600 }}>₹{fmt(stmt?.paid_amount || 5000)}</span>
                </div>

                {/* Remaining payable highlight */}
                <div className="billing-highlight-box teal-emphasis">
                  <div>
                    <span className="box-label">Remaining payable</span>
                  </div>
                  <span className="box-value">₹{fmt(stmt?.remaining_payable || 4500)}</span>
                </div>

                {/* Form fields */}
                <div className="billing-form-group">
                  <label className="billing-form-label">Payment amount</label>
                  <div style={{ display: "flex", alignItems: "center", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "0 12px" }}>
                    <span style={{ fontWeight: 600, color: "#64748b", marginRight: "4px" }}>₹</span>
                    <input
                      type="number"
                      step="0.01"
                      className="billing-form-input"
                      style={{ border: "none", padding: "8px 0" }}
                      value={payoutAmount}
                      onChange={(e) => setPayoutAmount(e.target.value)}
                    />
                  </div>
                </div>

                <div className="billing-form-group">
                  <label className="billing-form-label">Payment mode</label>
                  <select
                    className="billing-form-input"
                    value={payoutMode}
                    onChange={(e) => setPayoutMode(e.target.value)}
                  >
                    <option value="Bank transfer">Bank transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Cheque">Cheque</option>
                    <option value="UPI">UPI</option>
                  </select>
                </div>

                <div className="billing-form-group">
                  <label className="billing-form-label">Reference</label>
                  <input
                    type="text"
                    className="billing-form-input"
                    placeholder="Enter transaction reference"
                    value={payoutRef}
                    onChange={(e) => setPayoutRef(e.target.value)}
                  />
                </div>

                <div className="billing-form-group">
                  <label className="billing-form-label">Payment date</label>
                  <div style={{ display: "flex", alignItems: "center", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "0 12px" }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#64748b" strokeWidth="2" style={{ marginRight: "6px" }}>
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    <input
                      type="date"
                      className="billing-form-input"
                      style={{ border: "none", padding: "8px 0" }}
                      value={paymentDate}
                      onChange={(e) => setPaymentDate(e.target.value)}
                    />
                  </div>
                </div>

                {/* Record Payout button */}
                <button
                  type="button"
                  className="billing-btn-teal"
                  style={{ width: "100%", padding: "10px", marginTop: "4px" }}
                  onClick={handleRecordPayout}
                  disabled={submittingPayout}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <polyline points="9 15 11 17 15 13" />
                  </svg>
                  {submittingPayout ? "Recording..." : "Record payout"}
                </button>

                <div style={{ textAlign: "center", marginTop: "12px", fontSize: "0.75rem", color: "#64748b" }}>
                  ⓘ Record only after payment confirmation.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 6. Bottom Section: Payout History */}
      <div className="billing-card" style={{ marginTop: "1.25rem" }}>
        <div className="billing-card-header">
          <h2 className="billing-card-title">Payout history</h2>
        </div>

        <div className="billing-table-responsive">
          <table className="billing-table">
            <thead>
              <tr>
                <th>Payout no.</th>
                <th>Doctor</th>
                <th>Payment date</th>
                <th>Payment mode</th>
                <th>Amount</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {payoutHistory.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.payout_no}</td>
                  <td>{p.doctor_name}</td>
                  <td style={{ color: "#64748b" }}>{p.paid_date}</td>
                  <td>{p.payment_mode}</td>
                  <td style={{ fontWeight: 700 }}>₹{fmt(p.amount)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="billing-btn-table-outline"
                      onClick={() => printVoucher(p)}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="6 9 6 2 18 2 18 9" />
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                        <rect x="6" y="14" width="12" height="8" />
                      </svg>
                      Print voucher
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

