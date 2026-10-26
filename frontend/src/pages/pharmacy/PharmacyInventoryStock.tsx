import { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal } from "../../components/ui";
import { apiFetch, reportError } from "../../lib/api";
import { downloadCsv } from "../../lib/csvExport";
import type { Notice } from "../../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

const WhatsAppIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.031 2C6.504 2 2 6.504 2 12.031c0 1.954.563 3.778 1.536 5.32L2 22l4.821-1.503a10.007 10.007 0 0 0 5.21 1.534h.005c5.526 0 10.03-4.504 10.03-10.031A10.02 10.02 0 0 0 12.031 2zm0 18.272a8.23 8.23 0 0 1-4.214-1.157l-.302-.18-2.862.893.908-2.793-.197-.313A8.216 8.216 0 0 1 3.784 12.03c0-4.549 3.7-8.249 8.249-8.249 4.547 0 8.246 3.7 8.246 8.25 0 4.548-3.7 8.241-8.248 8.241zm4.52-6.177c-.248-.124-1.465-.723-1.692-.806-.228-.083-.393-.124-.559.124-.166.248-.642.806-.786.971-.145.166-.29.186-.538.062-.248-.124-1.049-.387-1.997-1.233-.738-.658-1.237-1.472-1.382-1.72-.145-.248-.016-.382.108-.506.112-.111.248-.29.373-.435.124-.145.166-.248.248-.414.083-.166.042-.311-.02-.435-.063-.124-.559-1.348-.766-1.846-.201-.485-.406-.419-.559-.427l-.476-.008c-.166 0-.435.062-.663.311-.228.248-.87 1.056-.87 2.574s1.099 2.984 1.253 3.191c.155.207 2.164 3.305 5.244 4.634.733.317 1.305.506 1.751.648.736.234 1.406.201 1.936.122.591-.088 1.815-.742 2.072-1.458.257-.716.257-1.33.18-1.458-.076-.124-.241-.186-.489-.31z" />
  </svg>
);

type StockItem = {
  id: number;
  medicine_id?: number;
  medicine_name: string;
  generic_name?: string;
  batch_no: string;
  mfg_date?: string;
  expiry_date?: string;
  qty_available: number;
  quantity: number;
  unit_price: number;
  mrp?: number;
  stock_source: "CASH" | "INSURANCE";
  batch_status?: string;
  unit_type?: string;
  master_reorder_level?: number;
  supplier_name?: string;
  supplier_phone?: string;
  supplier_contact_person?: string;
};

type StockMovement = {
  id: number;
  medicine_name: string;
  batch_no?: string;
  movement_type: string;
  delta_qty: number;
  stock_source?: string;
  ref_table?: string;
  ref_id?: number;
  actor?: string;
  created_at: string;
};

export default function PharmacyInventoryStock({ setNotice, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<
    "overview" | "ledger" | "batches" | "low_stock" | "adjustments" | "physical_count" | "transfers"
  >("overview");

  const [loading, setLoading] = useState(false);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [ledgerMovements, setLedgerMovements] = useState<StockMovement[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [ledgerFromDate, setLedgerFromDate] = useState("");
  const [ledgerToDate, setLedgerToDate] = useState("");

  // Adjustment Modal State
  const [adjustmentModalOpen, setAdjustmentModalOpen] = useState(false);
  const [adjBatchId, setAdjBatchId] = useState<number | null>(null);
  const [adjDirection, setAdjDirection] = useState<"ADD" | "DEDUCT">("DEDUCT");
  const [adjDelta, setAdjDelta] = useState<number>(1);
  const [adjReason, setAdjReason] = useState<string>("Damage / Breakage");
  const [adjRemarks, setAdjRemarks] = useState<string>("");
  const [submittingAdj, setSubmittingAdj] = useState(false);

  // Physical Count State
  const [physicalCountMedicine, setPhysicalCountMedicine] = useState<StockItem | null>(null);
  const [countedQty, setCountedQty] = useState<number>(0);
  const [countReason, setCountReason] = useState<string>("Quarterly stock audit reconciliation");

  // Suppliers & Order State
  const [suppliers, setSuppliers] = useState<{ id: number; supplier_name: string; phone?: string; contact_person?: string }[]>([]);
  const [orderingMed, setOrderingMed] = useState<string | null>(null);

  // WhatsApp Dialog State
  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");
  const [whatsAppTitle, setWhatsAppTitle] = useState("Share Purchase Requisition via WhatsApp");
  const [whatsAppRecipient, setWhatsAppRecipient] = useState("");

  const openWhatsAppDialog = (opts: {
    title: string;
    recipientName?: string;
    recipientPhone?: string;
    message: string;
  }) => {
    setWhatsAppTitle(opts.title);
    setWhatsAppRecipient(opts.recipientName || "");
    setWhatsAppPhone(opts.recipientPhone || "");
    setWhatsAppMessage(opts.message);
    setWhatsAppModalOpen(true);
  };

  const handleSendWhatsApp = () => {
    const digits = whatsAppPhone.replace(/[^0-9]/g, "");
    const countryCoded = digits ? (digits.length === 10 ? `91${digits}` : digits) : "";
    const url = countryCoded
      ? `https://wa.me/${countryCoded}?text=${encodeURIComponent(whatsAppMessage)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsAppMessage)}`;
    window.open(url, "_blank");
    setNotice({
      type: "success",
      message: "WhatsApp opened successfully! You can send the message now.",
    });
    setWhatsAppModalOpen(false);
  };

  // Load suppliers
  const loadSuppliers = async () => {
    try {
      const res = await apiFetch<{ suppliers: any[] }>("/api/pharmacy/suppliers");
      if (res?.suppliers) setSuppliers(res.suppliers);
    } catch {
      // ignore
    }
  };

  // Load stock
  const loadStock = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ batches: StockItem[] }>("/api/pharmacy/stock");
      if (res?.batches) {
        setStock(res.batches);
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load inventory stock");
    } finally {
      setLoading(false);
    }
  };

  // Load ledger
  const loadLedger = async () => {
    try {
      const res = await apiFetch<{ movements: StockMovement[] }>("/api/pharmacy/stock/ledger");
      if (res?.movements) {
        setLedgerMovements(res.movements);
      }
    } catch {
      // ignore
    }
  };

  const filteredLedgerMovements = useMemo(() => {
    if (!ledgerFromDate && !ledgerToDate) return ledgerMovements;
    return ledgerMovements.filter((m) => {
      const d = (m.created_at || "").slice(0, 10);
      if (!d) return false;
      if (ledgerFromDate && d < ledgerFromDate) return false;
      if (ledgerToDate && d > ledgerToDate) return false;
      return true;
    });
  }, [ledgerMovements, ledgerFromDate, ledgerToDate]);

  const handleExportLedgerCsv = () => {
    downloadCsv(
      `stock_ledger_${ledgerFromDate || "all"}_to_${ledgerToDate || "all"}.csv`,
      ["Date/Time", "Movement Type", "Medicine", "Batch", "Delta Qty", "Stock Source", "Actor"],
      filteredLedgerMovements.map((m) => [
        m.created_at ? new Date(m.created_at).toLocaleString("en-IN") : "",
        m.movement_type,
        m.medicine_name,
        m.batch_no || "",
        m.delta_qty,
        m.stock_source || "CASH",
        m.actor || "system",
      ])
    );
  };

  useEffect(() => {
    void loadStock();
    void loadLedger();
    void loadSuppliers();
  }, []);

  // Filtered Stock Items
  const filteredStock = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return stock;
    return stock.filter((s) =>
      s.medicine_name.toLowerCase().includes(q) ||
      (s.generic_name || "").toLowerCase().includes(q) ||
      s.batch_no.toLowerCase().includes(q)
    );
  }, [stock, searchQuery]);

  // Aggregate by medicine
  const medicineAggregates = useMemo(() => {
    const map = new Map<string, {
      medicine_name: string;
      generic_name?: string;
      total_qty: number;
      batch_count: number;
      total_val: number;
      nearest_exp?: string;
      unit_type?: string;
      reorder_level: number;
      supplier_name?: string;
      supplier_phone?: string;
      supplier_contact_person?: string;
    }>();

    for (const item of filteredStock) {
      const key = item.medicine_name;
      const existing = map.get(key) || {
        medicine_name: item.medicine_name,
        generic_name: item.generic_name,
        total_qty: 0,
        batch_count: 0,
        total_val: 0,
        nearest_exp: item.expiry_date,
        unit_type: item.unit_type,
        reorder_level: item.master_reorder_level ?? 10,
        supplier_name: item.supplier_name,
        supplier_phone: item.supplier_phone,
        supplier_contact_person: item.supplier_contact_person,
      };

      existing.total_qty += item.qty_available;
      existing.batch_count += 1;
      existing.total_val += (item.qty_available * (item.unit_price || 0));
      if (!existing.unit_type && item.unit_type) existing.unit_type = item.unit_type;
      if (item.master_reorder_level != null) existing.reorder_level = item.master_reorder_level;
      if (!existing.supplier_name && item.supplier_name) {
        existing.supplier_name = item.supplier_name;
        existing.supplier_phone = item.supplier_phone;
        existing.supplier_contact_person = item.supplier_contact_person;
      }

      if (item.expiry_date && (!existing.nearest_exp || item.expiry_date < existing.nearest_exp)) {
        existing.nearest_exp = item.expiry_date;
      }

      map.set(key, existing);
    }

    return Array.from(map.values());
  }, [filteredStock]);

  // Low stock medicines: total available at or below the medicine's real,
  // configured reorder level (same rule the Pharmacy Overview KPI uses) --
  // not a hardcoded number, so the two pages always agree.
  const lowStockItems = useMemo(() => {
    return medicineAggregates.filter((m) => m.total_qty <= m.reorder_level);
  }, [medicineAggregates]);

  // Handle submit adjustment
  const handleExecuteAdjustment = async () => {
    if (!adjBatchId) return;
    if (adjDelta <= 0) {
      setNotice({ type: "warning", message: "Quantity must be greater than 0" });
      return;
    }

    setSubmittingAdj(true);
    try {
      const signedDelta = adjDirection === "ADD" ? adjDelta : -adjDelta;
      await apiFetch("/api/pharmacy/stock/adjust", {
        method: "POST",
        body: JSON.stringify({
          pharmacy_inventory_id: adjBatchId,
          delta_qty: signedDelta,
          reason: `${adjReason}${adjRemarks ? ` - ${adjRemarks}` : ""}`,
        }),
      });

      setNotice({ type: "success", message: `Stock adjusted by ${signedDelta} units.` });
      setAdjustmentModalOpen(false);
      setAdjRemarks("");
      setAdjDelta(1);
      void loadStock();
      void loadLedger();
    } catch (err) {
      reportError(setNotice, err as any, "Adjustment failed");
    } finally {
      setSubmittingAdj(false);
    }
  };

  // Handle "Order Now" on Low Stock item: creates a New PR and opens WhatsApp
  const handleOrderNow = async (item: {
    medicine_name: string;
    total_qty: number;
    reorder_level: number;
    unit_type?: string;
    supplier_name?: string;
    supplier_phone?: string;
    supplier_contact_person?: string;
  }) => {
    setOrderingMed(item.medicine_name);
    try {
      // Match supplier from loaded list or item fields
      const matched = suppliers.find(
        (s) => s.supplier_name.toLowerCase() === (item.supplier_name || "").toLowerCase()
      ) || suppliers[0];

      const supplierId = matched?.id;
      if (!supplierId) {
        setNotice({ type: "warning", message: "No active supplier found. Please add a supplier first in Suppliers." });
        return;
      }

      const supplierName = matched?.supplier_name || item.supplier_name || "Supplier";
      const supplierPhone = matched?.phone || item.supplier_phone || "";
      const suggestedQty = Math.max(item.reorder_level * 2 - item.total_qty, 10);

      // 1. Automatically create the new PR
      const res = await apiFetch<{ pr_id: number; pr_no: string }>("/api/pharmacy/purchase-requests", {
        method: "POST",
        body: JSON.stringify({
          priority: "urgent",
          notes: `Automated Low Stock Requisition — Current stock: ${item.total_qty}, Reorder level: ${item.reorder_level}`,
          preferred_supplier_id: supplierId,
          supplier_id: supplierId,
          items: [{
            medicine_name: item.medicine_name,
            required_qty: suggestedQty,
            quantity: suggestedQty,
          }],
        }),
      });

      // 2. Format WhatsApp message
      const messageText = [
        `🏥 *HospAI Hospital Pharmacy — Purchase Requisition*`,
        `----------------------------------------`,
        `📋 *Purchase Request No:* ${res.pr_no}`,
        `📦 *Medicine / Supply:* ${item.medicine_name}`,
        `🔢 *Required Quantity:* ${suggestedQty} ${item.unit_type || "units"}`,
        `⚡ *Priority:* URGENT (Low Stock)`,
        `🏢 *Supplier:* ${supplierName}`,
        `📅 *Requisition Date:* ${new Date().toLocaleDateString("en-IN")}`,
        `📝 *Reason:* Stock at ${item.total_qty} units (below reorder level ${item.reorder_level})`,
        `----------------------------------------`,
        `Please confirm receipt, medicine availability, and expedited delivery timeline.`,
      ].join("\n");

      // 3. Open WhatsApp link directly
      const digits = supplierPhone.replace(/[^0-9]/g, "");
      const countryCoded = digits ? (digits.length === 10 ? `91${digits}` : digits) : "";
      const waUrl = countryCoded
        ? `https://wa.me/${countryCoded}?text=${encodeURIComponent(messageText)}`
        : `https://api.whatsapp.com/send?text=${encodeURIComponent(messageText)}`;
      window.open(waUrl, "_blank");

      // 4. Also open the dialog modal on-screen so the user can review or resend
      openWhatsAppDialog({
        title: `Share PR #${res.pr_no} via WhatsApp`,
        recipientName: supplierName,
        recipientPhone: supplierPhone,
        message: messageText,
      });

      setNotice({
        type: "success",
        message: `Purchase Request ${res.pr_no} created successfully! WhatsApp opened to send order to ${supplierName}.`,
      });
    } catch (err) {
      reportError(setNotice, err as any, "Failed to create Purchase Request");
    } finally {
      setOrderingMed(null);
    }
  };

  // Handle Physical Count Submit
  const handleExecutePhysicalCount = async () => {
    if (!physicalCountMedicine) return;
    const diff = countedQty - physicalCountMedicine.qty_available;
    if (diff === 0) {
      setNotice({ type: "info", message: "Count matches system quantity exactly. No adjustment needed." });
      setPhysicalCountMedicine(null);
      return;
    }

    setSubmittingAdj(true);
    try {
      await apiFetch("/api/pharmacy/stock/adjust", {
        method: "POST",
        body: JSON.stringify({
          pharmacy_inventory_id: physicalCountMedicine.id,
          delta_qty: diff,
          reason: `Physical Stock Count: ${countReason} (System: ${physicalCountMedicine.qty_available}, Counted: ${countedQty})`,
        }),
      });

      setNotice({ type: "success", message: `Physical stock count reconciled. Adjusted by ${diff} units.` });
      setPhysicalCountMedicine(null);
      void loadStock();
      void loadLedger();
    } catch (err) {
      reportError(setNotice, err as any, "Physical count reconciliation failed");
    } finally {
      setSubmittingAdj(false);
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
          <span style={{ color: "#0f172a", fontWeight: 700 }}>Inventory / Stock</span>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button
            type="button"
            className="primary"
            style={{ background: "#00828a", borderColor: "#00828a" }}
            onClick={() => {
              if (stock.length > 0) setAdjBatchId(stock[0].id);
              setAdjustmentModalOpen(true);
            }}
          >
            + Stock Adjustment
          </Button>
          <Button type="button" variant="secondary" onClick={() => void loadStock()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Sub-tabs Navigation */}
      <div style={{ display: "flex", borderBottom: "2px solid #e2e8f0", gap: "1.5rem", marginBottom: "1.5rem", overflowX: "auto" }}>
        {[
          { id: "overview", label: "Stock Overview" },
          { id: "ledger", label: "Stock Ledger (Audit Trail)" },
          { id: "batches", label: "Batch & Expiry" },
          { id: "low_stock", label: `Low Stock (${lowStockItems.length})` },
          { id: "physical_count", label: "Physical Stock Count" },
          { id: "transfers", label: "Stock Transfer" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            style={{
              padding: "0.6rem 0.2rem",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === tab.id ? "3px solid #00828a" : "3px solid transparent",
              color: activeTab === tab.id ? "#00828a" : "#64748b",
              fontWeight: activeTab === tab.id ? 800 : 600,
              fontSize: "0.9rem",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
            onClick={() => setActiveTab(tab.id as any)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 1. STOCK OVERVIEW */}
      {activeTab === "overview" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.75rem" }}>
            <div style={{ width: "320px" }}>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by medicine name or generic..."
              />
            </div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
              Showing {medicineAggregates.length} distinct medicines
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.6rem 0.75rem" }}>Medicine Name</th>
                  <th style={{ padding: "0.6rem 0.75rem" }}>Unit / Form</th>
                  <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Active Batches</th>
                  <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Total Quantity</th>
                  <th style={{ padding: "0.6rem 0.75rem", textAlign: "right" }}>Stock Value</th>
                  <th style={{ padding: "0.6rem 0.75rem" }}>Earliest Expiry</th>
                  <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Stock Status</th>
                </tr>
              </thead>
              <tbody>
                {medicineAggregates.map((m) => {
                  const isLow = m.total_qty <= m.reorder_level;
                  const isOut = m.total_qty === 0;

                  return (
                    <tr key={m.medicine_name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.6rem 0.75rem", fontWeight: 700, color: "#0f172a" }}>
                        {m.medicine_name}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", color: "#475569" }}>
                        {m.unit_type || "-"}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", color: "#475569" }}>
                        {m.batch_count}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", fontWeight: 700 }}>
                        {m.total_qty}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "right", fontWeight: 600, color: "#00828a" }}>
                        ₹{m.total_val.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", color: "#64748b" }}>
                        {m.nearest_exp || "-"}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "12px",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            background: isOut ? "#fee2e2" : (isLow ? "#fef3c7" : "#dcfce7"),
                            color: isOut ? "#991b1b" : (isLow ? "#92400e" : "#166534"),
                          }}
                        >
                          {isOut ? "Out of Stock" : (isLow ? "Low Stock" : "In Stock")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. STOCK LEDGER (AUDIT TRAIL) */}
      {activeTab === "ledger" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ marginBottom: "1rem" }}>
            <h3 style={{ margin: "0 0 4px 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Permanent Stock Movement Ledger
            </h3>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
              Every stock deduction, inward receipt (GRN), adjustment, and return is permanently recorded for regulatory and financial audit.
            </p>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
            <Input type="date" value={ledgerFromDate} onChange={(e) => setLedgerFromDate(e.target.value)} style={{ width: "150px" }} />
            <span style={{ color: "#94a3b8", fontSize: "12px" }}>to</span>
            <Input type="date" value={ledgerToDate} onChange={(e) => setLedgerToDate(e.target.value)} style={{ width: "150px" }} />
            <Button type="button" variant="secondary" onClick={handleExportLedgerCsv} disabled={filteredLedgerMovements.length === 0}>
              Export CSV
            </Button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Date / Time</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Movement Type</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Medicine</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Batch</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>Delta Qty</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Stock Source</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Actor / User</th>
                </tr>
              </thead>
              <tbody>
                {filteredLedgerMovements.length > 0 ? (
                  filteredLedgerMovements.map((mov) => (
                    <tr key={mov.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b" }}>
                        {mov.created_at ? new Date(mov.created_at).toLocaleString("en-IN") : "-"}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            background: mov.delta_qty > 0 ? "#dcfce7" : "#fee2e2",
                            color: mov.delta_qty > 0 ? "#166534" : "#991b1b",
                          }}
                        >
                          {mov.movement_type}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: 600 }}>{mov.medicine_name}</td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#475569" }}>{mov.batch_no || "-"}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 700, color: mov.delta_qty > 0 ? "#16a34a" : "#e11d48" }}>
                        {mov.delta_qty > 0 ? `+${mov.delta_qty}` : mov.delta_qty}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b" }}>{mov.stock_source || "CASH"}</td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#334155" }}>{mov.actor || "system"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} style={{ padding: "2rem", textAlign: "center", color: "#94a3b8" }}>
                      No stock movements recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. BATCH & EXPIRY */}
      {activeTab === "batches" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Batch Inventory & Expiry Tracking
            </h3>
            <div style={{ width: "300px" }}>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search batches..."
              />
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Medicine</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Unit / Form</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Batch No</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Mfg Date</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Expiry Date</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "center" }}>Available Qty</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>Unit Rate</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Supplier Name</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Contact Number</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Classification</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "center" }}>Expiry State</th>
                </tr>
              </thead>
              <tbody>
                {filteredStock.map((b) => {
                  const isExpired = b.expiry_date && new Date(b.expiry_date) < new Date();
                  const isNearExp = b.expiry_date && !isExpired && (new Date(b.expiry_date).getTime() - new Date().getTime()) < (30 * 24 * 60 * 60 * 1000);

                  return (
                    <tr key={b.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: 600 }}>{b.medicine_name}</td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#475569" }}>{b.unit_type || "-"}</td>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: 700, color: "#00828a" }}>{b.batch_no}</td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b" }}>{b.mfg_date || "-"}</td>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: isExpired ? 700 : 500, color: isExpired ? "#dc2626" : "#334155" }}>
                        {b.expiry_date || "-"}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "center", fontWeight: 700 }}>{b.qty_available}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "right" }}>₹{b.unit_price}</td>
                      <td style={{ padding: "0.5rem 0.75rem", fontWeight: 600, color: "#0f172a" }}>
                        {b.supplier_name || "-"}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem" }}>
                        {b.supplier_phone ? (
                          <a href={`tel:${b.supplier_phone}`} style={{ color: "#00828a", textDecoration: "none", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <span>📞</span> {b.supplier_phone}
                          </a>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#64748b" }}>{b.stock_source}</td>
                      <td style={{ padding: "0.5rem 0.75rem", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            background: isExpired ? "#fee2e2" : (isNearExp ? "#fef3c7" : "#f1f5f9"),
                            color: isExpired ? "#991b1b" : (isNearExp ? "#92400e" : "#475569"),
                          }}
                        >
                          {isExpired ? "EXPIRED" : (isNearExp ? "< 30 Days" : "Valid")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. LOW STOCK */}
      {activeTab === "low_stock" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                Low Stock Items ({lowStockItems.length})
              </h3>
              <p style={{ margin: "2px 0 0 0", fontSize: "0.85rem", color: "#64748b" }}>
                Medicines at or below each item's own reorder threshold (set in Medicine Master). Create purchase request in one click.
              </p>
            </div>
            <Button
              type="button"
              className="primary"
              style={{ background: "#00828a", borderColor: "#00828a" }}
              onClick={() => onNavigate("pharmacy-purchases")}
            >
              + Create Purchase Request
            </Button>
          </div>

          {lowStockItems.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Medicine</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Unit / Form</th>
                    <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Current Stock</th>
                    <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Reorder Level</th>
                    <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Suggested Qty</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Supplier Name</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Contact Number</th>
                    <th style={{ padding: "0.6rem 0.75rem", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStockItems.map((item) => (
                    <tr key={item.medicine_name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.6rem 0.75rem", fontWeight: 700, color: "#0f172a" }}>{item.medicine_name}</td>
                      <td style={{ padding: "0.6rem 0.75rem", color: "#475569" }}>{item.unit_type || "-"}</td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", color: "#dc2626", fontWeight: 800 }}>
                        {item.total_qty}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", color: "#64748b" }}>{item.reorder_level}</td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", fontWeight: 600 }}>{Math.max(item.reorder_level * 2 - item.total_qty, 10)}</td>
                      <td style={{ padding: "0.6rem 0.75rem", fontWeight: 600, color: "#0f172a" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ fontSize: "14px" }}>🏢</span>
                          <span>{item.supplier_name || "-"}</span>
                        </span>
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem" }}>
                        {item.supplier_phone ? (
                          <a
                            href={`tel:${item.supplier_phone}`}
                            style={{
                              color: "#00828a",
                              textDecoration: "none",
                              fontWeight: 600,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              padding: "2px 8px",
                              borderRadius: "6px",
                              background: "#f0fdfa",
                              border: "1px solid #ccfbf1",
                            }}
                            title={`Call ${item.supplier_contact_person || item.supplier_name || "Supplier"}`}
                          >
                            <span>📞</span> {item.supplier_phone}
                          </a>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.6rem 0.75rem", textAlign: "right" }}>
                        <Button
                          type="button"
                          disabled={orderingMed === item.medicine_name}
                          style={{
                            padding: "4px 12px",
                            fontSize: "0.8rem",
                            background: "#25D366",
                            borderColor: "#25D366",
                            color: "#ffffff",
                            fontWeight: 700,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            boxShadow: "0 2px 6px rgba(37, 211, 102, 0.25)",
                          }}
                          onClick={() => void handleOrderNow(item)}
                        >
                          <WhatsAppIcon size={14} />
                          {orderingMed === item.medicine_name ? "Ordering..." : "Order Now"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "#16a34a" }}>
              ✓ All medicines are currently above minimum reorder levels.
            </div>
          )}
        </div>
      )}

      {/* 5. PHYSICAL STOCK COUNT */}
      {activeTab === "physical_count" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ marginBottom: "1rem" }}>
            <h3 style={{ margin: "0 0 4px 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Physical Stock Reconciliation
            </h3>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
              Compare physical warehouse/pharmacy counts against system quantities. System creates an auditable stock adjustment for discrepancies.
            </p>
          </div>

          <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "0.6rem 0.75rem" }}>Medicine</th>
                <th style={{ padding: "0.6rem 0.75rem" }}>Unit / Form</th>
                <th style={{ padding: "0.6rem 0.75rem" }}>Batch</th>
                <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>System Qty</th>
                <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {stock.slice(0, 15).map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.6rem 0.75rem", fontWeight: 600 }}>{item.medicine_name}</td>
                  <td style={{ padding: "0.6rem 0.75rem", color: "#475569" }}>{item.unit_type || "-"}</td>
                  <td style={{ padding: "0.6rem 0.75rem", color: "#475569" }}>{item.batch_no}</td>
                  <td style={{ padding: "0.6rem 0.75rem", textAlign: "center", fontWeight: 700 }}>{item.qty_available}</td>
                  <td style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>
                    <Button
                      type="button"
                      variant="secondary"
                      style={{ padding: "2px 10px", fontSize: "0.8rem" }}
                      onClick={() => {
                        setPhysicalCountMedicine(item);
                        setCountedQty(item.qty_available);
                      }}
                    >
                      Count & Reconcile
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Physical Count Modal */}
          {physicalCountMedicine && (
            <Modal open={!!physicalCountMedicine} onClose={() => setPhysicalCountMedicine(null)}>
              <div style={{ padding: "1.5rem", maxWidth: "500px" }}>
                <h3 style={{ margin: "0 0 0.5rem 0", color: "#0f172a" }}>Reconcile Physical Count</h3>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.85rem", color: "#64748b" }}>
                  Medicine: <strong>{physicalCountMedicine.medicine_name}</strong> (Batch: {physicalCountMedicine.batch_no})
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", color: "#64748b", marginBottom: "4px" }}>
                      System Quantity:
                    </label>
                    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#334155" }}>
                      {physicalCountMedicine.qty_available}
                    </div>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", color: "#64748b", marginBottom: "4px" }}>
                      Physically Counted:
                    </label>
                    <Input
                      type="number"
                      min={0}
                      value={countedQty}
                      onChange={(e) => setCountedQty(parseInt(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <div style={{ padding: "0.6rem 0.85rem", borderRadius: "6px", background: "#f8fafc", border: "1px solid #e2e8f0", marginBottom: "1rem", fontSize: "0.85rem" }}>
                  Variance:{" "}
                  <strong style={{ color: countedQty - physicalCountMedicine.qty_available < 0 ? "#dc2626" : "#16a34a" }}>
                    {countedQty - physicalCountMedicine.qty_available} units
                  </strong>
                </div>

                <div style={{ marginBottom: "1.25rem" }}>
                  <label style={{ display: "block", fontSize: "0.8rem", color: "#475569", marginBottom: "4px" }}>
                    Audit Remarks / Reason:
                  </label>
                  <Input
                    value={countReason}
                    onChange={(e) => setCountReason(e.target.value)}
                    placeholder="Enter audit reason..."
                  />
                </div>

                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                  <Button type="button" variant="secondary" onClick={() => setPhysicalCountMedicine(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="primary"
                    style={{ background: "#00828a", borderColor: "#00828a" }}
                    disabled={submittingAdj}
                    onClick={handleExecutePhysicalCount}
                  >
                    {submittingAdj ? "Reconciling..." : "Save Reconciliation"}
                  </Button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* 6. STOCK TRANSFER */}
      {activeTab === "transfers" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
            Internal Stock Transfers (Store / Ward Racks)
          </h3>
          <p style={{ margin: "0 0 1.5rem 0", fontSize: "0.85rem", color: "#64748b" }}>
            Transfer verified stock between Main Central Pharmacy, Emergency Rack, OT Storage, and IPD Ward Cabinets.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", maxWidth: "800px", marginBottom: "1rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Source Store / Rack:
              </label>
              <select className="ui-input" style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                <option>Main Central Pharmacy</option>
                <option>Emergency Rack A</option>
                <option>OT Storage 1</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Destination Store / Ward:
              </label>
              <select className="ui-input" style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                <option>ICU Ward Cabinet</option>
                <option>General Ward Rack</option>
                <option>Emergency Room</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Transfer Quantity:
              </label>
              <Input type="number" min={1} defaultValue={10} />
            </div>
          </div>

          <Button
            type="button"
            className="primary"
            style={{ background: "#00828a", borderColor: "#00828a" }}
            onClick={() => setNotice({ type: "info", message: "Internal transfer request initiated." })}
          >
            Initiate Transfer
          </Button>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {adjustmentModalOpen && (
        <Modal open={adjustmentModalOpen} onClose={() => setAdjustmentModalOpen(false)}>
          <div style={{ padding: "1.5rem", maxWidth: "500px" }}>
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#0f172a" }}>Manual Stock Adjustment</h3>
            <p style={{ margin: "0 0 1rem 0", fontSize: "0.85rem", color: "#64748b" }}>
              Permission-controlled stock quantity correction with mandatory audit logging.
            </p>

            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Select Stock Batch:
              </label>
              <select
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={adjBatchId || ""}
                onChange={(e) => setAdjBatchId(parseInt(e.target.value) || null)}
              >
                {stock.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.medicine_name}{s.unit_type ? ` (${s.unit_type})` : ""} — Batch: {s.batch_no}, Avail: {s.qty_available}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Adjustment Type:
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: "0.4rem",
                      borderRadius: "6px",
                      border: adjDirection === "DEDUCT" ? "2px solid #e11d48" : "1px solid #cbd5e1",
                      background: adjDirection === "DEDUCT" ? "#fef2f2" : "#ffffff",
                      color: adjDirection === "DEDUCT" ? "#e11d48" : "#475569",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                    onClick={() => setAdjDirection("DEDUCT")}
                  >
                    - Deduct
                  </button>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: "0.4rem",
                      borderRadius: "6px",
                      border: adjDirection === "ADD" ? "2px solid #16a34a" : "1px solid #cbd5e1",
                      background: adjDirection === "ADD" ? "#f0fdf4" : "#ffffff",
                      color: adjDirection === "ADD" ? "#16a34a" : "#475569",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                    onClick={() => setAdjDirection("ADD")}
                  >
                    + Add
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Quantity:
                </label>
                <Input
                  type="number"
                  min={1}
                  value={adjDelta}
                  onChange={(e) => setAdjDelta(Math.max(1, parseInt(e.target.value) || 1))}
                />
              </div>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Reason for Adjustment:
              </label>
              <select
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
              >
                <option value="Damage / Breakage">Damage / Breakage</option>
                <option value="Expiry Write-off">Expiry Write-off</option>
                <option value="Physical Count Discrepancy">Physical Count Discrepancy</option>
                <option value="Correction of Data Entry">Correction of Data Entry</option>
                <option value="Supplier Replacement Sample">Supplier Replacement Sample</option>
              </select>
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Remarks / Authorization Note:
              </label>
              <Input
                value={adjRemarks}
                onChange={(e) => setAdjRemarks(e.target.value)}
                placeholder="Required for audit compliance..."
              />
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => setAdjustmentModalOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a" }}
                disabled={submittingAdj || !adjBatchId}
                onClick={handleExecuteAdjustment}
              >
                {submittingAdj ? "Saving..." : "Apply Adjustment"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* WhatsApp Sharing Modal */}
      {whatsAppModalOpen && (
        <Modal open={whatsAppModalOpen} onClose={() => setWhatsAppModalOpen(false)}>
          <div style={{ padding: "1.5rem", maxWidth: "520px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "0.75rem" }}>
              <div style={{ background: "#25D366", color: "#ffffff", width: "38px", height: "38px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <WhatsAppIcon size={22} />
              </div>
              <div>
                <h3 style={{ margin: 0, color: "#0f172a", fontSize: "1.15rem" }}>
                  {whatsAppTitle}
                </h3>
                <p style={{ margin: 0, fontSize: "0.82rem", color: "#64748b" }}>
                  Send purchase requisition directly to supplier on WhatsApp
                </p>
              </div>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                WhatsApp Mobile Number:
              </label>
              <Input
                type="text"
                placeholder="10-digit mobile number (e.g. 9876543210) or leave blank"
                value={whatsAppPhone}
                onChange={(e) => setWhatsAppPhone(e.target.value)}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "3px", display: "block" }}>
                {whatsAppRecipient ? `Recipient: ${whatsAppRecipient}` : "Leave blank to choose any contact or group in WhatsApp"}
              </span>
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Message Content (Preview & Edit):
              </label>
              <textarea
                rows={9}
                className="ui-input"
                style={{
                  width: "100%",
                  fontFamily: "monospace",
                  fontSize: "0.82rem",
                  padding: "0.65rem",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  lineHeight: "1.4",
                  resize: "vertical",
                }}
                value={whatsAppMessage}
                onChange={(e) => setWhatsAppMessage(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
              <Button type="button" variant="secondary" onClick={() => setWhatsAppModalOpen(false)}>
                Close
              </Button>
              <Button
                type="button"
                style={{
                  background: "#25D366",
                  borderColor: "#25D366",
                  color: "#ffffff",
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "0.55rem 1.25rem",
                  boxShadow: "0 2px 6px rgba(37, 211, 102, 0.35)",
                }}
                onClick={handleSendWhatsApp}
              >
                <WhatsAppIcon size={18} /> Open in WhatsApp
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
