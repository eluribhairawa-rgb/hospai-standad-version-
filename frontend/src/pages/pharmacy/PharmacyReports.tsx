import { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input } from "../../components/ui";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

type SaleRow = {
  id: number;
  medicine_name: string;
  quantity: number;
  unit_price: number;
  amount: number;
  stock_source?: string;
  admission_id?: number;
  patient_id?: string;
  sold_at: string;
};

type StockBatch = {
  id: number;
  medicine_name: string;
  qty_available: number;
  unit_price: number;
  mrp?: number;
  expiry_date?: string;
  stock_source: string;
};

export default function PharmacyReports({ setNotice, onNavigate }: Props) {
  const [reportCategory, setReportCategory] = useState<"sales" | "inventory" | "ipd" | "returns">("sales");
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [stock, setStock] = useState<StockBatch[]>([]);
  const [returns, setReturns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateFilter, setDateFilter] = useState<string>("all");

  const loadData = async () => {
    setLoading(true);
    try {
      const [salesRes, stockRes, returnsRes] = await Promise.all([
        apiFetch<{ sales: SaleRow[] }>("/api/pharmacy/sales"),
        apiFetch<{ batches: StockBatch[] }>("/api/pharmacy/stock"),
        apiFetch<{ returns: any[] }>("/api/pharmacy/returns"),
      ]);

      if (salesRes?.sales) setSales(salesRes.sales);
      if (stockRes?.batches) setStock(stockRes.batches);
      if (returnsRes?.returns) setReturns(returnsRes.returns);
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load report data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  // Filtered sales
  const filteredSales = useMemo(() => {
    if (dateFilter === "all") return sales;
    const now = new Date();
    return sales.filter((s) => {
      if (!s.sold_at) return false;
      const d = new Date(s.sold_at);
      if (dateFilter === "today") {
        return d.toDateString() === now.toDateString();
      }
      if (dateFilter === "week") {
        const diffDays = (now.getTime() - d.getTime()) / (1000 * 3600 * 24);
        return diffDays <= 7;
      }
      if (dateFilter === "month") {
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }
      return true;
    });
  }, [sales, dateFilter]);

  // Returns are refunded (and the money never comes back) the moment they're
  // recorded, regardless of whether they're later released or rejected --
  // see create_pharmacy_return / reject_pharmacy_return on the backend --
  // so every return in this window is real money out, not just the
  // still-quarantined ones.
  const filteredReturns = useMemo(() => {
    if (dateFilter === "all") return returns;
    const now = new Date();
    return returns.filter((r) => {
      if (!r.created_at) return false;
      const d = new Date(r.created_at);
      if (dateFilter === "today") return d.toDateString() === now.toDateString();
      if (dateFilter === "week") return (now.getTime() - d.getTime()) / (1000 * 3600 * 24) <= 7;
      if (dateFilter === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      return true;
    });
  }, [returns, dateFilter]);

  // Sales Totals (net of returns/refunds)
  const salesMetrics = useMemo(() => {
    let totalRevenue = 0;
    let opRevenue = 0;
    let ipdRevenue = 0;
    let cashRevenue = 0;
    let insuranceRevenue = 0;

    for (const s of filteredSales) {
      const amount = s.amount || 0;
      totalRevenue += amount;
      if (s.admission_id) {
        ipdRevenue += amount;
      } else {
        opRevenue += amount;
      }

      if (s.stock_source === "INSURANCE") {
        insuranceRevenue += amount;
      } else {
        cashRevenue += amount;
      }
    }

    const salesById = new Map(sales.map((s) => [s.id, s]));
    let totalReturned = 0;
    for (const r of filteredReturns) {
      const sale = salesById.get(r.original_sale_id);
      if (!sale) continue;
      const refund = (r.quantity || 0) * (sale.unit_price || 0);
      totalRevenue -= refund;
      totalReturned += refund;
      if (sale.admission_id) {
        ipdRevenue -= refund;
      } else {
        opRevenue -= refund;
      }
      if (sale.stock_source === "INSURANCE") {
        insuranceRevenue -= refund;
      } else {
        cashRevenue -= refund;
      }
    }

    return { totalRevenue, opRevenue, ipdRevenue, cashRevenue, insuranceRevenue, totalReturned };
  }, [filteredSales, filteredReturns, sales]);

  // Inventory Valuation Metrics
  const inventoryValuation = useMemo(() => {
    let costVal = 0;
    let mrpVal = 0;
    let totalQty = 0;

    for (const b of stock) {
      const qty = b.qty_available || 0;
      totalQty += qty;
      costVal += qty * (b.unit_price || 0);
      mrpVal += qty * (b.mrp || b.unit_price || 0);
    }

    return { costVal, mrpVal, totalQty };
  }, [stock]);

  // CSV Export
  const handleExportCsv = () => {
    let headers = "";
    let rows = "";

    if (reportCategory === "sales") {
      headers = "ID,Medicine,Quantity,Price,Total,Payer Source,Type,Date\n";
      rows = filteredSales
        .map((s) =>
          [
            s.id,
            `"${s.medicine_name}"`,
            s.quantity,
            s.unit_price,
            (s.amount || 0).toFixed(2),
            s.stock_source || "CASH",
            s.admission_id ? "IPD Issue" : "OP Dispense",
            s.sold_at || "",
          ].join(",")
        )
        .join("\n");
    } else if (reportCategory === "inventory") {
      headers = "ID,Medicine,Quantity,Unit Cost,MRP,Total Cost Val,Expiry\n";
      rows = stock
        .map((b) =>
          [
            b.id,
            `"${b.medicine_name}"`,
            b.qty_available,
            b.unit_price,
            b.mrp || b.unit_price,
            ((b.qty_available || 0) * (b.unit_price || 0)).toFixed(2),
            b.expiry_date || "",
          ].join(",")
        )
        .join("\n");
    } else {
      headers = "ID,Sale ID,Quantity,Reason,Status,Date\n";
      rows = returns
        .map((r) => [r.id, r.original_sale_id, r.quantity, `"${r.reason || ""}"`, r.status, r.created_at || ""].join(","))
        .join("\n");
    }

    const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pharmacy_${reportCategory}_report_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice({ type: "success", message: `Exported ${reportCategory} report as CSV.` });
  };

  const CATEGORY_TITLES: Record<typeof reportCategory, string> = {
    sales: "Pharmacy Sales & Revenue Report",
    inventory: "Pharmacy Inventory Valuation Report",
    ipd: "IPD Ward Medication Consumption Report",
    returns: "Pharmacy Returns & Reversals Report",
  };

  // Same pipeline the Main Dashboard's own Print button uses (a real
  // backend-rendered PDF via generatePDFBlob, then printPDF opens it) --
  // every report in the app shares one template, not a second one just here.
  const handlePrintReport = async () => {
    let columns: string[] = [];
    let rows: (string | number)[][] = [];
    let grandTotalLabel = "";
    let grandTotalValue = "";

    if (reportCategory === "sales") {
      columns = ["Medicine", "Qty", "Unit Price", "Amount", "Source", "Type", "Date"];
      let grandTotal = 0;
      rows = filteredSales.map((s) => {
        const amount = s.amount || 0;
        grandTotal += amount;
        return [s.medicine_name, s.quantity, `₹${(s.unit_price || 0).toFixed(2)}`, `₹${amount.toFixed(2)}`, s.stock_source || "CASH", s.admission_id ? "IPD Issue" : "OP Dispense", s.sold_at ? new Date(s.sold_at).toLocaleDateString("en-IN") : "-"];
      });
      grandTotalLabel = "Total Revenue"; grandTotalValue = `₹${grandTotal.toFixed(2)}`;
    } else if (reportCategory === "inventory") {
      columns = ["Medicine", "Qty Available", "Unit Cost", "MRP", "Total Cost Value", "Expiry"];
      let grandTotal = 0;
      rows = stock.map((b) => {
        const value = (b.qty_available || 0) * (b.unit_price || 0);
        grandTotal += value;
        return [b.medicine_name, b.qty_available, `₹${(b.unit_price || 0).toFixed(2)}`, `₹${(b.mrp || b.unit_price || 0).toFixed(2)}`, `₹${value.toFixed(2)}`, b.expiry_date || "-"];
      });
      grandTotalLabel = "Total Stock Value"; grandTotalValue = `₹${grandTotal.toFixed(2)}`;
    } else if (reportCategory === "ipd") {
      columns = ["Medicine", "Qty Issued", "Charge Rate", "Total Posted", "Patient UHID", "Admission #"];
      let grandTotal = 0;
      rows = sales.filter((s) => s.admission_id).map((s) => {
        const amount = s.amount || 0;
        grandTotal += amount;
        return [s.medicine_name, s.quantity, `₹${(s.unit_price || 0).toFixed(2)}`, `₹${amount.toFixed(2)}`, s.patient_id || "-", `ADM-${s.admission_id}`];
      });
      grandTotalLabel = "Total Posted to Admissions"; grandTotalValue = `₹${grandTotal.toFixed(2)}`;
    } else {
      columns = ["Return ID", "Original Sale", "Qty", "Reason", "Status", "Date"];
      rows = returns.map((r) => [r.id, r.original_sale_id, r.quantity, r.reason || "-", r.status, r.created_at || "-"]);
    }

    try {
      printViaIframe(buildPrintDocumentHtml({
        title: CATEGORY_TITLES[reportCategory] || "Pharmacy Report",
        subtitleLines: [
          `Category: ${CATEGORY_TITLES[reportCategory]}`,
          `Records: ${rows.length}`,
          `Filter: ${dateFilter === "all" ? "All dates" : dateFilter}`,
          `Generated: ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
        ],
        columns,
        rows,
        totals: grandTotalValue ? [{ label: grandTotalLabel || "Grand Total", value: grandTotalValue, grand: true }] : undefined,
        emptyMessage: "No report records found for the selected category and filter.",
      }));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to print the report." });
    }
  };

  return (
    <div className="pharmacy-theme-page" style={{ padding: "1.5rem", maxWidth: "1400px", margin: "0 auto" }}>
      {/* Topbar / Breadcrumbs */}
      <div className="pharmacy-topbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap", gap: "1rem" }}>
        <div className="pharmacy-breadcrumb" style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", color: "#64748b" }}>
          <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 600 }} onClick={() => window.history.back()}>HospAI</span>
          <span>/</span>
          <span style={{ cursor: "pointer", color: "#00828a", fontWeight: 600 }} onClick={() => onNavigate("pharmacy-overview")}>Pharmacy</span>
          <span>/</span>
          <span style={{ color: "#0f172a", fontWeight: 700 }}>Reports</span>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button type="button" variant="secondary" onClick={handleExportCsv}>
            Export CSV
          </Button>
          <Button
            type="button"
            className="primary"
            style={{ background: "#00828a", borderColor: "#00828a" }}
            onClick={handlePrintReport}
          >
            Print Report
          </Button>
        </div>
      </div>

      {/* Report Categories Navigation */}
      <div style={{ display: "flex", borderBottom: "2px solid #e2e8f0", gap: "1.5rem", marginBottom: "1.5rem", overflowX: "auto" }}>
        {[
          { id: "sales", label: "Sales & Revenue" },
          { id: "inventory", label: "Inventory Valuation" },
          { id: "ipd", label: "IPD Ward Consumption" },
          { id: "returns", label: `Returns & Reversals (${returns.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            style={{
              padding: "0.6rem 0.2rem",
              background: "transparent",
              border: "none",
              borderBottom: reportCategory === tab.id ? "3px solid #00828a" : "3px solid transparent",
              color: reportCategory === tab.id ? "#00828a" : "#64748b",
              fontWeight: reportCategory === tab.id ? 800 : 600,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
            onClick={() => setReportCategory(tab.id as any)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 1. SALES REPORT */}
      {reportCategory === "sales" && (
        <>
          {/* Filter Bar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {[
                { id: "all", label: "All Time" },
                { id: "today", label: "Today" },
                { id: "week", label: "Last 7 Days" },
                { id: "month", label: "This Month" },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  style={{
                    padding: "0.35rem 0.85rem",
                    borderRadius: "6px",
                    border: dateFilter === f.id ? "1.5px solid #00828a" : "1px solid #cbd5e1",
                    background: dateFilter === f.id ? "#f0fdfa" : "#ffffff",
                    color: dateFilter === f.id ? "#00828a" : "#475569",
                    fontWeight: dateFilter === f.id ? 700 : 500,
                    fontSize: "0.8rem",
                    cursor: "pointer",
                  }}
                  onClick={() => setDateFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
              Total Transactions: {filteredSales.length}
            </span>
          </div>

          {/* Revenue KPI Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Total Pharmacy Revenue</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
                ₹{salesMetrics.totalRevenue.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>OP Counter Sales</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#00828a", marginTop: "4px" }}>
                ₹{salesMetrics.opRevenue.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>IPD Admission Charges</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#0284c7", marginTop: "4px" }}>
                ₹{salesMetrics.ipdRevenue.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Insurance / Scheme Revenue</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#7c3aed", marginTop: "4px" }}>
                ₹{salesMetrics.insuranceRevenue.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#fff7ed", padding: "1.25rem", borderRadius: "10px", border: "1px solid #fed7aa" }}>
              <div style={{ fontSize: "0.8rem", color: "#9a3412", fontWeight: 700, textTransform: "uppercase" }}>Returned / Refunded</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#c2410c", marginTop: "4px" }}>
                -₹{salesMetrics.totalReturned.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Sales Breakdown Table */}
          <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Itemized Sales Breakdown
            </h3>
            <div style={{ overflowX: "auto" }}>
              <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.5rem 0.75rem" }}>Medicine</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "center" }}>Qty</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>Unit Price</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>Total Amount</th>
                    <th style={{ padding: "0.5rem 0.75rem" }}>Type</th>
                    <th style={{ padding: "0.5rem 0.75rem" }}>Patient UHID</th>
                    <th style={{ padding: "0.5rem 0.75rem" }}>Date / Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSales.slice(0, 30).map((s) => (
                    <tr key={s.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: 600 }}>{s.medicine_name}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "center", fontWeight: 700 }}>{s.quantity}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>₹{(s.unit_price || 0).toFixed(2)}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                        ₹{(s.amount || 0).toFixed(2)}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem" }}>
                        <span style={{ fontSize: "0.72rem", padding: "2px 8px", borderRadius: "10px", fontWeight: 600, background: s.admission_id ? "#e0f2fe" : "#f0fdf4", color: s.admission_id ? "#0369a1" : "#166534" }}>
                          {s.admission_id ? "IPD Issue" : "OP Dispense"}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b" }}>{s.patient_id || "-"}</td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b", fontSize: "0.8rem" }}>
                        {s.sold_at ? new Date(s.sold_at).toLocaleString("en-IN") : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 2. INVENTORY VALUATION */}
      {reportCategory === "inventory" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Total Physical Units</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
                {inventoryValuation.totalQty.toLocaleString("en-IN")}
              </div>
            </div>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Stock Cost Valuation (Cost Basis)</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#00828a", marginTop: "4px" }}>
                ₹{inventoryValuation.costVal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div style={{ background: "#ffffff", padding: "1.25rem", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Potential Retail MRP Value</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800, color: "#16a34a", marginTop: "4px" }}>
                ₹{inventoryValuation.mrpVal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Valuation by Batch
            </h3>
            <div style={{ overflowX: "auto" }}>
              <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.5rem" }}>Medicine</th>
                    <th style={{ padding: "0.5rem", textAlign: "center" }}>Available Qty</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Cost Price</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Total Cost Value</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Retail MRP</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Total MRP Value</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.slice(0, 30).map((b) => (
                    <tr key={b.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem", fontWeight: 600 }}>{b.medicine_name}</td>
                      <td style={{ padding: "0.5rem", textAlign: "center", fontWeight: 700 }}>{b.qty_available}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{b.unit_price}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700, color: "#00828a" }}>
                        ₹{(b.qty_available * (b.unit_price || 0)).toFixed(2)}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{b.mrp || b.unit_price}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700, color: "#16a34a" }}>
                        ₹{(b.qty_available * (b.mrp || b.unit_price || 0)).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. IPD WARD CONSUMPTION */}
      {reportCategory === "ipd" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
            Inpatient Medication Consumption by Admission
          </h3>
          <p style={{ fontSize: "0.85rem", color: "#64748b", margin: "0 0 1rem 0" }}>
            All running pharmacy charges posted to IPD patient accounts during hospital stay:
          </p>

          <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "0.5rem" }}>Medicine</th>
                <th style={{ padding: "0.5rem", textAlign: "center" }}>Qty Issued</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Charge Rate</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Total Posted</th>
                <th style={{ padding: "0.5rem" }}>Patient UHID</th>
                <th style={{ padding: "0.5rem" }}>Admission #</th>
              </tr>
            </thead>
            <tbody>
              {sales.filter((s) => s.admission_id).map((s) => (
                <tr key={s.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.5rem", fontWeight: 600 }}>{s.medicine_name}</td>
                  <td style={{ padding: "0.5rem", textAlign: "center", fontWeight: 700 }}>{s.quantity}</td>
                  <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{(s.unit_price || 0).toFixed(2)}</td>
                  <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700, color: "#0284c7" }}>
                    ₹{(s.amount || 0).toFixed(2)}
                  </td>
                  <td style={{ padding: "0.5rem", color: "#64748b" }}>{s.patient_id}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 600 }}>ADM-{s.admission_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4. RETURNS & REVERSALS */}
      {reportCategory === "returns" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
            Pharmacy Returns & Reversals Audit Log
          </h3>

          {returns.length > 0 ? (
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.5rem" }}>Return ID</th>
                  <th style={{ padding: "0.5rem" }}>Sale Ref</th>
                  <th style={{ padding: "0.5rem", textAlign: "center" }}>Returned Qty</th>
                  <th style={{ padding: "0.5rem" }}>Reason</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                  <th style={{ padding: "0.5rem" }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.5rem", fontWeight: 700, color: "#e11d48" }}>RET-{r.id}</td>
                    <td style={{ padding: "0.5rem" }}>Sale #{r.original_sale_id}</td>
                    <td style={{ padding: "0.5rem", textAlign: "center", fontWeight: 700 }}>{r.quantity}</td>
                    <td style={{ padding: "0.5rem", color: "#475569" }}>{r.reason || "Return"}</td>
                    <td style={{ padding: "0.5rem" }}>
                      <span style={{ padding: "2px 8px", borderRadius: "10px", fontSize: "0.72rem", fontWeight: 700, background: "#fee2e2", color: "#991b1b" }}>
                        {r.status || "Processed"}
                      </span>
                    </td>
                    <td style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem" }}>
                      {r.created_at ? new Date(r.created_at).toLocaleDateString() : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ textAlign: "center", padding: "2.5rem", color: "#94a3b8" }}>
              No returns recorded yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
