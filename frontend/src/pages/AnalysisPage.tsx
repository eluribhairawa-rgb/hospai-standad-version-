import { useMemo, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";
import { DonutChart, PieChart, BarChart, HorizontalBar } from "../components/charts";
import { printViaIframe } from "../lib/printViaIframe";
import type { Notice, HospitalSummary, DashboardAnalytics, DistributionItem } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
  hospitalSummary?: HospitalSummary | null;
  analytics?: DashboardAnalytics | null;
  analyticsLoading?: boolean;
};

type AnalysisTab = "operational" | "financial" | "clinical" | "departmental";

const ANALYSIS_TABS: Array<{ id: AnalysisTab; label: string; icon: string }> = [
  { id: "operational", label: "Operational Analysis", icon: "⚙️" },
  { id: "financial", label: "Financial & Revenue", icon: "💰" },
  { id: "clinical", label: "Clinical & Demographics", icon: "🩺" },
  { id: "departmental", label: "Departmental Performance", icon: "🏥" },
];

const PALETTE = ["#00828a", "#2563eb", "#10b981", "#f59e0b", "#dc2626", "#7c3aed", "#0ea5e9", "#64748b"];

/** Title-cases a raw backend label ("female", "unknown") for display. */
function titleCase(label: string): string {
  if (!label) return "Unknown";
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

function distributionToSlices(items: DistributionItem[] | undefined): { label: string; value: number; color: string }[] {
  return (items || [])
    .filter((d) => d.count > 0)
    .map((d, i) => ({ label: titleCase(d.label), value: d.count, color: PALETTE[i % PALETTE.length] }));
}

/** Formats a rupee amount the way this page's KPIs and reports expect (₹ prefix, Indian digit grouping). */
function formatINR(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

/** Percentage share of `part` within `whole`, rounded to the nearest whole number. */
function pctOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

type AnalysisReportData = {
  totalRevenue: number;
  opRevenue: number;
  pharmacyRevenue: number;
  labRevenue: number;
  bedOccupied: number;
  bedCapacity: number;
  bedOccupancyRate: number;
};

/** Builds the printable HTML for the "Export PDF Report" action (rendered via printViaIframe). */
function buildAnalysisReportHtml(data: AnalysisReportData): string {
  const { totalRevenue, opRevenue, pharmacyRevenue, labRevenue, bedOccupied, bedCapacity, bedOccupancyRate } = data;
  return `
    <div data-hospai-shared-print-shell style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1e293b; padding: 6px 12px; line-height: 1.35;">
      <style>
        @page { size: A4 portrait; margin: 8mm 10mm; }
        * { box-sizing: border-box; }
        .hdr { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #00828a; padding-bottom: 8px; margin-bottom: 12px; }
        .hdr h2 { margin: 0; color: #00828a; font-size: 19px; font-weight: 800; }
        .hdr .meta { color: #64748b; font-size: 11px; text-align: right; }
        .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
        .kpi-box { border: 1px solid #cbd5e1; padding: 7px 10px; border-radius: 6px; background: #f8fafc; }
        .kpi-box span { font-size: 10px; color: #64748b; display: block; font-weight: 600; text-transform: uppercase; }
        .kpi-box strong { font-size: 15px; color: #0f172a; display: block; margin-top: 2px; }
        h4 { margin: 8px 0 5px; font-size: 12px; color: #0f172a; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; font-size: 11px; }
        th { background: #f1f5f9; font-weight: 700; color: #334155; }
        footer { margin-top: 10px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; text-align: center; }
      </style>
      <div class="hdr">
        <div>
          <h2>HospAI</h2>
          <div style="font-size: 12px; font-weight: 600; color: #334155;">Comprehensive Performance Analysis</div>
        </div>
        <div class="meta">Generated: ${new Date().toLocaleString()}<br/>Period: Current month-to-date</div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-box"><span>Total Revenue</span><strong>${formatINR(totalRevenue)}</strong></div>
        <div class="kpi-box"><span>Bed Occupancy</span><strong>${bedOccupied}/${bedCapacity} (${bedOccupancyRate}%)</strong></div>
        <div class="kpi-box"><span>Pharmacy Sales</span><strong>${formatINR(pharmacyRevenue)}</strong></div>
        <div class="kpi-box"><span>Diagnostics</span><strong>${formatINR(labRevenue)}</strong></div>
      </div>

      <h4>1. Financial Breakdown</h4>
      <table>
        <thead><tr><th>Department</th><th>Revenue Contribution</th><th>Share %</th></tr></thead>
        <tbody>
          <tr><td>Outpatient & Consultations (OPD)</td><td>${formatINR(opRevenue)}</td><td>${pctOf(opRevenue, totalRevenue)}%</td></tr>
          <tr><td>Pharmacy Dispensing</td><td>${formatINR(pharmacyRevenue)}</td><td>${pctOf(pharmacyRevenue, totalRevenue)}%</td></tr>
          <tr><td>Laboratory & Imaging (Diagnostics)</td><td>${formatINR(labRevenue)}</td><td>${pctOf(labRevenue, totalRevenue)}%</td></tr>
          <tr><td><strong>Grand Total</strong></td><td><strong>${formatINR(totalRevenue)}</strong></td><td><strong>100%</strong></td></tr>
        </tbody>
      </table>

      <h4>2. Bed Occupancy & Utilization</h4>
      <table>
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Bed Occupancy Rate</td><td>${bedOccupancyRate}%</td></tr>
          <tr><td>Occupied Beds</td><td>${bedOccupied} of ${bedCapacity}</td></tr>
        </tbody>
      </table>

      <footer>HospAI Management Information System &middot; Confidential Performance Report</footer>
    </div>
  `;
}

const kpiCardStyle: CSSProperties = { background: "#ffffff", padding: "18px 20px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" };
const kpiLabelStyle: CSSProperties = { fontSize: "12px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" };
const kpiBadgeStyle = (bg: string, color: string): CSSProperties => ({ background: bg, color, fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "12px" });
const kpiValueStyle: CSSProperties = { fontSize: "24px", fontWeight: 800, color: "#0f172a", marginTop: "6px" };

type KpiTileProps = {
  label: string;
  badgeText: string;
  badgeBg: string;
  badgeColor: string;
  value: React.ReactNode;
  footnote: React.ReactNode;
  footnoteColor?: string;
};

/** One tile in the top KPI highlight strip (revenue, bed occupancy, pharmacy, lab). */
function KpiTile({ label, badgeText, badgeBg, badgeColor, value, footnote, footnoteColor = "#94a3b8" }: KpiTileProps) {
  return (
    <div style={kpiCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={kpiLabelStyle}>{label}</span>
        <span style={kpiBadgeStyle(badgeBg, badgeColor)}>{badgeText}</span>
      </div>
      <div style={kpiValueStyle}>{value}</div>
      <span style={{ fontSize: "12px", color: footnoteColor, fontWeight: footnoteColor === "#94a3b8" ? 400 : 600 }}>{footnote}</span>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: "12.5px", color: "#94a3b8", textAlign: "center", padding: "24px 0" }}>{children}</p>;
}

export default function AnalysisPage({ setNotice, onNavigate, hospitalSummary, analytics, analyticsLoading }: Props) {
  const [activeTab, setActiveTab] = useState<AnalysisTab>("operational");

  // All figures below are derived directly from the real hospital-summary /
  // dashboard-analytics payloads -- no invented benchmarks or illustrative
  // numbers. A panel is simply omitted (via EmptyNote) rather than filled
  // with a plausible-looking placeholder when the backing data is empty.
  const stats = useMemo(() => {
    const totalRevenue = hospitalSummary?.revenue?.monthly_total ?? 0;
    const pharmacyRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.pharmacy ?? 0;
    const labRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.lab_diagnostics ?? 0;
    const opRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.op_billing ?? Math.max(totalRevenue - pharmacyRevenue - labRevenue, 0);
    const bedCapacity = hospitalSummary?.bed_stats?.capacity ?? 0;
    const bedOccupied = hospitalSummary?.bed_stats?.occupied ?? 0;
    const bedOccupancyRate = hospitalSummary?.bed_stats?.occupancy_rate ?? (bedCapacity > 0 ? Math.round((bedOccupied / bedCapacity) * 100) : 0);
    const doctorPayoutReady = hospitalSummary?.revenue?.doctor_payout_ready ?? 0;
    const pharmacyTransactionsToday = hospitalSummary?.pharmacy_summary?.today_transactions ?? 0;
    return { totalRevenue, pharmacyRevenue, labRevenue, opRevenue, bedCapacity, bedOccupied, bedOccupancyRate, doctorPayoutReady, pharmacyTransactionsToday };
  }, [hospitalSummary]);

  const { totalRevenue, pharmacyRevenue, labRevenue, opRevenue, bedCapacity, bedOccupied, bedOccupancyRate, doctorPayoutReady, pharmacyTransactionsToday } = stats;

  const revenueSegments = useMemo(
    () => [
      { label: "Outpatient (OPD) Consultations", value: opRevenue, color: "#00828a" },
      { label: "Pharmacy Sales & Ward Indents", value: pharmacyRevenue, color: "#10b981" },
      { label: "Laboratory & Diagnostics", value: labRevenue, color: "#3b82f6" },
    ],
    [opRevenue, pharmacyRevenue, labRevenue]
  );

  const paymentModeSlices = useMemo(
    () => distributionToSlices(hospitalSummary?.revenue?.payment_mode_breakdown),
    [hospitalSummary]
  );

  const wardBreakdown = hospitalSummary?.bed_ward_breakdown || [];
  const genderSlices = useMemo(() => distributionToSlices(analytics?.gender_distribution), [analytics]);
  const admissionSlices = useMemo(() => distributionToSlices(analytics?.admission_status_distribution), [analytics]);
  const referralSlices = useMemo(() => distributionToSlices(hospitalSummary?.referrals), [hospitalSummary]);

  const patientsTrendBars = useMemo(
    () => (analytics?.patients_trend || []).map((p) => ({
      label: new Date(p.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
      value: p.count,
    })),
    [analytics]
  );

  const ipOpBars = useMemo(() => {
    const c = hospitalSummary?.ip_op_counts;
    if (!c) return [];
    return [
      { label: "OP (Today)", value: c.daily_op },
      { label: "IP (Today)", value: c.daily_ip },
      { label: "OP (Month)", value: c.monthly_op },
      { label: "IP (Month)", value: c.monthly_ip },
    ];
  }, [hospitalSummary]);

  const operationsToday = hospitalSummary?.operations_today;
  const operationsRows = useMemo(() => {
    if (!operationsToday) return [];
    const labels: Record<string, string> = {
      patient_registration: "Patient Registration",
      queue_management: "Queue Management",
      doctor_consultation: "Doctor Consultation",
      bed_management: "Bed Management",
      pharmacy: "Pharmacy",
      billing: "Billing",
      payment_collection: "Payment Collection",
      revenue_reporting: "Revenue Reporting",
      doctor_payout: "Doctor Payout",
    };
    return Object.entries(operationsToday)
      .filter(([, v]) => v && v.count > 0)
      .map(([key, v]) => ({ key, label: labels[key] || key, ...v! }));
  }, [operationsToday]);

  const printAnalysisReport = () => {
    const html = buildAnalysisReportHtml({ totalRevenue, opRevenue, pharmacyRevenue, labRevenue, bedOccupied, bedCapacity, bedOccupancyRate });
    printViaIframe(html, "Analysis_Report");
  };

  return (
    <div style={{ padding: "20px 32px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#64748b", fontWeight: 500, marginBottom: "4px" }}>
            <span>Hospital</span>
            <span>/</span>
            <span style={{ color: "#00828a", fontWeight: 700 }}>Analysis & Intelligence</span>
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", margin: 0 }}>Executive & Departmental Analysis</h1>
          <p style={{ fontSize: "13.5px", color: "#64748b", margin: "4px 0 0" }}>
            Real operational, financial, and clinical metrics, sourced live from the hospital database.
          </p>
        </div>

        <Button
          type="button"
          variant="primary"
          onClick={printAnalysisReport}
          style={{ background: "#00828a", borderColor: "#00828a", display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>🖨</span> Export PDF Report
        </Button>
      </div>

      {analyticsLoading && (
        <p style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "10px" }}>Refreshing analytics…</p>
      )}

      {/* KPI Highlight Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <KpiTile
          label="Gross Revenue (Monthly)"
          badgeText="This Month"
          badgeBg="#ccfbf1"
          badgeColor="#0f766e"
          value={formatINR(totalRevenue)}
          footnote="Includes OPD, Pharmacy & Diagnostics"
        />
        <KpiTile
          label="Bed Occupancy"
          badgeText={`${bedOccupancyRate}%`}
          badgeBg="#eff6ff"
          badgeColor="#1d4ed8"
          value={<>{bedOccupied} / {bedCapacity} <span style={{ fontSize: "14px", fontWeight: 500, color: "#64748b" }}>Beds</span></>}
          footnote={`${Math.max(bedCapacity - bedOccupied, 0)} Available across wards`}
          footnoteColor="#16a34a"
        />
        <KpiTile
          label="Pharmacy Sales (Monthly)"
          badgeText="Live"
          badgeBg="#fef3c7"
          badgeColor="#b45309"
          value={formatINR(pharmacyRevenue)}
          footnote={`${pharmacyTransactionsToday} transactions today`}
        />
        <KpiTile
          label="Lab & Diagnostics (Monthly)"
          badgeText="Live"
          badgeBg="#f3e8ff"
          badgeColor="#7e22ce"
          value={formatINR(labRevenue)}
          footnote="Diagnostics module revenue"
        />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "2px solid #e2e8f0", marginBottom: "20px" }}>
        {ANALYSIS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: "10px 20px",
              fontSize: "13.5px",
              fontWeight: 700,
              background: "transparent",
              border: "none",
              borderBottom: activeTab === t.id ? "3px solid #00828a" : "3px solid transparent",
              color: activeTab === t.id ? "#00828a" : "#64748b",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "-2px",
            }}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab 1: Operational */}
      {activeTab === "operational" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <Card className="panel">
            <CardHeader><CardTitle>Patient Registrations — Last {analytics?.window_days ?? 14} Days</CardTitle></CardHeader>
            <CardContent>
              {patientsTrendBars.some((b) => b.value > 0) ? (
                <BarChart data={patientsTrendBars} barColor="#00828a" />
              ) : (
                <EmptyNote>No patient registrations recorded in this window yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Ward Occupancy</CardTitle></CardHeader>
            <CardContent>
              {wardBreakdown.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(wardBreakdown.length, 3)}, 1fr)`, gap: "28px 16px", paddingBottom: "14px" }}>
                  {wardBreakdown.map((w) => {
                    const rate = w.occupied / Math.max(w.capacity, 1);
                    const occupiedColor = rate > 0.8 ? "#dc2626" : rate > 0.5 ? "#f59e0b" : "#2563eb";
                    return (
                      <div key={w.ward} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                        <PieChart
                          data={[
                            { label: "Occupied", value: w.occupied, color: occupiedColor },
                            { label: "Free", value: w.available, color: "#e2e8f0" },
                          ]}
                          size={116}
                        />
                        <div style={{ textAlign: "center" }}>
                          <strong style={{ display: "block", fontSize: "13px", color: "#0f172a" }}>{w.ward}</strong>
                          <span style={{ fontSize: "11.5px", color: "#64748b" }}>{w.occupied}/{w.capacity} occupied · {w.available} free</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyNote>No ward/bed configuration found.</EmptyNote>
              )}
            </CardContent>
          </Card>

          {ipOpBars.length > 0 && (
            <Card className="panel" style={{ gridColumn: "1 / -1" }}>
              <CardHeader><CardTitle>OP vs IP Volume</CardTitle></CardHeader>
              <CardContent>
                <BarChart data={ipOpBars} barColor="#2563eb" />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Tab 2: Financial */}
      {activeTab === "financial" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <Card className="panel">
            <CardHeader><CardTitle>Department Revenue Distribution (This Month)</CardTitle></CardHeader>
            <CardContent>
              {totalRevenue > 0 ? (
                <DonutChart data={revenueSegments} centerLabel="Total" centerValue={formatINR(totalRevenue)} />
              ) : (
                <EmptyNote>No revenue recorded this month yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Payment Mode Collections (Today)</CardTitle></CardHeader>
            <CardContent>
              {paymentModeSlices.length > 0 ? (
                <DonutChart data={paymentModeSlices} />
              ) : (
                <EmptyNote>No payments collected today yet.</EmptyNote>
              )}

              <div style={{ marginTop: "16px", padding: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Doctor Payout Ready:</span>
                  <strong style={{ display: "block", fontSize: "14px", color: "#0f172a" }}>{formatINR(doctorPayoutReady)}</strong>
                </div>
                {onNavigate && (
                  <Button size="sm" variant="secondary" onClick={() => onNavigate("accounts-doctor-payouts")}>
                    Manage Doctor Payouts →
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tab 3: Clinical */}
      {activeTab === "clinical" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "20px" }}>
          <Card className="panel">
            <CardHeader><CardTitle>Patient Gender Distribution</CardTitle></CardHeader>
            <CardContent>
              {genderSlices.length > 0 ? (
                <DonutChart data={genderSlices} formatValue={(v) => String(v)} size={140} />
              ) : (
                <EmptyNote>No patient records yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Admission Status</CardTitle></CardHeader>
            <CardContent>
              {admissionSlices.length > 0 ? (
                <DonutChart data={admissionSlices} formatValue={(v) => String(v)} size={140} />
              ) : (
                <EmptyNote>No admissions recorded yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Referral Sources</CardTitle></CardHeader>
            <CardContent>
              {referralSlices.length > 0 ? (
                <DonutChart data={referralSlices} formatValue={(v) => String(v)} size={140} />
              ) : (
                <EmptyNote>No referral data recorded yet.</EmptyNote>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tab 4: Departmental */}
      {activeTab === "departmental" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <Card className="panel">
            <CardHeader><CardTitle>Revenue Share by Department (This Month)</CardTitle></CardHeader>
            <CardContent>
              {totalRevenue > 0 ? (
                <DonutChart data={revenueSegments} />
              ) : (
                <EmptyNote>No revenue recorded this month yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Today's Operations Completion</CardTitle></CardHeader>
            <CardContent>
              {operationsRows.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {operationsRows.map((r) => (
                    <HorizontalBar
                      key={r.key}
                      label={r.label}
                      value={r.completed}
                      max={r.count}
                      color={r.completed === r.count ? "#16a34a" : "#f59e0b"}
                      valueLabel={`${r.completed}/${r.count} completed`}
                    />
                  ))}
                </div>
              ) : (
                <EmptyNote>No operational activity recorded today yet.</EmptyNote>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
