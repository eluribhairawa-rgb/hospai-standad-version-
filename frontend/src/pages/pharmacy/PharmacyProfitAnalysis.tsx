import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import "./pharmacyProfit.css";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

type ProfitRow = {
  medicine_key: string;
  medicine_name: string;
  manufacturer: string | null;
  category: string | null;
  in_stock_qty: number;
  cost_price: number | null;
  cost_source: "grn" | "batch" | null;
  last_grn_no: string | null;
  last_grn_date: string | null;
  sale_price: number | null;
  sale_price_source: string | null;
  unit_margin: number | null;
  margin_pct: number | null;
  below_cost: boolean;
  qty_sold: number;
  qty_returned: number;
  net_qty: number;
  net_revenue: number;
  avg_realized_price: number | null;
  cogs: number | null;
  profit_earned: number | null;
};

type ChartPoint = { medicine_name: string; profit_earned: number; qty_sold: number; net_revenue: number };

type ProfitResponse = {
  period: { from: string; to: string };
  summary: {
    has_sales: boolean;
    profit_period: number;
    profit_today: number;
    net_revenue_period: number;
    gross_margin_pct: number | null;
    avg_supplier_margin_pct: number | null;
    margin_medicine_count: number;
    top_medicine: { medicine_name: string; profit_earned: number; qty_sold: number } | null;
    near_expiry: { margin_at_risk: number; cost_at_risk: number; batch_count: number; window_days: number };
    missing_cost_count: number;
    below_cost_count: number;
  };
  rows: ProfitRow[];
  total_rows: number;
  page: number;
  page_size: number;
  pages: number;
  filtered_profit: number;
  chart: ChartPoint[];
  filters: { manufacturer: string[]; category: string[] };
};

type Preset = "today" | "mtd" | "30d" | "custom";
type SortKey = "medicine_name" | "cost_price" | "sale_price" | "qty_sold" | "profit_earned";

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function presetRange(preset: Exclude<Preset, "custom">): { from: string; to: string } {
  const today = new Date();
  if (preset === "today") return { from: isoDate(today), to: isoDate(today) };
  if (preset === "30d") {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { from: isoDate(start), to: isoDate(today) };
  }
  return { from: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDate(today) };
}

const inr = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined
    ? "—"
    : `${v < 0 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export default function PharmacyProfitAnalysis({ setNotice, onNavigate }: Props) {
  const [preset, setPreset] = useState<Preset>("mtd");
  const [range, setRange] = useState(() => presetRange("mtd"));
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"manufacturer" | "category">("manufacturer");
  const [groupValue, setGroupValue] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("profit_earned");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ProfitResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce typing so each keystroke doesn't hit the API.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      from_date: range.from,
      to_date: range.to,
      sort_by: sortBy,
      sort_dir: sortDir,
      page: String(page),
      page_size: String(pageSize),
    });
    if (search) params.set("q", search);
    if (groupValue) {
      params.set("group_by", groupBy);
      params.set("group_value", groupValue);
    }
    return params.toString();
  }, [range, sortBy, sortDir, page, pageSize, search, groupBy, groupValue]);

  useEffect(() => {
    if (!range.from || !range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ProfitResponse>(`/api/pharmacy/profit-analysis?${query}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as { message?: string })?.message || "Could not load profit analysis.");
        reportError(setNotice, err as { status?: number; message?: string }, "Could not load profit analysis.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, setNotice]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
    setPage(1);
  };

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortBy(key);
      setSortDir(key === "medicine_name" ? "asc" : "desc");
    }
    setPage(1);
  };

  const summary = data?.summary;
  const groupOptions = data?.filters[groupBy] ?? [];
  const chartMax = Math.max(1, ...(data?.chart ?? []).map((c) => Math.abs(c.profit_earned)));
  const firstRow = data && data.total_rows ? (data.page - 1) * data.page_size + 1 : 0;
  const lastRow = data ? Math.min(data.total_rows, data.page * data.page_size) : 0;
  const periodLabel = data ? (data.period.from === data.period.to ? fmtDate(data.period.from) : `${fmtDate(data.period.from)} – ${fmtDate(data.period.to)}`) : "";

  const sortHeader = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th
      className={`ppa-sortable ${sortBy === key ? "is-sorted" : ""}`}
      style={{ textAlign: align }}
      aria-sort={sortBy === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => toggleSort(key)}>
        {label}
        <span className="ppa-sort-arrow">{sortBy === key ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <div className="ppa-root">
      {/* Header */}
      <div className="hosp-dashboard-top ppa-top">
        <div>
          <div className="hosp-dashboard-eyebrow">
            <span>HospAI</span>
            <span>/</span>
            <span>Pharmacy</span>
            <span>/</span>
            <span style={{ color: "#0f172a", fontWeight: 700 }}>Profit &amp; Loss Analysis</span>
          </div>
          <h1 className="ppa-title">Medicine Profit Analysis</h1>
          <p className="ppa-subtitle">
            Cost from the latest verified GRN, sale price from the live dispensing rate, profit from actual OP/IP sales net of returns.
          </p>
        </div>
        <div className="ppa-period">
          <div className="ppa-segment" role="group" aria-label="Period">
            {([["today", "Today"], ["mtd", "Month to date"], ["30d", "Last 30 days"], ["custom", "Custom"]] as [Preset, string][]).map(([key, label]) => (
              <button key={key} type="button" className={preset === key ? "active" : ""} onClick={() => choosePreset(key)}>
                {label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="ppa-dates">
              <input type="date" aria-label="From date" value={range.from} max={range.to}
                onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setPage(1); }} />
              <span>to</span>
              <input type="date" aria-label="To date" value={range.to} min={range.from}
                onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setPage(1); }} />
            </div>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="hosp-kpi-row ppa-kpis">
        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#1e3a8a,#0b2e6b)" } as CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#1e3a8a,#0b2e6b)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Total Profit {preset === "mtd" ? "(MTD)" : "(Period)"}</p>
            <h3 className={`hosp-kpi-value ${summary && summary.profit_period < 0 ? "ppa-neg" : ""}`}>{summary ? inr(summary.profit_period, 0) : "…"}</h3>
            <span className="hosp-kpi-sub">
              Today: {summary ? inr(summary.profit_today, 0) : "…"}
              {summary?.gross_margin_pct !== null && summary?.gross_margin_pct !== undefined ? ` · ${summary.gross_margin_pct}% margin` : ""}
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#0ea5e9,#0369a1)" } as CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#0ea5e9,#0369a1)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Avg Supplier Margin</p>
            <h3 className="hosp-kpi-value">{summary ? (summary.avg_supplier_margin_pct === null ? "—" : `${summary.avg_supplier_margin_pct}%`) : "…"}</h3>
            <span className="hosp-kpi-sub" title="Median of (sale price − GRN cost) ÷ sale price across priced medicines">
              {summary ? `Median of ${summary.margin_medicine_count} medicines` : ""}
              {summary && summary.below_cost_count > 0 ? <strong className="ppa-warn"> · {summary.below_cost_count} below cost</strong> : null}
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#10b981,#047857)" } as CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#10b981,#047857)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Top Performing Medicine</p>
            <h3 className="hosp-kpi-value ppa-kpi-name" title={summary?.top_medicine?.medicine_name}>{summary ? summary.top_medicine?.medicine_name ?? "—" : "…"}</h3>
            <span className="hosp-kpi-sub">
              {summary?.top_medicine ? `${inr(summary.top_medicine.profit_earned, 0)} profit · ${summary.top_medicine.qty_sold} units` : summary ? "No profitable sales yet" : ""}
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#f59e0b,#b45309)" } as CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#f59e0b,#b45309)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Near Expiry Margin Loss</p>
            <h3 className="hosp-kpi-value">{summary ? inr(summary.near_expiry.margin_at_risk, 0) : "…"}</h3>
            <span className="hosp-kpi-sub">
              {summary
                ? summary.near_expiry.batch_count
                  ? `${summary.near_expiry.batch_count} batches ≤${summary.near_expiry.window_days}d · ${inr(summary.near_expiry.cost_at_risk, 0)} cost at risk`
                  : `No stock expiring within ${summary.near_expiry.window_days} days`
                : ""}
            </span>
          </div>
        </div>
      </div>

      {summary && !summary.has_sales && (
        <div className="ppa-empty-banner" role="status">
          <strong>No profit records found for this period.</strong> No medicines were sold or returned between {periodLabel}. In-stock medicines are still listed with their unit margins.
        </div>
      )}
      {summary && summary.missing_cost_count > 0 && (
        <div className="ppa-info-banner" role="status">
          {summary.missing_cost_count} medicine{summary.missing_cost_count > 1 ? "s were" : " was"} sold without any GRN or batch cost on record, so {summary.missing_cost_count > 1 ? "their" : "its"} profit shows as “—” and is left out of the totals.{" "}
          <button type="button" className="ppa-link" onClick={() => onNavigate("pharmacy-purchases")}>Record a GRN</button>
        </div>
      )}

      <div className="ppa-grid">
        {/* Table */}
        <section className="ppa-panel ppa-table-panel">
          <div className="ppa-toolbar">
            <div className="ppa-search">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input
                type="search"
                placeholder="Search patient, medicine, invoice..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label="Search patient, medicine, invoice"
              />
            </div>
            <div className="ppa-filter">
              <select
                aria-label="View by"
                value={groupBy}
                onChange={(e) => { setGroupBy(e.target.value as "manufacturer" | "category"); setGroupValue(""); setPage(1); }}
              >
                <option value="manufacturer">View by Manufacturer</option>
                <option value="category">View by Category</option>
              </select>
              <select aria-label={`Filter by ${groupBy}`} value={groupValue} onChange={(e) => { setGroupValue(e.target.value); setPage(1); }}>
                <option value="">All {groupBy === "manufacturer" ? "manufacturers" : "categories"}</option>
                {groupOptions.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={`ppa-table-wrap ${loading ? "is-loading" : ""}`}>
            <table className="ppa-table">
              <thead>
                <tr>
                  {sortHeader("medicine_name", "Medicine Name", "left")}
                  {sortHeader("cost_price", "Cost Price (₹)")}
                  {sortHeader("sale_price", "Sale Price (₹)")}
                  {sortHeader("qty_sold", "Units Sold")}
                  {sortHeader("profit_earned", "Profit Earned (₹)")}
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((r) => (
                  <tr key={r.medicine_key}>
                    <td>
                      <div className="ppa-med">{r.medicine_name}</div>
                      <div className="ppa-sub">
                        {[r.manufacturer, r.category].filter(Boolean).join(" · ") || "—"} · {r.in_stock_qty} in stock
                      </div>
                    </td>
                    <td className="num">
                      <div>{inr(r.cost_price)}</div>
                      <div className="ppa-sub" title={r.last_grn_date ? `Received ${fmtDate(r.last_grn_date)}` : undefined}>
                        {r.cost_source === "grn" ? r.last_grn_no || "Latest GRN" : r.cost_source === "batch" ? "Batch cost" : "No cost on record"}
                      </div>
                    </td>
                    <td className="num">
                      <div>{inr(r.sale_price)}</div>
                      {r.margin_pct !== null && (
                        <div className={`ppa-sub ${r.below_cost ? "ppa-neg" : ""}`}>
                          {r.below_cost ? "Below cost · " : ""}{inr(r.unit_margin)}/unit ({r.margin_pct}%)
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <div>{r.qty_sold}</div>
                      {r.qty_returned > 0 && <div className="ppa-sub">{r.qty_returned} returned</div>}
                    </td>
                    <td className="num">
                      <div className={`ppa-profit ${r.profit_earned !== null && r.profit_earned < 0 ? "ppa-neg" : r.profit_earned ? "ppa-pos" : ""}`}>
                        {inr(r.profit_earned)}
                      </div>
                      {r.qty_sold > 0 && <div className="ppa-sub">on {inr(r.net_revenue, 0)} revenue</div>}
                    </td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="ppa-empty-cell">
                      {search || groupValue
                        ? "No medicines match the current search or filter."
                        : "No profit records found for this period."}
                    </td>
                  </tr>
                )}
                {!data && !error && (
                  <tr><td colSpan={5} className="ppa-empty-cell">Loading profit data…</td></tr>
                )}
                {!data && error && (
                  <tr><td colSpan={5} className="ppa-empty-cell ppa-neg">{error}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {data && data.total_rows > 0 && (
            <div className="ppa-pager">
              <span>
                {firstRow}–{lastRow} of {data.total_rows} medicines
                {(search || groupValue) && <> · filtered profit <strong>{inr(data.filtered_profit, 0)}</strong></>}
              </span>
              <div className="ppa-pager-controls">
                <select aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
                </select>
                <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} aria-label="Previous page">‹</button>
                <span>Page {data.page} of {data.pages}</span>
                <button type="button" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)} aria-label="Next page">›</button>
              </div>
            </div>
          )}
        </section>

        {/* Chart */}
        <aside className="ppa-panel ppa-chart-panel">
          <div className="ppa-panel-head">
            <h2>Profit Trends – Top Medicines</h2>
            <span>{periodLabel}</span>
          </div>
          {data && data.chart.length > 0 ? (
            <ul className="ppa-bars">
              {data.chart.map((c) => {
                const pct = Math.max(2, (Math.abs(c.profit_earned) / chartMax) * 100);
                return (
                  <li key={c.medicine_name} title={`${c.medicine_name}: ${inr(c.profit_earned)} profit on ${c.qty_sold} units (${inr(c.net_revenue)} revenue)`}>
                    <div className="ppa-bar-label">
                      <span className="ppa-bar-name">{c.medicine_name}</span>
                      <span className={`ppa-bar-value ${c.profit_earned < 0 ? "ppa-neg" : ""}`}>{inr(c.profit_earned, 0)}</span>
                    </div>
                    <div className="ppa-bar-track">
                      <div className={`ppa-bar-fill ${c.profit_earned < 0 ? "is-neg" : ""}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="ppa-sub">{c.qty_sold} units sold</div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="ppa-chart-empty">{data ? "No profit records found for this period." : "Loading…"}</div>
          )}
        </aside>
      </div>
    </div>
  );
}
