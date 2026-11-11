import { useEffect, useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal } from "../../components/ui";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml } from "../../lib/printTemplates";
import { splitStoredPhone, toWhatsAppNumber } from "../../lib/phone";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
};

type Inpatient = {
  admission_id: number;
  patient_id: string;
  patient_name: string;
  ip_number?: string;
  ward: string;
  bed_no: string;
  doctor_name?: string;
  admitted_at?: string;
  status: string;
  running_pharmacy_total?: number;
  payer_type?: "self" | "insurance";
  insurance_provider?: string | null;
  insurance_policy_no?: string | null;
};

type WardIndentItem = {
  id: number;
  medicine_name: string;
  dose?: string;
  frequency?: string;
  route?: string;
  quantity_ordered: number;
  quantity_dispensed: number;
  status: string;
  start_at?: string;
  end_at?: string;
  is_prn?: boolean;
  instructions?: string;
  cancel_reason?: string;
};

type WardIndent = {
  id: number;
  indent_no: string;
  patient_id: string;
  patient_name?: string;
  admission_id?: number;
  ward: string;
  bed_no: string;
  doctor_name?: string;
  prescription_id?: number | null;
  payer_type?: "self" | "insurance";
  insurance_provider?: string | null;
  insurance_policy_no?: string | null;
  priority: "normal" | "urgent" | "stat";
  status: "pending" | "approved" | "processing" | "dispensed" | "cancelled" | "partially_issued";
  created_at: string;
  items: WardIndentItem[];
};

type StockBatch = {
  id: number;
  medicine_id?: number;
  medicine_name: string;
  generic_name?: string;
  batch_no: string;
  mfg_date?: string;
  expiry_date?: string;
  qty_available: number;
  unit_price: number;
  mrp?: number;
  stock_source: "CASH" | "INSURANCE";
  gst_rate?: number;
};

type IpCartItem = {
  batch_id: number;
  medicine_id?: number;
  medicine_name: string;
  generic_name?: string;
  batch_no: string;
  expiry_date?: string;
  available_qty: number;
  quantity: number;
  unit_price: number;
  mrp: number;
  dose?: string;
  route?: string;
  frequency?: string;
  stock_source: "CASH" | "INSURANCE";
};

export default function PharmacyIpDispense({ setNotice, onNavigate }: Props) {
  // Tabs: "direct" | "indents" | "returns"
  const [activeTab, setActiveTab] = useState<"direct" | "indents" | "returns">("direct");

  // Inpatients & Search
  const [inpatients, setInpatients] = useState<Inpatient[]>([]);
  const [loadingInpatients, setLoadingInpatients] = useState(false);
  const [patientSearchQuery, setPatientSearchQuery] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<Inpatient | null>(null);

  // Available Stock
  const [stockBatches, setStockBatches] = useState<StockBatch[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);

  // Full medicine master catalog, for the New Medication Order dropdown
  const [medicinesMaster, setMedicinesMaster] = useState<{ id: number; name: string }[]>([]);
  const [orderMedSuggestOpen, setOrderMedSuggestOpen] = useState(false);

  // Suggestions for the order's medicine field: in-stock medicines first (total
  // available across batches), then catalogue medicines that are out of stock.
  const orderMedicineOptions = useMemo(() => {
    const byName = new Map<string, { name: string; qty: number; batches: number }>();
    for (const b of stockBatches) {
      const key = b.medicine_name.trim().toLowerCase();
      const cur = byName.get(key) || { name: b.medicine_name.trim(), qty: 0, batches: 0 };
      cur.qty += Number(b.qty_available || 0);
      cur.batches += 1;
      byName.set(key, cur);
    }
    const inStock = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    const outOfStock = medicinesMaster
      .filter((m) => !byName.has(m.name.trim().toLowerCase()))
      .map((m) => ({ name: m.name.trim(), qty: 0, batches: 0 }));
    return [...inStock, ...outOfStock];
  }, [stockBatches, medicinesMaster]);

  // -------------------------------------------------------------
  // TAB 1: Direct IP Dispense (Workflow like OP Dispense)
  // -------------------------------------------------------------
  const [medSearchQuery, setMedSearchQuery] = useState("");
  const [selectedStockBatch, setSelectedStockBatch] = useState<StockBatch | null>(null);
  const [directQtyInput, setDirectQtyInput] = useState<string>("");
  const [directDose, setDirectDose] = useState("");
  const [directRoute, setDirectRoute] = useState("");
  const [directFrequency, setDirectFrequency] = useState("");
  const [directStockSource, setDirectStockSource] = useState<"CASH" | "INSURANCE">("CASH");
  const [showMedDropdown, setShowMedDropdown] = useState(false);

  // Direct IP Dispense Cart
  const [ipCart, setIpCart] = useState<IpCartItem[]>([]);
  const [submittingDirect, setSubmittingDirect] = useState(false);

  // Print Slip state for Direct Dispense
  const [directPrintModalOpen, setDirectPrintModalOpen] = useState(false);
  const [dispensedSlipData, setDispensedSlipData] = useState<{
    patient: Inpatient;
    items: IpCartItem[];
    invoice_no?: string;
    total_amount: number;
    dispensed_at: string;
  } | null>(null);

  // -------------------------------------------------------------
  // TAB 2: Ward Indents & Doctor Orders
  // -------------------------------------------------------------
  const [indents, setIndents] = useState<WardIndent[]>([]);
  const [loadingIndents, setLoadingIndents] = useState(false);
  const [selectedIndent, setSelectedIndent] = useState<WardIndent | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Indent Item Issue Modal state
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [activeIndentItem, setActiveIndentItem] = useState<WardIndentItem | null>(null);
  const [chosenBatch, setChosenBatch] = useState<StockBatch | null>(null);
  const [issueQtyInput, setIssueQtyInput] = useState<string>(""); // Clean string, NO static 1!
  const [submittingIssue, setSubmittingIssue] = useState(false);
  const [substituteBatchSearch, setSubstituteBatchSearch] = useState("");
  const [showSubstitutePicker, setShowSubstitutePicker] = useState(false);

  // New / edit medication order state
  const EMPTY_ORDER_FORM = {
    medicine_name: "",
    dose: "",
    frequency: "",
    route: "",
    quantity_ordered: "1",
    end_at: "",
    is_prn: false,
    instructions: "",
  };
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [orderPatientSearch, setOrderPatientSearch] = useState("");
  const [editingItem, setEditingItem] = useState<WardIndentItem | null>(null);
  const [orderForm, setOrderForm] = useState(EMPTY_ORDER_FORM);
  const [savingOrder, setSavingOrder] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<WardIndentItem | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  // -------------------------------------------------------------
  // TAB 3: IPD Returns & Reversals
  // -------------------------------------------------------------
  const [returnPatientQuery, setReturnPatientQuery] = useState("");
  const [ipdSales, setIpdSales] = useState<any[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);
  const [returnItem, setReturnItem] = useState<any | null>(null);
  const [returnQtyInput, setReturnQtyInput] = useState<string>("1");
  const [returnReason, setReturnReason] = useState("");
  const [returnSubmitting, setReturnSubmitting] = useState(false);

  // -------------------------------------------------------------
  // Data Loaders
  // -------------------------------------------------------------
  const loadInpatients = async () => {
    setLoadingInpatients(true);
    try {
      const [bedRes, wlRes] = await Promise.all([
        apiFetch<{ occupied?: any[] }>("/api/bed/occupancy").catch(() => ({ occupied: [] })),
        apiFetch<{ discharge_review?: any[] }>("/api/billing/worklist?tab=discharge_review").catch(() => ({ discharge_review: [] })),
      ]);

      const map = new Map<string, Inpatient>();

      // From bed occupancy
      if (bedRes?.occupied) {
        bedRes.occupied.forEach((a: any) => {
          const key = String(a.admission_id || a.patient_id);
          map.set(key, {
            admission_id: a.admission_id,
            patient_id: a.patient_id,
            patient_name: a.patient_name || "Inpatient",
            ip_number: `IP-${String(a.admission_id).padStart(4, "0")}`,
            ward: a.ward || "General Ward",
            bed_no: a.bed_no || "-",
            doctor_name: a.doctor_name || "-",
            admitted_at: a.allocated_at || a.admission_date,
            status: "admitted",
            payer_type: a.payer_type === "insurance" ? "insurance" : "self",
            insurance_provider: a.insurance_provider,
            insurance_policy_no: a.insurance_policy_no,
          });
        });
      }

      // From discharge review worklist
      if (wlRes?.discharge_review) {
        wlRes.discharge_review.forEach((a: any) => {
          const admId = a.raw_id || parseInt(String(a.admission_id || "").replace(/\D/g, ""), 10) || 0;
          const key = String(admId || a.patient_id);
          if (!map.has(key)) {
            map.set(key, {
              admission_id: admId,
              patient_id: a.patient_id,
              patient_name: a.patient_name || a.name || "Inpatient",
              ip_number: a.admission_id || `IP-${String(admId).padStart(4, "0")}`,
              ward: a.ward || "General Ward",
              bed_no: a.bed_no || "-",
              doctor_name: a.doctor_name || "-",
              admitted_at: a.admission_date,
              status: "admitted",
            });
          }
        });
      }

      const list = Array.from(map.values());
      setInpatients(list);

      // Auto-select first or previously selected if applicable
      const savedPid = localStorage.getItem("selected_pharmacy_patient");
      if (savedPid) {
        localStorage.removeItem("selected_pharmacy_patient");
        const found = list.find((p) => p.patient_id === savedPid || String(p.admission_id) === savedPid);
        if (found) {
          setSelectedPatient(found);
        } else {
          // fetch patient
          apiFetch<any>(`/api/patients/${encodeURIComponent(savedPid)}`).then((res) => {
            const p = res?.patient || res;
            if (p && p.patient_id) {
              setSelectedPatient({
                admission_id: p.admission_id || 0,
                patient_id: p.patient_id,
                patient_name: `${p.name || ""} ${p.last_name || ""}`.trim() || p.patient_id,
                ip_number: `IP-${p.admission_id || p.patient_id}`,
                ward: "Inpatient",
                bed_no: "-",
                status: "admitted",
              });
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load admitted patients.");
    } finally {
      setLoadingInpatients(false);
    }
  };

  const loadStock = async () => {
    setLoadingStock(true);
    try {
      const res = await apiFetch<{ batches: StockBatch[] }>("/api/pharmacy/stock");
      if (res?.batches) {
        // filter out zero stock
        const valid = res.batches.filter((b) => b.qty_available > 0);
        setStockBatches(valid);
      }
    } catch {
      // ignore
    } finally {
      setLoadingStock(false);
    }
  };

  const loadIndents = async () => {
    setLoadingIndents(true);
    try {
      const res = await apiFetch<{ indents?: WardIndent[] }>("/api/pharmacy/ward-indents");
      if (res?.indents) {
        setIndents(res.indents);
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load ward indents");
    } finally {
      setLoadingIndents(false);
    }
  };

  // Full medicine master catalog (not just current stock) -- a doctor's
  // order can name a medicine that's temporarily out of stock; that's a
  // procurement problem for pharmacy, not a reason to block the order.
  const loadMedicinesMaster = async () => {
    try {
      const res = await apiFetch<{ medicines?: { id: number; name: string }[] }>("/api/pharmacy/medicines?active_only=true");
      setMedicinesMaster(res.medicines || []);
    } catch {
      // ignore -- dropdown just stays empty
    }
  };

  useEffect(() => {
    void loadInpatients();
    void loadStock();
    void loadIndents();
    void loadMedicinesMaster();
  }, []);

  // Update running pharmacy charges whenever selectedPatient changes
  useEffect(() => {
    if (!selectedPatient) return;
    const key = selectedPatient.admission_id || selectedPatient.patient_id;
    if (key) {
      apiFetch<any>(`/api/billing/ip-discharge/${encodeURIComponent(String(key))}`)
        .then((res) => {
          if (res?.charges_summary) {
            setSelectedPatient((prev) =>
              prev ? { ...prev, running_pharmacy_total: res.charges_summary.pharmacy || 0 } : null
            );
          }
        })
        .catch(() => {});
    }
  }, [selectedPatient?.admission_id, selectedPatient?.patient_id]);

  // -------------------------------------------------------------
  // Filtered Lists
  // -------------------------------------------------------------
  // Inpatients filtered by search query
  const filteredInpatients = useMemo(() => {
    const q = patientSearchQuery.trim().toLowerCase();
    if (!q) return inpatients;
    return inpatients.filter(
      (p) =>
        p.patient_name.toLowerCase().includes(q) ||
        p.patient_id.toLowerCase().includes(q) ||
        (p.ip_number || "").toLowerCase().includes(q) ||
        (p.ward || "").toLowerCase().includes(q) ||
        (p.bed_no || "").toLowerCase().includes(q)
    );
  }, [inpatients, patientSearchQuery]);

  // Filtered Stock Batches for Direct Dispense (FEFO sorted)
  const filteredStockBatches = useMemo(() => {
    const q = medSearchQuery.trim().toLowerCase();
    if (!q) return [];

    const matches = stockBatches.filter((b) => {
      const isNotExpired = !b.expiry_date || new Date(b.expiry_date) >= new Date();
      const hasStock = b.qty_available > 0;
      const matchText =
        (b.medicine_name || "").toLowerCase().includes(q) ||
        (b.generic_name || "").toLowerCase().includes(q) ||
        (b.batch_no || "").toLowerCase().includes(q);
      return matchText && hasStock && isNotExpired;
    });

    // FEFO: earliest expiry first
    return matches.sort((a, b) => {
      const dateA = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
      const dateB = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
      return dateA - dateB;
    });
  }, [stockBatches, medSearchQuery]);

  // Filtered substitute batches for Indent Modal
  const substituteBatches = useMemo(() => {
    const q = substituteBatchSearch.trim().toLowerCase();
    if (!q) return stockBatches.slice(0, 15);
    return stockBatches
      .filter(
        (b) =>
          b.qty_available > 0 &&
          ((b.medicine_name || "").toLowerCase().includes(q) ||
            (b.generic_name || "").toLowerCase().includes(q) ||
            (b.batch_no || "").toLowerCase().includes(q))
      )
      .sort((a, b) => {
        const dateA = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
        const dateB = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
        return dateA - dateB;
      });
  }, [stockBatches, substituteBatchSearch]);

  // Indents filtered by selected patient and status
  const filteredIndents = useMemo(() => {
    return indents.filter((ind) => {
      if (selectedPatient && ind.patient_id !== selectedPatient.patient_id) return false;
      if (statusFilter === "all") return true;
      return ind.status === statusFilter;
    });
  }, [indents, statusFilter, selectedPatient]);

  const relevantIndents = useMemo(() => {
    if (!selectedPatient) return indents;
    return indents.filter((ind) => ind.patient_id === selectedPatient.patient_id);
  }, [indents, selectedPatient]);

  const patientStats = useMemo(() => {
    if (!selectedPatient) return null;
    let totalItems = 0;
    let pendingItems = 0;
    let issuedItems = 0;
    let statCount = 0;

    relevantIndents.forEach((ind) => {
      if (ind.priority === "stat") statCount++;
      (ind.items || []).forEach((item) => {
        if (item.status !== "cancelled") {
          totalItems += item.quantity_ordered;
          issuedItems += item.quantity_dispensed || 0;
          const pend = Math.max(0, item.quantity_ordered - (item.quantity_dispensed || 0));
          pendingItems += pend;
        }
      });
    });

    return {
      totalIndents: relevantIndents.length,
      totalItems,
      pendingItems,
      issuedItems,
      statCount,
    };
  }, [selectedPatient, relevantIndents]);

  // -------------------------------------------------------------
  // Cart Calculations (Direct IP Dispense)
  // -------------------------------------------------------------
  const cartTotals = useMemo(() => {
    let subtotal = 0;
    for (const item of ipCart) {
      subtotal += item.unit_price * item.quantity;
    }
    return {
      subtotal,
      grandTotal: subtotal,
      totalItemsCount: ipCart.reduce((sum, item) => sum + item.quantity, 0),
    };
  }, [ipCart]);

  // -------------------------------------------------------------
  // TAB 1 Actions: Direct IP Dispense
  // -------------------------------------------------------------
  const isInsuredAdmission = selectedPatient?.payer_type === "insurance";
  useEffect(() => {
    setDirectStockSource(isInsuredAdmission ? "INSURANCE" : "CASH");
  }, [selectedPatient?.admission_id, isInsuredAdmission]);

  const handleSelectPatient = (patient: Inpatient) => {
    setSelectedPatient(patient);
    setPatientSearchQuery("");
  };

  const handleSelectStockBatch = (batch: StockBatch) => {
    setSelectedStockBatch(batch);
    setMedSearchQuery(batch.medicine_name);
    setShowMedDropdown(false);
  };

  const handleAddToCart = () => {
    if (!selectedStockBatch) {
      setNotice({ type: "warning", message: "Please search and select a medicine batch first." });
      return;
    }

    if (!directDose.trim() || !directRoute.trim() || !directFrequency.trim()) {
      setNotice({ type: "warning", message: "Dosage, route and frequency are all required." });
      return;
    }

    const qty = parseInt(String(directQtyInput).trim(), 10);
    if (isNaN(qty) || qty <= 0) {
      setNotice({ type: "warning", message: "Please enter a valid quantity greater than 0." });
      return;
    }

    if (qty > selectedStockBatch.qty_available) {
      setNotice({
        type: "warning",
        message: `Quantity cannot exceed available stock (${selectedStockBatch.qty_available}).`,
      });
      return;
    }

    // Check existing item in cart
    const existingIndex = ipCart.findIndex((c) => c.batch_id === selectedStockBatch.id);
    if (existingIndex >= 0) {
      const updated = [...ipCart];
      const newQty = updated[existingIndex].quantity + qty;
      if (newQty > selectedStockBatch.qty_available) {
        setNotice({
          type: "warning",
          message: `Total in cart (${newQty}) exceeds available stock (${selectedStockBatch.qty_available}).`,
        });
        return;
      }
      updated[existingIndex].quantity = newQty;
      setIpCart(updated);
    } else {
      setIpCart([
        ...ipCart,
        {
          batch_id: selectedStockBatch.id,
          medicine_id: selectedStockBatch.medicine_id,
          medicine_name: selectedStockBatch.medicine_name,
          generic_name: selectedStockBatch.generic_name,
          batch_no: selectedStockBatch.batch_no,
          expiry_date: selectedStockBatch.expiry_date,
          available_qty: selectedStockBatch.qty_available,
          quantity: qty,
          unit_price: selectedStockBatch.unit_price || 0,
          mrp: selectedStockBatch.mrp || selectedStockBatch.unit_price || 0,
          dose: directDose,
          route: directRoute,
          frequency: directFrequency,
          stock_source: directStockSource,
        },
      ]);
    }

    // Reset medicine form
    setSelectedStockBatch(null);
    setMedSearchQuery("");
    setDirectQtyInput("");
    setShowMedDropdown(false);
  };

  const handleRemoveFromCart = (index: number) => {
    setIpCart(ipCart.filter((_, idx) => idx !== index));
  };

  const handleUpdateCartQty = (index: number, newQty: number) => {
    if (newQty <= 0) return;
    const item = ipCart[index];
    if (newQty > item.available_qty) {
      setNotice({
        type: "warning",
        message: `Quantity cannot exceed available stock (${item.available_qty}).`,
      });
      return;
    }
    const updated = [...ipCart];
    updated[index].quantity = newQty;
    setIpCart(updated);
  };

  const handleExecuteDirectDispense = async () => {
    if (!selectedPatient) {
      setNotice({ type: "warning", message: "Please search and select an inpatient first." });
      return;
    }
    if (ipCart.length === 0) {
      setNotice({ type: "warning", message: "Cart is empty. Please add medicines to dispense." });
      return;
    }

    setSubmittingDirect(true);
    try {
      const payload = {
        patient_id: selectedPatient.patient_id,
        admission_id: selectedPatient.admission_id || undefined,
        billing_type: "IPD_RUNNING",
        stock_source: directStockSource,
        payment_mode: directStockSource === "INSURANCE" ? "insurance" : "ipd_running",
        items: ipCart.map((c) => ({
          batch_id: c.batch_id,
          pharmacy_inventory_id: c.batch_id,
          medicine_name: c.medicine_name,
          quantity: c.quantity,
          unit_price: c.unit_price,
          price: c.unit_price,
          dose: c.dose || "1 dose",
          route: c.route || "Oral",
          frequency: c.frequency || "OD",
        })),
      };

      const res = await apiFetch<any>("/api/pharmacy/dispense", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setDispensedSlipData({
        patient: selectedPatient,
        items: [...ipCart],
        invoice_no: res?.invoice_no || `IPD-DISP-${Date.now().toString().slice(-6)}`,
        total_amount: cartTotals.grandTotal,
        dispensed_at: new Date().toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }),
      });

      setNotice({
        type: "success",
        message: directStockSource === "INSURANCE"
          ? `Dispensed ${ipCart.length} medicine(s) to ${selectedPatient.patient_name}, billed to insurance as Due${res?.invoice_no ? ` (${res.invoice_no})` : ""}. Stock is deducted when the insurance claim is settled.`
          : `Successfully dispensed ${ipCart.length} medicine(s) to ${selectedPatient.patient_name}. Running charge added to IP Admission Account!`,
      });

      setDirectPrintModalOpen(true);
      setIpCart([]);
      void loadStock();

      // Refresh running balance
      const key = selectedPatient.admission_id || selectedPatient.patient_id;
      if (key) {
        apiFetch<any>(`/api/billing/ip-discharge/${encodeURIComponent(String(key))}`)
          .then((d) => {
            if (d?.charges_summary) {
              setSelectedPatient((prev) =>
                prev ? { ...prev, running_pharmacy_total: d.charges_summary.pharmacy || 0 } : null
              );
            }
          })
          .catch(() => {});
      }
    } catch (err: any) {
      reportError(setNotice, err, "IP Dispense failed");
    } finally {
      setSubmittingDirect(false);
    }
  };

  const handlePrintDispenseSlip = () => {
    if (!dispensedSlipData) return;
    const { patient, items, total_amount, dispensed_at, invoice_no } = dispensedSlipData;

    const html = buildPrintDocumentHtml({
      title: "Inpatient Pharmacy Dispense Slip",
      subtitleLines: [
        "HospAI · 24/7 Clinical Pharmacy",
        `Dispense Slip: ${invoice_no || "-"} · ${dispensed_at}`,
      ],
      meta: [
        { label: "Patient UHID", value: patient.patient_id },
        { label: "Patient Name", value: patient.patient_name },
        { label: "IP Number", value: patient.ip_number || `IP-${patient.admission_id}` },
        { label: "Ward / Bed", value: `${patient.ward} · Bed ${patient.bed_no}` },
        { label: "Billing Type", value: "IPD Running Account (Discharge Settlement)" },
        { label: "Consultant Doctor", value: patient.doctor_name || "-" },
      ],
      columns: ["Medicine Name", "Batch No", "Expiry", "Dose / Route", "Qty", "Unit Price (₹)", "Amount (₹)"],
      rows: items.map((it) => [
        it.medicine_name,
        it.batch_no || "-",
        it.expiry_date ? String(it.expiry_date).slice(0, 10) : "-",
        `${it.dose || "1 dose"} (${it.route || "Oral"})`,
        it.quantity,
        `₹${it.unit_price.toFixed(2)}`,
        `₹${(it.unit_price * it.quantity).toFixed(2)}`,
      ]),
      totals: [
        { label: "Total Medicines Amount", value: `₹${total_amount.toFixed(2)}`, grand: true },
        { label: "Payment Status", value: "POSTED TO IP ADMISSION BILL" },
      ],
    });

    printViaIframe(html);
  };

  const handleShareWhatsAppDispenseSlip = async () => {
    if (!dispensedSlipData) return;
    const { patient, items, total_amount, dispensed_at, invoice_no } = dispensedSlipData;

    let phone = (patient as any).phone || (selectedPatient as any)?.phone || "";
    let phoneCode = (patient as any).phone_country_code || (selectedPatient as any)?.phone_country_code || "+91";
    if (!phone && patient.patient_id) {
      try {
        const res = await apiFetch<{ patient?: { phone?: string; phone_country_code?: string } }>(
          `/api/patients/${encodeURIComponent(patient.patient_id)}`
        );
        phone = res?.patient?.phone || "";
        phoneCode = res?.patient?.phone_country_code || "+91";
      } catch {
        // ignore
      }
    }

    const parts = splitStoredPhone(phone, phoneCode);
    const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

    const lines = [
      `*HospAI Hospital Pharmacy - Inpatient Dispense Slip*`,
      `----------------------------------------`,
      `Slip / Invoice: ${invoice_no || "-"}`,
      `Patient: ${patient.patient_name} (UHID: ${patient.patient_id})`,
      `Ward / Bed: ${patient.ward} · Bed ${patient.bed_no}`,
      patient.doctor_name ? `Consultant: ${patient.doctor_name}` : "",
      `Dispensed At: ${dispensed_at}`,
      `Total Medicines Amount: ₹${total_amount.toFixed(2)} (Posted to IP Bill)`,
      `----------------------------------------`,
      `Medicines Issued:`,
      ...items.map((it, idx) => `${idx + 1}. ${it.medicine_name} x ${it.quantity}`),
      `----------------------------------------`,
      `HospAI 24/7 Clinical Pharmacy`,
    ].filter(Boolean);

    const text = lines.join("\n");
    const url = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setNotice({
      type: "success",
      message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened.",
    });
  };

  // -------------------------------------------------------------
  // TAB 2 Actions: Ward Indents
  // -------------------------------------------------------------
  const handleOpenIssueModal = (indent: WardIndent, item: WardIndentItem) => {
    setSelectedIndent(indent);
    setActiveIndentItem(item);
    setShowSubstitutePicker(false);
    setSubstituteBatchSearch("");

    const pendingQty = Math.max(1, item.quantity_ordered - (item.quantity_dispensed || 0));
    // Clean string representation so user can type/backspace without static 1 bug!
    setIssueQtyInput(String(pendingQty));

    // Only auto-select a batch when the medicine name matches exactly (or is a
    // full substring match, e.g. brand vs generic naming) so a different
    // strength/formulation is never silently pre-chosen for the pharmacist.
    // Loose token overlap (e.g. "paracetamol 500mg" vs "paracetamol 650mg")
    // is left for the pharmacist to find and pick manually via stock search.
    const rawName = item.medicine_name.toLowerCase().trim();

    const exactCandidates = stockBatches.filter((b) => {
      const bMed = b.medicine_name.toLowerCase();
      return bMed === rawName || bMed.includes(rawName) || rawName.includes(bMed);
    }).sort((a, b) => {
      const dateA = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
      const dateB = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
      return dateA - dateB;
    });

    setChosenBatch(exactCandidates[0] || null);
    setShowSubstitutePicker(exactCandidates.length === 0);
    setIssueModalOpen(true);
  };

  const handleConfirmIssue = async () => {
    if (!selectedIndent || !activeIndentItem || !chosenBatch) {
      setNotice({ type: "warning", message: "Please select an available batch from stock." });
      return;
    }

    const qty = parseInt(issueQtyInput.trim(), 10);
    if (isNaN(qty) || qty <= 0) {
      setNotice({ type: "warning", message: "Please enter a valid quantity greater than 0." });
      return;
    }

    if (qty > chosenBatch.qty_available) {
      setNotice({
        type: "warning",
        message: `Quantity cannot exceed available stock (${chosenBatch.qty_available}).`,
      });
      return;
    }

    setSubmittingIssue(true);
    try {
      const payload = {
        patient_id: selectedIndent.patient_id,
        admission_id: selectedIndent.admission_id,
        indent_id: selectedIndent.id,
        billing_type: "IPD_RUNNING",
        stock_source: selectedIndent.payer_type === "insurance" ? "INSURANCE" : (chosenBatch.stock_source || "CASH"),
        ...(selectedIndent.payer_type === "insurance" ? { payment_mode: "insurance" } : {}),
        items: [
          {
            batch_id: chosenBatch.id,
            pharmacy_inventory_id: chosenBatch.id,
            medicine_name: chosenBatch.medicine_name || activeIndentItem.medicine_name,
            quantity: qty,
            unit_price: chosenBatch.unit_price || 0,
            price: chosenBatch.unit_price || 0,
            indent_item_id: activeIndentItem.id,
            dose: activeIndentItem.dose,
            route: activeIndentItem.route,
            frequency: activeIndentItem.frequency,
          },
        ],
      };

      await apiFetch(`/api/pharmacy/ward-indents/${selectedIndent.id}/dispense`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNotice({
        type: "success",
        message: `Issued ${qty} units of ${chosenBatch.medicine_name}. Charge added to Patient Admission #${selectedIndent.admission_id || selectedIndent.patient_id}.`,
      });

      setIssueModalOpen(false);
      void loadIndents();
      void loadStock();
    } catch (err) {
      reportError(setNotice, err as any, "Issue failed");
    } finally {
      setSubmittingIssue(false);
    }
  };

  // Medication Order Modal actions
  const openNewOrderModal = () => {
    setEditingItem(null);
    setOrderForm(EMPTY_ORDER_FORM);
    setOrderPatientSearch("");
    setOrderModalOpen(true);
  };

  const openEditOrderModal = (item: WardIndentItem) => {
    setEditingItem(item);
    setOrderForm({
      medicine_name: item.medicine_name,
      dose: item.dose || "",
      frequency: item.frequency || "",
      route: item.route || "",
      quantity_ordered: String(item.quantity_ordered),
      end_at: item.end_at ? String(item.end_at).slice(0, 16) : "",
      is_prn: !!item.is_prn,
      instructions: item.instructions || "",
    });
    setOrderModalOpen(true);
  };

  const submitOrder = async () => {
    if (!selectedPatient && !editingItem) return;
    if (
      !orderForm.medicine_name.trim() ||
      !orderForm.dose.trim() ||
      !orderForm.frequency.trim() ||
      !orderForm.route.trim()
    ) {
      setNotice({ type: "warning", message: "Medicine, dose, frequency and route are required." });
      return;
    }
    const qNum = parseInt(orderForm.quantity_ordered, 10);
    if (isNaN(qNum) || qNum <= 0) {
      setNotice({ type: "warning", message: "Quantity must be greater than 0." });
      return;
    }

    setSavingOrder(true);
    try {
      if (editingItem) {
        await apiFetch(`/api/pharmacy/ward-indent-items/${editingItem.id}`, {
          method: "PUT",
          body: JSON.stringify({
            dose: orderForm.dose,
            frequency: orderForm.frequency,
            route: orderForm.route,
            quantity_ordered: qNum,
            end_at: orderForm.end_at || null,
            is_prn: orderForm.is_prn,
            instructions: orderForm.instructions || null,
          }),
        });
        setNotice({ type: "success", message: "Medication order updated." });
      } else {
        await apiFetch("/api/pharmacy/ward-indents", {
          method: "POST",
          body: JSON.stringify({
            patient_id: selectedPatient?.patient_id,
            admission_id: selectedPatient?.admission_id,
            items: [
              {
                medicine_name: orderForm.medicine_name,
                dose: orderForm.dose,
                frequency: orderForm.frequency,
                route: orderForm.route,
                quantity_ordered: qNum,
                end_at: orderForm.end_at || undefined,
                is_prn: orderForm.is_prn,
                instructions: orderForm.instructions || undefined,
              },
            ],
          }),
        });
        setNotice({ type: "success", message: "Medication order created." });
      }
      setOrderModalOpen(false);
      await loadIndents();
    } catch (err) {
      reportError(setNotice, err as any, "Could not save the medication order.");
    } finally {
      setSavingOrder(false);
    }
  };

  const confirmCancelOrder = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await apiFetch(`/api/pharmacy/ward-indent-items/${cancelTarget.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason || "Medication order cancelled by clinical team" }),
      });
      setNotice({ type: "success", message: `${cancelTarget.medicine_name} order cancelled.` });
      setCancelTarget(null);
      setCancelReason("");
      void loadIndents();
    } catch (err) {
      reportError(setNotice, err as any, "Could not cancel the order.");
    } finally {
      setCancelling(false);
    }
  };

  // -------------------------------------------------------------
  // TAB 3 Actions: IPD Returns
  // -------------------------------------------------------------
  const handleSearchIpdSales = async () => {
    const q = returnPatientQuery.trim();
    if (!q) return;
    setLoadingSales(true);
    try {
      const res = await apiFetch<{ sales: any[] }>(
        `/api/pharmacy/sales?patient_id=${encodeURIComponent(q)}`
      );
      const ipdOnly = (res?.sales || []).filter(
        (s) => s.admission_id != null || s.billing_type === "IPD_RUNNING"
      );
      setIpdSales(ipdOnly.length > 0 ? ipdOnly : res?.sales || []);
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load IP sales");
    } finally {
      setLoadingSales(false);
    }
  };

  const handleProcessIpdReturn = async () => {
    if (!returnItem) return;
    const rQty = parseInt(returnQtyInput, 10);
    const maxReturnable = returnItem.remaining_qty ?? returnItem.quantity;
    if (isNaN(rQty) || rQty <= 0 || rQty > maxReturnable) {
      setNotice({ type: "warning", message: `Invalid return quantity (max ${maxReturnable}).` });
      return;
    }
    if (!returnReason.trim()) {
      setNotice({ type: "warning", message: "Reason for return is required." });
      return;
    }

    setReturnSubmitting(true);
    try {
      const retRes = await apiFetch<{ insurance_bill_reduced?: boolean }>("/api/pharmacy/returns", {
        method: "POST",
        body: JSON.stringify({
          original_sale_id: returnItem.id,
          quantity: rQty,
          reason: returnReason,
          admission_id: returnItem.admission_id,
        }),
      });

      setNotice({
        type: "success",
        message: retRes?.insurance_bill_reduced
          ? "Return processed: the insurance Due bill and claim were reduced. Stock was not yet deducted for this issue, so no stock is added back."
          : "IPD Return processed and credited to patient admission account.",
      });
      setReturnItem(null);
      setReturnReason("");
      setReturnQtyInput("1");
      void handleSearchIpdSales();
      void loadStock();
    } catch (err) {
      reportError(setNotice, err as any, "Return failed");
    } finally {
      setReturnSubmitting(false);
    }
  };

  return (
    <div className="pharmacy-theme-page" style={{ padding: "1.5rem", maxWidth: "1400px", margin: "0 auto" }}>
      {/* Topbar / Breadcrumbs & Navigation */}
      <div
        className="pharmacy-topbar"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.25rem",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div
          className="pharmacy-breadcrumb"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", color: "#64748b" }}
        >
          <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 600 }} onClick={() => window.history.back()}>
            HospAI
          </span>
          <span>/</span>
          <span style={{ cursor: "pointer", color: "#00828a", fontWeight: 600 }} onClick={() => onNavigate("pharmacy-overview")}>
            Pharmacy
          </span>
          <span>/</span>
          <span style={{ color: "#0f172a", fontWeight: 700 }}>IP Dispense</span>
        </div>

        {/* Tab switch */}
        <div style={{ display: "flex", background: "#f1f5f9", borderRadius: "10px", padding: "4px", gap: "4px" }}>
          <button
            type="button"
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "8px",
              border: "none",
              fontSize: "0.875rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "direct" ? "#00828a" : "transparent",
              color: activeTab === "direct" ? "#ffffff" : "#475569",
              boxShadow: activeTab === "direct" ? "0 2px 8px rgba(0, 130, 138, 0.25)" : "none",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("direct")}
          >
            <span>⚡ Direct IP Dispense</span>
          </button>
          <button
            type="button"
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "8px",
              border: "none",
              fontSize: "0.875rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "indents" ? "#00828a" : "transparent",
              color: activeTab === "indents" ? "#ffffff" : "#475569",
              boxShadow: activeTab === "indents" ? "0 2px 8px rgba(0, 130, 138, 0.25)" : "none",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("indents")}
          >
            <span>📋</span> <span>Ward Indents & Orders</span>
          </button>
          <button
            type="button"
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "8px",
              border: "none",
              fontSize: "0.875rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "returns" ? "#00828a" : "transparent",
              color: activeTab === "returns" ? "#ffffff" : "#475569",
              boxShadow: activeTab === "returns" ? "0 2px 8px rgba(0, 130, 138, 0.25)" : "none",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("returns")}
          >
            <span>🔄</span> <span>IPD Returns</span>
          </button>
        </div>
      </div>

      {/* Main Hospital Billing Integration Banner */}
      <div
        style={{
          background: "#f0f9ff",
          border: "1px solid #bae6fd",
          borderRadius: "10px",
          padding: "0.85rem 1.25rem",
          marginBottom: "1.25rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <div>
          <strong style={{ color: "#0369a1", fontSize: "0.9rem" }}>Main Hospital Billing Integration:</strong>
          <p style={{ margin: "2px 0 0 0", color: "#0284c7", fontSize: "0.825rem" }}>
            Medicines issued here automatically post running charges to the patient's admission account. The main hospital billing module settles the final discharge bill.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void loadIndents();
              void loadInpatients();
              void loadStock();
            }}
          >
            🔄 Refresh All
          </Button>
        </div>
      </div>

      {/* Selected Patient Identity Banner (Shown across tabs if patient is selected) */}
      {selectedPatient && (
        <div
          style={{
            background: "#ffffff",
            border: "1.5px solid #00828a",
            borderRadius: "14px",
            padding: "1.25rem 1.5rem",
            marginBottom: "1.5rem",
            boxShadow: "0 4px 16px rgba(0, 130, 138, 0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "12px",
                  background: "linear-gradient(135deg, #00828a 0%, #0369a1 100%)",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: "1.35rem",
                  boxShadow: "0 4px 10px rgba(0, 130, 138, 0.25)",
                }}
              >
                {selectedPatient.patient_name ? selectedPatient.patient_name.charAt(0).toUpperCase() : "P"}
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800, color: "#0f172a" }}>
                    {selectedPatient.patient_name}
                  </h2>
                  <span
                    style={{
                      background: "#ecfdf5",
                      color: "#059669",
                      border: "1px solid #a7f3d0",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981" }}></span>
                    ADMITTED INPATIENT
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "6px" }}>
                  <span style={{ fontSize: "0.8rem", background: "#f0fdfa", color: "#00828a", border: "1px solid #ccfbf1", padding: "2px 8px", borderRadius: "6px", fontWeight: 600 }}>
                    UHID: <strong>{selectedPatient.patient_id}</strong>
                  </span>
                  {selectedPatient.ip_number && (
                    <span style={{ fontSize: "0.8rem", background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd", padding: "2px 8px", borderRadius: "6px", fontWeight: 600 }}>
                      IP No: <strong>{selectedPatient.ip_number}</strong>
                    </span>
                  )}
                  <span style={{ fontSize: "0.8rem", background: "#f8fafc", color: "#334155", border: "1px solid #e2e8f0", padding: "2px 8px", borderRadius: "6px", fontWeight: 600 }}>
                    Ward: <strong>{selectedPatient.ward}</strong> &middot; Bed: <strong>{selectedPatient.bed_no}</strong>
                  </span>
                  {selectedPatient.running_pharmacy_total !== undefined && (
                    <span style={{ fontSize: "0.8rem", background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a", padding: "2px 8px", borderRadius: "6px", fontWeight: 700 }}>
                      Billed Pharmacy Total: ₹{selectedPatient.running_pharmacy_total.toLocaleString("en-IN")}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                style={{ color: "#e11d48", fontWeight: 600, border: "1px solid #fecdd3", background: "#fff1f2", borderRadius: "6px" }}
                onClick={() => {
                  setSelectedPatient(null);
                  setPatientSearchQuery("");
                }}
              >
                ✕ Switch Inpatient
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* TAB 1: Direct IP Dispense (Like OP Dispense Workflow)     */}
      {/* ========================================================= */}
      {activeTab === "direct" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* STEP 1: If no patient selected, show Search & Admitted Inpatient list */}
          {!selectedPatient && (
            <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "1.5rem", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: "#0f172a" }}>
                    Step 1: Search & Select Admitted Inpatient
                  </h3>
                  <p style={{ margin: "2px 0 0 0", fontSize: "0.825rem", color: "#64748b" }}>
                    Select an admitted patient to begin dispensing medications to their IP admission bill.
                  </p>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => void loadInpatients()}>
                  🔄 Refresh Admitted List
                </Button>
              </div>

              {/* Patient Search Input */}
              <div style={{ marginBottom: "1rem" }}>
                <Input
                  type="text"
                  placeholder="🔍 Type patient name, UHID (e.g. PAT-20260926-0075), IP No, Ward, or Bed..."
                  value={patientSearchQuery}
                  onChange={(e) => setPatientSearchQuery(e.target.value)}
                />
              </div>

              {/* Inpatients Cards / Grid */}
              {loadingInpatients ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "#64748b" }}>Loading admitted patients...</div>
              ) : filteredInpatients.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0.75rem", maxHeight: "380px", overflowY: "auto", padding: "2px" }}>
                  {filteredInpatients.map((p) => (
                    <div
                      key={p.admission_id || p.patient_id}
                      onClick={() => handleSelectPatient(p)}
                      style={{
                        padding: "0.875rem 1rem",
                        borderRadius: "10px",
                        border: "1px solid #e2e8f0",
                        background: "#f8fafc",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "#00828a";
                        e.currentTarget.style.background = "#f0fdfa";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "#e2e8f0";
                        e.currentTarget.style.background = "#f8fafc";
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>{p.patient_name}</div>
                        <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                          UHID: <span style={{ fontWeight: 600 }}>{p.patient_id}</span>
                        </div>
                        <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                          <span style={{ fontSize: "0.75rem", background: "#e0f2fe", color: "#0369a1", padding: "2px 6px", borderRadius: "4px", fontWeight: 600 }}>
                            {p.ward} · {p.bed_no}
                          </span>
                          <span style={{ fontSize: "0.75rem", background: "#e2e8f0", color: "#334155", padding: "2px 6px", borderRadius: "4px" }}>
                            {p.ip_number}
                          </span>
                        </div>
                      </div>
                      <Button type="button" size="sm" style={{ background: "#00828a", borderColor: "#00828a", color: "#ffffff" }}>
                        Select →
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "2rem", background: "#f8fafc", borderRadius: "8px", color: "#64748b" }}>
                  No admitted inpatients found matching "{patientSearchQuery}".
                </div>
              )}
            </div>
          )}

          {/* STEP 2: When Patient is Selected -> Search Medicine & Cart Workstation */}
          {selectedPatient && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
              {/* Left Column: Search & Add Medicines */}
              <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "1.5rem", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
                <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", fontWeight: 800, color: "#0f172a" }}>
                  Step 2: Search Available Medicines
                </h3>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.825rem", color: "#64748b" }}>
                  Search by medicine name, generic name, or batch number. Shows FEFO sorted batches.
                </p>

                {/* Medicine Search Box with Autocomplete */}
                <div style={{ position: "relative", marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Medicine Name / Brand:
                  </label>
                  <Input
                    type="text"
                    placeholder="Type to search (e.g. Paracetamol, Dolo, Saline, Amoxicillin)..."
                    value={medSearchQuery}
                    onChange={(e) => {
                      setMedSearchQuery(e.target.value);
                      setShowMedDropdown(true);
                      if (!e.target.value) setSelectedStockBatch(null);
                    }}
                    onFocus={() => {
                      if (medSearchQuery.trim()) setShowMedDropdown(true);
                    }}
                  />

                  {/* Autocomplete Dropdown */}
                  {showMedDropdown && filteredStockBatches.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        zIndex: 30,
                        background: "#ffffff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "8px",
                        boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
                        maxHeight: "260px",
                        overflowY: "auto",
                        marginTop: "4px",
                      }}
                    >
                      {filteredStockBatches.map((b, idx) => (
                        <div
                          key={b.id}
                          style={{
                            padding: "0.65rem 0.85rem",
                            borderBottom: "1px solid #f1f5f9",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "0.85rem",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdfa")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
                          onClick={() => handleSelectStockBatch(b)}
                        >
                          <div>
                            <div style={{ fontWeight: 700, color: "#0f172a" }}>
                              {b.medicine_name} {b.generic_name ? <span style={{ fontWeight: 400, color: "#64748b" }}>({b.generic_name})</span> : null}
                            </div>
                            <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
                              Batch: <strong>{b.batch_no}</strong> &middot; Exp: {b.expiry_date ? String(b.expiry_date).slice(0, 10) : "N/A"}{" "}
                              {idx === 0 && (
                                <span style={{ background: "#ccfbf1", color: "#0f766e", fontSize: "0.7rem", padding: "1px 6px", borderRadius: "10px", fontWeight: 700, marginLeft: "4px" }}>
                                  FEFO
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ color: "#16a34a", fontWeight: 700 }}>In Stock: {b.qty_available}</div>
                            <div style={{ color: "#0f172a", fontWeight: 600, fontSize: "0.8rem" }}>₹{b.unit_price} / unit</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Selected Medicine Info Card */}
                {selectedStockBatch && (
                  <div
                    style={{
                      background: "#f0fdfa",
                      border: "1.5px solid #00828a",
                      borderRadius: "8px",
                      padding: "0.85rem 1rem",
                      marginBottom: "1rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: "0.95rem", color: "#0f766e" }}>{selectedStockBatch.medicine_name}</div>
                        <div style={{ fontSize: "0.8rem", color: "#334155", marginTop: "3px" }}>
                          Batch: <strong>{selectedStockBatch.batch_no}</strong> &middot; Exp: {selectedStockBatch.expiry_date ? String(selectedStockBatch.expiry_date).slice(0, 10) : "N/A"}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <span style={{ background: "#16a34a", color: "#ffffff", padding: "2px 8px", borderRadius: "12px", fontSize: "0.75rem", fontWeight: 700 }}>
                          Available: {selectedStockBatch.qty_available}
                        </span>
                        <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#0f172a", marginTop: "3px" }}>
                          ₹{selectedStockBatch.unit_price} / unit
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Quantity Input (CLEAN STRING STATE, NO STATIC 1 BUG!) */}
                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Quantity to Dispense:
                  </label>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <Input
                      type="number"
                      min={1}
                      max={selectedStockBatch?.qty_available || 9999}
                      placeholder="Enter quantity"
                      value={directQtyInput}
                      onChange={(e) => setDirectQtyInput(e.target.value)}
                    />
                    {/* Quick quantity pill buttons */}
                    <div style={{ display: "flex", gap: "4px" }}>
                      {[1, 2, 5, 10].map((num) => (
                        <button
                          key={num}
                          type="button"
                          style={{
                            padding: "0.4rem 0.65rem",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            background: directQtyInput === String(num) ? "#00828a" : "#f8fafc",
                            color: directQtyInput === String(num) ? "#ffffff" : "#334155",
                            fontWeight: 700,
                            fontSize: "0.8rem",
                            cursor: "pointer",
                          }}
                          onClick={() => setDirectQtyInput(String(num))}
                        >
                          +{num}
                        </button>
                      ))}
                      {selectedStockBatch && (
                        <button
                          type="button"
                          style={{
                            padding: "0.4rem 0.65rem",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            background: directQtyInput === String(selectedStockBatch.qty_available) ? "#00828a" : "#f8fafc",
                            color: directQtyInput === String(selectedStockBatch.qty_available) ? "#ffffff" : "#334155",
                            fontWeight: 700,
                            fontSize: "0.8rem",
                            cursor: "pointer",
                          }}
                          onClick={() => setDirectQtyInput(String(selectedStockBatch.qty_available))}
                        >
                          Max
                        </button>
                      )}
                    </div>
                  </div>
                  {selectedStockBatch && (
                    <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "4px" }}>
                      Max available in batch: {selectedStockBatch.qty_available} units
                    </div>
                  )}
                </div>

                {/* Dosage, Route & Frequency options */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "1.25rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "#64748b", marginBottom: "2px" }}>
                      Dosage:
                    </label>
                    <Input
                      type="text"
                      placeholder="e.g. 1 tab / 5ml"
                      value={directDose}
                      onChange={(e) => setDirectDose(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "#64748b", marginBottom: "2px" }}>
                      Route:
                    </label>
                    <select
                      value={directRoute}
                      onChange={(e) => setDirectRoute(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.55rem",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "0.85rem",
                        background: "#ffffff",
                      }}
                    >
                      <option value="">-- Select route --</option>
                      <option value="Oral">Oral</option>
                      <option value="IV">IV (Intravenous)</option>
                      <option value="IM">IM (Intramuscular)</option>
                      <option value="SC">SC (Subcutaneous)</option>
                      <option value="Topical">Topical</option>
                      <option value="Inhalation">Inhalation</option>
                      <option value="Nasal">Nasal</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "#64748b", marginBottom: "2px" }}>
                      Frequency:
                    </label>
                    <select
                      value={directFrequency}
                      onChange={(e) => setDirectFrequency(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.55rem",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "0.85rem",
                        background: "#ffffff",
                      }}
                    >
                      <option value="">-- Select frequency --</option>
                      <option value="OD">OD (Once daily)</option>
                      <option value="BD">BD (Twice daily)</option>
                      <option value="TDS">TDS (Thrice daily)</option>
                      <option value="QID">QID (4 times daily)</option>
                      <option value="SOS">SOS (As needed)</option>
                      <option value="STAT">STAT (Immediately)</option>
                    </select>
                  </div>
                </div>

                {/* Add to Cart Button */}
                <Button
                  type="button"
                  className="primary"
                  style={{
                    width: "100%",
                    background: "#00828a",
                    borderColor: "#00828a",
                    fontWeight: 800,
                    padding: "0.75rem",
                  }}
                  disabled={!selectedStockBatch || !directQtyInput || parseInt(directQtyInput) <= 0}
                  onClick={handleAddToCart}
                >
                  + Add Medicine to IP Bill
                </Button>
              </div>

              {/* Right Column: Inpatient Dispense Cart & Running Bill */}
              <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "1.5rem", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: "#0f172a" }}>
                      Step 3: Inpatient Dispense Cart ({ipCart.length})
                    </h3>
                    <p style={{ margin: "2px 0 0 0", fontSize: "0.825rem", color: "#64748b" }}>
                      Medicines to be added to {selectedPatient.patient_name}'s admission account.
                    </p>
                  </div>
                  {ipCart.length > 0 && (
                    <Button type="button" variant="ghost" size="sm" style={{ color: "#ef4444" }} onClick={() => setIpCart([])}>
                      Clear Cart
                    </Button>
                  )}
                </div>

                {/* Cart Table */}
                <div style={{ flex: 1, minHeight: "220px", overflowY: "auto", marginBottom: "1rem" }}>
                  {ipCart.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#94a3b8", background: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1" }}>
                      <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>💊</div>
                      <div style={{ fontWeight: 600, color: "#475569" }}>Cart is currently empty</div>
                      <div style={{ fontSize: "0.8rem", marginTop: "2px" }}>
                        Search and add medicines from the left panel to populate this bill.
                      </div>
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1.5px solid #e2e8f0", textAlign: "left" }}>
                          <th style={{ padding: "0.6rem 0.5rem", color: "#475569" }}>Medicine</th>
                          <th style={{ padding: "0.6rem 0.5rem", color: "#475569" }}>Batch</th>
                          <th style={{ padding: "0.6rem 0.5rem", color: "#475569", width: "90px" }}>Qty</th>
                          <th style={{ padding: "0.6rem 0.5rem", color: "#475569", textAlign: "right" }}>Rate</th>
                          <th style={{ padding: "0.6rem 0.5rem", color: "#475569", textAlign: "right" }}>Amount</th>
                          <th style={{ padding: "0.6rem 0.5rem", width: "40px" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ipCart.map((item, idx) => (
                          <tr key={item.batch_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "0.6rem 0.5rem" }}>
                              <div style={{ fontWeight: 700, color: "#0f172a" }}>{item.medicine_name}</div>
                              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                                {item.dose} &middot; {item.route}
                              </div>
                            </td>
                            <td style={{ padding: "0.6rem 0.5rem", color: "#475569", fontSize: "0.8rem" }}>
                              {item.batch_no}
                            </td>
                            <td style={{ padding: "0.6rem 0.5rem" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <button
                                  type="button"
                                  style={{ padding: "2px 6px", border: "1px solid #cbd5e1", borderRadius: "4px", background: "#f8fafc", cursor: "pointer", fontWeight: 700 }}
                                  onClick={() => handleUpdateCartQty(idx, item.quantity - 1)}
                                >
                                  -
                                </button>
                                <span style={{ fontWeight: 700, minWidth: "20px", textAlign: "center" }}>{item.quantity}</span>
                                <button
                                  type="button"
                                  style={{ padding: "2px 6px", border: "1px solid #cbd5e1", borderRadius: "4px", background: "#f8fafc", cursor: "pointer", fontWeight: 700 }}
                                  onClick={() => handleUpdateCartQty(idx, item.quantity + 1)}
                                >
                                  +
                                </button>
                              </div>
                            </td>
                            <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", color: "#475569" }}>
                              ₹{item.unit_price}
                            </td>
                            <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                              ₹{(item.unit_price * item.quantity).toFixed(2)}
                            </td>
                            <td style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>
                              <button
                                type="button"
                                style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "1rem" }}
                                title="Remove item"
                                onClick={() => handleRemoveFromCart(idx)}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Cart Summary & Settlement Notice */}
                <div style={{ borderTop: "1.5px solid #e2e8f0", paddingTop: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "0.875rem", color: "#64748b" }}>Stock Billing Source:</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          cursor: "pointer",
                          border: directStockSource === "CASH" ? "1.5px solid #00828a" : "1px solid #cbd5e1",
                          background: directStockSource === "CASH" ? "#f0fdfa" : "#ffffff",
                          color: directStockSource === "CASH" ? "#00828a" : "#64748b",
                        }}
                        onClick={() => setDirectStockSource("CASH")}
                      >
                        Self-pay
                      </button>
                      <button
                        type="button"
                        style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          cursor: "pointer",
                          border: directStockSource === "INSURANCE" ? "1.5px solid #00828a" : "1px solid #cbd5e1",
                          background: directStockSource === "INSURANCE" ? "#f0fdfa" : "#ffffff",
                          color: directStockSource === "INSURANCE" ? "#00828a" : "#64748b",
                        }}
                        onClick={() => setDirectStockSource("INSURANCE")}
                        disabled={!isInsuredAdmission}
                        title={isInsuredAdmission ? undefined : "This admission is Self-pay. Set the payer to Insurance at IP Admission or IP Discharge Billing first."}
                      >
                        Insurance
                      </button>
                    </div>
                  </div>

                  {/* Notice banner */}
                  <div style={{ background: "#f8fafc", padding: "0.6rem 0.75rem", borderRadius: "6px", border: "1px solid #e2e8f0", marginBottom: "0.75rem", fontSize: "0.75rem", color: "#475569" }}>
                    {directStockSource === "INSURANCE" ? (
                      <>
                        🛡️ <strong>Insurance Billing:</strong> Billed to {selectedPatient.insurance_provider || "the insurer"}
                        {selectedPatient.insurance_policy_no ? ` (Policy ${selectedPatient.insurance_policy_no})` : ""} as <strong>Due</strong>.
                        Stock and stock value are deducted only when the insurance claim is settled.
                      </>
                    ) : (
                      <>
                        🏥 <strong>Inpatient Billing:</strong> Medicines will be charged to Admission #{selectedPatient.admission_id || selectedPatient.patient_id} as a running bill. Automatically reconciled at Discharge Settlement.
                      </>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                    <span style={{ fontSize: "1rem", fontWeight: 800, color: "#0f172a" }}>Grand Total:</span>
                    <span style={{ fontSize: "1.35rem", fontWeight: 800, color: "#00828a" }}>
                      ₹{cartTotals.grandTotal.toFixed(2)}
                    </span>
                  </div>

                  <Button
                    type="button"
                    className="primary"
                    style={{
                      width: "100%",
                      background: "#00828a",
                      borderColor: "#00828a",
                      fontWeight: 800,
                      padding: "0.85rem",
                      fontSize: "1rem",
                    }}
                    disabled={submittingDirect || ipCart.length === 0}
                    onClick={handleExecuteDirectDispense}
                  >
                    {submittingDirect ? "Processing IP Dispense..." : "Confirm & Dispense to Inpatient"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* TAB 2: Ward Indents & Doctor Orders                       */}
      {/* ========================================================= */}
      {activeTab === "indents" && (
        <>
          {/* Status Filter Buttons */}
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "#64748b", marginRight: "4px" }}>Filter:</span>
            {["all", "pending", "partially_issued", "dispensed"].map((st) => (
              <button
                key={st}
                type="button"
                style={{
                  padding: "0.35rem 0.85rem",
                  borderRadius: "20px",
                  border: "none",
                  fontSize: "0.8rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: statusFilter === st ? "#00828a" : "#f1f5f9",
                  color: statusFilter === st ? "#ffffff" : "#475569",
                }}
                onClick={() => setStatusFilter(st)}
              >
                {st.replace("_", " ").toUpperCase()}
              </button>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
              <Button
                type="button"
                className="primary"
                size="sm"
                style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
                onClick={openNewOrderModal}
              >
                + New Medication Order
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void loadIndents()}>
                🔄 Refresh Indents
              </Button>
            </div>
          </div>

          {/* Indents List */}
          {loadingIndents ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>Loading indents...</div>
          ) : filteredIndents.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", color: "#64748b" }}>
              No ward indents found.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {filteredIndents.map((ind) => (
                <div
                  key={ind.id}
                  style={{
                    background: "#ffffff",
                    borderRadius: "12px",
                    border: "1px solid #e2e8f0",
                    padding: "1.25rem",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.03)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontWeight: 800, fontSize: "1rem", color: "#0f172a" }}>{ind.indent_no}</span>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "0.7rem",
                            fontWeight: 700,
                            background: ind.status === "dispensed" ? "#ecfdf5" : ind.status === "pending" ? "#fff1f2" : "#fef3c7",
                            color: ind.status === "dispensed" ? "#059669" : ind.status === "pending" ? "#e11d48" : "#b45309",
                          }}
                        >
                          {ind.status.replace("_", " ").toUpperCase()}
                        </span>
                        {ind.priority === "stat" && (
                          <span style={{ background: "#dc2626", color: "#ffffff", padding: "1px 6px", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 800 }}>
                            STAT URGENT
                          </span>
                        )}
                        {ind.prescription_id && (
                          <span style={{ background: "#eff6ff", color: "#1d4ed8", padding: "2px 8px", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 700 }}>
                            FROM DOCTOR PRESCRIPTION
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "0.825rem", color: "#64748b", marginTop: "3px" }}>
                        Patient: <strong>{ind.patient_name || ind.patient_id}</strong> &middot; Ward: <strong>{ind.ward}</strong> &middot; Bed: <strong>{ind.bed_no}</strong>
                        {ind.doctor_name && <> &middot; <strong>{/^dr\.?\s/i.test(ind.doctor_name) ? ind.doctor_name : `Dr. ${ind.doctor_name}`}</strong></>}
                      </div>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                      Created: {ind.created_at ? String(ind.created_at).slice(0, 16).replace("T", " ") : "-"}
                    </div>
                  </div>

                  {/* Items in this Indent */}
                  <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "0.75rem" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.825rem" }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "#64748b" }}>
                          <th style={{ padding: "4px 8px" }}>Medicine</th>
                          <th style={{ padding: "4px 8px" }}>Dose / Route</th>
                          <th style={{ padding: "4px 8px" }}>Frequency</th>
                          <th style={{ padding: "4px 8px", textAlign: "center" }}>Ordered</th>
                          <th style={{ padding: "4px 8px", textAlign: "center" }}>Issued</th>
                          <th style={{ padding: "4px 8px", textAlign: "center" }}>Pending</th>
                          <th style={{ padding: "4px 8px", textAlign: "right" }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ind.items?.map((it) => {
                          const pending = Math.max(0, it.quantity_ordered - (it.quantity_dispensed || 0));
                          return (
                            <tr key={it.id} style={{ borderTop: "1px solid #f8fafc" }}>
                              <td style={{ padding: "6px 8px", fontWeight: 700, color: "#0f172a" }}>
                                {it.medicine_name}
                              </td>
                              <td style={{ padding: "6px 8px", color: "#475569" }}>
                                {it.dose || "-"} &middot; {it.route || "-"}
                              </td>
                              <td style={{ padding: "6px 8px", color: "#475569" }}>{it.frequency || "OD"}</td>
                              <td style={{ padding: "6px 8px", textAlign: "center", fontWeight: 600 }}>{it.quantity_ordered}</td>
                              <td style={{ padding: "6px 8px", textAlign: "center", color: "#16a34a", fontWeight: 600 }}>
                                {it.quantity_dispensed || 0}
                              </td>
                              <td style={{ padding: "6px 8px", textAlign: "center", color: pending > 0 ? "#e11d48" : "#64748b", fontWeight: 700 }}>
                                {pending}
                              </td>
                              <td style={{ padding: "6px 8px", textAlign: "right" }}>
                                <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", alignItems: "center" }}>
                                  {pending > 0 && it.status !== "cancelled" ? (
                                    <>
                                      <Button
                                        type="button"
                                        size="sm"
                                        style={{ background: "#00828a", borderColor: "#00828a", color: "#ffffff", fontWeight: 700 }}
                                        onClick={() => handleOpenIssueModal(ind, it)}
                                      >
                                        Issue Medicine
                                      </Button>
                                      {it.quantity_dispensed === 0 && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          style={{ padding: "2px 8px", fontSize: "0.75rem" }}
                                          onClick={() => openEditOrderModal(it)}
                                        >
                                          Edit
                                        </Button>
                                      )}
                                      {it.quantity_dispensed === 0 && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          style={{ color: "#e11d48", padding: "2px 8px", fontSize: "0.75rem" }}
                                          onClick={() => {
                                            setCancelTarget(it);
                                            setCancelReason("");
                                          }}
                                        >
                                          Cancel
                                        </Button>
                                      )}
                                    </>
                                  ) : it.status === "cancelled" ? (
                                    <span style={{ color: "#94a3b8", fontSize: "0.75rem", fontStyle: "italic" }}>
                                      Cancelled
                                    </span>
                                  ) : (
                                    <span style={{ color: "#16a34a", fontSize: "0.75rem", fontWeight: 700 }}>
                                      ✓ Fully Issued
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ========================================================= */}
      {/* TAB 3: IPD Returns & Reversals                            */}
      {/* ========================================================= */}
      {activeTab === "returns" && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "1.5rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem", fontWeight: 800, color: "#0f172a" }}>
            Inpatient Medication Returns & Bill Reversals
          </h3>
          <p style={{ margin: "0 0 1rem 0", fontSize: "0.825rem", color: "#64748b" }}>
            Search by Patient UHID (e.g. PAT-20260926-0075) to view dispensed medicines and credit returns to their admission bill.
          </p>

          <div style={{ display: "flex", gap: "0.5rem", maxWidth: "500px", marginBottom: "1.5rem" }}>
            <Input
              type="text"
              placeholder="Enter Patient UHID (e.g. PAT-20260926-0075)..."
              value={returnPatientQuery}
              onChange={(e) => setReturnPatientQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSearchIpdSales();
              }}
            />
            <Button
              type="button"
              className="primary"
              style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
              onClick={handleSearchIpdSales}
              disabled={loadingSales}
            >
              {loadingSales ? "Searching..." : "Search Sales"}
            </Button>
          </div>

          {/* Sales list */}
          {ipdSales.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
              <thead>
                <tr style={{ background: "#f8fafc", textAlign: "left", color: "#475569" }}>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Date & Time</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Medicine Name</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>Dispensed Qty</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>Returned</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Unit Price</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Amount</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {ipdSales.map((sale) => {
                  const returned = Number(sale.returned_qty || 0);
                  const remaining = Math.max(0, sale.quantity - returned);
                  return (
                    <tr key={sale.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.6rem 0.5rem" }}>
                        {sale.sold_at ? String(sale.sold_at).slice(0, 16).replace("T", " ") : "-"}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", fontWeight: 700, color: "#0f172a" }}>
                        {sale.medicine_name}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "center", fontWeight: 700 }}>
                        {sale.quantity}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "center", color: returned > 0 ? "#c2410c" : "#94a3b8" }}>
                        {returned}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>₹{sale.unit_price}</td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: 700 }}>₹{sale.amount}</td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>
                        {remaining > 0 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setReturnItem({ ...sale, remaining_qty: remaining });
                              setReturnQtyInput("1");
                              setReturnReason("Medication discontinued by doctor");
                            }}
                          >
                            Return Item
                          </Button>
                        ) : (
                          <span style={{ color: "#16a34a", fontSize: "0.75rem", fontWeight: 700 }}>Fully Returned</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Return Processing Box */}
          {returnItem && (
            <div style={{ background: "#f8fafc", border: "1.5px solid #00828a", borderRadius: "10px", padding: "1.25rem", maxWidth: "550px" }}>
              <h4 style={{ margin: "0 0 0.5rem 0", color: "#0f172a" }}>
                Process Return for: <strong>{returnItem.medicine_name}</strong>
              </h4>
              <div style={{ marginBottom: "0.75rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 700, marginBottom: "2px" }}>
                  Return Quantity (Max: {returnItem.remaining_qty ?? returnItem.quantity}):
                </label>
                <Input
                  type="number"
                  min={1}
                  max={returnItem.remaining_qty ?? returnItem.quantity}
                  value={returnQtyInput}
                  onChange={(e) => setReturnQtyInput(e.target.value)}
                />
              </div>
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 700, marginBottom: "2px" }}>
                  Reason for Return:
                </label>
                <select
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                >
                  <option value="Medication discontinued by doctor">Medication discontinued by doctor</option>
                  <option value="Dose modified">Dose modified</option>
                  <option value="Excess ward indent">Excess ward indent</option>
                  <option value="Patient discharged / transfer">Patient discharged / transfer</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                <Button type="button" variant="secondary" onClick={() => setReturnItem(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="primary"
                  style={{ background: "#00828a", borderColor: "#00828a" }}
                  disabled={returnSubmitting}
                  onClick={handleProcessIpdReturn}
                >
                  {returnSubmitting ? "Processing..." : "Reverse Charge & Return to Stock"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 1: Issue Medicine to Ward (From Indent, Screenshot)  */}
      {/* ========================================================= */}
      {issueModalOpen && activeIndentItem && selectedIndent && (
        <Modal open={issueModalOpen} onClose={() => setIssueModalOpen(false)}>
          <div style={{ padding: "1.5rem", maxWidth: "560px" }}>
            <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.25rem", fontWeight: 800, color: "#0f172a" }}>
              Issue Medicine to Ward
            </h2>
            <p style={{ margin: "0 0 1rem 0", fontSize: "0.875rem", color: "#64748b" }}>
              Indent: <strong>{selectedIndent.indent_no}</strong> &middot; Patient: <strong>{selectedIndent.patient_name || selectedIndent.patient_id}</strong> (Ward: {selectedIndent.ward}, Bed: {selectedIndent.bed_no})
            </p>

            {/* Prescribed Item Header */}
            <div style={{ background: "#f8fafc", padding: "0.85rem 1rem", borderRadius: "8px", border: "1px solid #e2e8f0", marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.95rem", fontWeight: 800, color: "#0f172a" }}>
                {activeIndentItem.medicine_name}
              </div>
              <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                Ordered: {activeIndentItem.quantity_ordered} &middot; Already Issued: {activeIndentItem.quantity_dispensed || 0} &middot; Pending:{" "}
                <strong style={{ color: "#e11d48" }}>{Math.max(0, activeIndentItem.quantity_ordered - (activeIndentItem.quantity_dispensed || 0))}</strong>
              </div>
            </div>

            {/* Chosen Batch Display */}
            {chosenBatch ? (
              <div style={{ background: "#f0fdfa", border: "1.5px solid #00828a", borderRadius: "8px", padding: "0.85rem 1rem", marginBottom: "1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 800, color: "#0f766e", fontSize: "0.95rem" }}>
                      Selected: {chosenBatch.medicine_name}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "#334155", marginTop: "2px" }}>
                      Batch: <strong>{chosenBatch.batch_no}</strong> &middot; Exp: {chosenBatch.expiry_date ? String(chosenBatch.expiry_date).slice(0, 10) : "N/A"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ background: "#16a34a", color: "#ffffff", padding: "2px 8px", borderRadius: "10px", fontSize: "0.75rem", fontWeight: 700 }}>
                      In Stock: {chosenBatch.qty_available}
                    </span>
                    <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "#0f172a", marginTop: "3px" }}>
                      ₹{chosenBatch.unit_price} / unit
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: "0.85rem 1rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "0.85rem", marginBottom: "1rem" }}>
                ⚠️ No exact batch match found for "{activeIndentItem.medicine_name}". Use the stock search below to select an available batch.
              </div>
            )}

            {/* Toggle Substitute / Stock Batch Picker */}
            <div style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <label style={{ fontSize: "0.825rem", fontWeight: 700, color: "#334155" }}>
                  Select or Substitute Batch from Available Stock:
                </label>
                <button
                  type="button"
                  style={{ background: "none", border: "none", color: "#00828a", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer" }}
                  onClick={() => setShowSubstitutePicker(!showSubstitutePicker)}
                >
                  {showSubstitutePicker ? "Hide Stock Search ▲" : "Search All In-Stock Batches ▼"}
                </button>
              </div>

              {showSubstitutePicker && (
                <div style={{ background: "#f8fafc", padding: "0.75rem", borderRadius: "8px", border: "1px solid #cbd5e1" }}>
                  <Input
                    type="text"
                    placeholder="Search by brand name, generic name, or batch no..."
                    value={substituteBatchSearch}
                    onChange={(e) => setSubstituteBatchSearch(e.target.value)}
                  />
                  <div style={{ maxHeight: "180px", overflowY: "auto", marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {substituteBatches.length > 0 ? (
                      substituteBatches.map((b) => (
                        <div
                          key={b.id}
                          style={{
                            padding: "0.5rem 0.75rem",
                            borderRadius: "6px",
                            border: chosenBatch?.id === b.id ? "2px solid #00828a" : "1px solid #e2e8f0",
                            background: chosenBatch?.id === b.id ? "#f0fdfa" : "#ffffff",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "0.825rem",
                          }}
                          onClick={() => {
                            setChosenBatch(b);
                            setShowSubstitutePicker(false);
                          }}
                        >
                          <div>
                            <strong>{b.medicine_name}</strong> (Batch: {b.batch_no} &middot; Exp: {b.expiry_date ? String(b.expiry_date).slice(0, 10) : "N/A"})
                          </div>
                          <div style={{ textAlign: "right", color: "#16a34a", fontWeight: 700 }}>
                            Avail: {b.qty_available} &middot; ₹{b.unit_price}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem" }}>No stock items found.</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Quantity to Issue (FIXED: NO STATIC 1 BUG!) */}
            <div style={{ marginBottom: "1.5rem" }}>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                Quantity to Issue (Support partial issue):
              </label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <Input
                  type="number"
                  min={1}
                  max={chosenBatch?.qty_available || 999}
                  placeholder="Enter quantity to issue"
                  value={issueQtyInput}
                  onChange={(e) => setIssueQtyInput(e.target.value)}
                />
                {/* Fast pill buttons */}
                <div style={{ display: "flex", gap: "4px" }}>
                  {[1, 2, 5].map((num) => (
                    <button
                      key={num}
                      type="button"
                      style={{
                        padding: "0.4rem 0.65rem",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: issueQtyInput === String(num) ? "#00828a" : "#f8fafc",
                        color: issueQtyInput === String(num) ? "#ffffff" : "#334155",
                        fontWeight: 700,
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                      onClick={() => setIssueQtyInput(String(num))}
                    >
                      {num}
                    </button>
                  ))}
                  {chosenBatch && (
                    <button
                      type="button"
                      style={{
                        padding: "0.4rem 0.65rem",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: issueQtyInput === String(chosenBatch.qty_available) ? "#00828a" : "#f8fafc",
                        color: issueQtyInput === String(chosenBatch.qty_available) ? "#ffffff" : "#334155",
                        fontWeight: 700,
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                      onClick={() => setIssueQtyInput(String(chosenBatch.qty_available))}
                    >
                      Max Stock
                    </button>
                  )}
                </div>
              </div>
              <span style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "4px", display: "block" }}>
                If available stock is less than ordered, partial issue is allowed.
              </span>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => setIssueModalOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
                disabled={submittingIssue || !chosenBatch || !issueQtyInput || parseInt(issueQtyInput) <= 0}
                onClick={handleConfirmIssue}
              >
                {submittingIssue ? "Issuing..." : "Confirm & Post to Patient Bill"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ========================================================= */}
      {/* MODAL 2: Print Issue Slip Modal (Direct Dispense Success) */}
      {/* ========================================================= */}
      {directPrintModalOpen && dispensedSlipData && (
        <Modal open={directPrintModalOpen} onClose={() => setDirectPrintModalOpen(false)}>
          <div style={{ padding: "1.5rem", maxWidth: "600px" }}>
            <div style={{ textAlign: "center", marginBottom: "1rem" }}>
              <div style={{ fontSize: "2.5rem" }}>✅</div>
              <h2 style={{ margin: "0.25rem 0", fontSize: "1.3rem", fontWeight: 800, color: "#0f766e" }}>
                Medicines Successfully Dispensed!
              </h2>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                Posted to IP Admission Account &middot; Reconciled at Discharge
              </p>
            </div>

            {/* Slip Summary Box */}
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "1rem", marginBottom: "1.25rem", fontSize: "0.85rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <div>
                  Patient: <strong>{dispensedSlipData.patient.patient_name}</strong>
                </div>
                <div>
                  UHID: <strong>{dispensedSlipData.patient.patient_id}</strong>
                </div>
                <div>
                  IP Number: <strong>{dispensedSlipData.patient.ip_number}</strong>
                </div>
                <div>
                  Ward / Bed: <strong>{dispensedSlipData.patient.ward} · {dispensedSlipData.patient.bed_no}</strong>
                </div>
                <div>
                  Date & Time: <strong>{dispensedSlipData.dispensed_at}</strong>
                </div>
                <div>
                  Total Amount: <strong style={{ color: "#00828a" }}>₹{dispensedSlipData.total_amount.toFixed(2)}</strong>
                </div>
              </div>

              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "0.5rem" }}>
                <div style={{ fontWeight: 700, color: "#334155", marginBottom: "4px" }}>Items Dispensed:</div>
                {dispensedSlipData.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", color: "#475569", fontSize: "0.8rem", padding: "2px 0" }}>
                    <span>
                      {it.medicine_name} ({it.batch_no}) x {it.quantity}
                    </span>
                    <span style={{ fontWeight: 600 }}>₹{(it.unit_price * it.quantity).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => setDirectPrintModalOpen(false)}>
                Done
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
                onClick={handlePrintDispenseSlip}
              >
                🖨️ Print Issue Slip
              </Button>
              <Button
                type="button"
                style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff", fontWeight: 700 }}
                onClick={() => void handleShareWhatsAppDispenseSlip()}
              >
                💬 WhatsApp Slip
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ========================================================= */}
      {/* MODAL 3: New / Edit Medication Order Modal                 */}
      {/* ========================================================= */}
      {orderModalOpen && (
        <Modal open={orderModalOpen} onClose={() => setOrderModalOpen(false)}>
          <div style={{ padding: "1.5rem", maxWidth: "550px" }}>
            <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.25rem", fontWeight: 800, color: "#0f172a" }}>
              {editingItem ? "Edit Medication Order" : "New Medication Order"}
            </h2>

            {selectedPatient ? (
              <p style={{ margin: "0 0 1rem 0", fontSize: "0.875rem", color: "#64748b" }}>
                Patient: <strong>{selectedPatient.patient_name}</strong>
                {selectedPatient.ward ? ` (${selectedPatient.ward} · Bed ${selectedPatient.bed_no})` : ""}
              </p>
            ) : !editingItem && (
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                  Select Admitted Inpatient *
                </label>
                <Input
                  type="text"
                  placeholder="🔍 Type patient name, UHID, ward, or bed..."
                  value={orderPatientSearch}
                  onChange={(e) => setOrderPatientSearch(e.target.value)}
                />
                <div style={{ maxHeight: "220px", overflowY: "auto", marginTop: "6px", border: orderPatientSearch.trim() ? "1px solid #e2e8f0" : "none", borderRadius: "8px" }}>
                  {orderPatientSearch.trim() && (
                    (() => {
                      const q = orderPatientSearch.trim().toLowerCase();
                      const matches = inpatients.filter((p) =>
                        p.patient_name?.toLowerCase().includes(q) ||
                        p.patient_id?.toLowerCase().includes(q) ||
                        p.ward?.toLowerCase().includes(q) ||
                        p.bed_no?.toLowerCase().includes(q)
                      );
                      if (matches.length === 0) {
                        return (
                          <div style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#94a3b8", textAlign: "center" }}>
                            No admitted patient matches "{orderPatientSearch}".
                          </div>
                        );
                      }
                      return matches.map((p) => (
                        <div
                          key={p.admission_id || p.patient_id}
                          onClick={() => {
                            setSelectedPatient(p);
                            setOrderPatientSearch("");
                          }}
                          style={{
                            padding: "0.6rem 0.75rem",
                            cursor: "pointer",
                            borderBottom: "1px solid #f1f5f9",
                            fontSize: "0.85rem",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdfa")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ fontWeight: 700, color: "#0f172a" }}>{p.patient_name}</div>
                          <div style={{ color: "#64748b", fontSize: "0.78rem" }}>
                            UHID: {p.patient_id} &middot; {p.ward} · Bed {p.bed_no}
                          </div>
                        </div>
                      ));
                    })()
                  )}
                </div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                  Medicine Name {editingItem && "(cannot be changed once ordered)"} *
                </label>
                {(() => {
                  const typed = orderForm.medicine_name.trim();
                  const q = typed.toLowerCase();
                  const matches = orderMedicineOptions.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, 30);
                  const exact = orderMedicineOptions.find((m) => m.name.toLowerCase() === q);
                  return (
                    <div style={{ position: "relative" }}>
                      <Input
                        value={orderForm.medicine_name}
                        disabled={!!editingItem}
                        placeholder="Type to search stock, or enter a medicine name"
                        autoComplete="off"
                        onChange={(e) => { setOrderForm({ ...orderForm, medicine_name: e.target.value }); setOrderMedSuggestOpen(true); }}
                        onFocus={() => setOrderMedSuggestOpen(true)}
                        onBlur={() => window.setTimeout(() => setOrderMedSuggestOpen(false), 150)}
                        onKeyDown={(e) => { if (e.key === "Escape") setOrderMedSuggestOpen(false); }}
                      />
                      {!editingItem && orderMedSuggestOpen && (matches.length > 0 || typed) && (
                        <div style={{ position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0, right: 0, maxHeight: "240px", overflowY: "auto", background: "#fff", border: "1px solid #cbd5e1", borderRadius: "8px", boxShadow: "0 8px 20px rgba(15,23,42,0.12)" }}>
                          {matches.map((m) => (
                            <div
                              key={m.name}
                              onMouseDown={(e) => { e.preventDefault(); setOrderForm({ ...orderForm, medicine_name: m.name }); setOrderMedSuggestOpen(false); }}
                              style={{ display: "flex", justifyContent: "space-between", gap: "8px", padding: "0.5rem 0.75rem", cursor: "pointer", borderBottom: "1px solid #f1f5f9", fontSize: "0.85rem" }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdfa")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                            >
                              <span style={{ fontWeight: 600, color: "#0f172a" }}>{m.name}</span>
                              {m.qty > 0 ? (
                                <span style={{ color: "#047857", fontSize: "0.78rem", fontWeight: 700, whiteSpace: "nowrap" }}>In stock: {m.qty}</span>
                              ) : (
                                <span style={{ color: "#b45309", fontSize: "0.78rem", fontWeight: 700, whiteSpace: "nowrap" }}>Out of stock</span>
                              )}
                            </div>
                          ))}
                          {typed && !exact && (
                            <div
                              onMouseDown={(e) => { e.preventDefault(); setOrderMedSuggestOpen(false); }}
                              style={{ padding: "0.5rem 0.75rem", cursor: "pointer", fontSize: "0.82rem", color: "#334155", background: "#f8fafc" }}
                            >
                              ✎ Use "<strong>{typed}</strong>" as typed (not in stock list)
                            </div>
                          )}
                        </div>
                      )}
                      {!editingItem && typed && (
                        <div style={{ fontSize: "0.75rem", marginTop: "4px", color: exact && exact.qty > 0 ? "#047857" : "#b45309" }}>
                          {exact && exact.qty > 0
                            ? `${exact.qty} available in stock`
                            : exact
                              ? "In the medicine catalogue but currently out of stock. The order is saved and pharmacy can issue it after restocking."
                              : "Not in the stock list. The order is saved with this name and pharmacy procures or substitutes it."}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                    Dose *
                  </label>
                  <Input
                    value={orderForm.dose}
                    onChange={(e) => setOrderForm({ ...orderForm, dose: e.target.value })}
                    placeholder="e.g. 650mg, 1 tablet"
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                    Quantity *
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={orderForm.quantity_ordered}
                    onChange={(e) => setOrderForm({ ...orderForm, quantity_ordered: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                    Route *
                  </label>
                  <select
                    value={orderForm.route}
                    onChange={(e) => setOrderForm({ ...orderForm, route: e.target.value })}
                    style={{ width: "100%", padding: "0.55rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">-- Select route --</option>
                    <option value="Oral">Oral</option>
                    <option value="IV">IV</option>
                    <option value="IM">IM</option>
                    <option value="SC">SC</option>
                    <option value="Topical">Topical</option>
                    <option value="Inhalation">Inhalation</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                    Frequency *
                  </label>
                  <select
                    value={orderForm.frequency}
                    onChange={(e) => setOrderForm({ ...orderForm, frequency: e.target.value })}
                    style={{ width: "100%", padding: "0.55rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">-- Select frequency --</option>
                    <option value="OD">OD (Once daily)</option>
                    <option value="BD">BD (Twice daily)</option>
                    <option value="TDS">TDS (Thrice daily)</option>
                    <option value="QID">QID (4 times daily)</option>
                    <option value="SOS">SOS (As needed)</option>
                    <option value="STAT">STAT (Immediately)</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.825rem", fontWeight: 700, marginBottom: "4px" }}>
                  Special Instructions
                </label>
                <Input
                  value={orderForm.instructions}
                  onChange={(e) => setOrderForm({ ...orderForm, instructions: e.target.value })}
                  placeholder="e.g. Take after food, monitor BP"
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <Button type="button" variant="secondary" onClick={() => setOrderModalOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
                disabled={savingOrder}
                onClick={submitOrder}
              >
                {savingOrder ? "Saving..." : "Save Medication Order"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ========================================================= */}
      {/* MODAL 4: Cancel Order Confirmation                        */}
      {/* ========================================================= */}
      {cancelTarget && (
        <Modal open={!!cancelTarget} onClose={() => setCancelTarget(null)}>
          <div style={{ padding: "1.5rem", maxWidth: "450px" }}>
            <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.15rem", fontWeight: 800, color: "#0f172a" }}>
              Cancel {cancelTarget.medicine_name}?
            </h2>
            <p style={{ margin: "0 0 1rem 0", fontSize: "0.85rem", color: "#64748b" }}>
              This order has not been issued yet. This action cannot be undone.
            </p>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                Reason for Cancellation
              </label>
              <Input
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. Doctor changed prescription, stopped medication"
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <Button type="button" variant="ghost" onClick={() => setCancelTarget(null)}>
                Back
              </Button>
              <Button
                type="button"
                style={{ background: "#dc2626", borderColor: "#dc2626", color: "#ffffff", fontWeight: 700 }}
                disabled={cancelling}
                onClick={() => void confirmCancelOrder()}
              >
                {cancelling ? "Cancelling..." : "Confirm Cancel"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
