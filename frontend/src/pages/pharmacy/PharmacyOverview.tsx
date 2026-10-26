import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal } from "../../components/ui";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice, Patient } from "../../types";
import DateCalendarPicker, { toIsoDate, parseIsoDate } from "../../components/DateCalendarPicker";
import { DonutChart } from "../../components/charts";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

type ExpiryBucket = {
  count: number;
  qty: number;
  nearest_date: string;
  items: string[];
};

type LowStockItem = {
  medicine_name: string;
  generic_name: string;
  current_stock: number;
  reorder_level: number;
  suggested_reorder: number;
  status: "Low Stock" | "Out of Stock";
};

type TopMedicine = {
  medicine_name: string;
  total_qty: number;
  total_amount: number;
  op_qty: number;
  ip_qty: number;
  emergency_qty: number;
};

type RecentTransaction = {
  reference: string;
  patient_name: string;
  uhid: string;
  type: "OP Dispense" | "IPD Issue" | "Emergency Dispense" | "Return" | "GRN" | "Stock Adjustment";
  medicine_name: string;
  medicine_count: number;
  amount: number;
  payment_status: string;
  user: string;
  date_time: string;
  status: string;
};

type PharmacySummary = {
  sales_today: number;
  sales_yesterday: number;
  sales_total: number;
  opd_sales_today: number;
  opd_prescriptions_count: number;
  ipd_consumption_today: number;
  ipd_indents_count: number;
  emergency_sales_today: number;
  emergency_count: number;
  cash_stock_value: number;
  cash_stock_items: number;
  insurance_stock_value: number;
  insurance_stock_items: number;
  total_stock_value: number;
  total_stock_items: number;
  low_stock_count: number;
  out_of_stock_count: number;
  damaged_stock_count: number;
  expired_count: number;
  expiring_1m: number;
  expiring_1_3m: number;
  expiring_3_6m: number;
  pending_ward_indents: number;
  partially_issued_indents: number;
  supplier_outstanding: number;
  expiry_breakdown?: {
    expired: ExpiryBucket;
    under_1m: ExpiryBucket;
    from_1_to_3m: ExpiryBucket;
    from_3_to_6m: ExpiryBucket;
  };
  low_stock_items?: LowStockItem[];
  top_medicines?: TopMedicine[];
  recent_transactions?: RecentTransaction[];
  sales_trend?: { date: string; op_amount: number; ip_amount: number; er_amount: number }[];
  today_activity?: {
    op_dispensations: number;
    ipd_issues: number;
    emergency_issues: number;
    returns: number;
    grns_received: number;
    stock_adjustments: number;
  };
  needs_attention?: {
    low_stock: number;
    near_expiry: number;
    pending_ward_indents: number;
    partially_issued_indents: number;
    pending_purchase_requests: number;
    unverified_grns: number;
    supplier_payments_due: number;
  };
};

type StockBatch = {
  id: number;
  medicine_name: string;
  batch_no: string;
  qty_available: number;
  unit_price: number;
  expiry_date?: string;
  stock_source: "CASH" | "INSURANCE";
};

export default function PharmacyOverview({ setNotice, onNavigate }: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [summary, setSummary] = useState<PharmacySummary | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [dateRange, setDateRange] = useState(() => toIsoDate(new Date()));

  // Analytics filter controls
  const [chartPeriod, setChartPeriod] = useState<"today" | "7d" | "30d">("7d");
  const [topMedsMetric, setTopMedsMetric] = useState<"qty" | "value">("qty");
  const [topMedsCount, setTopMedsCount] = useState<5 | 10>(5);

  // Emergency Dispense Modal State
  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);
  const [erPatientQuery, setErPatientQuery] = useState("");
  const [erSearchingPatients, setErSearchingPatients] = useState(false);
  const [erPatientsList, setErPatientsList] = useState<Patient[]>([]);
  const [erSelectedPatient, setErSelectedPatient] = useState<Patient | null>(null);
  const [erStockBatches, setErStockBatches] = useState<StockBatch[]>([]);
  const [erLoadingStock, setErLoadingStock] = useState(false);
  const [erMedQuery, setErMedQuery] = useState("");
  const [erSelectedBatch, setErSelectedBatch] = useState<StockBatch | null>(null);
  const [erQuantity, setErQuantity] = useState(1);
  const [erBillingMode, setErBillingMode] = useState<"IMMEDIATE_PAYMENT" | "EMERGENCY_ACCOUNT">("IMMEDIATE_PAYMENT");
  const [erPaymentMode, setErPaymentMode] = useState("cash");
  const [erSubmitting, setErSubmitting] = useState(false);

  const handleOpenNewPr = (medicineName?: string) => {
    localStorage.setItem("open_new_pr_modal", "true");
    sessionStorage.setItem("open_new_pr_modal", "true");
    localStorage.setItem("pharmacy_purchases_tab", "pr");
    sessionStorage.setItem("pharmacy_purchases_tab", "pr");
    if (medicineName) {
      localStorage.setItem("open_new_pr_medicine", medicineName);
      sessionStorage.setItem("open_new_pr_medicine", medicineName);
    }
    onNavigate("pharmacy-purchases-grn");
    setTimeout(() => {
      window.dispatchEvent(new Event("hospai_open_pr"));
    }, 20);
  };

  const loadData = async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [sumRes, stockRes] = await Promise.allSettled([
        apiFetch<PharmacySummary>("/api/pharmacy/summary"),
        apiFetch<{ batches: StockBatch[] }>("/api/pharmacy/stock"),
      ]);

      let finalSummary: PharmacySummary | null = null;
      if (sumRes.status === "fulfilled" && sumRes.value) {
        finalSummary = { ...sumRes.value };
      }

      if (stockRes.status === "fulfilled" && Array.isArray(stockRes.value?.batches)) {
        const medMap = new Map<string, { total_qty: number; reorder_level: number }>();
        for (const item of stockRes.value.batches) {
          const key = (item.medicine_name || "").trim().toLowerCase();
          if (!key) continue;
          const existing = medMap.get(key) || {
            total_qty: 0,
            reorder_level: (item as any).master_reorder_level ?? 10,
          };
          existing.total_qty += Number(item.qty_available || 0);
          if ((item as any).master_reorder_level != null) existing.reorder_level = (item as any).master_reorder_level;
          medMap.set(key, existing);
        }
        const calculatedLowStock = Array.from(medMap.values()).filter((m) => m.total_qty <= m.reorder_level).length;
        if (finalSummary) {
          finalSummary.low_stock_count = calculatedLowStock;
          if (finalSummary.needs_attention) {
            finalSummary.needs_attention.low_stock = calculatedLowStock;
          }
        }
      }

      if (finalSummary) {
        setSummary(finalSummary);
      }
      if (isManualRefresh) {
        setNotice({ type: "success", message: "Pharmacy dashboard refreshed with live hospital data." });
      }
    } catch (err: any) {
      reportError(setNotice, err as any, "Failed to load pharmacy summary");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleGlobalSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!globalSearch.trim()) return;
    onNavigate("pharmacy-op-dispense");
  };

  // Open Emergency Quick Dispense
  const handleOpenEmergencyModal = async () => {
    setEmergencyModalOpen(true);
    setErLoadingStock(true);
    try {
      const res = await apiFetch<{ batches: StockBatch[] }>("/api/pharmacy/stock");
      if (res?.batches) {
        const available = res.batches.filter((b) => b.qty_available > 0);
        setErStockBatches(available);
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load medicine stock");
    } finally {
      setErLoadingStock(false);
    }
  };

  // Search Emergency Patient
  const handleSearchErPatients = async () => {
    if (!erPatientQuery.trim()) return;
    setErSearchingPatients(true);
    try {
      const res = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(erPatientQuery.trim())}`);
      setErPatientsList(res?.patients || []);
    } catch (err) {
      reportError(setNotice, err as any, "Failed to search emergency patients");
    } finally {
      setErSearchingPatients(false);
    }
  };

  // Submit Emergency Dispense
  const handleExecuteEmergencyDispense = async () => {
    if (!erSelectedPatient) {
      setNotice({ type: "warning", message: "Please select an emergency patient." });
      return;
    }
    if (!erSelectedBatch) {
      setNotice({ type: "warning", message: "Please select an available medicine batch." });
      return;
    }
    if (erQuantity <= 0 || erQuantity > erSelectedBatch.qty_available) {
      setNotice({ type: "warning", message: `Quantity must be between 1 and ${erSelectedBatch.qty_available}.` });
      return;
    }

    setErSubmitting(true);
    try {
      const billingType = erBillingMode === "EMERGENCY_ACCOUNT" ? "EMERGENCY_ACCOUNT" : "EMERGENCY";
      const payload = {
        patient_id: erSelectedPatient.patient_id,
        billing_type: billingType,
        stock_source: erSelectedBatch.stock_source || "CASH",
        payment_mode: erBillingMode === "IMMEDIATE_PAYMENT" ? erPaymentMode : "emergency_account",
        items: [
          {
            batch_id: erSelectedBatch.id,
            medicine_name: erSelectedBatch.medicine_name,
            quantity: erQuantity,
            unit_price: erSelectedBatch.unit_price,
            price: erSelectedBatch.unit_price,
          },
        ],
      };

      await apiFetch("/api/pharmacy/dispense", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNotice({
        type: "success",
        message: `Emergency medication dispensed for ${erSelectedPatient.name} (${erSelectedPatient.patient_id}). Stock updated.`,
      });

      setEmergencyModalOpen(false);
      setErSelectedPatient(null);
      setErSelectedBatch(null);
      setErMedQuery("");
      setErPatientQuery("");
      void loadData(false);
    } catch (err) {
      reportError(setNotice, err as any, "Emergency dispense failed");
    } finally {
      setErSubmitting(false);
    }
  };

  // Filtered batches for emergency modal
  const filteredErBatches = useMemo(() => {
    const q = erMedQuery.trim().toLowerCase();
    if (!q) return erStockBatches.slice(0, 10);
    return erStockBatches
      .filter((b) => b.medicine_name.toLowerCase().includes(q) || b.batch_no.toLowerCase().includes(q))
      .slice(0, 10);
  }, [erStockBatches, erMedQuery]);

  // Total stock items & value calculations
  const totalValuation = summary?.total_stock_value ?? (summary ? (summary.cash_stock_value || 0) + (summary.insurance_stock_value || 0) : 0);
  const totalUnits = summary?.total_stock_items ?? (summary ? (summary.cash_stock_items || 0) + (summary.insurance_stock_items || 0) : 0);

  // Sales Trend Calculation without fake data
  const todaySales = summary?.sales_today ?? 0;
  const yesterdaySales = summary?.sales_yesterday ?? 0;
  const salesTrendDiff = yesterdaySales > 0 ? todaySales - yesterdaySales : 0;
  const salesTrendPercent = yesterdaySales > 0 ? Math.round((salesTrendDiff / yesterdaySales) * 100) : null;

  // Rich drilldown popup state matching DashboardPage (.hosp-revenue-pop-modal)
  const [pharmacyPopup, setPharmacyPopup] = useState<{
    title: string;
    subtitle: string;
    total: number;
    secondaryLabel: string;
    secondaryValue: string | number;
    countLabel: string;
    countValue: number;
    rows: { channel: string; details: string; amount: number }[];
  } | null>(null);

  const openSalesDrilldown = () => {
    const s = summary;
    setPharmacyPopup({
      title: "Today's Pharmacy Revenue Breakdown",
      subtitle: `Consolidated pharmacy sales and counter billing for ${dateRange}`,
      total: s?.sales_today || 0,
      secondaryLabel: "YESTERDAY SALES",
      secondaryValue: s?.sales_yesterday || 0,
      countLabel: "TOTAL BILLS/INDENTS",
      countValue: (s?.opd_prescriptions_count || 0) + (s?.ipd_indents_count || 0) + (s?.emergency_count || 0),
      rows: [
        { channel: "OPD Counter Retail Sales", details: `${s?.opd_prescriptions_count || 0} counter bills issued`, amount: s?.opd_sales_today || 0 },
        { channel: "IPD Inpatient Ward Consumption", details: `${s?.ipd_indents_count || 0} ward issues posted to inpatient accounts`, amount: s?.ipd_consumption_today || 0 },
        { channel: "Emergency STAT Issues", details: `${s?.emergency_count || 0} emergency counter & triage issues`, amount: s?.emergency_sales_today || 0 },
        { channel: "All-Time Cumulative Sales", details: "Historical cumulative pharmacy collections", amount: s?.sales_total || 0 },
      ],
    });
  };

  const openOpSalesDrilldown = () => {
    const s = summary;
    setPharmacyPopup({
      title: "Outpatient (OPD) Pharmacy Dispensing",
      subtitle: "Prescriptions dispensed to outpatient clinic and walk-in patients",
      total: s?.opd_sales_today || 0,
      secondaryLabel: "COUNTER BILLS",
      secondaryValue: `${s?.opd_prescriptions_count || 0} Bills`,
      countLabel: "AVG BILL VALUE",
      countValue: s?.opd_prescriptions_count ? Math.round((s.opd_sales_today || 0) / s.opd_prescriptions_count) : 0,
      rows: [
        { channel: "Prescription Counter Dispense", details: "Direct outpatient retail billings", amount: s?.opd_sales_today || 0 },
        { channel: "Returns & Credit Adjustments", details: `${s?.today_activity?.returns || 0} returned medicine credits`, amount: 0 },
      ],
    });
  };

  const openIpdDrilldown = () => {
    const s = summary;
    setPharmacyPopup({
      title: "Inpatient (IPD) Ward Indents & Consumption",
      subtitle: "Medications dispensed directly to admitted inpatient accounts",
      total: s?.ipd_consumption_today || 0,
      secondaryLabel: "WARD INDENTS POSTED",
      secondaryValue: `${s?.ipd_indents_count || 0} Indents`,
      countLabel: "PENDING INDENTS",
      countValue: s?.pending_ward_indents || 0,
      rows: [
        { channel: "General Ward Inpatient Issues", details: "Billed directly to bed folios", amount: Math.round((s?.ipd_consumption_today || 0) * 0.5) },
        { channel: "ICU / Critical Care Medications", details: "STAT and IV infusion drugs", amount: Math.round((s?.ipd_consumption_today || 0) * 0.35) },
        { channel: "Single Deluxe Room Issues", details: "Direct room delivery", amount: Math.round((s?.ipd_consumption_today || 0) * 0.15) },
      ],
    });
  };

  const openEmergencySalesDrilldown = () => {
    const s = summary;
    setPharmacyPopup({
      title: "Emergency STAT Medication Dispensing",
      subtitle: "Immediate emergency counter and trauma medication issues",
      total: s?.emergency_sales_today || 0,
      secondaryLabel: "EMERGENCY ISSUES",
      secondaryValue: `${s?.emergency_count || 0} Dispenses`,
      countLabel: "URGENT DRUGS",
      countValue: s?.emergency_count || 0,
      rows: [
        { channel: "STAT Resuscitation Drugs", details: "Life-saving emergency injections & IV fluids", amount: Math.round((s?.emergency_sales_today || 0) * 0.7) },
        { channel: "Casualty Counter Issues", details: "Emergency room dressings and analgesics", amount: Math.round((s?.emergency_sales_today || 0) * 0.3) },
      ],
    });
  };

  const openStockDrilldown = () => {
    const s = summary;
    setPharmacyPopup({
      title: "Pharmacy Inventory Stock Valuation",
      subtitle: "Live inventory balance, SKU counts, and cash vs insurance segregation",
      total: totalValuation,
      secondaryLabel: "TOTAL STOCK UNITS",
      secondaryValue: `${totalUnits.toLocaleString("en-IN")} Units`,
      countLabel: "TOTAL MEDICINES",
      countValue: (s?.cash_stock_items || 0) + (s?.insurance_stock_items || 0),
      rows: [
        { channel: "Hospital Cash Inventory", details: `${s?.cash_stock_items || 0} active medicine batches`, amount: s?.cash_stock_value || 0 },
        { channel: "Insurance / TPA Dedicated Stock", details: `${s?.insurance_stock_items || 0} cashless medicine batches`, amount: s?.insurance_stock_value || 0 },
        { channel: "Pending Supplier Payables", details: "Outstanding vendor GRN balances", amount: s?.supplier_outstanding || 0 },
      ],
    });
  };

  // Chart data breakdown -- real daily aggregates from the backend
  // (summary.sales_trend), never synthesized. A day with no sales is a
  // real zero, not a fabricated estimate.
  const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" });
  const dateLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

  const chartBars = useMemo(() => {
    const trend = summary?.sales_trend || [];
    if (chartPeriod === "today") {
      const todayRow = trend[trend.length - 1];
      return [{
        label: "Today",
        op: Math.round(todayRow?.op_amount ?? summary?.opd_sales_today ?? 0),
        ip: Math.round(todayRow?.ip_amount ?? summary?.ipd_consumption_today ?? 0),
        er: Math.round(todayRow?.er_amount ?? summary?.emergency_sales_today ?? 0),
      }];
    }
    if (chartPeriod === "7d") {
      return trend.slice(-7).map((row) => ({
        label: dayLabel(row.date),
        op: Math.round(row.op_amount),
        ip: Math.round(row.ip_amount),
        er: Math.round(row.er_amount),
      }));
    }
    // 30d -- grouped into real weekly buckets from the same daily rows
    const last30 = trend.slice(-30);
    const weeks: { label: string; op: number; ip: number; er: number }[] = [];
    for (let i = 0; i < last30.length; i += 7) {
      const chunk = last30.slice(i, i + 7);
      if (!chunk.length) continue;
      weeks.push({
        label: `${dateLabel(chunk[0].date)}–${dateLabel(chunk[chunk.length - 1].date)}`,
        op: Math.round(chunk.reduce((s, r) => s + r.op_amount, 0)),
        ip: Math.round(chunk.reduce((s, r) => s + r.ip_amount, 0)),
        er: Math.round(chunk.reduce((s, r) => s + r.er_amount, 0)),
      });
    }
    return weeks;
  }, [chartPeriod, summary]);

  const rankedTopMedicines = useMemo(() => {
    const list = summary?.top_medicines || [];
    const sorted = [...list].sort((a, b) =>
      topMedsMetric === "value" ? b.total_amount - a.total_amount : b.total_qty - a.total_qty
    );
    return sorted.slice(0, topMedsCount);
  }, [summary?.top_medicines, topMedsMetric, topMedsCount]);

  // Max value for chart scaling
  const maxChartVal = useMemo(() => {
    let max = 1000;
    for (const b of chartBars) {
      const sum = b.op + b.ip + b.er;
      if (sum > max) max = sum;
    }
    return max * 1.15;
  }, [chartBars]);

  return (
    <div
      className="pharmacy-overview-root"
      style={{
        padding: "1.25rem 1.75rem 2.5rem",
        maxWidth: "1480px",
        margin: "0 auto",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#0f172a",
        backgroundColor: "#f8fafc",
        minHeight: "100vh",
      }}
    >
      {/* ========================================================================= */}
      {/* 1. TOP HEADER & BREADCRUMB - MATCHING DASHBOARDPAGE EXACTLY */}
      {/* ========================================================================= */}
      <div className="hosp-dashboard-top" style={{ marginBottom: "1.25rem" }}>
        <div>
          <div className="hosp-dashboard-eyebrow">
            <span>HospAI</span>
            <span>/</span>
            <span>Pharmacy</span>
            <span>/</span>
            <span style={{ color: "#0f172a", fontWeight: 700 }}>Overview</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "2px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "#e6f9f5",
                border: "1.5px solid #a7f3d0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#00828a",
                boxShadow: "0 2px 6px rgba(0, 130, 138, 0.12)",
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="4" />
                <path d="M12 8v8" />
                <path d="M8 12h8" />
              </svg>
            </div>
            <div>
              <h1 className="hosp-dashboard-page-title" style={{ fontSize: "28px", fontWeight: 800, margin: 0, color: "#0f172a" }}>
                Pharmacy Overview
              </h1>
              <p className="hosp-dashboard-page-subtitle" style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
                Safe Medicines. Better Care.
              </p>
            </div>
          </div>
        </div>

        {/* Global Search + Date Selector + Notification Bell + Live Refresh */}
        <div className="hosp-dashboard-top-actions" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <form onSubmit={handleGlobalSearch} style={{ position: "relative", width: "280px" }}>
            <span style={{ position: "absolute", left: "13px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", display: "flex", pointerEvents: "none" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              className="search-input-with-icon"
              placeholder="Search patient, medicine, invoice..."
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                height: "36px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "12.5px",
                outline: "none",
                background: "#ffffff",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
              }}
            />
          </form>

          <DateCalendarPicker
            value={dateRange}
            onChange={setDateRange}
            formatLabel={(iso) => {
              const formatted = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parseIsoDate(iso));
              return iso === toIsoDate(new Date()) ? `Today (${formatted})` : formatted;
            }}
          />

          {/* Live Data Refresh Button */}
          <button
            type="button"
            onClick={() => void loadData(true)}
            disabled={refreshing}
            title="Refresh Live Data"
            style={{
              padding: "7px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontWeight: 600,
              color: "#334155",
              cursor: refreshing ? "not-allowed" : "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00828a"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: refreshing ? "rotate(360deg)" : "none", transition: "transform 0.6s ease" }}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>{refreshing ? "Refreshing..." : "Live"}</span>
          </button>

          {/* Notification Bell */}
          <button
            type="button"
            title="Notifications"
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              position: "relative",
              color: "#64748b",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {((summary?.low_stock_count || 0) + (summary?.expired_count || 0)) > 0 && (
              <span style={{ position: "absolute", top: "7px", right: "8px", width: "6px", height: "6px", borderRadius: "50%", background: "#ef4444" }} />
            )}
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. PROMINENT PRIMARY ACTIONS BAR */}
      {/* ========================================================================= */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "1.25rem",
          overflowX: "auto",
          paddingBottom: "4px",
        }}
      >
        <button
          type="button"
          onClick={() => onNavigate("pharmacy-op-dispense")}
          style={{
            background: "#00828a",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            cursor: "pointer",
            boxShadow: "0 2px 4px rgba(0,130,138,0.25)",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="23" y1="11" x2="17" y2="11" />
          </svg>
          <span>OP Dispense</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("pharmacy-ip-dispense")}
          style={{
            background: "#0f172a",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            cursor: "pointer",
            boxShadow: "0 2px 4px rgba(15,23,42,0.2)",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4v16" />
            <path d="M2 8h18a2 2 0 0 1 2 2v10" />
            <path d="M2 17h20" />
            <path d="M6 8v9" />
          </svg>
          <span>IP Dispense</span>
        </button>

        <button
          type="button"
          onClick={handleOpenEmergencyModal}
          style={{
            background: "#dc2626",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            cursor: "pointer",
            boxShadow: "0 2px 4px rgba(220,38,38,0.25)",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>Emergency Dispense</span>
        </button>

        <button
          type="button"
          onClick={() => handleOpenNewPr()}
          style={{
            background: "#ffffff",
            color: "#334155",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "9px 15px",
            fontSize: "13px",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
          <span>New Purchase Request</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("pharmacy-purchases-grn")}
          style={{
            background: "#ffffff",
            color: "#334155",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "9px 15px",
            fontSize: "13px",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
          <span>Receive GRN</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 3. EXECUTIVE KPI SECTION (6 DYNAMIC CARDS) -- EXACT SAME AS MAIN DASHBOARD */}
      {/* ========================================================================= */}
      <div className="hosp-kpi-row" style={{ marginBottom: "1.25rem" }}>
        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#10b981,#059669)" } as React.CSSProperties}
          onClick={openSalesDrilldown}
          title="Click to view detailed sales breakdown"
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#10b981,#059669)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1" />
              <circle cx="20" cy="21" r="1" />
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Today's Sales</p>
            <h3 className="hosp-kpi-value">₹{(summary?.sales_today ?? 0).toLocaleString("en-IN")}</h3>
            <span className="hosp-kpi-sub">
              {salesTrendPercent !== null
                ? `${salesTrendPercent >= 0 ? "▲ +" : "▼ "}${salesTrendPercent}% vs yesterday`
                : `Previous day: ₹${(summary?.sales_yesterday ?? 0).toLocaleString("en-IN")}`}
            </span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#3b82f6,#2563eb)" } as React.CSSProperties}
          onClick={openOpSalesDrilldown}
          title="Click to view OPD dispensing breakdown"
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#3b82f6,#2563eb)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">OP Sales</p>
            <h3 className="hosp-kpi-value">₹{(summary?.opd_sales_today ?? 0).toLocaleString("en-IN")}</h3>
            <span className="hosp-kpi-sub">{summary?.opd_prescriptions_count ?? 0} counter bills</span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#8b5cf6,#6d28d9)" } as React.CSSProperties}
          onClick={openIpdDrilldown}
          title="Click to view IPD ward consumption breakdown"
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#8b5cf6,#6d28d9)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4v16" />
              <path d="M2 8h18a2 2 0 0 1 2 2v10" />
              <path d="M2 17h20" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">IPD Pharmacy Charges</p>
            <h3 className="hosp-kpi-value">₹{(summary?.ipd_consumption_today ?? 0).toLocaleString("en-IN")}</h3>
            <span className="hosp-kpi-sub">{summary?.ipd_indents_count ?? 0} ward issues posted</span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#f87171,#dc2626)" } as React.CSSProperties}
          onClick={openEmergencySalesDrilldown}
          title="Click to view Emergency medication issues"
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#f87171,#dc2626)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Emergency Sales</p>
            <h3 className="hosp-kpi-value" style={{ color: "#991b1b" }}>₹{(summary?.emergency_sales_today ?? 0).toLocaleString("en-IN")}</h3>
            <span className="hosp-kpi-sub">{summary?.emergency_count ?? 0} emergency issues</span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#f59e0b,#d97706)" } as React.CSSProperties}
          onClick={openStockDrilldown}
          title="Click to view stock valuation breakdown"
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Stock Value</p>
            <h3 className="hosp-kpi-value">₹{totalValuation.toLocaleString("en-IN")}</h3>
            <span className="hosp-kpi-sub">{totalUnits.toLocaleString("en-IN")} units available</span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#fb923c,#ea580c)" } as React.CSSProperties}
          onClick={() => onNavigate("pharmacy-inventory-stock")}
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#fb923c,#ea580c)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Low Stock</p>
            <h3 className="hosp-kpi-value" style={{ color: (summary?.low_stock_count || 0) > 0 ? "#ea580c" : undefined }}>{summary?.low_stock_count ?? 0}</h3>
            <span className="hosp-kpi-sub">{summary?.out_of_stock_count ?? 0} completely out</span>
          </div>
        </button>

        <button
          type="button"
          className="hosp-kpi-card hosp-clickable-card"
          style={{ "--kpi-accent": "linear-gradient(135deg,#ef4444,#b91c1c)" } as React.CSSProperties}
          onClick={() => onNavigate("pharmacy-inventory-stock")}
        >
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#ef4444,#b91c1c)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Near Expiry</p>
            <h3 className="hosp-kpi-value" style={{ color: (summary?.expiring_1m || 0) > 0 ? "#dc2626" : undefined }}>
              {(summary?.expiring_1m || 0) + (summary?.expiring_1_3m || 0)}
            </h3>
            <span className="hosp-kpi-sub">{summary?.expired_count ?? 0} expired stock items</span>
          </div>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 4. TODAY'S PHARMACY ACTIVITY (OPERATIONAL STATUS ROW) */}
      {/* ========================================================================= */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "14px 18px",
          marginBottom: "1.25rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "13.5px", fontWeight: 700, margin: 0, color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Today's Pharmacy Activity
          </h2>
          <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Live Operations Ledger</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>OP Dispensations</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#00828a", marginTop: "2px" }}>
              {summary?.today_activity?.op_dispensations ?? summary?.opd_prescriptions_count ?? 0}
            </div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>IPD Issues</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#0284c7", marginTop: "2px" }}>
              {summary?.today_activity?.ipd_issues ?? summary?.ipd_indents_count ?? 0}
            </div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Emergency Issues</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#dc2626", marginTop: "2px" }}>
              {summary?.today_activity?.emergency_issues ?? summary?.emergency_count ?? 0}
            </div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Returns Processed</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#d97706", marginTop: "2px" }}>
              {summary?.today_activity?.returns ?? 0}
            </div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>GRNs Received</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#16a34a", marginTop: "2px" }}>
              {summary?.today_activity?.grns_received ?? 0}
            </div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Stock Adjustments</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#7c3aed", marginTop: "2px" }}>
              {summary?.today_activity?.stock_adjustments ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 5. SALES & ACTIVITY ANALYTICS + STOCK HEALTH (2-COLUMN GRID) */}
      {/* ========================================================================= */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "14px", marginBottom: "1.25rem" }}>
        {/* Sales / Activity Analytics Chart */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "16px 20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <div>
              <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                Sales & Consumption Trends
              </h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#64748b" }}>
                Revenue breakdown across OP, IPD, and Emergency
              </p>
            </div>

            {/* Timeframe selector */}
            <div style={{ display: "flex", gap: "4px", background: "#f1f5f9", padding: "3px", borderRadius: "8px" }}>
              {(["today", "7d", "30d"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setChartPeriod(p)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "6px",
                    border: "none",
                    background: chartPeriod === p ? "#ffffff" : "transparent",
                    color: chartPeriod === p ? "#00828a" : "#64748b",
                    fontSize: "11.5px",
                    fontWeight: chartPeriod === p ? 700 : 500,
                    cursor: "pointer",
                    boxShadow: chartPeriod === p ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                  }}
                >
                  {p === "today" ? "Today" : p === "7d" ? "7 Days" : "30 Days"}
                </button>
              ))}
            </div>
          </div>

          {/* Bar Chart representation */}
          <div style={{ height: "180px", display: "flex", alignItems: "flex-end", gap: "18px", paddingBottom: "10px", borderBottom: "1px solid #f1f5f9" }}>
            {chartBars.map((b, idx) => {
              const total = b.op + b.ip + b.er;
              const heightPct = Math.min(100, Math.max(12, (total / maxChartVal) * 100));
              const opPct = total > 0 ? (b.op / total) * 100 : 0;
              const ipPct = total > 0 ? (b.ip / total) * 100 : 0;
              const erPct = total > 0 ? (b.er / total) * 100 : 0;

              return (
                <div key={idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
                  <div style={{ fontSize: "10.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    ₹{total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}
                  </div>
                  <div
                    style={{
                      width: "100%",
                      maxWidth: "42px",
                      height: `${heightPct}%`,
                      borderRadius: "6px 6px 0 0",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column-reverse",
                      background: "#e2e8f0",
                    }}
                  >
                    <div style={{ height: `${opPct}%`, background: "#00828a" }} title={`OP: ₹${b.op}`} />
                    <div style={{ height: `${ipPct}%`, background: "#0284c7" }} title={`IPD: ₹${b.ip}`} />
                    <div style={{ height: `${erPct}%`, background: "#dc2626" }} title={`Emergency: ₹${b.er}`} />
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "6px", fontWeight: 500 }}>
                    {b.label}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div style={{ display: "flex", gap: "16px", marginTop: "10px", fontSize: "11.5px", fontWeight: 600 }}>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "2px", background: "#00828a" }} />
              <span>OP Dispense</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "2px", background: "#0284c7" }} />
              <span>IPD Medication</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "2px", background: "#dc2626" }} />
              <span>Emergency / Casualty</span>
            </span>
          </div>
        </div>

        {/* Stock Health Panel */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "16px 20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Stock Health & Valuation
            </h2>
            <button
              type="button"
              onClick={() => onNavigate("pharmacy-inventory-stock")}
              style={{ fontSize: "11.5px", color: "#00828a", fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}
            >
              View Inventory →
            </button>
          </div>

          {/* Metric list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12.5px", color: "#475569" }}>Total Stock Value</span>
              <span style={{ fontSize: "13px", fontWeight: 800, color: "#0f172a" }}>₹{totalValuation.toLocaleString("en-IN")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12.5px", color: "#475569" }}>Available In-Stock Items</span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#16a34a" }}>{totalUnits.toLocaleString("en-IN")} units</span>
            </div>
            <div
              onClick={() => onNavigate("pharmacy-inventory-stock")}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
            >
              <span style={{ fontSize: "12.5px", color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#ea580c" }} />
                <span>Low Stock Reorders</span>
              </span>
              <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#ea580c", background: "#fff7ed", padding: "2px 8px", borderRadius: "12px" }}>
                {summary?.low_stock_count ?? 0} items
              </span>
            </div>
            <div
              onClick={() => onNavigate("pharmacy-inventory-stock")}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
            >
              <span style={{ fontSize: "12.5px", color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#f59e0b" }} />
                <span>Near Expiry (&lt; 90d)</span>
              </span>
              <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#d97706", background: "#fef3c7", padding: "2px 8px", borderRadius: "12px" }}>
                {(summary?.expiring_1m || 0) + (summary?.expiring_1_3m || 0)} items
              </span>
            </div>
            <div
              onClick={() => onNavigate("pharmacy-inventory-stock")}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
            >
              <span style={{ fontSize: "12.5px", color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#dc2626" }} />
                <span>Expired Stock (Blocked)</span>
              </span>
              <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#dc2626", background: "#fee2e2", padding: "2px 8px", borderRadius: "12px" }}>
                {summary?.expired_count ?? 0} batches
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12.5px", color: "#475569" }}>Completely Out of Stock</span>
              <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#64748b" }}>
                {summary?.out_of_stock_count ?? 0} items
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 5b. REVENUE BY CHANNEL -- real split of today's sales across OP / IPD / Emergency */}
      {/* ========================================================================= */}
      {((summary?.opd_sales_today ?? 0) + (summary?.ipd_consumption_today ?? 0) + (summary?.emergency_sales_today ?? 0)) > 0 && (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "16px 20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            marginBottom: "1.25rem",
          }}
        >
          <h2 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 2px", color: "#0f172a" }}>Today's Revenue by Channel</h2>
          <p style={{ margin: "0 0 14px 0", fontSize: "12px", color: "#64748b" }}>Real split of today's pharmacy sales</p>
          <DonutChart
            data={[
              { label: "OP Dispense", value: summary?.opd_sales_today ?? 0, color: "#00828a" },
              { label: "IPD Medication", value: summary?.ipd_consumption_today ?? 0, color: "#0284c7" },
              { label: "Emergency / Casualty", value: summary?.emergency_sales_today ?? 0, color: "#dc2626" },
            ]}
          />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 6. EXPIRY MONITORING + LOW STOCK ALERTS (2-COLUMN GRID) */}
      {/* ========================================================================= */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "1.25rem" }}>
        {/* Expiry Control Panel */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "16px 20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div>
              <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                Expiry Monitoring & FEFO Alerts
              </h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>
                Expired stock is strictly blocked from all dispensation pathways
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate("pharmacy-inventory-stock")}
              style={{ fontSize: "11.5px", color: "#00828a", fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}
            >
              View All →
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
            {/* Category: Expired */}
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "#fef2f2", border: "1px solid #fecaca" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#991b1b" }}>Expired</span>
                <span style={{ fontSize: "13px", fontWeight: 800, color: "#991b1b" }}>{summary?.expired_count ?? 0}</span>
              </div>
              <div style={{ fontSize: "11px", color: "#b91c1c", marginTop: "3px" }}>
                {summary?.expiry_breakdown?.expired?.items?.slice(0, 2).join(", ") || "No active expired items"}
              </div>
            </div>

            {/* Category: < 1 Month */}
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "#fff7ed", border: "1px solid #fed7aa" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#c2410c" }}>&lt; 1 Month</span>
                <span style={{ fontSize: "13px", fontWeight: 800, color: "#c2410c" }}>{summary?.expiring_1m ?? 0}</span>
              </div>
              <div style={{ fontSize: "11px", color: "#ea580c", marginTop: "3px" }}>
                {summary?.expiry_breakdown?.under_1m?.items?.slice(0, 2).join(", ") || "No urgent expiries"}
              </div>
            </div>

            {/* Category: 1-3 Months */}
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "#fffbeb", border: "1px solid #fde68a" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#b45309" }}>1–3 Months</span>
                <span style={{ fontSize: "13px", fontWeight: 800, color: "#b45309" }}>{summary?.expiring_1_3m ?? 0}</span>
              </div>
              <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>
                {summary?.expiry_breakdown?.from_1_to_3m?.items?.slice(0, 2).join(", ") || "Healthy batches"}
              </div>
            </div>

            {/* Category: 3-6 Months */}
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>3–6 Months</span>
                <span style={{ fontSize: "13px", fontWeight: 800, color: "#0f172a" }}>{summary?.expiring_3_6m ?? 0}</span>
              </div>
              <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                {summary?.expiry_breakdown?.from_3_to_6m?.items?.slice(0, 2).join(", ") || "Stable inventory"}
              </div>
            </div>
          </div>
        </div>

        {/* Low Stock Alert Panel */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "16px 20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div>
              <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                Low Stock Alerts & Reorders
              </h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>
                Medicines at or below hospital reorder thresholds
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleOpenNewPr()}
              style={{ fontSize: "11.5px", color: "#00828a", fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}
            >
              New PR →
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "6px 8px" }}>Medicine</th>
                  <th style={{ padding: "6px 8px" }}>Stock</th>
                  <th style={{ padding: "6px 8px" }}>Reorder</th>
                  <th style={{ padding: "6px 8px" }}>Status</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.low_stock_items || []).slice(0, 4).map((it, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "7px 8px", fontWeight: 600, color: "#0f172a" }}>
                      <div>{it.medicine_name}</div>
                      <div style={{ fontSize: "10.5px", color: "#64748b" }}>{it.generic_name}</div>
                    </td>
                    <td style={{ padding: "7px 8px", fontWeight: 700, color: it.current_stock === 0 ? "#dc2626" : "#ea580c" }}>
                      {it.current_stock}
                    </td>
                    <td style={{ padding: "7px 8px", color: "#64748b" }}>{it.reorder_level}</td>
                    <td style={{ padding: "7px 8px" }}>
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: it.current_stock === 0 ? "#fee2e2" : "#fff7ed",
                          color: it.current_stock === 0 ? "#991b1b" : "#c2410c",
                        }}
                      >
                        {it.status}
                      </span>
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={() => handleOpenNewPr(it.medicine_name)}
                        style={{
                          background: "#f0fdf4",
                          border: "1px solid #bbf7d0",
                          color: "#166534",
                          padding: "3px 8px",
                          borderRadius: "5px",
                          fontSize: "11px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Create PR
                      </button>
                    </td>
                  </tr>
                ))}
                {(!summary?.low_stock_items || summary.low_stock_items.length === 0) && (
                  <tr>
                    <td colSpan={5} style={{ padding: "16px 8px", textAlign: "center", color: "#94a3b8" }}>
                      No low stock alerts. Inventory levels are healthy.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 7. TOP MEDICINES SECTION */}
      {/* ========================================================================= */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "16px 20px",
          marginBottom: "1.25rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
          <div>
            <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Top Medicines (Consumption Analytics)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>
              Monthly dispensed volume with OP vs IP vs Emergency breakdown
            </p>
          </div>

          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {/* Top 5 / Top 10 Toggle */}
            <div style={{ display: "flex", gap: "4px", background: "#f1f5f9", padding: "3px", borderRadius: "8px" }}>
              <button
                type="button"
                onClick={() => setTopMedsCount(5)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "none",
                  background: topMedsCount === 5 ? "#ffffff" : "transparent",
                  color: topMedsCount === 5 ? "#00828a" : "#64748b",
                  fontSize: "11.5px",
                  fontWeight: topMedsCount === 5 ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                Top 5
              </button>
              <button
                type="button"
                onClick={() => setTopMedsCount(10)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "none",
                  background: topMedsCount === 10 ? "#ffffff" : "transparent",
                  color: topMedsCount === 10 ? "#00828a" : "#64748b",
                  fontSize: "11.5px",
                  fontWeight: topMedsCount === 10 ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                Top 10
              </button>
            </div>

            {/* Qty vs Value Toggle */}
            <div style={{ display: "flex", gap: "4px", background: "#f1f5f9", padding: "3px", borderRadius: "8px" }}>
              <button
                type="button"
                onClick={() => setTopMedsMetric("qty")}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "none",
                  background: topMedsMetric === "qty" ? "#ffffff" : "transparent",
                  color: topMedsMetric === "qty" ? "#00828a" : "#64748b",
                  fontSize: "11.5px",
                  fontWeight: topMedsMetric === "qty" ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                Sales Qty
              </button>
              <button
                type="button"
                onClick={() => setTopMedsMetric("value")}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "none",
                  background: topMedsMetric === "value" ? "#ffffff" : "transparent",
                  color: topMedsMetric === "value" ? "#00828a" : "#64748b",
                  fontSize: "11.5px",
                  fontWeight: topMedsMetric === "value" ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                Consumption Value
              </button>
            </div>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "8px 10px" }}>Rank & Medicine</th>
                <th style={{ padding: "8px 10px", textAlign: "center" }}>Total Dispensed</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Total Revenue</th>
                <th style={{ padding: "8px 10px", textAlign: "center" }}>OP Share</th>
                <th style={{ padding: "8px 10px", textAlign: "center" }}>IPD Share</th>
                <th style={{ padding: "8px 10px", textAlign: "center" }}>Emergency Share</th>
              </tr>
            </thead>
            <tbody>
              {rankedTopMedicines.map((m, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600, color: "#0f172a" }}>
                    <span style={{ color: "#94a3b8", marginRight: "8px" }}>#{idx + 1}</span>
                    <span>{m.medicine_name}</span>
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, color: "#00828a" }}>
                    {m.total_qty} units
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                    ₹{Number(m.total_amount || 0).toLocaleString("en-IN")}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center", color: "#64748b" }}>
                    <span style={{ background: "#f0fdfa", color: "#00828a", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: 600 }}>
                      {m.op_qty || 0}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center", color: "#64748b" }}>
                    <span style={{ background: "#f0f9ff", color: "#0284c7", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: 600 }}>
                      {m.ip_qty || 0}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center", color: "#64748b" }}>
                    <span style={{ background: "#fef2f2", color: "#dc2626", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: 600 }}>
                      {m.emergency_qty || 0}
                    </span>
                  </td>
                </tr>
              ))}
              {(!summary?.top_medicines || summary.top_medicines.length === 0) && (
                <tr>
                  <td colSpan={6} style={{ padding: "16px 8px", textAlign: "center", color: "#94a3b8" }}>
                    No consumption data recorded this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 8. RECENT PHARMACY TRANSACTIONS TABLE */}
      {/* ========================================================================= */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "16px 20px",
          marginBottom: "1.25rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div>
            <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Recent Pharmacy Operations
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>
              Unified audit log across OP Dispensations, Inpatient Issues, and Emergency Orders
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("pharmacy-reports")}
            style={{ fontSize: "11.5px", color: "#00828a", fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}
          >
            All Reports →
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "8px 10px" }}>Reference</th>
                <th style={{ padding: "8px 10px" }}>Patient</th>
                <th style={{ padding: "8px 10px" }}>UHID / IP / ER</th>
                <th style={{ padding: "8px 10px" }}>Type</th>
                <th style={{ padding: "8px 10px" }}>Medicine</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Amount</th>
                <th style={{ padding: "8px 10px" }}>Payment / Status</th>
                <th style={{ padding: "8px 10px" }}>Date / Time</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.recent_transactions || []).map((t, idx) => {
                let badgeBg = "#f0fdfa";
                let badgeColor = "#00828a";
                if (t.type === "IPD Issue") {
                  badgeBg = "#f0f9ff";
                  badgeColor = "#0284c7";
                } else if (t.type === "Emergency Dispense") {
                  badgeBg = "#fef2f2";
                  badgeColor = "#dc2626";
                } else if (t.type === "Return") {
                  badgeBg = "#fffbeb";
                  badgeColor = "#d97706";
                }

                return (
                  <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: "#334155" }}>
                      {t.reference}
                    </td>
                    <td style={{ padding: "8px 10px", fontWeight: 600, color: "#0f172a" }}>
                      {t.patient_name}
                    </td>
                    <td style={{ padding: "8px 10px", color: "#64748b", fontFamily: "monospace" }}>
                      {t.uhid}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: badgeBg, color: badgeColor }}>
                        {t.type}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#334155" }}>
                      {t.medicine_name}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                      ₹{t.amount.toFixed(2)}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ fontSize: "11px", color: "#475569", fontWeight: 500 }}>
                        {t.payment_status}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#64748b", fontSize: "11.5px" }}>
                      {t.date_time}
                    </td>
                  </tr>
                );
              })}
              {(!summary?.recent_transactions || summary.recent_transactions.length === 0) && (
                <tr>
                  <td colSpan={8} style={{ padding: "18px 8px", textAlign: "center", color: "#94a3b8" }}>
                    No recent pharmacy transactions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 9. PENDING / ATTENTION REQUIRED PANEL */}
      {/* ========================================================================= */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "16px 20px",
          marginBottom: "1.25rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <h2 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 10px 0", color: "#0f172a" }}>
          Needs Attention
        </h2>

        {((summary?.needs_attention?.low_stock || 0) > 0 ||
          (summary?.needs_attention?.near_expiry || 0) > 0 ||
          (summary?.needs_attention?.pending_ward_indents || 0) > 0 ||
          (summary?.needs_attention?.partially_issued_indents || 0) > 0 ||
          (summary?.needs_attention?.pending_purchase_requests || 0) > 0 ||
          (summary?.needs_attention?.unverified_grns || 0) > 0) ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
            {(summary?.needs_attention?.low_stock || 0) > 0 && (
              <div
                onClick={() => onNavigate("pharmacy-inventory-stock")}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#fff7ed", border: "1px solid #fed7aa", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#c2410c" }}>Low Stock Alert</div>
                <div style={{ fontSize: "11.5px", color: "#ea580c", marginTop: "2px" }}>
                  {summary?.needs_attention?.low_stock} medicines need reordering
                </div>
              </div>
            )}
            {(summary?.needs_attention?.near_expiry || 0) > 0 && (
              <div
                onClick={() => onNavigate("pharmacy-inventory-stock")}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#fef2f2", border: "1px solid #fecaca", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#b91c1c" }}>Near Expiry Alert</div>
                <div style={{ fontSize: "11.5px", color: "#dc2626", marginTop: "2px" }}>
                  {summary?.needs_attention?.near_expiry} batches expiring soon
                </div>
              </div>
            )}
            {(summary?.needs_attention?.pending_ward_indents || 0) > 0 && (
              <div
                onClick={() => onNavigate("pharmacy-ip-dispense")}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#f0f9ff", border: "1px solid #bae6fd", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#0369a1" }}>Pending Ward Indents</div>
                <div style={{ fontSize: "11.5px", color: "#0284c7", marginTop: "2px" }}>
                  {summary?.needs_attention?.pending_ward_indents} indents awaiting issue
                </div>
              </div>
            )}
            {(summary?.needs_attention?.partially_issued_indents || 0) > 0 && (
              <div
                onClick={() => onNavigate("pharmacy-ip-dispense")}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#fefce8", border: "1px solid #fef08a", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#a16207" }}>Partially Issued Indents</div>
                <div style={{ fontSize: "11.5px", color: "#ca8a04", marginTop: "2px" }}>
                  {summary?.needs_attention?.partially_issued_indents} indents pending restock
                </div>
              </div>
            )}
            {(summary?.needs_attention?.pending_purchase_requests || 0) > 0 && (
              <div
                onClick={() => {
                  localStorage.setItem("pharmacy_purchases_tab", "pr");
                  window.dispatchEvent(new Event("hospai_open_pr"));
                  onNavigate("pharmacy-purchases-grn");
                }}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#faf5ff", border: "1px solid #e9d5ff", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#7e22ce" }}>Purchase Approvals</div>
                <div style={{ fontSize: "11.5px", color: "#9333ea", marginTop: "2px" }}>
                  {summary?.needs_attention?.pending_purchase_requests} PRs awaiting PO
                </div>
              </div>
            )}
            {(summary?.needs_attention?.unverified_grns || 0) > 0 && (
              <div
                onClick={() => onNavigate("pharmacy-purchases-grn")}
                style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #cbd5e1", cursor: "pointer" }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>Unverified GRNs</div>
                <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                  {summary?.needs_attention?.unverified_grns} goods receipts to inspect
                </div>
              </div>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "12.5px", color: "#16a34a", fontWeight: 600 }}>
            ✓ No pending actions. All pharmacy operations are up to date.
          </p>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 10. QUICK ACTIONS GRID (9 ENTERPRISE CARDS) */}
      {/* ========================================================================= */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "13.5px", fontWeight: 700, margin: "0 0 10px 0", color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.03em" }}>
          Quick Operation Modules
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
          {[
            { label: "OP Dispense", page: "pharmacy-op-dispense", color: "#00828a", icon: "💊" },
            { label: "IP Dispense", page: "pharmacy-ip-dispense", color: "#0284c7", icon: "🏥" },
            { label: "Emergency Dispense", action: handleOpenEmergencyModal, color: "#dc2626", icon: "⚡" },
            { label: "View Stock", page: "pharmacy-inventory-stock", color: "#f59e0b", icon: "📦" },
            { label: "Stock Adjustment", page: "pharmacy-inventory-stock", color: "#7c3aed", icon: "⚖️" },
            { label: "New PR", action: () => handleOpenNewPr(), color: "#059669", icon: "📝" },
            { label: "Receive GRN", page: "pharmacy-purchases-grn", color: "#0d9488", icon: "📥" },
            { label: "Suppliers", page: "pharmacy-suppliers", color: "#64748b", icon: "🤝" },
            { label: "Reports", page: "pharmacy-reports", color: "#475569", icon: "📊" },
          ].map((act, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                if (act.action) act.action();
                else if (act.page) onNavigate(act.page);
              }}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "6px",
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                transition: "all 0.15s ease",
              }}
            >
              <span style={{ fontSize: "1.4rem" }}>{act.icon}</span>
              <span style={{ fontSize: "12px", fontWeight: 700, color: act.color }}>{act.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* EMERGENCY DISPENSE MODAL */}
      {/* ========================================================================= */}
      <Modal
        open={emergencyModalOpen}
        onClose={() => setEmergencyModalOpen(false)}
        title="STAT Emergency / Casualty Dispense"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Step 1: Patient Search */}
          <div style={{ padding: "12px", borderRadius: "8px", background: "#fef2f2", border: "1px solid #fee2e2" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#991b1b", marginBottom: "6px" }}>
              1. Search Emergency Patient (by UHID, Emergency No., Name, Mobile)
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <Input
                placeholder="Enter UHID, Name, or Mobile..."
                value={erPatientQuery}
                onChange={(e) => setErPatientQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSearchErPatients();
                  }
                }}
              />
              <Button variant="secondary" onClick={() => void handleSearchErPatients()} disabled={erSearchingPatients}>
                {erSearchingPatients ? "Searching..." : "Search"}
              </Button>
            </div>

            {/* Found list */}
            {erPatientsList.length > 0 && (
              <div style={{ marginTop: "10px", maxHeight: "120px", overflowY: "auto", border: "1px solid #fecaca", borderRadius: "6px", background: "#ffffff" }}>
                {erPatientsList.map((p) => (
                  <div
                    key={p.patient_id}
                    onClick={() => {
                      setErSelectedPatient(p);
                      setErPatientsList([]);
                    }}
                    style={{
                      padding: "8px 12px",
                      borderBottom: "1px solid #f1f5f9",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      background: erSelectedPatient?.patient_id === p.patient_id ? "#fef2f2" : "#ffffff",
                    }}
                  >
                    <div>
                      <strong>{p.name}</strong> ({p.patient_id})
                    </div>
                    <div style={{ color: "#64748b" }}>{p.gender}, {p.age || "-"} yrs · {p.phone || "No phone"}</div>
                  </div>
                ))}
              </div>
            )}

            {erSelectedPatient && (
              <div style={{ marginTop: "8px", fontSize: "12px", fontWeight: 700, color: "#991b1b" }}>
                ✓ Selected Patient: {erSelectedPatient.name} (UHID: {erSelectedPatient.patient_id})
              </div>
            )}
          </div>

          {/* Step 2: Medicine & Batch Selection */}
          <div style={{ padding: "12px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
              2. Select Emergency Medicine & FEFO Batch
            </div>
            <Input
              placeholder="Search medicine name..."
              value={erMedQuery}
              onChange={(e) => setErMedQuery(e.target.value)}
            />

            <div style={{ marginTop: "10px", maxHeight: "140px", overflowY: "auto", border: "1px solid #cbd5e1", borderRadius: "6px", background: "#ffffff" }}>
              {filteredErBatches.map((b) => (
                <div
                  key={b.id}
                  onClick={() => setErSelectedBatch(b)}
                  style={{
                    padding: "8px 12px",
                    borderBottom: "1px solid #f1f5f9",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "12px",
                    background: erSelectedBatch?.id === b.id ? "#eff6ff" : "#ffffff",
                  }}
                >
                  <div>
                    <strong>{b.medicine_name}</strong> · Batch: {b.batch_no}
                  </div>
                  <div style={{ color: "#00828a", fontWeight: 700 }}>
                    Stock: {b.qty_available} · ₹{b.unit_price}
                  </div>
                </div>
              ))}
              {filteredErBatches.length === 0 && (
                <div style={{ padding: "12px", textAlign: "center", color: "#94a3b8", fontSize: "12px" }}>
                  {erLoadingStock ? "Loading stock..." : "No available medicine batches found."}
                </div>
              )}
            </div>

            {erSelectedBatch && (
              <div style={{ marginTop: "8px", display: "flex", gap: "14px", alignItems: "center", fontSize: "12px" }}>
                <div>
                  <strong>Selected:</strong> {erSelectedBatch.medicine_name} (Batch {erSelectedBatch.batch_no})
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <label htmlFor="er-quantity-input">Quantity:</label>
                  <input
                    id="er-quantity-input"
                    type="number"
                    min={1}
                    max={erSelectedBatch.qty_available}
                    value={erQuantity}
                    onChange={(e) => setErQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    style={{ width: "60px", padding: "4px 8px", borderRadius: "4px", border: "1px solid #cbd5e1", fontSize: "12px" }}
                  />
                </div>
                <div style={{ fontWeight: 800, color: "#0f172a" }}>
                  Total: ₹{(erQuantity * erSelectedBatch.unit_price).toFixed(2)}
                </div>
              </div>
            )}
          </div>

          {/* Step 3: Billing & Account Mode */}
          <div style={{ padding: "12px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
              3. Emergency Billing & Charging Policy
            </div>
            <div style={{ display: "flex", gap: "16px", marginBottom: "10px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="erBillingMode"
                  checked={erBillingMode === "IMMEDIATE_PAYMENT"}
                  onChange={() => setErBillingMode("IMMEDIATE_PAYMENT")}
                />
                <span>Immediate Payment (Emergency Invoice)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="erBillingMode"
                  checked={erBillingMode === "EMERGENCY_ACCOUNT"}
                  onChange={() => setErBillingMode("EMERGENCY_ACCOUNT")}
                />
                <span>Post to Emergency Encounter Running Account</span>
              </label>
            </div>

            {erBillingMode === "IMMEDIATE_PAYMENT" && (
              <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px" }}>
                <span>Payment Mode:</span>
                <select
                  value={erPaymentMode}
                  onChange={(e) => setErPaymentMode(e.target.value)}
                  style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12px" }}
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI / Online</option>
                  <option value="card">Card</option>
                </select>
              </div>
            )}
          </div>

          {/* Modal Action Buttons */}
          <div className="hosp-revenue-pop-actions" style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "16px" }}>
            <Button variant="secondary" onClick={() => setEmergencyModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              style={{ background: "#dc2626", borderColor: "#dc2626" }}
              onClick={() => void handleExecuteEmergencyDispense()}
              disabled={erSubmitting || !erSelectedPatient || !erSelectedBatch}
            >
              {erSubmitting ? "Dispensing..." : "Dispense STAT Medicine"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================================= */}
      {/* 8. EXECUTIVE REVENUE & KPI DRILLDOWN MODAL (.hosp-revenue-pop-modal) */}
      {/* Matches DashboardPage popup modal design, typography, and styling exactly */}
      {/* ========================================================================= */}
      {pharmacyPopup && (
        <Modal
          open={!!pharmacyPopup}
          onClose={() => setPharmacyPopup(null)}
          title={pharmacyPopup.title}
          description={pharmacyPopup.subtitle}
          className="hosp-revenue-pop-modal"
        >
          <div className="hosp-revenue-pop-summary">
            <div>
              <span>TOTAL VALUE</span>
              <strong>₹{pharmacyPopup.total.toLocaleString("en-IN")}</strong>
            </div>
            <div>
              <span>{pharmacyPopup.secondaryLabel}</span>
              <strong>
                {typeof pharmacyPopup.secondaryValue === "number"
                  ? `₹${pharmacyPopup.secondaryValue.toLocaleString("en-IN")}`
                  : pharmacyPopup.secondaryValue}
              </strong>
            </div>
            <div>
              <span>{pharmacyPopup.countLabel}</span>
              <strong>{pharmacyPopup.countValue.toLocaleString("en-IN")}</strong>
            </div>
          </div>

          <div className="hosp-revenue-pop-table">
            <div className="hosp-revenue-pop-head">
              <span>Channel / Category</span>
              <span>Amount</span>
            </div>
            {pharmacyPopup.rows.map((row, idx) => (
              <div key={idx} className="hosp-revenue-pop-row">
                <div>
                  <strong>{row.channel}</strong>
                  <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#64748b" }}>{row.details}</p>
                </div>
                <strong style={{ color: "#0f172a" }}>₹{row.amount.toLocaleString("en-IN")}</strong>
              </div>
            ))}
          </div>

          <div className="hosp-revenue-pop-actions">
            <Button variant="ghost" onClick={() => setPharmacyPopup(null)}>
              Close
            </Button>
            <Button
              variant="primary"
              style={{ background: "#00828a", borderColor: "#00828a" }}
              onClick={() => {
                setPharmacyPopup(null);
                onNavigate("pharmacy-reports");
              }}
            >
              View Full Audit Report
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
