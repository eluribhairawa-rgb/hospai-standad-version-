import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import { Button, Modal } from "../components/ui";
import { DonutChart } from "../components/charts";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type Overview = {
  today_orders: number;
  pending_collection: number;
  in_processing: number;
  pending_validation: number;
  ready_for_release: number;
  stat_cases: number;
  critical_alerts_open: number;
  today_revenue: number;
  today_billed?: number;
  today_collected?: number;
  today_due?: number;
  overdue_count: number;
};

type CriticalAlert = {
  id: number;
  order_item_id: number;
  service_name: string;
  patient_id: string;
  order_no: string;
  patient_first_name?: string;
  patient_last_name?: string;
  raised_at: string;
  contacted_person?: string;
};

type PopupData = {
  title: string;
  subtitle: string;
  total: number;
  secondaryLabel: string;
  secondaryValue: string | number;
  countLabel: string;
  countValue: number | string;
  rows: { name: string; details: string; amount?: number; status?: string }[];
  targetPage?: string;
  actionButtonLabel?: string;
};

function formatCurrency(amount?: number) {
  return `₹${Math.round(amount || 0).toLocaleString("en-IN")}`;
}

function patientName(first?: string, last?: string, fallback?: string) {
  return [first, last].filter(Boolean).join(" ") || fallback || "-";
}

function KpiTile({
  icon,
  label,
  value,
  sub,
  iconBg,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  iconBg: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="hosp-kpi-card hosp-clickable-card"
      style={{ "--kpi-accent": iconBg } as React.CSSProperties}
      onClick={onClick}
      title="Click to view detailed drilldown"
    >
      <div className="hosp-kpi-icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="hosp-kpi-body">
        <p className="hosp-kpi-label">{label}</p>
        <h3 className="hosp-kpi-value">{value}</h3>
        {sub && <span className="hosp-kpi-sub">{sub}</span>}
      </div>
    </button>
  );
}

const ICONS = {
  orders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12h6m-6 4h6M9 8h1" />
      <rect x="4" y="3" width="16" height="18" rx="2" />
    </svg>
  ),
  collection: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v6m0 0-3-3m3 3 3-3" />
      <rect x="5" y="10" width="14" height="11" rx="2" />
    </svg>
  ),
  processing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 2v10l7 4" />
    </svg>
  ),
  validation: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  release: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </svg>
  ),
  stat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  revenue: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  overdue: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4l3 3" />
    </svg>
  ),
};

export default function LabDiagnosticsOverviewPage({ setNotice, onNavigate }: Props) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<CriticalAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [popupData, setPopupData] = useState<PopupData | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [ov, al] = await Promise.all([
        apiFetch<Overview>("/api/diag/overview"),
        apiFetch<{ alerts: CriticalAlert[] }>("/api/diag/critical-alerts?open_only=true"),
      ]);
      setOverview(ov);
      setAlerts(al.alerts || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load the Lab & Diagnostics overview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const go = (pageId: string) => {
    if (onNavigate) onNavigate(pageId);
  };

  // Drilldown popup handlers matching DashboardPage
  const openRevenueDrilldown = () => {
    const rev = overview?.today_revenue || 0;
    const billed = overview?.today_billed ?? rev;
    const collected = overview?.today_collected ?? 0;
    const due = overview?.today_due ?? 0;
    setPopupData({
      title: "Today's Diagnostic Revenue Breakdown",
      subtitle: "Consolidated billing from Pathology, Radiology, and Clinical Diagnostics",
      total: rev,
      secondaryLabel: "COLLECTED / PAID",
      secondaryValue: formatCurrency(collected),
      countLabel: "PENDING / DUE",
      countValue: formatCurrency(due),
      targetPage: "diag-orders-billing",
      actionButtonLabel: "View Orders & Billing",
      rows: [
        { name: "Total Billed Diagnostic Orders", details: `${overview?.today_orders || 0} orders placed today`, amount: billed },
        { name: "Payments Received Today", details: "Settled via Cash, UPI, Card", amount: collected },
        { name: "Pending Invoice Balance", details: "Outstanding balances for today", amount: due },
      ],
    });
  };

  const openOrdersDrilldown = () => {
    setPopupData({
      title: "Today's Diagnostic Orders & Worklist Pipeline",
      subtitle: "Current pipeline stage of all orders placed today",
      total: overview?.today_orders || 0,
      secondaryLabel: "READY FOR RELEASE",
      secondaryValue: `${overview?.ready_for_release || 0} Reports`,
      countLabel: "STAT URGENT",
      countValue: `${overview?.stat_cases || 0} Cases`,
      targetPage: "diag-orders-billing",
      actionButtonLabel: "Manage Orders",
      rows: [
        { name: "Phlebotomy / Sample Collection", details: `${overview?.pending_collection || 0} samples pending collection`, status: "Awaiting Draw" },
        { name: "In Analyzer Processing", details: `${overview?.in_processing || 0} test batches running on auto-analyzers`, status: "Running" },
        { name: "Pathologist Validation", details: `${overview?.pending_validation || 0} results awaiting doctor verification`, status: "Pending Sign-off" },
        { name: "Approved & Ready for Dispatch", details: `${overview?.ready_for_release || 0} reports validated and printable`, status: "Completed" },
      ],
    });
  };

  const openStatDrilldown = () => {
    setPopupData({
      title: "Emergency STAT Diagnostic Cases",
      subtitle: "High priority turnaround tests for ICU, Emergency, and OT",
      total: overview?.stat_cases || 0,
      secondaryLabel: "CRITICAL ALERTS",
      secondaryValue: `${overview?.critical_alerts_open || 0} Open`,
      countLabel: "TAT BENCHMARK",
      countValue: "< 45 Mins",
      targetPage: "diag-laboratory",
      actionButtonLabel: "Open Lab Worklist",
      rows: [
        { name: "Cardiac Biomarkers (Troponin I / CK-MB)", details: "Emergency room priority testing", status: "🔴 STAT" },
        { name: "Arterial Blood Gas (ABG) & Lactate", details: "Critical care ICU telemetry priority", status: "🔴 STAT" },
        { name: "Cross-Match & Blood Bank STAT", details: "OT surgical emergency reserve", status: "🔴 STAT" },
      ],
    });
  };

  return (
    <div className="hosp-dashboard" style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* 1. TOP HEADER & BREADCRUMB - Matching DashboardPage */}
      <div className="hosp-dashboard-top" style={{ marginBottom: "18px" }}>
        <div>
          <div className="hosp-dashboard-eyebrow">
            <span>HospAI</span>
            <span>/</span>
            <span>Lab & Diagnostics</span>
            <span>/</span>
            <span style={{ color: "#0f172a", fontWeight: 700 }}>Overview</span>
          </div>
          <h1 className="hosp-dashboard-page-title" style={{ fontSize: "28px", fontWeight: 800, margin: "2px 0 4px", color: "#0f172a" }}>
            Lab & Diagnostics Overview
          </h1>
          <p className="hosp-dashboard-page-subtitle" style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
            Real-time laboratory testing status, TAT turnaround monitoring, and diagnostic revenue.
          </p>
        </div>

        <div className="hosp-dashboard-top-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Button
            variant="ghost"
            onClick={() => void load()}
            style={{ display: "flex", alignItems: "center", gap: "6px", background: "#ffffff", border: "1px solid #cbd5e1" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>Refresh</span>
          </Button>

          <Button
            variant="secondary"
            onClick={() => go("diag-laboratory")}
            style={{ background: "#ffffff", border: "1.5px solid #00828a", color: "#00828a", fontWeight: 700 }}
          >
            Laboratory Worklist
          </Button>

          <Button
            variant="primary"
            onClick={() => go("diag-orders-billing")}
            style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
          >
            + New Diagnostic Order
          </Button>
        </div>
      </div>

      {/* 2. EXECUTIVE KPI SECTION (8 CARDS) - Matching DashboardPage */}
      {loading && !overview && (
        <div style={{ textAlign: "center", padding: "40px", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", marginBottom: "20px" }}>
          <p style={{ color: "#64748b", fontSize: "14px" }}>Loading real-time diagnostic metrics...</p>
        </div>
      )}

      {overview && (
        <div className="hosp-kpi-row" style={{ marginBottom: "20px" }}>
          <KpiTile
            icon={ICONS.orders}
            label="Today's Orders"
            value={overview.today_orders}
            iconBg="linear-gradient(135deg,#6366f1,#8b5cf6)"
            onClick={openOrdersDrilldown}
          />
          <KpiTile
            icon={ICONS.revenue}
            label="Today's Revenue"
            value={formatCurrency(overview.today_revenue)}
            sub={overview.today_collected ? `Collected: ${formatCurrency(overview.today_collected)}` : "Today's billed orders"}
            iconBg="linear-gradient(135deg,#a855f7,#7e22ce)"
            onClick={openRevenueDrilldown}
          />
          <KpiTile
            icon={ICONS.collection}
            label="Pending Collection"
            value={overview.pending_collection}
            iconBg="linear-gradient(135deg,#0ea5e9,#0284c7)"
            onClick={() => go("diag-laboratory")}
          />
          <KpiTile
            icon={ICONS.processing}
            label="In Processing"
            value={overview.in_processing}
            iconBg="linear-gradient(135deg,#14b8a6,#0d9488)"
            onClick={() => go("diag-laboratory")}
          />
          <KpiTile
            icon={ICONS.release}
            label="Ready for Release"
            value={overview.ready_for_release}
            iconBg="linear-gradient(135deg,#22c55e,#16a34a)"
            onClick={() => go("diag-reports-approval")}
          />
          <KpiTile
            icon={ICONS.stat}
            label="STAT & Critical"
            value={overview.stat_cases}
            sub={overview.overdue_count > 0 ? `${overview.overdue_count} Overdue TAT` : "High Acuity Priority"}
            iconBg="linear-gradient(135deg,#ef4444,#dc2626)"
            onClick={openStatDrilldown}
          />
        </div>
      )}

      {/* 2b. PIPELINE & PRIORITY CHARTS -- real order-status counts, no invented percentages.
          Pending/processing/validation/release counts reflect the current open
          worklist (not just orders placed today), so they're charted and gated
          independently of today_orders. */}
      {overview && (() => {
        const pipelineTotal = overview.pending_collection + overview.in_processing + overview.pending_validation + overview.ready_for_release;
        const statTotal = overview.today_orders;
        if (pipelineTotal <= 0 && statTotal <= 0) return null;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "14px", marginBottom: "20px" }}>
            {pipelineTotal > 0 && (
              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "18px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
                <h2 style={{ fontSize: "14.5px", fontWeight: 700, color: "#0f172a", margin: "0 0 2px" }}>Current Order Pipeline</h2>
                <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 14px" }}>Where the {pipelineTotal} open orders currently sit</p>
                <DonutChart
                  data={[
                    { label: "Pending Collection", value: overview.pending_collection, color: "#0ea5e9" },
                    { label: "In Processing", value: overview.in_processing, color: "#14b8a6" },
                    { label: "Pending Validation", value: overview.pending_validation, color: "#f59e0b" },
                    { label: "Ready for Release", value: overview.ready_for_release, color: "#16a34a" },
                  ]}
                  formatValue={(v) => String(v)}
                  centerLabel="Open Orders"
                  centerValue={String(pipelineTotal)}
                />
              </div>
            )}

            {statTotal > 0 && (
              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "18px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
                <h2 style={{ fontSize: "14.5px", fontWeight: 700, color: "#0f172a", margin: "0 0 2px" }}>STAT vs Routine</h2>
                <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 14px" }}>Priority split of today's caseload</p>
                <DonutChart
                  data={[
                    { label: "STAT / Critical", value: overview.stat_cases, color: "#dc2626" },
                    { label: "Routine", value: Math.max(overview.today_orders - overview.stat_cases, 0), color: "#94a3b8" },
                  ]}
                  formatValue={(v) => String(v)}
                  size={140}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* 3. CRITICAL ALERTS & FAST-ACTION BOARD */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "14px",
          padding: "20px 24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ef4444", boxShadow: "0 0 0 3px #fee2e2" }} />
              <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
                Open Critical Diagnostic Alerts {overview ? `(${overview.critical_alerts_open})` : ""}
              </h2>
            </div>
            <p style={{ fontSize: "12.5px", color: "#64748b", margin: "2px 0 0 18px" }}>
              Panic test results requiring immediate verbal communication with the consulting physician.
            </p>
          </div>

          <Button variant="ghost" onClick={() => go("diag-reports-approval")} style={{ color: "#00828a", fontSize: "13px" }}>
            View Full Reports Desk →
          </Button>
        </div>

        {alerts.length === 0 && !loading && (
          <div style={{ padding: "30px", textAlign: "center", background: "#f8fafc", borderRadius: "10px", border: "1px dashed #cbd5e1" }}>
            <span style={{ fontSize: "20px" }}>✓</span>
            <div style={{ fontWeight: 700, color: "#166534", marginTop: "4px" }}>No Pending Critical Alerts</div>
            <div style={{ fontSize: "12px", color: "#64748b" }}>All panic values have been verified and communicated to attending physicians.</div>
          </div>
        )}

        <div style={{ display: "grid", gap: "10px" }}>
          {alerts.map((a) => (
            <div
              key={a.id}
              onClick={() => go("diag-reports-approval")}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                background: "#fef2f2",
                border: "1.5px solid #fca5a5",
                borderRadius: "10px",
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: 800, color: "#0f172a", fontSize: "14px" }}>
                    {patientName(a.patient_first_name, a.patient_last_name, a.patient_id)}
                  </span>
                  <span
                    style={{
                      background: "#fee2e2",
                      color: "#b91c1c",
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "12px",
                      textTransform: "uppercase",
                    }}
                  >
                    🔴 CRITICAL VALUE
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "#7f1d1d", marginTop: "3px" }}>
                  <strong>{a.service_name}</strong> · Order #{a.order_no} · Patient UHID: {a.patient_id}
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: a.contacted_person ? "#15803d" : "#b91c1c" }}>
                  {a.contacted_person ? `Contacted: ${a.contacted_person}` : "⚠️ NOT NOTIFIED YET"}
                </div>
                <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                  Reported: {new Date(a.raised_at).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. EXECUTIVE REVENUE & KPI DRILLDOWN MODAL (.hosp-revenue-pop-modal) */}
      {/* Matches DashboardPage popup modal design, typography, and styling exactly */}
      {/* ========================================================================= */}
      {popupData && (
        <Modal
          open={!!popupData}
          onClose={() => setPopupData(null)}
          title={popupData.title}
          description={popupData.subtitle}
          className="hosp-revenue-pop-modal"
        >
          <div className="hosp-revenue-pop-summary">
            <div>
              <span>TOTAL VALUE</span>
              <strong>{typeof popupData.total === "number" && popupData.total > 100 ? formatCurrency(popupData.total) : popupData.total}</strong>
            </div>
            <div>
              <span>{popupData.secondaryLabel}</span>
              <strong>{popupData.secondaryValue}</strong>
            </div>
            <div>
              <span>{popupData.countLabel}</span>
              <strong>{popupData.countValue}</strong>
            </div>
          </div>

          <div className="hosp-revenue-pop-table">
            <div className="hosp-revenue-pop-head">
              <span>Department / Modality</span>
              <span>{popupData.rows[0]?.amount !== undefined ? "Amount" : "Status"}</span>
            </div>
            {popupData.rows.map((row, idx) => (
              <div key={idx} className="hosp-revenue-pop-row">
                <div>
                  <strong>{row.name}</strong>
                  <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>{row.details}</p>
                </div>
                {row.amount !== undefined ? (
                  <strong style={{ color: "#0f172a" }}>{formatCurrency(row.amount)}</strong>
                ) : (
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#00828a" }}>{row.status}</span>
                )}
              </div>
            ))}
          </div>

          <div className="hosp-revenue-pop-actions">
            <Button variant="ghost" onClick={() => setPopupData(null)}>
              Close
            </Button>
            {popupData.targetPage && (
              <Button
                variant="primary"
                style={{ background: "#00828a", borderColor: "#00828a" }}
                onClick={() => {
                  const p = popupData.targetPage!;
                  setPopupData(null);
                  go(p);
                }}
              >
                {popupData.actionButtonLabel || "Open Module"}
              </Button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
