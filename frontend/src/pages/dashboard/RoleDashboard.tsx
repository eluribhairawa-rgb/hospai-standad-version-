import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui";
import { KpiCard, MiniDonut } from "../../components/DashboardWidgets";
import DateCalendarPicker, { parseIsoDate } from "../../components/DateCalendarPicker";
import PdfExportDropdown from "../../components/PdfExportDropdown";
import { apiFetch, reportError } from "../../lib/api";
import { generatePDFBlob, printPDF } from "../../lib/exportService";
import type { StandardPdfPayload } from "../../lib/exportService";
import type { Notice, User } from "../../types";

/**
 * Role-based dashboard for every non-admin employee.
 *
 * Same layout and components as the executive dashboard (header, KPI row, Quick Actions,
 * two-column cards); only the data and widgets differ. Persona, figures and data scope
 * (e.g. a doctor's own patients) are all decided by GET /api/dashboard/my on the server.
 */

export function isExecutiveDashboardUser(user: User | null | undefined): boolean {
  // Unknown user: fall back to the existing dashboard (previous behaviour).
  if (!user) return true;
  return user.user_type === "admin" || user.user_type === "super_admin";
}

type Persona = "doctor" | "nurse" | "receptionist" | "pharmacist" | "lab_technician" | "billing" | "staff" | "admin";

type RoleKpi = {
  key: string;
  label: string;
  value: number | string;
  sub?: string;
  format?: "number" | "currency" | "text";
  icon?: string;
  accent?: string;
  page?: string | null;
};

type RoleTask = { key: string; label: string; count: number; page?: string | null; severity?: "high" | "normal"; icon?: string };
type Breakdown = { title: string; items: { label: string; count: number }[]; page?: string | null; format?: "currency" | "number" };
type WorklistCell = string | number | null | { currency: number };
type Worklist = { title: string; page?: string | null; columns: string[]; rows: WorklistCell[][]; empty?: string };

export type RoleDashboardData = {
  persona: Persona;
  persona_label: string;
  job_role?: string;
  date: string;
  scope_label?: string;
  notice?: string | null;
  kpis: RoleKpi[];
  tasks: RoleTask[];
  breakdown: Breakdown | null;
  worklist: Worklist | null;
  /** Nurse persona only: patients currently assigned to this nurse (empty when none are assigned). */
  assigned_patients?: { patient_id: string; patient_name?: string | null; ward?: string | null; bed?: string | null; shift?: string | null }[];
};

type Props = {
  user: User | null;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  setNotice?: Dispatch<SetStateAction<Notice | null>>;
  dashboardDate: string;
  setDashboardDate: (date: string) => void;
  canOpenPage?: (page: string) => boolean;
};

const AUTO_REFRESH_MS = 60_000;

const ACCENTS: Record<string, string> = {
  indigo: "linear-gradient(135deg,#6366f1,#8b5cf6)",
  amber: "linear-gradient(135deg,#f59e0b,#d97706)",
  green: "linear-gradient(135deg,#10b981,#059669)",
  teal: "linear-gradient(135deg,#0d9488,#0f766e)",
  blue: "linear-gradient(135deg,#3b82f6,#2563eb)",
  violet: "linear-gradient(135deg,#8b5cf6,#6d28d9)",
  red: "linear-gradient(135deg,#ef4444,#dc2626)",
};

const DONUT_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#0d9488", "#8b5cf6"];

const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

const ICONS: Record<string, React.ReactNode> = {
  users: svg(<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>),
  calendar: svg(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>),
  clock: svg(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>),
  bed: svg(<><path d="M2 4v16" /><path d="M2 8h18a2 2 0 0 1 2 2v10" /><path d="M2 17h20" /><path d="M6 8v9" /></>),
  rx: svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></>),
  doc: svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8" /></>),
  clipboard: svg(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>),
  flask: svg(<><path d="M10 3v5l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3.5L14 8V3" /><path d="M8.5 13h7" /></>),
  pill: svg(<><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" /><path d="m8.5 8.5 7 7" /></>),
  repeat: svg(<><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></>),
  alert: svg(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>),
  check: svg(<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>),
  box: svg(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" /></>),
  chart: svg(<><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-3" /></>),
  wallet: svg(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>),
  stethoscope: svg(<><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" /><path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4" /><circle cx="20" cy="10" r="2" /></>),
};

/** Quick actions per role, using existing pages only; each is shown only if this login can open it. */
const QUICK_ACTIONS: Record<Persona, { label: string; icon: string; page: string }[]> = {
  doctor: [
    { label: "My OP Queue", icon: "🏥", page: "op-queue-management" },
    { label: "Doctor Prescription", icon: "📝", page: "doctor-prescription" },
    { label: "Doctors History", icon: "📚", page: "doctors-history" },
    { label: "Patients", icon: "🔍", page: "patients" },
    { label: "Inpatient Patients", icon: "🛏️", page: "inpatient-patients" },
    { label: "Discharge Summary", icon: "📄", page: "discharge-summary" },
    { label: "Patient Journey", icon: "🗺️", page: "patient-journey" },
    { label: "Emergency Worklist", icon: "🚑", page: "emergency-worklist" },
  ],
  nurse: [
    { label: "Nursing Station", icon: "💉", page: "nurse-station" },
    { label: "Inpatient Patients", icon: "🛏️", page: "inpatient-patients" },
    { label: "Bed Management", icon: "🏨", page: "bed-management" },
    { label: "Inpatient Admission", icon: "➕", page: "ip-admission" },
    { label: "Discharge Summary", icon: "📄", page: "discharge-summary" },
    { label: "Emergency Worklist", icon: "🚑", page: "emergency-worklist" },
    { label: "Patients", icon: "🔍", page: "patients" },
  ],
  receptionist: [
    { label: "Patient Registration", icon: "👤", page: "add" },
    { label: "Patients", icon: "🔍", page: "patients" },
    { label: "Queue Management", icon: "🏥", page: "op-queue-management" },
    { label: "Doctor Scheduling", icon: "🩺", page: "op-desk" },
    { label: "Re-visit", icon: "🔄", page: "readmit" },
    { label: "Patient Journey", icon: "🗺️", page: "patient-journey" },
    { label: "Bed Management", icon: "🛏️", page: "bed-management" },
    { label: "Emergency Worklist", icon: "🚑", page: "emergency-worklist" },
  ],
  pharmacist: [
    { label: "Pharmacy Overview", icon: "💊", page: "pharmacy-overview" },
    { label: "OP Dispense", icon: "🧾", page: "pharmacy-op-dispense" },
    { label: "IP Dispense", icon: "📦", page: "pharmacy-ip-dispense" },
    { label: "Inventory / Stock", icon: "🗃️", page: "pharmacy-inventory" },
    { label: "Purchase & GRN", icon: "🚚", page: "pharmacy-purchases" },
    { label: "Pharmacy Reports", icon: "📊", page: "pharmacy-reports" },
  ],
  lab_technician: [
    { label: "Lab & Diagnostics Overview", icon: "🧪", page: "diag-overview" },
    { label: "Orders & Billing", icon: "🧾", page: "diag-orders-billing" },
    { label: "Laboratory", icon: "🔬", page: "diag-laboratory" },
    { label: "Imaging / Radiology", icon: "🩻", page: "diag-imaging" },
    { label: "Reports & Approval", icon: "✅", page: "diag-reports-approval" },
    { label: "Reports History", icon: "📚", page: "diag-reports-history" },
    { label: "Quality & Equipment", icon: "🛠️", page: "diag-quality-equipment" },
  ],
  billing: [
    { label: "Billing Overview", icon: "💳", page: "billing-overview" },
    { label: "Patient Bills & Payments", icon: "🧾", page: "billing-patient-bills" },
    { label: "Create Invoice", icon: "➕", page: "billing-create-invoice" },
    { label: "IP Discharge Billing", icon: "🏥", page: "billing-ip-discharge" },
    { label: "Advances & Refunds", icon: "🔁", page: "billing-advances-refunds" },
    { label: "Invoices", icon: "📄", page: "billing-invoices" },
    { label: "Revenue Reports", icon: "📊", page: "billing-module-collections" },
    { label: "Reports & Day Close", icon: "📅", page: "billing-reports-day-close" },
  ],
  staff: [
    { label: "Patients", icon: "🔍", page: "patients" },
    { label: "Queue Management", icon: "🏥", page: "op-queue-management" },
    { label: "Patient Journey", icon: "🗺️", page: "patient-journey" },
    { label: "Inpatient Patients", icon: "🛏️", page: "inpatient-patients" },
  ],
  admin: [],
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function formatNumber(amount?: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount || 0);
}

function formatKpiValue(k: RoleKpi): string {
  if (k.format === "currency") return formatCurrency(Number(k.value) || 0);
  if (k.format === "text" || typeof k.value === "string") return String(k.value ?? "-");
  return formatNumber(Number(k.value) || 0);
}

function formatCell(cell: WorklistCell): string {
  if (cell && typeof cell === "object" && "currency" in cell) return formatCurrency(cell.currency);
  if (cell === null || cell === undefined || cell === "") return "-";
  return String(cell);
}

export default function RoleDashboard({ user, onNavigate, onLogout, setNotice, dashboardDate, setDashboardDate, canOpenPage }: Props) {
  const [data, setData] = useState<RoleDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [exportStatus, setExportStatus] = useState<"" | "print">("");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);

  const currentDateLabel = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parseIsoDate(dashboardDate));

  const load = useCallback(async (background = false) => {
    const seq = ++requestSeq.current;
    if (!background) setLoading(true);
    try {
      const res = await apiFetch<RoleDashboardData>(`/api/dashboard/my?date=${encodeURIComponent(dashboardDate)}`, { background });
      if (seq !== requestSeq.current) return true; // a newer request (e.g. date change) superseded this one
      setData(res);
      setLastRefreshedAt(new Date());
      return true;
    } catch (error) {
      if (!background && setNotice) reportError(setNotice, error as { message?: string; status?: number }, "Unable to load your dashboard.");
      return false;
    } finally {
      if (!background && seq === requestSeq.current) setLoading(false);
    }
  }, [dashboardDate, setNotice]);

  useEffect(() => {
    void load();
    // Live figures: refresh quietly in the background (does not extend the idle session).
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, AUTO_REFRESH_MS);
    const onRefreshEvent = () => void load(true);
    window.addEventListener("dashboard:refresh", onRefreshEvent);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("dashboard:refresh", onRefreshEvent);
    };
  }, [load]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const canOpen = (page?: string | null) => !!page && (!canOpenPage || canOpenPage(page));
  const go = (page?: string | null) => {
    if (page && canOpen(page)) onNavigate(page);
  };

  const handleManualRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const persona: Persona = data?.persona || "staff";
  const personaLabel = data?.persona_label || user?.job_role || "Employee";
  const kpis = data?.kpis || [];
  const tasks = data?.tasks || [];
  const breakdown = data?.breakdown || null;
  const worklist = data?.worklist || null;
  const quickActions = QUICK_ACTIONS[persona].filter((a) => canOpen(a.page));
  const breakdownTotal = (breakdown?.items || []).reduce((sum, i) => sum + Number(i.count || 0), 0);
  const breakdownIsCurrency = breakdown?.format === "currency";
  const donutSegments = (breakdown?.items || []).map((item, idx) => ({
    label: item.label,
    count: Number(item.count || 0),
    color: DONUT_COLORS[idx % DONUT_COLORS.length],
    pct: breakdownTotal > 0 ? (Number(item.count || 0) / breakdownTotal) * 100 : 0,
  }));
  const pendingTotal = tasks.reduce((sum, t) => sum + t.count, 0);

  const handleGeneratePdf = async () => {
    const sections: StandardPdfPayload["sections"] = [
      {
        title: "Summary",
        headers: ["Metric", "Value", "Remarks"],
        rows: kpis.map((k) => [k.label, formatKpiValue(k), k.sub || ""]),
      },
    ];
    if (tasks.length) {
      sections.push({ title: "Pending Tasks", headers: ["Task", "Count"], rows: tasks.map((t) => [t.label, t.count]) });
    }
    if (breakdown) {
      sections.push({
        title: breakdown.title,
        headers: ["Category", breakdownIsCurrency ? "Amount" : "Count"],
        rows: breakdown.items.map((i) => [i.label, breakdownIsCurrency ? formatCurrency(i.count) : i.count]),
      });
    }
    if (worklist && worklist.rows.length) {
      sections.push({ title: worklist.title, headers: worklist.columns, rows: worklist.rows.map((r) => r.map(formatCell)) });
    }
    return await generatePDFBlob({
      title: `${personaLabel} Dashboard Report`,
      subtitle: `${data?.scope_label || "Personal dashboard"} · ${currentDateLabel}`,
      filename: `${persona}_dashboard`,
      operator_name: user?.full_name || user?.username || "HospAI System",
      sections,
    } as StandardPdfPayload);
  };

  const handlePrint = async () => {
    if (exportStatus) return;
    setExportStatus("print");
    try {
      const { blob } = await handleGeneratePdf();
      printPDF(blob);
    } catch (error) {
      if (setNotice) reportError(setNotice, error as { message?: string }, "Unable to print the dashboard.");
    } finally {
      setExportStatus("");
    }
  };

  const greetingHour = new Date().getHours();
  const timeOfDayGreeting = greetingHour < 12 ? "Good morning" : greetingHour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (user?.full_name || user?.username || "").trim().split(/\s+/)[0];
  const headline = firstName ? `${timeOfDayGreeting}, ${firstName} 👋` : `${timeOfDayGreeting} 👋`;

  return (
    <section className="hosp-dashboard" data-persona={persona}>
      <div className="hosp-dashboard-top">
        <div>
          <p className="hosp-dashboard-page-title">{headline}</p>
          <p className="hosp-dashboard-page-subtitle">
            Your {personaLabel.toLowerCase()} dashboard for {currentDateLabel}
            {data?.scope_label ? ` · ${data.scope_label}` : ""}.
          </p>
        </div>
        <div className="hosp-dashboard-top-actions">
          <DateCalendarPicker value={dashboardDate} onChange={setDashboardDate} />
          <button type="button" className="hosp-dashboard-icon-btn" onClick={() => void handleManualRefresh()} disabled={refreshing} title="Refresh dashboard data">
            <span className="hosp-dashboard-action-icon">{refreshing ? "⏳" : "🔄"}</span>
            <span>
              {refreshing
                ? "Refreshing..."
                : lastRefreshedAt
                ? `Last Refresh: ${lastRefreshedAt.toLocaleString("en-IN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "Refresh"}
            </span>
          </button>
          <button type="button" className="hosp-dashboard-icon-btn" onClick={() => void handlePrint()} disabled={exportStatus !== "" || !data}>
            <span className="hosp-dashboard-action-icon">🖨️</span>
            <span>{exportStatus === "print" ? "Preparing..." : "Print"}</span>
          </button>
          <PdfExportDropdown
            setNotice={setNotice}
            onGenerate={async () => {
              const { blob, filename } = await handleGeneratePdf();
              return { blob, filename, title: `HospAI ${personaLabel} Dashboard`, text: `HospAI ${personaLabel.toLowerCase()} dashboard export` };
            }}
            renderTrigger={(onClick, pdfLoading) => (
              <button type="button" className="hosp-dashboard-icon-btn" onClick={onClick} disabled={pdfLoading || exportStatus !== "" || !data}>
                <span className="hosp-dashboard-action-icon">📥</span>
                <span>{pdfLoading ? "Preparing..." : "Download PDF ▼"}</span>
              </button>
            )}
          />
          <div className="hosp-dashboard-profile-wrap" ref={profileRef}>
            <button type="button" className="hosp-dashboard-user" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen} aria-haspopup="menu">
              <span className="hosp-dashboard-avatar">{(user?.full_name || user?.username || "U").slice(0, 2).toUpperCase()}</span>
              <div>
                <p className="hosp-dashboard-user-name">{user?.full_name || user?.username || "User"}</p>
                <p className="hosp-dashboard-user-role">{user?.job_role || personaLabel}</p>
              </div>
              <span className="hosp-dashboard-user-caret">⌄</span>
            </button>
            {profileOpen && (
              <div className="hosp-dashboard-profile-menu" role="menu">
                <button type="button" disabled>{user?.full_name || user?.username || "Signed in user"}</button>
                <button type="button" className="danger" onClick={onLogout}>Logout</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {data?.notice && (
        <div className="hosp-empty-pop" role="status" style={{ textAlign: "left" }}>
          <strong>{data.scope_label}</strong>
          <p>{data.notice}</p>
        </div>
      )}

      {/* KPI Row */}
      {kpis.length > 0 && (
        <div className="hosp-kpi-row">
          {kpis.map((k) => (
            <KpiCard
              key={k.key}
              icon={ICONS[k.icon || "users"] || ICONS.users}
              label={k.label}
              value={formatKpiValue(k)}
              sub={k.sub}
              iconBg={ACCENTS[k.accent || "indigo"] || ACCENTS.indigo}
              onClick={canOpen(k.page) ? () => go(k.page) : undefined}
            />
          ))}
        </div>
      )}

      {/* Quick Actions */}
      {quickActions.length > 0 && (
        <Card className="panel hosp-section-card">
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="hosp-quick-actions">
              {quickActions.map((action) => (
                <button key={action.page} className="hosp-quick-btn" onClick={() => go(action.page)}>
                  <span className="hosp-quick-icon">{action.icon}</span>
                  <span>{action.label}</span>
                  <span className="hosp-quick-arrow">›</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Tasks | Chart */}
      {(tasks.length > 0 || breakdown) && (
        <div className="hosp-row-4col">
          {tasks.length > 0 && (
            <Card className="panel hosp-section-card">
              <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <CardTitle>Pending Tasks</CardTitle>
                <span className="hosp-view-all" style={{ cursor: "default" }}>{formatNumber(pendingTotal)} open</span>
              </CardHeader>
              <CardContent>
                <div className="hosp-rev-list">
                  {tasks.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className="hosp-rev-row hosp-table-click"
                      onClick={() => go(t.page)}
                      disabled={!canOpen(t.page)}
                      title={canOpen(t.page) ? `Open ${t.label}` : undefined}
                    >
                      <span className="hosp-rev-icon">{t.icon || "•"}</span>
                      <span className="hosp-rev-label">{t.label}</span>
                      <span className="hosp-rev-value" style={t.severity === "high" ? { color: "#dc2626" } : undefined}>{formatNumber(t.count)}</span>
                    </button>
                  ))}
                </div>
                <div className="hosp-rev-total-row">
                  <span>Total Pending</span>
                  <span>{formatNumber(pendingTotal)}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {breakdown && (
            <Card className="panel hosp-section-card">
              <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <CardTitle>{breakdown.title}</CardTitle>
                {canOpen(breakdown.page) && <button className="hosp-view-all" onClick={() => go(breakdown.page)}>View Details</button>}
              </CardHeader>
              <CardContent>
                <div className="hosp-queue-layout">
                  <MiniDonut
                    segments={breakdownTotal > 0
                      ? donutSegments.filter((s) => s.pct > 0)
                      : [{ label: "empty", count: 0, color: "#e8f2f8", pct: 100 }]}
                    total={breakdownIsCurrency ? Math.round(breakdownTotal) : breakdownTotal}
                  />
                  <div className="hosp-queue-legend">
                    {donutSegments.map((s) => (
                      <div key={s.label} className="hosp-queue-leg-row">
                        <span className="hosp-queue-dot" style={{ background: s.color }} />
                        <span className="hosp-queue-leg-label">{s.label}</span>
                        <span className="hosp-queue-leg-count">
                          {breakdownIsCurrency ? formatCurrency(s.count) : formatNumber(s.count)}
                          {breakdownTotal > 0 ? ` (${Math.round(s.pct)}%)` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Nurse: assigned-patient list (never the whole ward) */}
      {data?.assigned_patients && (
        <Card className="panel hosp-section-card" data-testid="nurse-assigned-patients">
          <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <CardTitle>My Assigned Patients</CardTitle>
            {canOpen("nurse-station") && <button className="hosp-view-all" onClick={() => go("nurse-station")}>View All</button>}
          </CardHeader>
          <CardContent>
            {data.assigned_patients.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No patients are assigned to you.</p>
            ) : (
              <div className="hosp-revenue-pop-table" style={{ overflowX: "auto" }}>
                <div className="hosp-revenue-pop-head" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                  <span>Patient</span><span>Ward</span><span>Bed</span><span>Shift</span>
                </div>
                {data.assigned_patients.map((p) => (
                  <div key={`${p.patient_id}-${p.shift || ""}`} className="hosp-revenue-pop-row" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.patient_name || p.patient_id}</span>
                    <span>{p.ward || "-"}</span><span>{p.bed || "-"}</span><span>{p.shift || "Any"}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Worklist */}
      {worklist && (
        <Card className="panel hosp-section-card">
          <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <CardTitle>{worklist.title}</CardTitle>
            {canOpen(worklist.page) && <button className="hosp-view-all" onClick={() => go(worklist.page)}>View All</button>}
          </CardHeader>
          <CardContent>
            {worklist.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{worklist.empty || "Nothing to show."}</p>
            ) : (
              <div className="hosp-revenue-pop-table" style={{ overflowX: "auto" }}>
                <div className="hosp-revenue-pop-head" style={{ gridTemplateColumns: `repeat(${worklist.columns.length}, minmax(0, 1fr))` }}>
                  {worklist.columns.map((c) => <span key={c}>{c}</span>)}
                </div>
                {worklist.rows.map((row, idx) => (
                  <div key={idx} className="hosp-revenue-pop-row" style={{ gridTemplateColumns: `repeat(${worklist.columns.length}, minmax(0, 1fr))` }}>
                    {row.map((cell, cIdx) => (
                      <span key={cIdx} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{formatCell(cell)}</span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading && !data ? <p className="muted" style={{ marginTop: "0.5rem" }}>Loading your dashboard…</p> : null}
    </section>
  );
}
