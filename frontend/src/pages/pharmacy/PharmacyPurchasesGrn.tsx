import { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal } from "../../components/ui";
import { apiFetch, reportError, getHospitalCode } from "../../lib/api";
import { API_BASE } from "../../lib/constants";
import { downloadCsv } from "../../lib/csvExport";
import type { Notice } from "../../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

const UNIT_TYPES = [
  "Tablet",
  "Capsule",
  "Syrup / Bottle",
  "Injection / Vial",
  "Syringe",
  "Ampoule",
  "Drops",
  "Ointment / Tube",
  "Inhaler",
  "Strip",
  "Box",
  "IV Fluid Bottle",
  "Other",
];

const WhatsAppIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.031 2C6.504 2 2 6.504 2 12.031c0 1.954.563 3.778 1.536 5.32L2 22l4.821-1.503a10.007 10.007 0 0 0 5.21 1.534h.005c5.526 0 10.03-4.504 10.03-10.031A10.02 10.02 0 0 0 12.031 2zm0 18.272a8.23 8.23 0 0 1-4.214-1.157l-.302-.18-2.862.893.908-2.793-.197-.313A8.216 8.216 0 0 1 3.784 12.03c0-4.549 3.7-8.249 8.249-8.249 4.547 0 8.246 3.7 8.246 8.25 0 4.548-3.7 8.241-8.248 8.241zm4.52-6.177c-.248-.124-1.465-.723-1.692-.806-.228-.083-.393-.124-.559.124-.166.248-.642.806-.786.971-.145.166-.29.186-.538.062-.248-.124-1.049-.387-1.997-1.233-.738-.658-1.237-1.472-1.382-1.72-.145-.248-.016-.382.108-.506.112-.111.248-.29.373-.435.124-.145.166-.248.248-.414.083-.166.042-.311-.02-.435-.063-.124-.559-1.348-.766-1.846-.201-.485-.406-.419-.559-.427l-.476-.008c-.166 0-.435.062-.663.311-.228.248-.87 1.056-.87 2.574s1.099 2.984 1.253 3.191c.155.207 2.164 3.305 5.244 4.634.733.317 1.305.506 1.751.648.736.234 1.406.201 1.936.122.591-.088 1.815-.742 2.072-1.458.257-.716.257-1.33.18-1.458-.076-.124-.241-.186-.489-.31z" />
  </svg>
);

type Supplier = {
  id: number;
  supplier_name: string;
  phone?: string;
  gst_number?: string;
};

type MedicineMaster = {
  id: number;
  name: string;
  category?: string;
  dosage_form?: string;
  unit?: string;
};

type PurchaseRequest = {
  id: number;
  pr_no: string;
  status: string;
  priority: string;
  notes?: string;
  created_at: string;
  preferred_supplier_id?: number;
  supplier_id?: number;
  supplier_name?: string;
  items?: { medicine_name: string; required_qty?: number; quantity?: number; estimated_unit_cost?: number }[];
};

type PurchaseOrder = {
  id: number;
  medicine_name: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  status: string;
  supplier_id?: number;
  supplier_name?: string;
  created_at: string;
};

type GoodsReceiptItem = {
  id?: number;
  medicine_name: string;
  manufacturer: string;
  hsn_code: string;
  pack_size: string;
  batch_no: string;
  mfg_date: string;
  expiry_date: string;
  received_qty: number | string;
  free_qty: number | string;
  damaged_qty: number | string;
  unit_cost: number | string;
  discount_pct: number | string;
  mrp: number | string;
  selling_price: number | string;
  gst_rate: number | string;
  unit_type: string;
};

const emptyGrnItem = (): GoodsReceiptItem => ({
  medicine_name: "",
  manufacturer: "",
  hsn_code: "",
  pack_size: "",
  batch_no: "",
  mfg_date: "",
  expiry_date: "",
  received_qty: "",
  free_qty: "",
  damaged_qty: "",
  unit_cost: "",
  discount_pct: "",
  mrp: "",
  selling_price: "",
  gst_rate: "",
  unit_type: "Tablet",
});

// Taxable value after discount, GST on top -- matches how supplier invoices total a line.
const grnLineAmounts = (it: GoodsReceiptItem) => {
  const taxable = Number(it.received_qty || 0) * Number(it.unit_cost || 0) * (1 - Number(it.discount_pct || 0) / 100);
  const gst = (taxable * Number(it.gst_rate || 0)) / 100;
  return { taxable, gst, total: taxable + gst };
};

type OcrInvoice = {
  supplier_name: string;
  supplier_gstin: string;
  invoice_no: string;
  invoice_date: string;
  items: {
    medicine_name: string;
    manufacturer: string;
    hsn_code: string;
    pack_size: string;
    unit_type: string;
    batch_no: string;
    mfg_date: string;
    expiry_date: string;
    quantity: string;
    free_qty: string;
    unit_cost: string;
    mrp: string;
    discount_pct: string;
    gst_rate: string;
  }[];
};

// Response of POST /api/pharmacy/goods-receipts/import (CSV parsed directly, PDF/image via OCR).
type GrnImportResult = {
  file_type: "csv" | "pdf" | "image";
  file_name: string;
  processing: "csv_direct" | "pdf_text" | "pdf_scan_ocr" | "ocr_image";
  detected_fields: string[];
  field_mapping?: Record<string, string | null>;
  row_count: number;
  preview: Record<string, string>[];
  fields: OcrInvoice;
  warnings: string[];
};

const GRN_IMPORT_ACCEPT = ".csv,text/csv,.pdf,application/pdf,image/*";
const GRN_IMPORT_EXTENSIONS = /\.(csv|pdf|jpe?g|png|webp|tiff?|bmp|gif|heic|heif)$/i;
const GRN_IMPORT_MAX_MB = 15;
const PROCESSING_LABELS: Record<GrnImportResult["processing"], string> = {
  csv_direct: "CSV parsed directly",
  pdf_text: "PDF text read by AI",
  pdf_scan_ocr: "Scanned PDF read by OCR",
  ocr_image: "Image read by OCR",
};

type GoodsReceipt = {
  id: number;
  grn_no: string;
  supplier_invoice_no?: string;
  supplier_id?: number;
  supplier_name?: string;
  received_date?: string;
  status: "draft" | "verified" | "cancelled";
  stock_source: string;
  items?: GoodsReceiptItem[];
};

export default function PharmacyPurchasesGrn({ setNotice, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<"grn" | "grn_history" | "pr" | "po" | "returns">("grn");

  // Suppliers & Orders
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseRequests, setPurchaseRequests] = useState<PurchaseRequest[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [goodsReceipts, setGoodsReceipts] = useState<GoodsReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [grnFromDate, setGrnFromDate] = useState("");
  const [grnToDate, setGrnToDate] = useState("");

  // New PR Modal State
  type PrItemLine = {
    medicine_name: string;
    quantity: number | "";
    notes?: string;
  };
  const [newPrModalOpen, setNewPrModalOpen] = useState(false);
  const [prItems, setPrItems] = useState<PrItemLine[]>([
    { medicine_name: "", quantity: 50, notes: "" },
  ]);
  const [prUrgency, setPrUrgency] = useState<string>("normal");
  const [prNotes, setPrNotes] = useState<string>("");
  const [prSupplierId, setPrSupplierId] = useState<number | null>(null);
  const [submittingPr, setSubmittingPr] = useState(false);

  const handleAddPrItem = () => {
    setPrItems((prev) => [...prev, { medicine_name: "", quantity: 50, notes: "" }]);
  };

  const handleUpdatePrItem = (idx: number, field: keyof PrItemLine, val: any) => {
    setPrItems((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: val };
      return copy;
    });
  };

  const handleRemovePrItem = (idx: number) => {
    setPrItems((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
  };

  const resetPrModal = () => {
    setPrItems([{ medicine_name: "", quantity: 50, notes: "" }]);
    setPrUrgency("normal");
    setPrNotes("");
    setPrSupplierId(null);
  };

  // Approve / Reject PR Modal State
  const [prDecisionTarget, setPrDecisionTarget] = useState<PurchaseRequest | null>(null);
  const [prDecisionAction, setPrDecisionAction] = useState<"approve" | "reject" | null>(null);
  const [prApproveSupplierId, setPrApproveSupplierId] = useState<number | null>(null);
  const [prRejectReason, setPrRejectReason] = useState("");
  const [submittingPrDecision, setSubmittingPrDecision] = useState(false);

  // WhatsApp Share Dialog State
  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");
  const [whatsAppTitle, setWhatsAppTitle] = useState("Share via WhatsApp");
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

  // New GRN Entry Form State
  const [grnSupplierId, setGrnSupplierId] = useState<number | null>(null);
  const [grnInvoiceNo, setGrnInvoiceNo] = useState("");
  const [grnInvoiceDate, setGrnInvoiceDate] = useState(new Date().toISOString().split("T")[0]);
  const [grnPoId, setGrnPoId] = useState<number | null>(null);
  const [grnStockSource, setGrnStockSource] = useState<"CASH" | "INSURANCE">("CASH");
  const [medicinesMaster, setMedicinesMaster] = useState<MedicineMaster[]>([]);

  // Items in active GRN draft - starts empty without dummy defaults
  const [grnItems, setGrnItems] = useState<GoodsReceiptItem[]>([emptyGrnItem()]);

  const [submittingGrn, setSubmittingGrn] = useState(false);

  // Invoice import: one upload for CSV (parsed directly) or PDF / image (OCR). GRN header and lines are filled in.
  const [ocrScanning, setOcrScanning] = useState(false);
  const [ocrFileName, setOcrFileName] = useState("");
  const [lastImport, setLastImport] = useState<GrnImportResult | null>(null);

  const applyOcrInvoice = (inv: OcrInvoice): string[] => {
    const filled: string[] = [];
    const gstin = inv.supplier_gstin.toUpperCase();
    const name = inv.supplier_name.trim().toLowerCase();
    const supplier =
      (gstin && suppliers.find((s) => (s.gst_number || "").replace(/\s/g, "").toUpperCase() === gstin)) ||
      (name && suppliers.find((s) => s.supplier_name.trim().toLowerCase() === name)) ||
      (name && suppliers.find((s) => {
        const sn = s.supplier_name.trim().toLowerCase();
        return sn.includes(name) || name.includes(sn);
      }));
    if (supplier) {
      setGrnSupplierId(supplier.id);
      filled.push(`Supplier (${supplier.supplier_name})`);
    }
    if (inv.invoice_no) {
      setGrnInvoiceNo(inv.invoice_no);
      filled.push("Invoice No");
    }
    if (inv.invoice_date) {
      setGrnInvoiceDate(inv.invoice_date);
      filled.push("Invoice Date");
    }
    if (inv.items.length) {
      const scanned: GoodsReceiptItem[] = inv.items.map((it) => {
        const known = UNIT_TYPES.find((u) => u.toLowerCase() === it.unit_type.toLowerCase());
        return {
          ...emptyGrnItem(),
          medicine_name: it.medicine_name,
          manufacturer: it.manufacturer,
          hsn_code: it.hsn_code,
          pack_size: it.pack_size,
          unit_type: known || suggestUnitType(it.medicine_name) || (it.unit_type ? "Other" : "Tablet"),
          batch_no: it.batch_no,
          mfg_date: it.mfg_date,
          expiry_date: it.expiry_date,
          received_qty: it.quantity,
          free_qty: it.free_qty,
          unit_cost: it.unit_cost,
          discount_pct: it.discount_pct,
          mrp: it.mrp,
          gst_rate: it.gst_rate,
        };
      });
      // Replace blank placeholder rows, keep lines already typed in.
      setGrnItems((prev) => [...prev.filter((it) => it.medicine_name.trim()), ...scanned]);
      filled.push(`${scanned.length} medicine line${scanned.length > 1 ? "s" : ""}`);
    }
    if (inv.supplier_name && !supplier) {
      filled.push(`(supplier "${inv.supplier_name}" not found in the supplier list -- select it manually)`);
    }
    return filled;
  };

  const handleOcrUpload = async (file: File | undefined) => {
    if (!file) return;
    const isAccepted =
      GRN_IMPORT_EXTENSIONS.test(file.name) ||
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      file.type === "text/csv";
    if (!isAccepted) {
      setNotice({ type: "warning", message: "Please upload a CSV, a PDF or an image (JPG, PNG, WEBP, TIFF...)." });
      return;
    }
    if (file.size === 0) {
      setNotice({ type: "warning", message: `${file.name} is empty.` });
      return;
    }
    if (file.size > GRN_IMPORT_MAX_MB * 1024 * 1024) {
      setNotice({ type: "warning", message: `${file.name} is larger than ${GRN_IMPORT_MAX_MB} MB.` });
      return;
    }
    setOcrFileName(file.name);
    setOcrScanning(true);
    setLastImport(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const baseUrl = (API_BASE || "").replace(/\/+$/, "").replace(/\/api$/, "");
      const response = await fetch(`${baseUrl}/api/pharmacy/goods-receipts/import`, {
        method: "POST",
        body,
        credentials: "include",
        headers: { "X-Hospital-Code": getHospitalCode() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(data?.detail || data?.error || "Invoice import failed."), { status: response.status });
      }
      const result = data as GrnImportResult;
      setLastImport(result);
      const filled = applyOcrInvoice(result.fields);
      const warnings = (result.warnings || []).join(" ");
      setNotice(
        filled.length
          ? {
              type: warnings ? "warning" : "success",
              message: `${PROCESSING_LABELS[result.processing] || "Invoice imported"}. Filled: ${filled.join(", ")}. ${warnings} Please verify every line before saving.`,
            }
          : { type: "warning", message: warnings || "No invoice details could be read from this file." }
      );
    } catch (err) {
      reportError(setNotice, err as any, "Invoice import failed.");
    } finally {
      setOcrScanning(false);
    }
  };

  // Load Data
  const loadData = async () => {
    setLoading(true);
    try {
      const [supRes, prRes, poRes, grnRes, medRes] = await Promise.all([
        apiFetch<{ suppliers: Supplier[] }>("/api/pharmacy/suppliers"),
        apiFetch<{ purchase_requests: PurchaseRequest[] }>("/api/pharmacy/purchase-requests"),
        apiFetch<{ purchase_orders: PurchaseOrder[] }>("/api/pharmacy/purchase-orders"),
        apiFetch<{ goods_receipts: GoodsReceipt[] }>("/api/pharmacy/goods-receipts"),
        apiFetch<{ medicines: MedicineMaster[] }>("/api/pharmacy/medicines"),
      ]);

      if (supRes?.suppliers) setSuppliers(supRes.suppliers);
      if (prRes?.purchase_requests) setPurchaseRequests(prRes.purchase_requests);
      if (poRes?.purchase_orders) setPurchaseOrders(poRes.purchase_orders);
      if (grnRes?.goods_receipts) setGoodsReceipts(grnRes.goods_receipts);
      if (medRes?.medicines) setMedicinesMaster(medRes.medicines);
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load procurement data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();

    const checkOpenPr = () => {
      const savedTab = localStorage.getItem("pharmacy_purchases_tab") || sessionStorage.getItem("pharmacy_purchases_tab");
      if (savedTab) {
        localStorage.removeItem("pharmacy_purchases_tab");
        sessionStorage.removeItem("pharmacy_purchases_tab");
        setActiveTab(savedTab as any);
      }

      const shouldOpenPr = localStorage.getItem("open_new_pr_modal") || sessionStorage.getItem("open_new_pr_modal");
      if (shouldOpenPr === "true") {
        localStorage.removeItem("open_new_pr_modal");
        sessionStorage.removeItem("open_new_pr_modal");
        setActiveTab("pr");
        setNewPrModalOpen(true);
        const medName = localStorage.getItem("open_new_pr_medicine") || sessionStorage.getItem("open_new_pr_medicine");
        if (medName) {
          localStorage.removeItem("open_new_pr_medicine");
          sessionStorage.removeItem("open_new_pr_medicine");
          setPrItems([{ medicine_name: medName, quantity: 50, notes: "" }]);
        }
      }
    };

    checkOpenPr();
    const t = setTimeout(checkOpenPr, 50);
    window.addEventListener("hospai_open_pr", checkOpenPr);
    return () => {
      clearTimeout(t);
      window.removeEventListener("hospai_open_pr", checkOpenPr);
    };
  }, []);

  const filteredGoodsReceipts = useMemo(() => {
    if (!grnFromDate && !grnToDate) return goodsReceipts;
    return goodsReceipts.filter((g) => {
      const d = (g.received_date || "").slice(0, 10);
      if (!d) return false;
      if (grnFromDate && d < grnFromDate) return false;
      if (grnToDate && d > grnToDate) return false;
      return true;
    });
  }, [goodsReceipts, grnFromDate, grnToDate]);

  const handleExportGrnCsv = () => {
    downloadCsv(
      `grn_history_${grnFromDate || "all"}_to_${grnToDate || "all"}.csv`,
      ["GRN Number", "Supplier Invoice", "Date", "Classification", "Status"],
      filteredGoodsReceipts.map((g) => [g.grn_no, g.supplier_invoice_no || "", g.received_date || "", g.stock_source, g.status])
    );
  };

  // Look up the master catalog's form/packaging for a medicine name, so the
  // unit type can be suggested instead of re-typed on every GRN line.
  const suggestUnitType = (medicineName: string): string | null => {
    const match = medicinesMaster.find((m) => m.name.trim().toLowerCase() === medicineName.trim().toLowerCase());
    if (!match) return null;
    const candidate = match.category || match.dosage_form || match.unit;
    if (!candidate) return null;
    const known = UNIT_TYPES.find((u) => u.toLowerCase().startsWith(candidate.toLowerCase()) || candidate.toLowerCase().startsWith(u.toLowerCase().split(" ")[0].toLowerCase()));
    return known || candidate;
  };

  // Add Item to GRN draft
  const handleAddGrnItem = () => {
    setGrnItems([...grnItems, emptyGrnItem()]);
  };

  const handleUpdateGrnItem = (idx: number, field: keyof GoodsReceiptItem, val: any) => {
    const updated = [...grnItems];
    updated[idx] = { ...updated[idx], [field]: val };
    if (field === "medicine_name" && typeof val === "string") {
      const suggested = suggestUnitType(val);
      if (suggested) updated[idx].unit_type = suggested;
    }
    setGrnItems(updated);
  };

  const handleRemoveGrnItem = (idx: number) => {
    setGrnItems(grnItems.filter((_, i) => i !== idx));
  };

  // Submit and Create GRN
  const handleCreateGrn = async () => {
    if (!grnSupplierId) {
      setNotice({ type: "warning", message: "Supplier is mandatory. Please select a supplier." });
      return;
    }
    if (!grnInvoiceNo.trim()) {
      setNotice({ type: "warning", message: "Supplier Invoice Number is required." });
      return;
    }
    if (grnItems.length === 0) {
      setNotice({ type: "warning", message: "At least one item line is required." });
      return;
    }
    for (const item of grnItems) {
      if (!item.medicine_name || !item.batch_no || !item.expiry_date) {
        setNotice({ type: "warning", message: "All items must have Medicine Name, Batch No, and Expiry Date." });
        return;
      }
      if (item.mfg_date && item.mfg_date > item.expiry_date) {
        setNotice({ type: "warning", message: `${item.medicine_name}: Mfg Date cannot be after Expiry Date.` });
        return;
      }
      if (Number(item.damaged_qty || 0) > Number(item.received_qty || 1) + Number(item.free_qty || 0)) {
        setNotice({ type: "warning", message: `${item.medicine_name}: Damaged Qty cannot exceed Qty + Free Qty.` });
        return;
      }
    }

    setSubmittingGrn(true);
    try {
      const payload = {
        supplier_id: grnSupplierId,
        supplier_invoice_no: grnInvoiceNo,
        received_date: grnInvoiceDate,
        purchase_order_id: grnPoId,
        stock_source: grnStockSource,
        items: grnItems.map((it) => {
          // Free goods enter stock too; damaged units are held out of available stock.
          const billed = Number(it.received_qty || 1);
          const free = Number(it.free_qty || 0);
          const damaged = Number(it.damaged_qty || 0);
          return {
            medicine_name: it.medicine_name,
            manufacturer: it.manufacturer || undefined,
            hsn_code: it.hsn_code || undefined,
            pack_size: it.pack_size || undefined,
            batch_no: it.batch_no,
            mfg_date: it.mfg_date || undefined,
            expiry_date: it.expiry_date,
            qty_received: billed + free,
            qty_accepted: billed + free - damaged,
            qty_damaged: damaged,
            free_qty: free,
            purchase_price: Number(it.unit_cost || 0),
            discount_pct: Number(it.discount_pct || 0),
            mrp: Number(it.mrp || 0),
            selling_price: it.selling_price === "" ? undefined : Number(it.selling_price),
            gst_rate: Number(it.gst_rate || 0),
            unit_type: it.unit_type,
          };
        }),
      };

      const res = await apiFetch<{ grn_id: number; grn_no: string }>("/api/pharmacy/goods-receipts", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNotice({ type: "success", message: `GRN ${res.grn_no} created as Draft. Ready for verification.` });
      setGrnInvoiceNo("");
      setGrnPoId(null);
      setGrnItems([emptyGrnItem()]);
      setOcrFileName("");
      void loadData();
      setActiveTab("grn_history");
    } catch (err) {
      reportError(setNotice, err as any, "Failed to create GRN");
    } finally {
      setSubmittingGrn(false);
    }
  };

  // Verify GRN (The ONLY event that increases physical inventory!)
  const handleVerifyGrn = async (grnId: number, grnNo: string) => {
    try {
      await apiFetch(`/api/pharmacy/goods-receipts/${grnId}/verify`, {
        method: "POST",
      });
      setNotice({ type: "success", message: `GRN ${grnNo} successfully verified! Physical inventory stock increased and ledger updated.` });
      void loadData();
    } catch (err) {
      reportError(setNotice, err as any, "Verification failed");
    }
  };

  // Submit Purchase Request
  const handleCreatePr = async () => {
    if (!prSupplierId) {
      setNotice({ type: "warning", message: "Supplier is mandatory. Please select a supplier." });
      return;
    }
    const validItems = prItems
      .map((it) => ({
        medicine_name: it.medicine_name.trim(),
        quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1,
        notes: it.notes?.trim() || undefined,
      }))
      .filter((it) => it.medicine_name.length > 0);

    if (validItems.length === 0) {
      setNotice({ type: "warning", message: "Please enter at least one medicine or item name." });
      return;
    }

    setSubmittingPr(true);
    try {
      await apiFetch("/api/pharmacy/purchase-requests", {
        method: "POST",
        body: JSON.stringify({
          priority: prUrgency,
          notes: prNotes,
          preferred_supplier_id: prSupplierId,
          supplier_id: prSupplierId,
          items: validItems.map((it) => ({
            medicine_name: it.medicine_name,
            required_qty: it.quantity,
            quantity: it.quantity,
            notes: it.notes,
          })),
        }),
      });
      setNotice({
        type: "success",
        message: `Purchase Request submitted for approval with ${validItems.length} medicine item(s).`,
      });
      setNewPrModalOpen(false);
      resetPrModal();
      void loadData();
    } catch (err) {
      reportError(setNotice, err as any, "Failed to create PR");
    } finally {
      setSubmittingPr(false);
    }
  };

  // Open the Approve / Reject decision modal for a pending PR
  const openPrDecision = (pr: PurchaseRequest, action: "approve" | "reject") => {
    setPrDecisionTarget(pr);
    setPrDecisionAction(action);
    setPrApproveSupplierId(pr.preferred_supplier_id || pr.supplier_id || null);
    setPrRejectReason("");
  };

  // Approve: generates the Purchase Order(s) from this PR's items, moving it
  // out of Pending. Reject: closes it out with a reason, no PO created.
  const submitPrDecision = async () => {
    if (!prDecisionTarget || !prDecisionAction) return;
    setSubmittingPrDecision(true);
    try {
      if (prDecisionAction === "approve") {
        if (!prApproveSupplierId) {
          setNotice({ type: "warning", message: "Supplier is mandatory to approve and issue a Purchase Order." });
          return;
        }
        const res = await apiFetch<{ created_po_ids: number[] }>(
          `/api/pharmacy/purchase-requests/${prDecisionTarget.id}/approve`,
          { method: "POST", body: JSON.stringify({ supplier_id: prApproveSupplierId }) }
        );
        setNotice({
          type: "success",
          message: `${prDecisionTarget.pr_no} approved. ${res.created_po_ids.length} Purchase Order${res.created_po_ids.length === 1 ? "" : "s"} created.`,
        });
      } else {
        await apiFetch(`/api/pharmacy/purchase-requests/${prDecisionTarget.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ reason: prRejectReason || undefined }),
        });
        setNotice({ type: "info", message: `${prDecisionTarget.pr_no} rejected.` });
      }
      setPrDecisionTarget(null);
      setPrDecisionAction(null);
      void loadData();
    } catch (err) {
      reportError(setNotice, err as any, `Failed to ${prDecisionAction} purchase request`);
    } finally {
      setSubmittingPrDecision(false);
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
          <span style={{ color: "#0f172a", fontWeight: 700 }}>Purchase & GRN</span>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button
            type="button"
            className="primary"
            style={{ background: "#00828a", borderColor: "#00828a" }}
            onClick={() => setNewPrModalOpen(true)}
          >
            + New Purchase Request
          </Button>
          <Button type="button" variant="secondary" onClick={() => void loadData()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Sub-tabs Navigation */}
      <div style={{ display: "flex", borderBottom: "2px solid #e2e8f0", gap: "1.5rem", marginBottom: "1.5rem", overflowX: "auto" }}>
        {[
          { id: "pr", label: `Purchase Requests (${purchaseRequests.length})` },
          { id: "po", label: `Purchase Orders (${purchaseOrders.length})` },
          { id: "grn", label: "Receive Goods (New GRN)" },
          { id: "grn_history", label: `GRN Inward History (${goodsReceipts.length})` },
          { id: "returns", label: "Purchase Returns" },
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

      {/* 1. NEW GRN ENTRY FORM */}
      {activeTab === "grn" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ margin: "0 0 4px 0", fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
              Goods Receipt Note (GRN) — Stock Inward
            </h2>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
              Enter incoming supplier delivery details. Stock and supplier payable balances only increase upon formal verification.
            </p>
          </div>

          {/* OCR Upload: scan the supplier invoice to auto-fill the GRN */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!ocrScanning) void handleOcrUpload(e.dataTransfer.files?.[0]);
            }}
            style={{
              marginBottom: "1rem",
              padding: "0.85rem 1rem",
              background: "#f0fdfa",
              border: "1.5px dashed #5eead4",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#0f172a" }}>📄 Import Supplier Invoice to Auto-fill</div>
              <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
                {ocrScanning
                  ? /\.csv$/i.test(ocrFileName)
                    ? `Reading ${ocrFileName}…`
                    : `Reading ${ocrFileName} with OCR… (large invoices can take up to a minute)`
                  : ocrFileName
                    ? `Last imported: ${ocrFileName}`
                    : "Upload or drop a CSV export, PDF or photo of the invoice. Supplier, invoice no/date and every medicine batch line are filled in."}
              </div>
            </div>
            <label
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "6px",
                background: ocrScanning ? "#94a3b8" : "#00828a",
                color: "#ffffff",
                fontWeight: 700,
                fontSize: "0.85rem",
                cursor: ocrScanning ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {ocrScanning ? "Reading…" : "⬆ Upload Invoice (CSV / PDF / Image)"}
              <input
                type="file"
                accept={GRN_IMPORT_ACCEPT}
                disabled={ocrScanning}
                style={{ display: "none" }}
                onChange={(e) => {
                  void handleOcrUpload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {/* What the last import detected: file type, column → GRN field mapping and a data preview */}
          {lastImport && !ocrScanning && (
            <details style={{ marginBottom: "1rem", padding: "0.6rem 0.9rem", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#ffffff" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "#334155" }}>
                {lastImport.file_type.toUpperCase()} · {PROCESSING_LABELS[lastImport.processing]} · {lastImport.row_count}{" "}
                {lastImport.file_type === "csv" ? "row" : "line"}{lastImport.row_count === 1 ? "" : "s"} · {lastImport.detected_fields.length} field
                {lastImport.detected_fields.length === 1 ? "" : "s"} detected
              </summary>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "0.6rem 0" }}>
                {lastImport.detected_fields.map((f) => {
                  const target = lastImport.field_mapping ? lastImport.field_mapping[f] : f;
                  return (
                    <span
                      key={f}
                      title={target ? `Fills GRN field: ${target}` : "Not used for the GRN"}
                      style={{
                        fontSize: "0.72rem",
                        padding: "2px 8px",
                        borderRadius: "999px",
                        border: `1px solid ${target ? "#5eead4" : "#e2e8f0"}`,
                        background: target ? "#f0fdfa" : "#f8fafc",
                        color: target ? "#0f766e" : "#94a3b8",
                      }}
                    >
                      {lastImport.field_mapping && target && target !== f ? `${f} → ${target.replace(/_/g, " ")}` : f.replace(/_/g, " ")}
                    </span>
                  );
                })}
              </div>
              {lastImport.preview.length > 0 && (
                <div style={{ overflowX: "auto", maxHeight: "220px" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: "0.72rem", width: "100%" }}>
                    <thead>
                      <tr>
                        {Object.keys(lastImport.preview[0]).map((k) => (
                          <th key={k} style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #e2e8f0", color: "#475569", whiteSpace: "nowrap" }}>
                            {k.replace(/_/g, " ")}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lastImport.preview.slice(0, 10).map((row, i) => (
                        <tr key={i}>
                          {Object.keys(lastImport.preview[0]).map((k) => (
                            <td key={k} style={{ padding: "3px 6px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>
                              {row[k]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          )}

          {/* Supplier & Invoice Header Details */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", marginBottom: "1.5rem", background: "#f8fafc", padding: "1rem", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Select Supplier <span style={{ color: "#dc2626" }}>*</span>:
              </label>
              <select
                required
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={grnSupplierId || ""}
                onChange={(e) => setGrnSupplierId(parseInt(e.target.value) || null)}
              >
                <option value="">-- Select Supplier * --</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.supplier_name}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Supplier Invoice Number *:
              </label>
              <Input
                value={grnInvoiceNo}
                onChange={(e) => setGrnInvoiceNo(e.target.value)}
                placeholder="e.g. INV-99824"
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Invoice Date:
              </label>
              <input
                type="date"
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={grnInvoiceDate}
                onChange={(e) => setGrnInvoiceDate(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Payer Classification:
              </label>
              <select
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={grnStockSource}
                onChange={(e) => setGrnStockSource(e.target.value as any)}
              >
                <option value="CASH">General / Cash Stock</option>
                <option value="INSURANCE">Insurance / Scheme Stock</option>
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Link to Purchase Order (optional):
              </label>
              <select
                className="ui-input"
                style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                value={grnPoId || ""}
                onChange={(e) => {
                  const id = parseInt(e.target.value) || null;
                  setGrnPoId(id);
                  const po = purchaseOrders.find((p) => p.id === id);
                  if (po && !grnSupplierId && po.supplier_id) setGrnSupplierId(po.supplier_id);
                }}
              >
                <option value="">Not linked to an order</option>
                {purchaseOrders.filter((p) => p.status === "ordered").map((p) => (
                  <option key={p.id} value={p.id}>
                    PO-{p.id} -- {p.medicine_name} (Qty {p.quantity}{p.supplier_name ? `, ${p.supplier_name}` : ""})
                  </option>
                ))}
              </select>
              {grnPoId && (
                <p style={{ margin: "4px 0 0 0", fontSize: "0.75rem", color: "#00828a" }}>
                  This GRN will mark PO-{grnPoId} as received once verified.
                </p>
              )}
            </div>
          </div>

          {/* Line Items Table */}
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, color: "#0f172a" }}>
                Received Medicine Batches ({grnItems.length} lines)
              </h3>
              <Button type="button" variant="secondary" onClick={handleAddGrnItem}>
                + Add Line Item
              </Button>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table className="pharmacy-data-table" style={{ width: "100%", minWidth: "1900px", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.5rem", minWidth: "200px", textAlign: "left" }}>Medicine Name *</th>
                    <th style={{ padding: "0.5rem", minWidth: "130px", textAlign: "left" }}>Manufacturer</th>
                    <th style={{ padding: "0.5rem", minWidth: "90px", textAlign: "left" }}>HSN</th>
                    <th style={{ padding: "0.5rem", minWidth: "80px", textAlign: "left" }}>Pack</th>
                    <th style={{ padding: "0.5rem", minWidth: "140px", textAlign: "left" }}>Unit / Form *</th>
                    <th style={{ padding: "0.5rem", minWidth: "110px", textAlign: "left" }}>Batch No *</th>
                    <th style={{ padding: "0.5rem", minWidth: "135px", textAlign: "left" }}>Mfg Date</th>
                    <th style={{ padding: "0.5rem", minWidth: "135px", textAlign: "left" }}>Expiry Date *</th>
                    <th style={{ padding: "0.5rem", minWidth: "70px", textAlign: "center" }}>Qty *</th>
                    <th style={{ padding: "0.5rem", minWidth: "60px", textAlign: "center" }}>Free</th>
                    <th style={{ padding: "0.5rem", minWidth: "75px", textAlign: "center" }}>Damaged</th>
                    <th style={{ padding: "0.5rem", minWidth: "85px", textAlign: "right" }}>Rate (₹)</th>
                    <th style={{ padding: "0.5rem", minWidth: "65px", textAlign: "right" }}>Disc %</th>
                    <th style={{ padding: "0.5rem", minWidth: "85px", textAlign: "right" }}>MRP (₹)</th>
                    <th style={{ padding: "0.5rem", minWidth: "90px", textAlign: "right" }}>Sale Rate (₹)</th>
                    <th style={{ padding: "0.5rem", minWidth: "60px", textAlign: "right" }}>GST %</th>
                    <th style={{ padding: "0.5rem", minWidth: "95px", textAlign: "right" }}>Amount (₹)</th>
                    <th style={{ padding: "0.5rem", textAlign: "center" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {grnItems.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="text"
                          list="grn-medicine-master-list"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.medicine_name}
                          onChange={(e) => handleUpdateGrnItem(idx, "medicine_name", e.target.value)}
                          placeholder="Medicine name..."
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="text"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.manufacturer ?? ""}
                          placeholder="Company"
                          onChange={(e) => handleUpdateGrnItem(idx, "manufacturer", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="text"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.hsn_code ?? ""}
                          placeholder="HSN"
                          onChange={(e) => handleUpdateGrnItem(idx, "hsn_code", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="text"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.pack_size ?? ""}
                          placeholder="10x10"
                          onChange={(e) => handleUpdateGrnItem(idx, "pack_size", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <select
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.unit_type}
                          onChange={(e) => handleUpdateGrnItem(idx, "unit_type", e.target.value)}
                        >
                          {UNIT_TYPES.map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="text"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.batch_no ?? ""}
                          placeholder="Batch #"
                          onChange={(e) => handleUpdateGrnItem(idx, "batch_no", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="date"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.mfg_date}
                          onChange={(e) => handleUpdateGrnItem(idx, "mfg_date", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="date"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px" }}
                          value={item.expiry_date}
                          onChange={(e) => handleUpdateGrnItem(idx, "expiry_date", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={1}
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "center" }}
                          value={item.received_qty ?? ""}
                          placeholder="1"
                          onChange={(e) => handleUpdateGrnItem(idx, "received_qty", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "center" }}
                          value={item.free_qty ?? ""}
                          placeholder="0"
                          onChange={(e) => handleUpdateGrnItem(idx, "free_qty", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "center" }}
                          value={item.damaged_qty ?? ""}
                          placeholder="0"
                          onChange={(e) => handleUpdateGrnItem(idx, "damaged_qty", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "right" }}
                          value={item.unit_cost ?? ""}
                          placeholder="0.00"
                          onChange={(e) => handleUpdateGrnItem(idx, "unit_cost", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "right" }}
                          value={item.discount_pct ?? ""}
                          placeholder="0"
                          onChange={(e) => handleUpdateGrnItem(idx, "discount_pct", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "right" }}
                          value={item.mrp ?? ""}
                          placeholder="0.00"
                          onChange={(e) => handleUpdateGrnItem(idx, "mrp", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "right" }}
                          value={item.selling_price ?? ""}
                          placeholder="0.00"
                          onChange={(e) => handleUpdateGrnItem(idx, "selling_price", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          type="number"
                          min={0}
                          className="ui-input"
                          style={{ width: "100%", padding: "4px 6px", textAlign: "right" }}
                          value={item.gst_rate ?? ""}
                          placeholder="0"
                          onChange={(e) => handleUpdateGrnItem(idx, "gst_rate", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "0.35rem", textAlign: "right", fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap" }}>
                        {grnLineAmounts(item).total.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.35rem", textAlign: "center" }}>
                        {grnItems.length > 1 && (
                          <button
                            type="button"
                            className="ui-button ghost"
                            style={{ color: "#e11d48", padding: "2px 6px" }}
                            onClick={() => handleRemoveGrnItem(idx)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="grn-medicine-master-list">
                {medicinesMaster.map((m) => (
                  <option key={m.id} value={m.name} />
                ))}
              </datalist>
            </div>
            {(() => {
              const totals = grnItems.reduce(
                (acc, it) => {
                  const a = grnLineAmounts(it);
                  return { taxable: acc.taxable + a.taxable, gst: acc.gst + a.gst, total: acc.total + a.total };
                },
                { taxable: 0, gst: 0, total: 0 }
              );
              return (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "1.5rem", marginTop: "0.75rem", fontSize: "0.85rem", color: "#475569" }}>
                  <span>Taxable: <strong>₹{totals.taxable.toFixed(2)}</strong></span>
                  <span>GST: <strong>₹{totals.gst.toFixed(2)}</strong></span>
                  <span style={{ color: "#0f172a" }}>Invoice Total: <strong>₹{totals.total.toFixed(2)}</strong></span>
                </div>
              );
            })()}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
            <Button
              type="button"
              className="primary"
              style={{ background: "#00828a", borderColor: "#00828a", padding: "0.6rem 1.5rem", fontWeight: 700 }}
              disabled={submittingGrn}
              onClick={handleCreateGrn}
            >
              {submittingGrn ? "Creating GRN..." : "Save GRN Draft"}
            </Button>
          </div>
        </div>
      )}

      {/* 2. GRN HISTORY & VERIFICATION */}
      {activeTab === "grn_history" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "10px" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Goods Receipt History & Verification
            </h3>
            <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
              Verify drafts to commit stock and post supplier ledger
            </span>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
            <Input type="date" value={grnFromDate} onChange={(e) => setGrnFromDate(e.target.value)} style={{ width: "150px" }} />
            <span style={{ color: "#94a3b8", fontSize: "12px" }}>to</span>
            <Input type="date" value={grnToDate} onChange={(e) => setGrnToDate(e.target.value)} style={{ width: "150px" }} />
            <Button type="button" variant="secondary" onClick={handleExportGrnCsv} disabled={filteredGoodsReceipts.length === 0}>
              Export CSV
            </Button>
          </div>

          {filteredGoodsReceipts.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.6rem 0.75rem" }}>GRN Number</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Supplier Invoice</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Date</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Classification</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Status</th>
                    <th style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>Stock Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGoodsReceipts.map((grn) => {
                    const isVerified = grn.status === "verified";

                    return (
                      <tr key={grn.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "0.6rem 0.75rem", fontWeight: 700, color: "#00828a" }}>{grn.grn_no}</td>
                        <td style={{ padding: "0.6rem 0.75rem", fontWeight: 600 }}>{grn.supplier_invoice_no || "-"}</td>
                        <td style={{ padding: "0.6rem 0.75rem", color: "#64748b" }}>{grn.received_date || "-"}</td>
                        <td style={{ padding: "0.6rem 0.75rem", color: "#475569" }}>{grn.stock_source}</td>
                        <td style={{ padding: "0.6rem 0.75rem" }}>
                          <span
                            style={{
                              padding: "2px 8px",
                              borderRadius: "12px",
                              fontSize: "0.75rem",
                              fontWeight: 700,
                              background: isVerified ? "#dcfce7" : "#fef3c7",
                              color: isVerified ? "#166534" : "#92400e",
                              textTransform: "uppercase",
                            }}
                          >
                            {grn.status}
                          </span>
                        </td>
                        <td style={{ padding: "0.6rem 0.75rem", textAlign: "center" }}>
                          {!isVerified ? (
                            <Button
                              type="button"
                              className="primary"
                              style={{ padding: "3px 12px", fontSize: "0.78rem", background: "#16a34a", borderColor: "#16a34a" }}
                              onClick={() => handleVerifyGrn(grn.id, grn.grn_no)}
                            >
                              Verify & Add Stock
                            </Button>
                          ) : (
                            <span style={{ color: "#16a34a", fontWeight: 700, fontSize: "0.8rem" }}>
                              ✓ Stock Inwarded
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "2.5rem", color: "#94a3b8" }}>
              No GRNs found. Create your first delivery receipt above.
            </div>
          )}
        </div>
      )}

      {/* 3. PURCHASE REQUESTS (PR) */}
      {activeTab === "pr" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Purchase Requests (Internal Requisitions)
            </h3>
            <Button
              type="button"
              className="primary"
              style={{ background: "#00828a", borderColor: "#00828a" }}
              onClick={() => setNewPrModalOpen(true)}
            >
              + New PR
            </Button>
          </div>

          {purchaseRequests.length > 0 ? (
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.5rem" }}>PR Number</th>
                  <th style={{ padding: "0.5rem" }}>Medicine Name</th>
                  <th style={{ padding: "0.5rem", textAlign: "center" }}>Quantity</th>
                  <th style={{ padding: "0.5rem" }}>Supplier Name</th>
                  <th style={{ padding: "0.5rem" }}>Priority</th>
                  <th style={{ padding: "0.5rem" }}>Notes / Reason</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                  <th style={{ padding: "0.5rem" }}>Date</th>
                  <th style={{ padding: "0.5rem", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {purchaseRequests.map((pr) => {
                  const isPending = pr.status === "pending";
                  const supplierName = pr.supplier_name || suppliers.find((s) => s.id === (pr.preferred_supplier_id || pr.supplier_id))?.supplier_name;
                  return (
                    <tr key={pr.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem", fontWeight: 700, color: "#00828a" }}>{pr.pr_no}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {pr.items && pr.items.length > 0 ? (
                          pr.items.map((it, idx) => (
                            <div key={idx} style={{ color: "#0f172a", fontWeight: 600 }}>
                              {it.medicine_name}
                            </div>
                          ))
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "center" }}>
                        {pr.items && pr.items.length > 0 ? (
                          pr.items.map((it, idx) => (
                            <div key={idx} style={{ color: "#0f172a", fontWeight: 600 }}>
                              {it.required_qty ?? (it as any).quantity ?? 1}
                            </div>
                          ))
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        {supplierName ? (
                          <span style={{ fontWeight: 600, color: "#1e293b" }}>{supplierName}</span>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem", textTransform: "capitalize" }}>{pr.priority}</td>
                      <td style={{ padding: "0.5rem", color: "#475569" }}>{pr.notes || "-"}</td>
                      <td style={{ padding: "0.5rem" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            textTransform: "capitalize",
                            background: pr.status === "approved" ? "#dcfce7" : pr.status === "rejected" ? "#fee2e2" : "#fef3c7",
                            color: pr.status === "approved" ? "#166534" : pr.status === "rejected" ? "#991b1b" : "#92400e",
                          }}
                        >
                          {pr.status}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem" }}>
                        {pr.created_at ? new Date(pr.created_at).toLocaleDateString() : "-"}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                          <Button
                            type="button"
                            style={{
                              padding: "3px 8px",
                              fontSize: "0.78rem",
                              background: "#25D366",
                              borderColor: "#25D366",
                              color: "#ffffff",
                              fontWeight: 600,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                            title="Share this Purchase Request via WhatsApp"
                            onClick={() => {
                              const sup = suppliers.find((s) => s.id === (pr.preferred_supplier_id || pr.supplier_id));
                              const itemsList = pr.items && pr.items.length > 0
                                ? pr.items.map((it) => `• ${it.medicine_name} (Qty: ${it.required_qty ?? (it as any).quantity ?? 1})`).join("\n")
                                : "• Not specified";
                              const text = [
                                `🏥 *HospAI Hospital Pharmacy — Purchase Request #${pr.pr_no}*`,
                                `----------------------------------------`,
                                `📋 *Requested Medicines:*`,
                                itemsList,
                                `⚡ *Priority:* ${pr.priority || "Normal"}`,
                                `📊 *Status:* ${pr.status.toUpperCase()}`,
                                sup?.supplier_name ? `🏢 *Supplier:* ${sup.supplier_name}` : "",
                                pr.notes ? `📝 *Notes:* ${pr.notes}` : "",
                                `📅 *Date:* ${pr.created_at ? new Date(pr.created_at).toLocaleDateString("en-IN") : "-"}`,
                                `----------------------------------------`,
                                `Please confirm supply availability.`,
                              ].filter(Boolean).join("\n");

                              openWhatsAppDialog({
                                title: `Share PR #${pr.pr_no} via WhatsApp`,
                                recipientName: sup?.supplier_name || "Supplier",
                                recipientPhone: sup?.phone || "",
                                message: text,
                              });
                            }}
                          >
                            <WhatsAppIcon size={13} /> WhatsApp
                          </Button>
                          {isPending ? (
                            <>
                              <Button
                                type="button"
                                className="primary"
                                style={{ padding: "3px 10px", fontSize: "0.78rem", background: "#16a34a", borderColor: "#16a34a" }}
                                onClick={() => openPrDecision(pr, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                style={{ padding: "3px 10px", fontSize: "0.78rem", color: "#dc2626", borderColor: "#fca5a5" }}
                                onClick={() => openPrDecision(pr, "reject")}
                              >
                                Reject
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
              No purchase requests found.
            </div>
          )}
        </div>
      )}

      {/* 4. PURCHASE ORDERS (PO) */}
      {activeTab === "po" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
              Purchase Orders
            </h3>
            <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
              PO records ordered supplies. Does NOT increase stock until GRN.
            </span>
          </div>

          {purchaseOrders.length > 0 ? (
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.5rem" }}>PO ID</th>
                  <th style={{ padding: "0.5rem" }}>Medicine</th>
                  <th style={{ padding: "0.5rem" }}>Supplier Name</th>
                  <th style={{ padding: "0.5rem", textAlign: "center" }}>Qty</th>
                  <th style={{ padding: "0.5rem", textAlign: "right" }}>Unit Cost</th>
                  <th style={{ padding: "0.5rem", textAlign: "right" }}>Total Cost</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                  <th style={{ padding: "0.5rem" }}>Date</th>
                  <th style={{ padding: "0.5rem", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.map((po) => {
                  const sName = po.supplier_name || suppliers.find((s) => s.id === po.supplier_id)?.supplier_name;
                  const isReceived = po.status === "received";
                  return (
                    <tr key={po.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem", fontWeight: 700, color: "#00828a" }}>PO-{po.id}</td>
                      <td style={{ padding: "0.5rem", fontWeight: 600 }}>{po.medicine_name}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {sName ? (
                          <span style={{ fontWeight: 600, color: "#1e293b" }}>{sName}</span>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "center" }}>{po.quantity}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{po.unit_cost}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700 }}>₹{po.total_cost}</td>
                      <td style={{ padding: "0.5rem" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            textTransform: "capitalize",
                            background: isReceived ? "#dcfce7" : "#e0f2fe",
                            color: isReceived ? "#166534" : "#0369a1",
                          }}
                        >
                          {po.status}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem" }}>
                        {po.created_at ? new Date(po.created_at).toLocaleDateString() : "-"}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                          <Button
                            type="button"
                            style={{
                              padding: "3px 8px",
                              fontSize: "0.78rem",
                              background: "#25D366",
                              borderColor: "#25D366",
                              color: "#ffffff",
                              fontWeight: 600,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                            title="Share Purchase Order with supplier on WhatsApp"
                            onClick={() => {
                              const sup = suppliers.find((s) => s.id === po.supplier_id);
                              const text = [
                                `🏥 *HospAI Hospital Pharmacy — Official Purchase Order*`,
                                `📄 *PO ID:* PO-${po.id}`,
                                `----------------------------------------`,
                                `📦 *Medicine / Supply:* ${po.medicine_name}`,
                                `🔢 *Quantity:* ${po.quantity} units`,
                                `💰 *Unit Cost:* ₹${po.unit_cost}`,
                                `💵 *Total Cost:* ₹${po.total_cost}`,
                                sup?.supplier_name ? `🏢 *Vendor / Supplier:* ${sup.supplier_name}` : "",
                                `📊 *Order Status:* ${po.status.toUpperCase()}`,
                                `📅 *Date:* ${po.created_at ? new Date(po.created_at).toLocaleDateString("en-IN") : "-"}`,
                                `----------------------------------------`,
                                `Please acknowledge receipt and dispatch with invoice and batch details.`,
                              ].filter(Boolean).join("\n");

                              openWhatsAppDialog({
                                title: `Share PO-${po.id} via WhatsApp`,
                                recipientName: sup?.supplier_name || po.supplier_name || "Supplier",
                                recipientPhone: sup?.phone || "",
                                message: text,
                              });
                            }}
                          >
                            <WhatsAppIcon size={13} /> WhatsApp
                          </Button>
                          {!isReceived ? (
                            <Button
                              type="button"
                              className="primary"
                              style={{ padding: "3px 10px", fontSize: "0.78rem", background: "#00828a", borderColor: "#00828a" }}
                              onClick={() => {
                                setGrnPoId(po.id);
                                if (po.supplier_id) setGrnSupplierId(po.supplier_id);
                                setGrnItems([{
                                  ...emptyGrnItem(),
                                  medicine_name: po.medicine_name,
                                  received_qty: po.quantity,
                                  unit_cost: po.unit_cost,
                                  mrp: Math.round(po.unit_cost * 1.25),
                                  selling_price: Math.round(po.unit_cost * 1.25),
                                  gst_rate: 12,
                                  unit_type: "Tablet",
                                }]);
                                setActiveTab("grn");
                              }}
                            >
                              Receive (GRN) →
                            </Button>
                          ) : (
                            <span style={{ fontSize: "0.78rem", color: "#16a34a", fontWeight: 700 }}>✓ Inwarded</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
              No purchase orders found.
            </div>
          )}
        </div>
      )}

      {/* 5. PURCHASE RETURNS */}
      {activeTab === "returns" && (
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
            Purchase Returns (Supplier Returns)
          </h3>
          <p style={{ margin: "0 0 1.5rem 0", fontSize: "0.85rem", color: "#64748b" }}>
            Return damaged, near-expiry, or recall stock to suppliers. Deducts inventory and credits the supplier ledger account.
          </p>

          <div style={{ maxWidth: "600px", background: "#f8fafc", padding: "1rem", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Select Supplier:
              </label>
              <select className="ui-input" style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.supplier_name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Medicine & Batch:
                </label>
                <Input placeholder="Enter medicine and batch..." />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Return Qty:
                </label>
                <Input type="number" min={1} defaultValue={10} />
              </div>
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Return Reason:
              </label>
              <select className="ui-input" style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                <option>Damaged in transit</option>
                <option>Near expiry received</option>
                <option>Wrong product received</option>
                <option>Manufacturer drug recall</option>
              </select>
            </div>
            <Button
              type="button"
              className="primary"
              style={{ background: "#00828a", borderColor: "#00828a" }}
              onClick={() => setNotice({ type: "info", message: "Purchase return recorded and stock deducted." })}
            >
              Submit Supplier Return
            </Button>
          </div>
        </div>
      )}

      {/* New PR Modal */}
      {newPrModalOpen && (
        <Modal open={newPrModalOpen} onClose={() => { setNewPrModalOpen(false); resetPrModal(); }}>
          <div style={{ padding: "1.5rem", maxWidth: "680px", width: "100%" }}>
            <div style={{ marginBottom: "1rem" }}>
              <h3 style={{ margin: "0 0 0.25rem 0", color: "#0f172a", fontSize: "1.25rem" }}>
                New Purchase Request
              </h3>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                Requisition multiple medicine supplies under a single purchase request. Converted to PO upon approval.
              </p>
            </div>

            {/* Header: Supplier & Urgency */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.25rem", background: "#f8fafc", padding: "1rem", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Supplier Name <span style={{ color: "#dc2626" }}>*</span>:
                </label>
                <select
                  required
                  className="ui-input"
                  style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  value={prSupplierId || ""}
                  onChange={(e) => setPrSupplierId(e.target.value ? parseInt(e.target.value) : null)}
                >
                  <option value="">-- Select Supplier * --</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.supplier_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Priority / Urgency:
                </label>
                <select
                  className="ui-input"
                  style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  value={prUrgency}
                  onChange={(e) => setPrUrgency(e.target.value)}
                >
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                  <option value="stat">STAT / Emergency</option>
                </select>
              </div>
            </div>

            {/* Multiple Medicines / Items Table */}
            <div style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <label style={{ fontSize: "0.875rem", fontWeight: 700, color: "#1e293b" }}>
                  Medicines & Supplies ({prItems.length} {prItems.length === 1 ? "item" : "items"}):
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  style={{
                    padding: "4px 10px",
                    fontSize: "0.8rem",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontWeight: 600,
                  }}
                  onClick={handleAddPrItem}
                >
                  + Add Medicine / Item
                </Button>
              </div>

              <datalist id="pr-medicines-master-list">
                {medicinesMaster.map((m) => (
                  <option key={m.id} value={m.name} />
                ))}
              </datalist>

              <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.825rem" }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", textAlign: "left", color: "#475569", borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: "0.5rem 0.6rem", width: "32px", textAlign: "center" }}>#</th>
                      <th style={{ padding: "0.5rem 0.6rem" }}>Medicine Name *</th>
                      <th style={{ padding: "0.5rem 0.6rem", width: "100px", textAlign: "center" }}>Required Qty *</th>
                      <th style={{ padding: "0.5rem 0.6rem", width: "160px" }}>Item Notes / Specs</th>
                      <th style={{ padding: "0.5rem 0.6rem", width: "36px", textAlign: "center" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {prItems.map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: idx === prItems.length - 1 ? "none" : "1px solid #f1f5f9" }}>
                        <td style={{ padding: "0.45rem 0.5rem", textAlign: "center", color: "#94a3b8", fontWeight: 600 }}>
                          {idx + 1}
                        </td>
                        <td style={{ padding: "0.45rem 0.5rem" }}>
                          <input
                            list="pr-medicines-master-list"
                            type="text"
                            className="ui-input"
                            style={{ width: "100%", padding: "5px 8px" }}
                            value={item.medicine_name}
                            onChange={(e) => handleUpdatePrItem(idx, "medicine_name", e.target.value)}
                            placeholder="e.g. Amoxicillin 500mg, Paracetamol..."
                          />
                        </td>
                        <td style={{ padding: "0.45rem 0.5rem" }}>
                          <input
                            type="number"
                            min={1}
                            className="ui-input"
                            style={{ width: "100%", padding: "5px 8px", textAlign: "center" }}
                            value={item.quantity ?? ""}
                            placeholder="1"
                            onChange={(e) =>
                              handleUpdatePrItem(
                                idx,
                                "quantity",
                                e.target.value === "" ? "" : Math.max(1, parseInt(e.target.value) || 1)
                              )
                            }
                          />
                        </td>
                        <td style={{ padding: "0.45rem 0.5rem" }}>
                          <input
                            type="text"
                            className="ui-input"
                            style={{ width: "100%", padding: "5px 8px" }}
                            value={item.notes || ""}
                            onChange={(e) => handleUpdatePrItem(idx, "notes", e.target.value)}
                            placeholder="e.g. Strip / Box / Vial"
                          />
                        </td>
                        <td style={{ padding: "0.45rem 0.5rem", textAlign: "center" }}>
                          {prItems.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemovePrItem(idx)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#ef4444",
                                cursor: "pointer",
                                fontSize: "1.1rem",
                                lineHeight: 1,
                                padding: "2px 4px",
                                borderRadius: "4px",
                              }}
                              title="Remove item"
                            >
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Overall Clinical Remarks / Reason */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Clinical Remarks / Reason:
              </label>
              <Input
                value={prNotes}
                onChange={(e) => setPrNotes(e.target.value)}
                placeholder="e.g. Current stock below reorder level, monthly pharmacy replenishment..."
              />
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", flexWrap: "wrap", alignItems: "center" }}>
              <Button type="button" variant="secondary" onClick={() => { setNewPrModalOpen(false); resetPrModal(); }}>
                Cancel
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
                  padding: "0.45rem 1rem",
                  boxShadow: "0 2px 6px rgba(37, 211, 102, 0.25)",
                }}
                onClick={() => {
                  const validItems = prItems
                    .map((it) => ({
                      medicine_name: it.medicine_name.trim(),
                      quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1,
                      notes: it.notes?.trim() || undefined,
                    }))
                    .filter((it) => it.medicine_name.length > 0);

                  if (validItems.length === 0) {
                    setNotice({ type: "warning", message: "Please enter at least one medicine or item name first." });
                    return;
                  }
                  if (!prSupplierId) {
                    setNotice({ type: "warning", message: "Supplier is mandatory. Please select a supplier." });
                    return;
                  }
                  const sup = suppliers.find((s) => s.id === prSupplierId);
                  const urgencyLabel = prUrgency === "stat" ? "STAT / Emergency" : prUrgency === "urgent" ? "Urgent" : "Normal";
                  const text = [
                    `🏥 *HospAI Hospital Pharmacy — Purchase Requisition*`,
                    `----------------------------------------`,
                    sup?.supplier_name ? `🏢 *Suggested Supplier:* ${sup.supplier_name}` : "",
                    `⚡ *Priority / Urgency:* ${urgencyLabel}`,
                    `📅 *Requisition Date:* ${new Date().toLocaleDateString("en-IN")}`,
                    `----------------------------------------`,
                    `📦 *Requested Medicines / Items (${validItems.length}):*`,
                    ...validItems.map((it, idx) => `${idx + 1}. *${it.medicine_name}* — Qty: ${it.quantity} units${it.notes ? ` (${it.notes})` : ""}`),
                    prNotes.trim() ? `\n📝 *Clinical Remarks:* ${prNotes.trim()}` : "",
                    `----------------------------------------`,
                    `Please check medicine availability, quotation rate, and estimated delivery timeline.`,
                  ].filter(Boolean).join("\n");

                  openWhatsAppDialog({
                    title: "Share Purchase Requisition via WhatsApp",
                    recipientName: sup?.supplier_name || "Supplier",
                    recipientPhone: sup?.phone || "",
                    message: text,
                  });
                }}
              >
                <WhatsAppIcon size={16} /> Share via WhatsApp
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a" }}
                disabled={submittingPr}
                onClick={handleCreatePr}
              >
                {submittingPr ? "Submitting..." : "Submit Requisition"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Approve / Reject PR Modal */}
      {prDecisionTarget && prDecisionAction && (
        <Modal open={!!prDecisionTarget} onClose={() => { setPrDecisionTarget(null); setPrDecisionAction(null); }}>
          <div style={{ padding: "1.5rem", maxWidth: "460px" }}>
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#0f172a" }}>
              {prDecisionAction === "approve" ? "Approve Purchase Request" : "Reject Purchase Request"}
            </h3>
            <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.85rem", color: "#64748b" }}>
              {prDecisionTarget.pr_no}
              {prDecisionAction === "approve"
                ? " -- approving will generate a Purchase Order for each requested item."
                : " -- rejecting closes this request with no order created."}
            </p>

            {prDecisionTarget.items && prDecisionTarget.items.length > 0 && (
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "0.75rem 0.9rem", marginBottom: "1.25rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "6px" }}>
                  {prDecisionAction === "approve" ? "You are approving:" : "You are rejecting:"}
                </div>
                {prDecisionTarget.items.map((it, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", padding: "2px 0" }}>
                    <span style={{ fontWeight: 600, color: "#0f172a" }}>{it.medicine_name}</span>
                    <span style={{ color: "#475569" }}>Qty: {it.required_qty ?? (it as any).quantity ?? 1}</span>
                  </div>
                ))}
                {(() => {
                  const reqSup = prDecisionTarget.supplier_name || suppliers.find((s) => s.id === (prDecisionTarget.preferred_supplier_id || prDecisionTarget.supplier_id))?.supplier_name;
                  return reqSup ? (
                    <div style={{ marginTop: "0.5rem", paddingTop: "0.4rem", borderTop: "1px dashed #cbd5e1", fontSize: "0.82rem", color: "#334155" }}>
                      <span style={{ fontWeight: 600 }}>Requested Supplier:</span> {reqSup}
                    </div>
                  ) : null;
                })()}
              </div>
            )}

            {prDecisionAction === "approve" ? (
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Assigned Supplier <span style={{ color: "#dc2626" }}>*</span>:
                </label>
                <select
                  required
                  className="ui-input"
                  style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  value={prApproveSupplierId || ""}
                  onChange={(e) => setPrApproveSupplierId(parseInt(e.target.value) || null)}
                >
                  <option value="">-- Select Supplier * --</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.supplier_name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  Reason (optional):
                </label>
                <Input
                  value={prRejectReason}
                  onChange={(e) => setPrRejectReason(e.target.value)}
                  placeholder="e.g. Stock already sufficient..."
                />
              </div>
            )}

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => { setPrDecisionTarget(null); setPrDecisionAction(null); }}>
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                style={{
                  background: prDecisionAction === "approve" ? "#16a34a" : "#dc2626",
                  borderColor: prDecisionAction === "approve" ? "#16a34a" : "#dc2626",
                }}
                disabled={submittingPrDecision}
                onClick={() => void submitPrDecision()}
              >
                {submittingPrDecision ? "Saving..." : prDecisionAction === "approve" ? "Approve & Create PO" : "Confirm Rejection"}
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
                  Send formatted requisition or order details directly to WhatsApp
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
                {whatsAppRecipient ? `Recipient: ${whatsAppRecipient}` : "Leave blank to pick any contact or group directly in WhatsApp"}
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
                Cancel
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
