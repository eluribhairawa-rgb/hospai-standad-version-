import { useEffect, useMemo, useState } from "react";
import { brandTitle, escapeBrandText } from "../lib/branding";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Modal } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { DonutChart, PieChart, BarChart, HorizontalBar } from "../components/charts";
import { toIsoDate, parseIsoDate } from "../components/DateCalendarPicker";
import { printViaIframe } from "../lib/printViaIframe";
import type { Notice, HospitalSummary, DashboardAnalytics } from "../types";

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
function distributionToSlices(items: { label: string; count: number }[] | undefined, exclude: string[] = []): KeyedSlice[] {
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
  // No own letterhead: the shared print frame adds the hospital logo, name, title block and page footer
  // (a document carrying data-hospai-shared-print-shell skips it, which is what left this report without one).
  return `<!doctype html><html><head><meta charset="utf-8"><title>Comprehensive Performance Analysis</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1e293b; line-height: 1.35; }
      .period { font-size: 12px; color: #334155; margin: 0 0 10px; }
      .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
      .kpi-box { border: 1px solid #cbd5e1; padding: 7px 10px; border-radius: 6px; background: #f8fafc; }
      .kpi-box span { font-size: 10px; color: #64748b; display: block; font-weight: 600; text-transform: uppercase; }
      .kpi-box strong { font-size: 15px; color: #0f172a; display: block; margin-top: 2px; }
      h4 { margin: 8px 0 5px; font-size: 12px; color: #0f172a; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; font-size: 11px; }
      th { background: #f1f5f9; font-weight: 700; color: #334155; }
    </style></head><body>
      <p class="period"><strong>Period:</strong> ${periodLabel}</p>

      <div class="kpi-grid">
        <div class="kpi-box"><span>Total Revenue</span><strong>${formatINR(totalRevenue)}</strong></div>
        <div class="kpi-box"><span>Bed Occupancy (now)</span><strong>${bedOccupied}/${bedCapacity} (${bedOccupancyRate}%)</strong></div>
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

    </body></html>
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


// ------------------------------------------------------------ period handling --
type Period = "day" | "week" | "month" | "year" | "custom";
const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Day" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }, { id: "year", label: "Year" }, { id: "custom", label: "From – To" },
];

const fmtDay = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parseIsoDate(iso));

function addDays(iso: string, n: number) { const d = parseIsoDate(iso); d.setDate(d.getDate() + n); return toIsoDate(d); }

/** Inclusive from/to dates and a readable label for the chosen period around `anchor`. */
function computeRange(period: Period, anchor: string, customFrom: string, customTo: string): { from: string; to: string; label: string; short: string } {
  const a = parseIsoDate(anchor);
  if (period === "day") return { from: anchor, to: anchor, label: fmtDay(anchor), short: fmtDay(anchor) };
  if (period === "week") {
    const monday = addDays(anchor, -((a.getDay() + 6) % 7));
    const sunday = addDays(monday, 6);
    return { from: monday, to: sunday, label: `${fmtDay(monday)} – ${fmtDay(sunday)}`, short: "This week" };
  }
  if (period === "month") {
    const first = toIsoDate(new Date(a.getFullYear(), a.getMonth(), 1));
    const last = toIsoDate(new Date(a.getFullYear(), a.getMonth() + 1, 0));
    const name = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(a);
    return { from: first, to: last, label: name, short: new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(a) };
  }
  if (period === "year") {
    return { from: `${a.getFullYear()}-01-01`, to: `${a.getFullYear()}-12-31`, label: String(a.getFullYear()), short: String(a.getFullYear()) };
  }
  return { from: customFrom, to: customTo, label: `${fmtDay(customFrom)} – ${fmtDay(customTo)}`, short: "Selected range" };
}

function shiftAnchor(period: Period, anchor: string, dir: 1 | -1): string {
  const a = parseIsoDate(anchor);
  if (period === "day") return addDays(anchor, dir);
  if (period === "week") return addDays(anchor, 7 * dir);
  if (period === "month") return toIsoDate(new Date(a.getFullYear(), a.getMonth() + dir, 1));
  return toIsoDate(new Date(a.getFullYear() + dir, 0, 1));
}

type Summary = {
  from: string; to: string; days: number;
  revenue: { total: number; modules: Record<string, number>; outstanding: number; payment_modes: { label: string; amount: number }[] };
  registrations: { total: number; trend: { label: string; from: string; to: string; count: number }[] };
  visits: { op: number; ip: number; er: number };
  operations: { queue: { count: number; completed: number }; billing: { count: number; completed: number }; payments: { count: number; completed: number } };
  gender: { label: string; count: number }[];
  admissions: { label: string; count: number }[];
  referrals: { label: string; count: number }[];
};

const PAYMENT_LABELS: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", cheque: "Cheque", razorpay: "Razorpay", net_banking: "Net banking", bank_transfer: "Bank transfer" };

const periodButtonStyle = (active: boolean): CSSProperties => ({
  padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: "none",
  background: active ? "#00828a" : "transparent", color: active ? "#ffffff" : "#475569", borderRadius: 7,
});
const dateInputStyle: CSSProperties = { height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 13, background: "#ffffff" };

export default function AnalysisPage({ setNotice, onNavigate, hospitalSummary, dashboardDate, setDashboardDate }: Props) {
  const [activeTab, setActiveTab] = useState<AnalysisTab>("operational");
  const todayIso = toIsoDate(new Date());

  // ---- period selection: day / week / month / year / custom from-to
  const [period, setPeriod] = useState<Period>("month");
  const [anchor, setAnchor] = useState(dashboardDate || todayIso);
  const [customFrom, setCustomFrom] = useState(() => addDays(todayIso, -6));
  const [customTo, setCustomTo] = useState(todayIso);
  const range = useMemo(() => computeRange(period, anchor, customFrom, customTo), [period, anchor, customFrom, customTo]);
  const rangeError = period === "custom" && (!customFrom || !customTo || customFrom > customTo)
    ? (customFrom > customTo && customFrom && customTo ? "The 'from' date must not be after the 'to' date." : "Choose both dates.")
    : "";
  const canGoNext = period !== "custom" && range.to < todayIso;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (rangeError) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<Summary>(`/api/analysis/summary?date_from=${encodeURIComponent(range.from)}&date_to=${encodeURIComponent(range.to)}`)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((error) => { if (!cancelled) reportError(setNotice, error as { message?: string; status?: number }, "Unable to load the analysis."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, rangeError]);

  // The main dashboard date follows the anchor (so the bed / payout snapshot stays in sync).
  useEffect(() => { if (setDashboardDate && period !== "custom") setDashboardDate(anchor); }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalRevenue = summary?.revenue.total ?? 0;
  const mod = summary?.revenue.modules ?? {};
  const opRevenue = (mod.op ?? 0) + (mod.other ?? 0);
  const ipRevenue = mod.ip ?? 0;
  const pharmacyRevenue = mod.pharmacy ?? 0;
  const labRevenue = mod.lab ?? 0;
  // Beds are a live snapshot (past occupancy is not stored).
  const bedCapacity = hospitalSummary?.bed_stats?.capacity ?? 0;
  const bedOccupied = hospitalSummary?.bed_stats?.occupied ?? 0;
  const bedOccupancyRate = hospitalSummary?.bed_stats?.occupancy_rate ?? (bedCapacity > 0 ? Math.round((bedOccupied / bedCapacity) * 100) : 0);
  const doctorPayoutReady = hospitalSummary?.revenue?.doctor_payout_ready ?? 0;
  const wardBreakdown = hospitalSummary?.bed_ward_breakdown || [];

  const revenueSegments = useMemo(() => [
    { key: "op", label: "Outpatient (OPD) Consultations", value: opRevenue, color: "#00828a" },
    { key: "ip", label: "Inpatient (IPD) Admissions", value: ipRevenue, color: "#f59e0b" },
    { key: "pharmacy", label: "Pharmacy Sales & Ward Indents", value: pharmacyRevenue, color: "#10b981" },
    { key: "lab", label: "Laboratory & Diagnostics", value: labRevenue, color: "#3b82f6" },
  ].filter((x) => x.value > 0), [opRevenue, ipRevenue, pharmacyRevenue, labRevenue]);

  const paymentModeSlices = useMemo<KeyedSlice[]>(
    () => (summary?.revenue.payment_modes || []).map((m, i) => ({ key: m.label, label: PAYMENT_LABELS[m.label] || titleCase(m.label), value: m.amount, color: PALETTE[i % PALETTE.length] })),
    [summary]
  );

  // Only recorded male / female are charted: "Unknown" (no gender entered) and "Other" are not useful splits.
  const genderSlices = useMemo(() => distributionToSlices(summary?.gender, ["unknown", "other", ""]).filter((x) => ["male", "female"].includes(x.key.trim().toLowerCase())), [summary]);
  const admissionSlices = useMemo(() => distributionToSlices(summary?.admissions), [summary]);
  // "unknown" means no referral source was entered; charting it would only hide the real sources.
  const referralSlices = useMemo(() => distributionToSlices(summary?.referrals, ["unknown", ""]), [summary]);

  const trendBars = useMemo(() => (summary?.registrations.trend || []).map((t) => ({ label: t.label, value: t.count })), [summary]);
  const visitBars = useMemo(() => summary ? [
    { label: "OP visits", value: summary.visits.op }, { label: "IP admissions", value: summary.visits.ip }, { label: "Emergency", value: summary.visits.er },
  ] : [], [summary]);

  const operationsRows = useMemo(() => {
    if (!summary) return [];
    const o = summary.operations;
    return [
      { key: "queue", label: "Consultations", ...o.queue },
      { key: "billing", label: "Billing (invoices)", ...o.billing },
      { key: "payments", label: "Payments collected (vs. dues)", ...o.payments },
    ].filter((r) => r.count > 0);
  }, [summary]);

  // ---------------------------------------------------------------- drill-down --
  const [drill, setDrill] = useState<DrillState | null>(null);
  const rangeQuery = `date_from=${encodeURIComponent(range.from)}&date_to=${encodeURIComponent(range.to)}`;
  const revenueQuery = `date=${encodeURIComponent(range.from)}&date_to=${encodeURIComponent(range.to)}&period=range`;

  const fail = (error: unknown) => {
    setDrill(null);
    reportError(setNotice, error as { message?: string; status?: number }, "Unable to load the records.");
  };

  type RevenueEntry = { at: string | null; patient_id?: string | null; patient_name: string; reference?: string | null; mode?: string | null; amount: number; source?: string | null };

  const revenueEntriesView = (title: string, data: { total: number; entries: RevenueEntry[] }, back?: () => void): DrillState => ({
    title, subtitle: range.label, back,
    columns: ["Date / time", "Patient", "UHID", "Reference", "Mode", "Amount"],
    rows: data.entries.map((e) => [e.at || "", e.patient_name, e.patient_id || "", e.reference || "", e.mode ? String(e.mode).toUpperCase() : "", e.amount]),
    total: formatINR(data.total),
  });

  const showRevenueDetails = async (category: string, back?: () => void) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ label: string; total: number; entries: RevenueEntry[] }>(`/api/dashboard/revenue-details?category=${encodeURIComponent(category)}&${revenueQuery}`);
      setDrill(revenueEntriesView(data.label, data, back));
    } catch (error) { fail(error); }
  };

  const showRevenueBreakdown = async () => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ total: number; rows: { key: string; label: string; amount: number; count: number }[] }>(`/api/dashboard/revenue-breakdown?${revenueQuery}`);
      const view: DrillState = {
        title: "Revenue collected", subtitle: `${range.label} · click a row to see the payments behind it`,
        columns: ["Source", "Entries", "Amount"],
        rows: data.rows.map((r) => [r.label, r.count, r.amount]),
        total: formatINR(data.total),
        note: "Pending / Due is for reference and is not part of the total.",
        onRow: (i) => { void showRevenueDetails(data.rows[i].key, () => setDrill(view)); },
      };
      setDrill(view);
    } catch (error) { fail(error); }
  };

  const showPaymentMode = async (mode: string, label: string) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ total: number; entries: RevenueEntry[] }>(`/api/dashboard/payment-mode-details?mode=${encodeURIComponent(mode)}&${revenueQuery}`);
      setDrill(revenueEntriesView(`${label} collections`, data));
    } catch (error) { fail(error); }
  };

  const showRecords = async (kind: string, key: string) => {
    setDrill({ title: "Loading…", columns: [], rows: [], loading: true });
    try {
      const data = await apiFetch<{ title: string; columns: string[]; rows: (string | number)[][]; note?: string | null; count: number }>(
        `/api/analysis/drilldown?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&${rangeQuery}`);
      setDrill({ title: data.title, columns: data.columns, rows: data.rows, note: data.count >= 500 ? "Showing the first 500 records." : data.note || undefined });
    } catch (error) { fail(error); }
  };

  const printAnalysisReport = () => {
    const html = buildAnalysisReportHtml({
      totalRevenue, opRevenue, ipRevenue, pharmacyRevenue, labRevenue,
      bedOccupied, bedCapacity, bedOccupancyRate, periodLabel: range.label,
    });
    printViaIframe(html, `Analysis_Report_${range.from}_${range.to}`);
  };

  const bedBadge = `${bedOccupancyRate}%`;

  return (
    <div style={{ padding: "20px 32px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#64748b", fontWeight: 500, marginBottom: "4px" }}>
            <span>Hospital</span>
            <span>/</span>
            <span style={{ color: "#00828a", fontWeight: 700 }}>Analysis & Intelligence</span>
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", margin: 0 }}>Executive & Departmental Analysis</h1>
          <p style={{ fontSize: "13.5px", color: "#64748b", margin: "4px 0 0" }}>
            Operational, financial and clinical metrics for <strong style={{ color: "#0f172a" }}>{range.label}</strong>, sourced live from the hospital database.
          </p>
        </div>
        <Button type="button" variant="primary" onClick={printAnalysisReport} style={{ background: "#00828a", borderColor: "#00828a", display: "flex", alignItems: "center", gap: "6px" }}>
          <span>🖨</span> Export PDF Report
        </Button>
      </div>

      {/* Period selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 14px" }}>
        <div style={{ display: "flex", gap: 2, background: "#f1f5f9", padding: 3, borderRadius: 9 }}>
          {PERIODS.map((p) => (
            <button key={p.id} type="button" style={periodButtonStyle(period === p.id)} onClick={() => setPeriod(p.id)}>{p.label}</button>
          ))}
        </div>

        {period !== "custom" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Button type="button" variant="ghost" onClick={() => setAnchor(shiftAnchor(period, anchor, -1))} aria-label="Previous period">‹</Button>
            {period === "day" && <input type="date" value={anchor} max={todayIso} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={dateInputStyle} />}
            {period === "week" && <input type="date" value={anchor} max={todayIso} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={dateInputStyle} title="Any day in the week" />}
            {period === "month" && <input type="month" value={anchor.slice(0, 7)} max={todayIso.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(`${e.target.value}-01`)} style={dateInputStyle} />}
            {period === "year" && (
              <input type="number" value={anchor.slice(0, 4)} min={2000} max={Number(todayIso.slice(0, 4))} onChange={(e) => e.target.value.length === 4 && setAnchor(`${e.target.value}-01-01`)} style={{ ...dateInputStyle, width: 90 }} />
            )}
            <Button type="button" variant="ghost" disabled={!canGoNext} onClick={() => setAnchor(shiftAnchor(period, anchor, 1))} aria-label="Next period">›</Button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12.5, color: "#475569", fontWeight: 600 }}>From</label>
            <input type="date" value={customFrom} max={customTo || todayIso} onChange={(e) => setCustomFrom(e.target.value)} style={dateInputStyle} />
            <label style={{ fontSize: 12.5, color: "#475569", fontWeight: 600 }}>To</label>
            <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} style={dateInputStyle} />
          </div>
        )}

        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#64748b", fontWeight: 600 }}>
          {rangeError ? <span style={{ color: "#dc2626" }}>{rangeError}</span> : <>Showing {range.label}{summary && summary.days > 1 ? ` · ${summary.days} days` : ""}</>}
        </span>
      </div>

      {loading && <p style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "10px" }}>Refreshing analysis…</p>}

      {/* KPI Highlight Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <KpiTile
          label={`Gross Revenue (${range.short})`}
          badgeText={range.short}
          badgeBg="#ccfbf1"
          badgeColor="#0f766e"
          value={formatINR(totalRevenue)}
          footnote={summary && summary.revenue.outstanding > 0 ? `${formatINR(summary.revenue.outstanding)} still due on bills raised` : "Collected: OPD, IPD, Pharmacy & Diagnostics"}
          onClick={() => void showRevenueBreakdown()}
        />
        <KpiTile
          label="Bed Occupancy (now)"
          badgeText={bedBadge}
          badgeBg="#eff6ff"
          badgeColor="#1d4ed8"
          value={<>{bedOccupied} / {bedCapacity} <span style={{ fontSize: "14px", fontWeight: 500, color: "#64748b" }}>Beds</span></>}
          footnote={`${Math.max(bedCapacity - bedOccupied, 0)} Available across wards`}
          footnoteColor="#16a34a"
          onClick={() => void showRecords("beds", "")}
        />
        <KpiTile
          label={`Pharmacy Sales (${range.short})`}
          badgeText="Pharmacy"
          badgeBg="#fef3c7"
          badgeColor="#b45309"
          value={formatINR(pharmacyRevenue)}
          footnote="Pharmacy collections in this period"
          onClick={() => void showRevenueDetails("pharmacy")}
        />
        <KpiTile
          label={`Lab & Diagnostics (${range.short})`}
          badgeText="Diagnostics"
          badgeBg="#f3e8ff"
          badgeColor="#7e22ce"
          value={formatINR(labRevenue)}
          footnote="Diagnostics collections in this period"
          onClick={() => void showRevenueDetails("lab")}
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
              padding: "10px 20px", fontSize: "13.5px", fontWeight: 700, background: "transparent", border: "none",
              borderBottom: activeTab === t.id ? "3px solid #00828a" : "3px solid transparent",
              color: activeTab === t.id ? "#00828a" : "#64748b", cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", marginBottom: "-2px",
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
            <CardHeader><CardTitle>Patient Registrations — {range.label} ({summary?.registrations.total ?? 0})</CardTitle></CardHeader>
            <CardContent>
              {trendBars.some((b) => b.value > 0) ? (
                <BarChart
                  data={trendBars}
                  barColor="#00828a"
                  onSelect={(i) => { const b = summary?.registrations.trend[i]; if (b) void showRecords("registrations", `${b.from}|${b.to}`); }}
                />
              ) : (
                <EmptyNote>No patient registrations recorded in this period.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Ward Occupancy (now)</CardTitle></CardHeader>
            <CardContent>
              {wardBreakdown.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(wardBreakdown.length, 3)}, 1fr)`, gap: "28px 16px", paddingBottom: "14px" }}>
                  {wardBreakdown.map((w) => {
                    const rate = w.occupied / Math.max(w.capacity, 1);
                    const occupiedColor = rate > 0.8 ? "#dc2626" : rate > 0.5 ? "#f59e0b" : "#2563eb";
                    return (
                      <div key={w.ward} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                        <PieChart
                          data={[{ label: "Occupied", value: w.occupied, color: occupiedColor }, { label: "Free", value: w.available, color: "#e2e8f0" }]}
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

          {visitBars.some((b) => b.value > 0) && (
            <Card className="panel" style={{ gridColumn: "1 / -1" }}>
              <CardHeader><CardTitle>OP vs IP vs Emergency Volume — {range.label}</CardTitle></CardHeader>
              <CardContent>
                <BarChart data={visitBars} barColor="#2563eb" onSelect={(i) => void showRecords("ipop", ["op", "ip", "er"][i])} />
              </CardContent>
            </Card>
          )}

          {operationsRows.length > 0 && (
            <Card className="panel" style={{ gridColumn: "1 / -1" }}>
              <CardHeader><CardTitle>Operations Still Open — {range.label}</CardTitle></CardHeader>
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
                      onClick={() => { if (r.key === "payments") void showPaymentMode("all", "All payment"); else void showRecords("ops", r.key); }}
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
            <CardHeader><CardTitle>Department Revenue Distribution — {range.label}</CardTitle></CardHeader>
            <CardContent>
              {totalRevenue > 0 ? (
                <DonutChart data={revenueSegments} centerLabel="Total" centerValue={formatINR(totalRevenue)} onSelect={(i) => void showRevenueDetails(revenueSegments[i].key)} />
              ) : (
                <EmptyNote>No revenue recorded for {range.label}.</EmptyNote>
              )}
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Payment Mode Collections — {range.label}</CardTitle></CardHeader>
            <CardContent>
              {paymentModeSlices.length > 0 ? (
                <DonutChart data={paymentModeSlices} onSelect={(i) => void showPaymentMode(paymentModeSlices[i].key.trim().toLowerCase(), paymentModeSlices[i].label)} />
              ) : (
                <EmptyNote>No payments collected in this period.</EmptyNote>
              )}

              <div style={{ marginTop: "16px", padding: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Doctor Payout Ready (this month):</span>
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
                <EmptyNote>No patients seen in this period.</EmptyNote>
              )}
              <p style={{ fontSize: 11.5, color: "#94a3b8", margin: "10px 0 0" }}>Patients with an appointment, admission or emergency visit in {range.label}.</p>
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Admission Status</CardTitle></CardHeader>
            <CardContent>
              {admissionSlices.length > 0 ? (
                <DonutChart data={admissionSlices} formatValue={(v) => String(v)} size={140} onSelect={(i) => void showRecords("admissions", admissionSlices[i].key)} />
              ) : (
                <EmptyNote>No admissions in this period.</EmptyNote>
              )}
              <p style={{ fontSize: 11.5, color: "#94a3b8", margin: "10px 0 0" }}>Admissions that started in {range.label}; status is as of now.</p>
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader><CardTitle>Referral Sources</CardTitle></CardHeader>
            <CardContent>
              {referralSlices.length > 0 ? (
                <DonutChart data={referralSlices} formatValue={(v) => String(v)} size={140} onSelect={(i) => void showRecords("referral", referralSlices[i].key)} />
              ) : (
                <EmptyNote>No referral data recorded for {range.label}.</EmptyNote>
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
