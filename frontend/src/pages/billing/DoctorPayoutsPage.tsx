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

  const [summary, setSummary] = useState({ fees_earned: 0, adjustments: 0, paid: 0, payable: 0 });
  const [statements, setStatements] = useState<any[]>([]);
  const [payoutHistory, setPayoutHistory] = useState<any[]>([]);
  // Every department in the department list, plus those doctors are scheduled under (from the server).
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);

  // Selected statement for right panel
  const [selectedStatement, setSelectedStatement] = useState<any>(null);
  const [payoutAmount, setPayoutAmount] = useState<string>("");
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
      const list: any[] = res?.statements || [];
      setDepartmentOptions(res?.departments || []);
      setSummary(res?.summary || { fees_earned: 0, adjustments: 0, paid: 0, payable: 0 });
      setStatements(list);
      setPayoutHistory(res?.payout_history || []);
      // Keep the same doctor selected across refreshes; otherwise the first doctor who is owed money.
      setSelectedStatement((current: any) =>
        (current && list.find((x) => x.doctor_name === current.doctor_name)) ||
        list.find((x) => x.id && Number(x.remaining_payable) > 0) ||
        list[0] ||
        null
      );
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

  // The payout form always starts from what is still owed on the selected statement.
  useEffect(() => {
    const due = Number(selectedStatement?.remaining_payable || 0);
    setPayoutAmount(due > 0 ? String(due) : "");
  }, [selectedStatement?.id, selectedStatement?.remaining_payable]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadDoctorStatements();
  };

  const handleSelectStatement = (stmt: any) => {
    setSelectedStatement(stmt);
  };

  const handleRecordPayout = async () => {
    if (!selectedStatement?.id) {
      setNotice({ type: "warning", message: "This doctor has no fees for the month yet, so there is nothing to pay." });
      return;
    }
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
          payment_date: paymentDate,
          notes: `Payout disburse for ${selectedStatement.doctor_name}`,
        }),
      });

      setNotice({
        type: "success",
        message: `Payout voucher ${res.payout_no || "recorded"} for ₹${fmt(amt)} created.`,
      });
      setPayoutRef("");
      loadDoctorStatements();
    } catch (err: any) {
      reportError(setNotice, err, "Failed to record doctor payout.");
    } finally {
      setSubmittingPayout(false);
    }
  };

  const monthLabel = (ym: string) => {
    const d = new Date(`${ym}-01T00:00:00`);
    return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  };
  const periodLabel = monthLabel(periodMonth);
  const STATUS_LABEL: Record<string, string> = {
    ready_for_review: "Ready for review",
    approved: "Approved",
    draft: "Draft",
    no_fees: "No fees yet",
  };
  const statusLabel = (st?: string) => STATUS_LABEL[st || ""] || st || "";
  const statusClass = (st?: string) => (st === "approved" ? "billing-badge-approved" : "billing-badge-review");
  const fmtDate = (d?: string) => {
    if (!d) return "-";
    const x = new Date(`${String(d).slice(0, 10)}T00:00:00`);
    return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  };

  const printStatementSummary = () => {
    const html = buildPrintDocumentHtml({
      title: `Doctor Payout Statement Summary`,
      subtitleLines: [
        `HospAI · Medical Finance Department`,
        `Period: ${periodLabel} · Generated: ${new Date().toLocaleDateString("en-IN")}`,
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
        statusLabel(s.status),
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
        `Payment Date: ${fmtDate(p.paid_date)} · Mode: ${p.payment_mode}`,
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

  const stmt = selectedStatement;

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
          {departmentOptions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
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
                  {statements.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", padding: "1.5rem", color: "#64748b" }}>
                        {loading ? "Loading doctors…" : "No doctors found for this selection. Doctors appear here once they are added in Doctor Scheduling."}
                      </td>
                    </tr>
                  )}
                  {statements.map((s) => {
                    const isSelected = stmt?.doctor_name === s.doctor_name;
                    return (
                      <tr
                        key={s.doctor_name}
                        className={isSelected ? "selected" : ""}
                        onClick={() => handleSelectStatement(s)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <div style={{ fontWeight: 600, color: "#0f172a" }}>{s.doctor_name}</div>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                            {s.department || "No department"} · {s.consultations || 0} consultation{(s.consultations || 0) === 1 ? "" : "s"}
                          </div>
                        </td>
                        <td style={{ fontWeight: 600 }}>₹{fmt(s.fees_earned)}</td>
                        <td style={{ color: "#ea580c" }}>-₹{fmt(Math.abs(s.adjustments || 0))}</td>
                        <td style={{ color: "#64748b" }}>₹{fmt(s.paid_amount || 0)}</td>
                        <td style={{ fontWeight: 700, color: "#0f172a" }}>₹{fmt(s.remaining_payable || 0)}</td>
                        <td style={{ textAlign: "right" }}>
                          <span className={statusClass(s.status)}>{statusLabel(s.status)}</span>
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
              {!stmt && (
                <div style={{ padding: "1rem 0", color: "#64748b", fontSize: "0.875rem" }}>
                  Select a doctor to see their statement.
                </div>
              )}
              {stmt && (<>
              {/* Doctor header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>{stmt.doctor_name}</h3>
                  <div style={{ fontSize: "0.775rem", color: "#64748b", marginTop: "2px" }}>
                    {stmt.department || "No department"} • {stmt.statement_no || "No statement yet"} • {monthLabel(stmt.period_month || periodMonth)}
                  </div>
                </div>
                <span className={statusClass(stmt.status)}>{statusLabel(stmt.status)}</span>
              </div>

              {/* Breakdown lines */}
              <div style={{ marginTop: "12px", borderTop: "1px solid #f1f5f9", paddingTop: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Fees earned ({stmt.consultations || 0} consultation{(stmt.consultations || 0) === 1 ? "" : "s"})</span>
                  <span style={{ fontWeight: 600 }}>₹{fmt(stmt.fees_earned)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Adjustment</span>
                  <span style={{ color: "#ea580c", fontWeight: 600 }}>-₹{fmt(Math.abs(stmt.adjustments || 0))}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Net payable</span>
                  <span style={{ fontWeight: 600 }}>₹{fmt(stmt.net_payable)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px", fontSize: "0.875rem" }}>
                  <span style={{ color: "#64748b" }}>Previously paid</span>
                  <span style={{ color: "#64748b", fontWeight: 600 }}>₹{fmt(stmt.paid_amount)}</span>
                </div>

                {/* Remaining payable highlight */}
                <div className="billing-highlight-box teal-emphasis">
                  <div>
                    <span className="box-label">Remaining payable</span>
                  </div>
                  <span className="box-value">₹{fmt(stmt.remaining_payable)}</span>
                </div>

                {Number(stmt.remaining_payable || 0) <= 0 && (
                  <div style={{ margin: "10px 0", padding: "8px 10px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0", color: "#475569", fontSize: "0.8rem" }}>
                    {stmt.id
                      ? "Nothing is payable on this statement. It is paid in full."
                      : `No fees earned by ${stmt.doctor_name} in ${monthLabel(periodMonth)} yet. Fees come from completed consultations.`}
                  </div>
                )}

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
                  disabled={submittingPayout || !stmt?.id || Number(stmt?.remaining_payable || 0) <= 0}
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
              </>)}
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
              {payoutHistory.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "1.25rem", color: "#64748b" }}>
                    No payouts recorded for {periodLabel}{department !== "All departments" ? ` in ${department}` : ""}.
                  </td>
                </tr>
              )}
              {payoutHistory.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.payout_no}</td>
                  <td>{p.doctor_name}</td>
                  <td style={{ color: "#64748b" }}>{fmtDate(p.paid_date)}</td>
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

