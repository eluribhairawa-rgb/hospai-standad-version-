import { useMemo, useState } from "react";
import { brandTitle, escapeBrandText } from "../lib/branding";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Modal } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { DonutChart, PieChart, BarChart, HorizontalBar } from "../components/charts";
import DateCalendarPicker, { toIsoDate, parseIsoDate } from "../components/DateCalendarPicker";
import { printViaIframe } from "../lib/printViaIframe";
import type { Notice, HospitalSummary, DashboardAnalytics, DistributionItem } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
  hospitalSummary?: HospitalSummary | null;
  analytics?: DashboardAnalytics | null;
  analyticsLoading?: boolean;
  dashboardDate?: string;
  setDashboardDate?: (date: string) => void;
};

type AnalysisTab = "operational" | "financial" | "clinical";

const ANALYSIS_TABS: Array<{ id: AnalysisTab; label: string; icon: string }> = [
  { id: "operational", label: "Operational Analysis", icon: "⚙️" },
  { id: "financial", label: "Financial & Revenue", icon: "💰" },
  { id: "clinical", label: "Clinical & Demographics", icon: "🩺" },
];

const PALETTE = ["#00828a", "#2563eb", "#10b981", "#f59e0b", "#dc2626", "#7c3aed", "#0ea5e9", "#64748b"];

/** Title-cases a raw backend label ("female", "unknown") for display. */
function titleCase(label: string): string {
  if (!label) return "Unknown";
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

type KeyedSlice = { key: string; label: string; value: number; color: string };

/** Slices for a distribution; `key` is the raw backend label (used to open the records behind a slice).
 *  `exclude` drops labels that carry no information (e.g. "unknown" referral source). */
function distributionToSlices(items: DistributionItem[] | undefined, exclude: string[] = []): KeyedSlice[] {
  return (items || [])
    .filter((d) => d.count > 0 && !exclude.includes(String(d.label || "").trim().toLowerCase()))
    .map((d, i) => ({ key: d.label, label: titleCase(d.label), value: d.count, color: PALETTE[i % PALETTE.length] }));
}

type DrillState = {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: (string | number)[][];
  total?: string;
  note?: string;
  loading?: boolean;
  /** Set when this view was opened from another one (e.g. a revenue row from the revenue breakdown). */
  back?: () => void;
  /** Row click handler (used by the revenue breakdown to open a row's records). */
  onRow?: (rowIndex: number) => void;
};

const MONEY_COLUMN = /^(amount|total|paid|due|rate)/i;

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
  ipRevenue: number;
  pharmacyRevenue: number;
  labRevenue: number;
  bedOccupied: number;
  bedCapacity: number;
  bedOccupancyRate: number;
  periodLabel: string;
};

/** Builds the printable HTML for the "Export PDF Report" action (rendered via printViaIframe). */
function buildAnalysisReportHtml(data: AnalysisReportData): string {
  const { totalRevenue, opRevenue, ipRevenue, pharmacyRevenue, labRevenue, bedOccupied, bedCapacity, bedOccupancyRate, periodLabel } = data;
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
          <h2>${escapeBrandText(brandTitle())}</h2>
          <div style="font-size: 12px; font-weight: 600; color: #334155;">Comprehensive Performance Analysis</div>
        </div>
        <div class="meta">Generated: ${new Date().toLocaleString()}<br/>Period: ${periodLabel}</div>
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
          ${ipRevenue > 0 ? `<tr><td>Inpatient (IPD) Admissions</td><td>${formatINR(ipRevenue)}</td><td>${pctOf(ipRevenue, totalRevenue)}%</td></tr>` : ""}
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

      <footer>${escapeBrandText(brandTitle())} Management Information System &middot; Confidential Performance Report</footer>
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
  onClick?: () => void;
};

/** One tile in the top KPI highlight strip (revenue, bed occupancy, pharmacy, lab). */
function KpiTile({ label, badgeText, badgeBg, badgeColor, value, footnote, footnoteColor = "#94a3b8", onClick }: KpiTileProps) {
  return (
    <div
      style={{ ...kpiCardStyle, cursor: onClick ? "pointer" : undefined }}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter") onClick(); } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? "Click to see the records" : undefined}
    >
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

export default function AnalysisPage({ setNotice, onNavigate, hospitalSummary, analytics, analyticsLoading, dashboardDate, setDashboardDate }: Props) {
  const [activeTab, setActiveTab] = useState<AnalysisTab>("operational");

  const selectedDate = dashboardDate || toIsoDate(new Date());
  const selectedDateObj = parseIsoDate(selectedDate);
  const todayIso = toIsoDate(new Date());
  const isCurrentMonth = selectedDate.slice(0, 7) === todayIso.slice(0, 7);
  const selectedMonthLabel = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(selectedDateObj);
  const selectedFullMonthLabel = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(selectedDateObj);
  const monthBadgeText = isCurrentMonth ? "This Month" : selectedMonthLabel;

  // All figures below are derived directly from the real hospital-summary /
  // dashboard-analytics payloads -- no invented benchmarks or illustrative
  // numbers. A panel is simply omitted (via EmptyNote) rather than filled
  // with a plausible-looking placeholder when the backing data is empty.
  const stats = useMemo(() => {
    const totalRevenue = hospitalSummary?.revenue?.monthly_total ?? 0;
    const pharmacyRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.pharmacy ?? 0;
    const labRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.lab_diagnostics ?? 0;
    const ipRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.ip_billing ?? 0;
    const opRevenue = hospitalSummary?.revenue?.module_breakdown?.monthly?.op_billing ?? Math.max(totalRevenue - pharmacyRevenue - labRevenue - ipRevenue, 0);
    const bedCapacity = hospitalSummary?.bed_stats?.capacity ?? 0;
    const bedOccupied = hospitalSummary?.bed_stats?.occupied ?? 0;
    const bedOccupancyRate = hospitalSummary?.bed_stats?.occupancy_rate ?? (bedCapacity > 0 ? Math.round((bedOccupied / bedCapacity) * 100) : 0);
    const doctorPayoutReady = hospitalSummary?.revenue?.doctor_payout_ready ?? 0;
    const pharmacyTransactionsToday = hospitalSummary?.pharmacy_summary?.today_transactions ?? 0;
    return { totalRevenue, pharmacyRevenue, labRevenue, ipRevenue, opRevenue, bedCapacity, bedOccupied, bedOccupancyRate, doctorPayoutReady, pharmacyTransactionsToday };
  }, [hospitalSummary]);

  const { totalRevenue, pharmacyRevenue, labRevenue, ipRevenue, opRevenue, bedCapacity, bedOccupied, bedOccupancyRate, doctorPayoutReady, pharmacyTransactionsToday } = stats;

  const revenueSegments = useMemo(
    () => {
      const segments = [
        { key: "op", label: "Outpatient (OPD) Consultations", value: opRevenue, color: "#00828a" },
        { key: "ip", label: "Inpatient (IPD) Admissions", value: ipRevenue, color: "#f59e0b" },
        { key: "pharmacy", label: "Pharmacy Sales & Ward Indents", value: pharmacyRevenue, color: "#10b981" },
        { key: "lab", label: "Laboratory & Diagnostics", value: labRevenue, color: "#3b82f6" },
      ];
      return segments.filter((s) => s.value > 0);
    },
    [opRevenue, ipRevenue, pharmacyRevenue, labRevenue]
  );

  const paymentModeSlices = useMemo(
    () => distributionToSlices(hospitalSummary?.revenue?.payment_mode_breakdown),
    [hospitalSummary]
  );

  const wardBreakdown = hospitalSummary?.bed_ward_breakdown || [];
  // Only recorded male / female are charted: "Unknown" (no gender entered) and "Other" are not useful splits.
  const genderSlices = useMemo(() => distributionToSlices(analytics?.gender_distribution, ["unknown", "other", ""]).filter((s) => ["male", "female"].includes(s.key.trim().toLowerCase())), [analytics]);
  const admissionSlices = useMemo(() => distributionToSlices(analytics?.admission_status_distribution), [analytics]);
  // "unknown" means no referral source was entered; charting it would only hide the real sources.
  const referralSlices = useMemo(() => distributionToSlices(hospitalSummary?.referrals, ["unknown", ""]), [hospitalSummary]);

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
      { label: "OP (Day)", value: c.daily_op },
      { label: "IP (Day)", value: c.daily_ip },
      { label: `OP (${selectedMonthLabel})`, value: c.monthly_op },
      { label: `IP (${selectedMonthLabel})`, value: c.monthly_ip },
    ];
  }, [hospitalSummary, selectedMonthLabel]);

  const operationsToday = hospitalSummary?.operations_today;
  // Only the counts that mean "work still to finish": consultations, invoices and payments.
  // (Registrations, pharmacy sales and revenue reporting are always 100%; bed occupancy is already shown above.)
  const operationsRows = useMemo(() => {
    if (!operationsToday) return [];
    const wanted: [string, string][] = [
      ["queue_management", "Consultations"], ["billing", "Billing (invoices)"],
      ["payment_collection", "Payment Collection"],
    ];
    return wanted
      .map(([key, label]) => ({ key, label, ...(operationsToday as Record<string, { count: number; completed: number; pending: number } | undefined>)[key]! }))
      .filter((r) => r.count > 0);
  }, [operationsToday]);

  // ---------------------------------------------------------------- drill-down --
  const [drill, setDrill] = useState<DrillState | null>(null);

  const fail = (error: unknown) => {
    setDrill(null);
    reportError(setNotice, error as { message?: string; status?: number }, "Unable to load the records.");
  };

  type RevenueEntry = { at: string | null; patient_id?: string | null; patient_name: string; reference?: string | null; mode?: string | null; amount: number; source?: string | null };

  const revenueEntriesView = (title: string, subtitle: string, data: { total: number; entries: RevenueEntry[] }, back?: () => void): DrillState => ({
    title, subtitle, back,
    columns: ["Date / time", "Patient", "UHID", "Reference", "Mode", "Amount"],
    rows: data.entries.map((e) => [e.at || "", e.patient_name, e.patient_id || "", e.reference || "", e.mode ? String(e.mode).toUpperCase() : "", e.amount]),
    total: formatINR(data.total),
  });

  const showRevenueDetails = async (category: string, period: "today" | "month", back?: () => void) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ label: string; total: number; entries: RevenueEntry[] }>(
        `/api/dashboard/revenue-details?category=${encodeURIComponent(category)}&date=${encodeURIComponent(selectedDate)}&period=${period}`);
      setDrill(revenueEntriesView(data.label, period === "month" ? selectedFullMonthLabel : selectedDate, data, back));
    } catch (error) { fail(error); }
  };

  const showRevenueBreakdown = async () => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ total: number; rows: { key: string; label: string; amount: number; count: number }[] }>(
        `/api/dashboard/revenue-breakdown?date=${encodeURIComponent(selectedDate)}&period=month`);
      const view: DrillState = {
        title: `Revenue collected — ${selectedFullMonthLabel}`,
        subtitle: "Click a row to see the payments behind it",
        columns: ["Source", "Entries", "Amount"],
        rows: data.rows.map((r) => [r.label, r.count, r.amount]),
        total: formatINR(data.total),
        note: "Pending / Due is shown for reference and is not part of the total.",
        onRow: (i) => { void showRevenueDetails(data.rows[i].key, "month", () => setDrill(view)); },
      };
      setDrill(view);
    } catch (error) { fail(error); }
  };

  const showPaymentMode = async (mode: string, label: string) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ label: string; total: number; entries: RevenueEntry[] }>(
        `/api/dashboard/payment-mode-details?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(selectedDate)}&period=today`);
      setDrill(revenueEntriesView(`${label} collections`, selectedDate, data));
    } catch (error) { fail(error); }
  };

  const showRecords = async (kind: string, key: string) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ title: string; columns: string[]; rows: (string | number)[][]; note?: string | null; count: number }>(
        `/api/analysis/drilldown?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&date=${encodeURIComponent(selectedDate)}`);
      setDrill({
        title: data.title, columns: data.columns, rows: data.rows,
        note: data.count >= 500 ? "Showing the first 500 records." : data.note || undefined,
      });
    } catch (error) { fail(error); }
  };

  const printAnalysisReport = () => {
    const html = buildAnalysisReportHtml({
      totalRevenue,
      opRevenue,
      ipRevenue,
      pharmacyRevenue,
      labRevenue,
      bedOccupied,
      bedCapacity,
      bedOccupancyRate,
      periodLabel: selectedFullMonthLabel,
    });
    printViaIframe(html, `Analysis_Report_${selectedDate.slice(0, 7)}`);
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
            Real operational, financial, and clinical metrics for {selectedFullMonthLabel}, sourced live from the hospital database.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {setDashboardDate && (
            <DateCalendarPicker value={selectedDate} onChange={setDashboardDate} />
          )}
          <Button
            type="button"
            variant="primary"
            onClick={printAnalysisReport}
            style={{ background: "#00828a", borderColor: "#00828a", display: "flex", alignItems: "center", gap: "6px" }}
          >
            <span>🖨</span> Export PDF Report
          </Button>
        </div>
      </div>

      {analyticsLoading && (
        <p style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "10px" }}>Refreshing analytics…</p>
      )}

      {/* KPI Highlight Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <KpiTile
          label={`Gross Revenue (${monthBadgeText})`}
          badgeText={monthBadgeText}
          badgeBg="#ccfbf1"
          badgeColor="#0f766e"
          value={formatINR(totalRevenue)}
          footnote="Includes OPD, IPD, Pharmacy & Diagnostics"
          onClick={() => void showRevenueBreakdown()}
        />
        <KpiTile
          label="Bed Occupancy"
          badgeText={`${bedOccupancyRate}%`}
          badgeBg="#eff6ff"
          badgeColor="#1d4ed8"
          value={<>{bedOccupied} / {bedCapacity} <span style={{ fontSize: "14px", fontWeight: 500, color: "#64748b" }}>Beds</span></>}
          footnote={`${Math.max(bedCapacity - bedOccupied, 0)} Available across wards`}
          footnoteColor="#16a34a"
          onClick={() => void showRecords("beds", "")}
        />
        <KpiTile
          label={`Pharmacy Sales (${monthBadgeText})`}
          badgeText={isCurrentMonth ? "Live" : selectedMonthLabel}
          badgeBg="#fef3c7"
          badgeColor="#b45309"
          value={formatINR(pharmacyRevenue)}
          footnote={isCurrentMonth ? `${pharmacyTransactionsToday} transactions today` : `Pharmacy dispensing for ${selectedMonthLabel}`}
          onClick={() => void showRevenueDetails("pharmacy", "month")}
        />
        <KpiTile
          label={`Lab & Diagnostics (${monthBadgeText})`}
          badgeText={isCurrentMonth ? "Live" : selectedMonthLabel}
          badgeBg="#f3e8ff"
          badgeColor="#7e22ce"
          value={formatINR(labRevenue)}
          footnote="Diagnostics module revenue"
          onClick={() => void showRevenueDetails("lab", "month")}
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
            <CardHeader><CardTitle>Patient Registrations — Window ({analytics?.window_days ?? 14} Days ending {new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(selectedDateObj)})</CardTitle></CardHeader>
            <CardContent>
              {patientsTrendBars.some((b) => b.value > 0) ? (
                <BarChart
                  data={patientsTrendBars}
                  barColor="#00828a"
                  onSelect={(i) => { const day = analytics?.patients_trend?.[i]?.date; if (day) void showRecords("registrations", day); }}
                />
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
                          onSelect={() => void showRecords("ward", w.ward)}
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
                <BarChart
                  data={ipOpBars}
                  barColor="#2563eb"
                  onSelect={(i) => void showRecords("ipop", ["daily_op", "daily_ip", "monthly_op", "monthly_ip"][i])}
                />
              </CardContent>
            </Card>
          )}

          {operationsRows.length > 0 && (
            <Card className="panel" style={{ gridColumn: "1 / -1" }}>
              <CardHeader><CardTitle>Operations Still Open ({isCurrentMonth ? "Today" : selectedDate})</CardTitle></CardHeader>
              <CardContent>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px 28px" }}>
                  {operationsRows.map((r) => (
                    <HorizontalBar
                      key={r.key}
                      label={r.label}
                      value={r.completed}
                      max={r.count}
                      color={r.completed === r.count ? "#16a34a" : "#f59e0b"}
                      valueLabel={`${r.completed}/${r.count} completed`}
                      onClick={() => {
                        if (r.key === "payment_collection") void showPaymentMode("all", "All payment");
                        else void showRecords("ops", r.key === "queue_management" ? "queue" : "billing");
                      }}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Tab 2: Financial */}
      {activeTab === "financial" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <Card className="panel">
            <CardHeader><CardTitle>Department Revenue Distribution ({monthBadgeText})</CardTitle></CardHeader>
            <CardContent>
              {totalRevenue > 0 ? (
                <DonutChart
                  data={revenueSegments}
                  centerLabel="Total"
                  centerValue={formatINR(totalRevenue)}
                  onSelect={(i) => void showRevenueDetails(revenueSegments[i].key, "month")}
                />
              ) : (
                <EmptyNote>No revenue recorded for {selectedFullMonthLabel} yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Payment Mode Collections ({isCurrentMonth ? "Today" : selectedDate})</CardTitle></CardHeader>
            <CardContent>
              {paymentModeSlices.length > 0 ? (
                <DonutChart
                  data={paymentModeSlices}
                  onSelect={(i) => void showPaymentMode(paymentModeSlices[i].key.trim().toLowerCase(), paymentModeSlices[i].label)}
                />
              ) : (
                <EmptyNote>No payments collected on this date yet.</EmptyNote>
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
                <DonutChart data={genderSlices} formatValue={(v) => String(v)} size={140} onSelect={(i) => void showRecords("gender", genderSlices[i].key)} />
              ) : (
                <EmptyNote>No patient records yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Admission Status</CardTitle></CardHeader>
            <CardContent>
              {admissionSlices.length > 0 ? (
                <DonutChart data={admissionSlices} formatValue={(v) => String(v)} size={140} onSelect={(i) => void showRecords("admissions", admissionSlices[i].key)} />
              ) : (
                <EmptyNote>No admissions recorded yet.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Referral Sources</CardTitle></CardHeader>
            <CardContent>
              {referralSlices.length > 0 ? (
                <DonutChart data={referralSlices} formatValue={(v) => String(v)} size={140} onSelect={(i) => void showRecords("referral", referralSlices[i].key)} />
              ) : (
                <EmptyNote>No referral data recorded for {selectedFullMonthLabel} yet.</EmptyNote>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Modal
        open={!!drill}
        onClose={() => setDrill(null)}
        title={drill?.title}
        description={drill?.subtitle}
        className="analysis-drill-modal"
      >
        {drill && (
          <div>
            {drill.back && (
              <Button variant="ghost" onClick={drill.back} style={{ marginBottom: 8 }}>← Back</Button>
            )}
            {drill.loading && <p style={{ color: "#64748b", fontSize: 13 }}>Loading records…</p>}
            {!drill.loading && drill.rows.length === 0 && <EmptyNote>No records found for this selection.</EmptyNote>}
            {!drill.loading && drill.rows.length > 0 && (
              <div style={{ overflow: "auto", maxHeight: "62vh", border: "1px solid #e2e8f0", borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
                      {drill.columns.map((c) => (
                        <th key={c} style={{ padding: "8px 10px", position: "sticky", top: 0, background: "#f1f5f9", textAlign: MONEY_COLUMN.test(c) ? "right" : "left", whiteSpace: "nowrap" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {drill.rows.map((row, ri) => (
                      <tr
                        key={ri}
                        onClick={drill.onRow ? () => drill.onRow!(ri) : undefined}
                        style={{ borderTop: "1px solid #f1f5f9", cursor: drill.onRow ? "pointer" : undefined }}
                      >
                        {row.map((cell, ci) => (
                          <td key={ci} style={{ padding: "7px 10px", textAlign: MONEY_COLUMN.test(drill.columns[ci] || "") ? "right" : "left", fontWeight: MONEY_COLUMN.test(drill.columns[ci] || "") ? 700 : 400 }}>
                            {MONEY_COLUMN.test(drill.columns[ci] || "") && typeof cell === "number" ? formatINR(cell) : (cell === "" ? "—" : cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 12.5, color: "#475569" }}>
              <span>{!drill.loading ? `${drill.rows.length} record${drill.rows.length === 1 ? "" : "s"}` : ""}{drill.note ? ` · ${drill.note}` : ""}</span>
              {drill.total && <strong style={{ color: "#0f172a" }}>Total: {drill.total}</strong>}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
