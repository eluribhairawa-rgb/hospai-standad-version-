import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal } from "../../components/ui";
import PatientSearchPicker from "../../components/PatientSearchPicker";
import PatientIdentityBanner from "../../components/PatientIdentityBanner";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice, Patient } from "../../types";
import { printViaIframe } from "../../lib/printViaIframe";
import { buildPrintDocumentHtml, buildPrintLabelsHtml } from "../../lib/printTemplates";
import { downloadCsv } from "../../lib/csvExport";
import { COUNTRY_CODE_RULES, COUNTRY_CODES, normalizePhoneNumber, validateMobileByCountry, withCountryCode } from "../../lib/phone";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate: (pageId: string) => void;
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

type CartItem = {
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
  discount_percent: number;
  gst_rate: number;
  stock_source: "CASH" | "INSURANCE";
};

type DispenseResult = {
  invoice_id?: number;
  invoice_no?: string;
  sale_ids?: number[];
  total_amount: number;
  paid_amount?: number;
  due_amount?: number;
  payment_status?: string;
  stock_source: string;
};

type IncomingRxMedicine = {
  id: number;
  medicine_name: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
};

// A doctor's e-prescription sent to the pharmacy ("Send electronic Rx to Pharmacy OP Dispense").
type IncomingRx = {
  id: number;
  appointment_id?: number | null;
  patient_id: string;
  patient_name?: string | null;
  patient_last_name?: string | null;
  patient_age?: number | string | null;
  patient_gender?: string | null;
  doctor_name?: string;
  department?: string;
  diagnosis?: string;
  dispense_status: string;
  created_at: string;
  medicines: IncomingRxMedicine[];
};

type RxStockStatus = "in_stock" | "low_stock" | "out_of_stock" | "not_in_inventory";

const RX_STOCK_BADGE: Record<RxStockStatus, { label: string; color: string; background: string }> = {
  in_stock: { label: "In stock", color: "#15803d", background: "#dcfce7" },
  low_stock: { label: "Low stock", color: "#b45309", background: "#fef3c7" },
  out_of_stock: { label: "Out of stock", color: "#b91c1c", background: "#fee2e2" },
  not_in_inventory: { label: "Not in inventory", color: "#475569", background: "#e2e8f0" },
};

const FREQUENCY_CODES: Record<string, number> = { OD: 1, QD: 1, HS: 1, SOS: 1, STAT: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, QDS: 4 };

/** "1-0-1" -> 2, "1/2-0-1/2" -> 1, "TDS" -> 3; unknown -> 1 */
function dosesPerDay(frequency?: string): number {
  const f = (frequency || "").trim().toUpperCase();
  if (/^[\d./\s]+(-[\d./\s]+)+$/.test(f)) {
    return f.split("-").reduce((sum, part) => {
      const [num, den] = part.trim().split("/").map(Number);
      return sum + (den ? num / den : num || 0);
    }, 0);
  }
  return FREQUENCY_CODES[f] ?? 1;
}

/** "7 Days" -> 7, "2 Weeks" -> 14, "1 Month" -> 30; unknown -> 1 */
function durationDays(duration?: string): number {
  const m = (duration || "").match(/(\d+(?:\.\d+)?)\s*(day|week|month)?/i);
  if (!m) return 1;
  const unit = (m[2] || "day").toLowerCase();
  return parseFloat(m[1]) * (unit.startsWith("week") ? 7 : unit.startsWith("month") ? 30 : 1);
}

function prescribedQuantity(med: IncomingRxMedicine): number {
  return Math.max(1, Math.ceil(dosesPerDay(med.frequency) * durationDays(med.duration)) || 1);
}

const isUsableBatch = (b: StockBatch) => b.qty_available > 0 && (!b.expiry_date || new Date(b.expiry_date) >= new Date());

/** Inventory batches for a prescribed name: exact brand/generic match first, then "starts with" (e.g. "dolo" -> "Dolo 650"). */
function matchRxBatches(name: string, batches: StockBatch[]): StockBatch[] {
  const q = name.trim().toLowerCase();
  if (!q) return [];
  const names = (b: StockBatch) => [(b.medicine_name || "").toLowerCase(), (b.generic_name || "").toLowerCase()];
  const exact = batches.filter((b) => names(b).includes(q));
  return exact.length ? exact : batches.filter((b) => names(b).some((n) => n.startsWith(q)));
}

export default function PharmacyOpDispense({ setNotice, onNavigate }: Props) {
  // Tabs: Dispense vs Dues vs Returns vs History
  const [activeTab, setActiveTab] = useState<"dispense" | "dues" | "returns" | "history">("dispense");
  const [dispenseHistory, setDispenseHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyDate, setHistoryDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [historySearch, setHistorySearch] = useState("");

  // Patient Selection
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [patientOutstandingDue, setPatientOutstandingDue] = useState<number>(0);

  // Sale Mode: Internal (Registered patient with UHID) vs External (Walk-in without UHID)
  const [saleMode, setSaleMode] = useState<"internal" | "external">("internal");
  const [customerName, setCustomerName] = useState<string>("");
  const [customerAge, setCustomerAge] = useState<string>("");
  const [customerDob, setCustomerDob] = useState<string>("");
  const [customerPhone, setCustomerPhone] = useState<string>("");
  const [customerCountryCode, setCustomerCountryCode] = useState<string>("+91");
  const customerPhoneRule = COUNTRY_CODE_RULES[customerCountryCode] || COUNTRY_CODE_RULES["+91"];
  const customerPhoneError = useMemo(() => {
    if (!customerPhone) return null;
    const lengthError = validateMobileByCountry(customerPhone, customerCountryCode, true);
    if (lengthError) return lengthError;
    if (customerCountryCode === "+91" && !/^[6-9]/.test(customerPhone)) {
      return "India (+91) mobile must start with 6, 7, 8, or 9.";
    }
    return null;
  }, [customerPhone, customerCountryCode]);
  const [externalCustomerDue, setExternalCustomerDue] = useState<number>(0);
  const [remarks, setRemarks] = useState<string>("");

  // Stock Batches cache
  const [allBatches, setAllBatches] = useState<StockBatch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);

  // Medicine Search & Barcode
  const [searchMedQuery, setSearchMedQuery] = useState("");
  const [selectedBatch, setSelectedBatch] = useState<StockBatch | null>(null);
  const [addQuantity, setAddQuantity] = useState<string>("");
  const [showMedDropdown, setShowMedDropdown] = useState(false);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentMode, setPaymentMode] = useState<string>("cash");
  const [dispenseStockSource, setDispenseStockSource] = useState<"CASH" | "INSURANCE">("CASH");

  // Partial Payment State
  const [paymentType, setPaymentType] = useState<"full" | "partial">("full");
  const [paidAmountInput, setPaidAmountInput] = useState<string>("");

  // Pending Dues & Repayment State
  const [dueInvoices, setDueInvoices] = useState<any[]>([]);
  const [loadingDues, setLoadingDues] = useState<boolean>(false);
  const [dueSearch, setDueSearch] = useState<string>("");
  const [dueStatusFilter, setDueStatusFilter] = useState<string>("pending_due");
  const [pendingDuesCount, setPendingDuesCount] = useState<number>(0);
  const [selectedDueInvoice, setSelectedDueInvoice] = useState<any | null>(null);
  const [repayModalOpen, setRepayModalOpen] = useState<boolean>(false);
  const [repayAmount, setRepayAmount] = useState<string>("");
  const [repayMode, setRepayMode] = useState<string>("cash");
  const [repayRef, setRepayRef] = useState<string>("");
  const [repaySubmitting, setRepaySubmitting] = useState<boolean>(false);
  // Set once a repayment is recorded: the modal switches to a success view with Print Receipt.
  const [repayReceipt, setRepayReceipt] = useState<{
    invoice: any;
    paymentId?: number;
    amount: number;
    mode: string;
    reference: string;
    paidBefore: number;
    remaining: number;
    status: string;
    paidAt: Date;
  } | null>(null);

  // Processing state
  const [submitting, setSubmitting] = useState(false);
  const [dispenseResult, setDispenseResult] = useState<DispenseResult | null>(null);
  // Cart is cleared right after a successful dispense, so a snapshot of what
  // was actually billed is kept here purely for the invoice/label print --
  // never re-derived from the (by then empty) cart.
  const [dispensedItems, setDispensedItems] = useState<CartItem[]>([]);
  const [dispensedPatient, setDispensedPatient] = useState<Patient | null>(null);
  const [dispensedCustomer, setDispensedCustomer] = useState<{
    name: string;
    age?: string;
    phone?: string;
    dob?: string;
  } | null>(null);
  const [printModalOpen, setPrintModalOpen] = useState(false);

  // Helper: auto calculate age when DOB is picked
  const handleDobChange = (dobVal: string) => {
    setCustomerDob(dobVal);
    if (dobVal) {
      const birth = new Date(dobVal);
      if (!isNaN(birth.getTime())) {
        const today = new Date();
        let calcAge = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
          calcAge--;
        }
        if (calcAge >= 0 && calcAge <= 125) {
          setCustomerAge(String(calcAge));
        }
      }
    }
  };

  // Helper: clear external customer inputs
  const handleClearCustomer = () => {
    setCustomerName("");
    setCustomerAge("");
    setCustomerDob("");
    setCustomerPhone("");
    setCustomerCountryCode("+91");
    setExternalCustomerDue(0);
  };

  // Check external customer prior dues by phone
  useEffect(() => {
    if (saleMode === "external" && customerPhone.length >= customerPhoneRule.min) {
      apiFetch<{ invoices: any[] }>(`/api/pharmacy/invoices?search=${encodeURIComponent(customerPhone.trim())}&payment_status=pending_due`)
        .then((res) => {
          const total = (res?.invoices || []).reduce((sum, inv) => sum + (parseFloat(inv.due_amount) || 0), 0);
          setExternalCustomerDue(total);
        })
        .catch(() => setExternalCustomerDue(0));
    } else {
      setExternalCustomerDue(0);
    }
  }, [saleMode, customerPhone, customerPhoneRule.min]);

  // OP Returns state
  const [searchInvoiceNo, setSearchInvoiceNo] = useState("");
  const [invoiceLookupLoading, setInvoiceLookupLoading] = useState(false);
  const [foundSales, setFoundSales] = useState<any[]>([]);
  const [returnItem, setReturnItem] = useState<any | null>(null);
  const [returnQty, setReturnQty] = useState<string>("1");
  const [returnReason, setReturnReason] = useState<string>("");
  const [returnSubmitting, setReturnSubmitting] = useState(false);

  // Incoming doctor e-prescriptions (pending / partially dispensed)
  const [incomingRx, setIncomingRx] = useState<IncomingRx[]>([]);
  const [loadingIncomingRx, setLoadingIncomingRx] = useState(false);
  // The e-Rx currently loaded into the cart; sent with the dispense so the prescription gets marked.
  const [loadedRx, setLoadedRx] = useState<{
    id: number;
    patientId: string;
    lines: { name: string; needed: number; batchIds: number[] }[];
  } | null>(null);

  const loadIncomingRx = async () => {
    setLoadingIncomingRx(true);
    try {
      const res = await apiFetch<{ prescriptions: IncomingRx[] }>("/api/pharmacy/prescriptions?status=sent_to_pharmacy,partially_dispensed");
      // Newest first; a consultation saved more than once keeps only its latest e-Rx.
      const seenAppointments = new Set<number>();
      setIncomingRx((res?.prescriptions || []).filter((rx) => {
        if (!rx.appointment_id) return true;
        if (seenAppointments.has(rx.appointment_id)) return false;
        seenAppointments.add(rx.appointment_id);
        return true;
      }));
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load incoming e-prescriptions");
    } finally {
      setLoadingIncomingRx(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "dispense") return;
    void loadIncomingRx();
    const timer = window.setInterval(() => void loadIncomingRx(), 60000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const rxStock = (med: IncomingRxMedicine) => {
    const needed = prescribedQuantity(med);
    const matches = matchRxBatches(med.medicine_name, allBatches);
    const usable = matches.filter(isUsableBatch).sort((a, b) =>
      (a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity) - (b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity));
    const available = usable.reduce((sum, b) => sum + b.qty_available, 0);
    const status: RxStockStatus = !matches.length ? "not_in_inventory"
      : available <= 0 ? "out_of_stock"
      : available < needed ? "low_stock"
      : "in_stock";
    return { needed, available, usable, status, matchedName: usable[0]?.medicine_name || matches[0]?.medicine_name };
  };

  const handleLoadPrescription = async (rx: IncomingRx) => {
    let patient: Patient | undefined;
    try {
      // GET /api/patients/{id} responds with { patient: {...} }
      const res = await apiFetch<{ patient?: Patient }>(`/api/patients/${encodeURIComponent(rx.patient_id)}`);
      patient = res?.patient;
    } catch {
      patient = undefined;
    }
    if (!patient?.patient_id) {
      setNotice({ type: "warning", message: `Patient ${rx.patient_id} could not be found in registrations.` });
      return;
    }
    const newCart: CartItem[] = [];
    const lines: { name: string; needed: number; batchIds: number[] }[] = [];
    const unavailable: string[] = [];
    const short: string[] = [];
    for (const med of rx.medicines) {
      const { needed, usable } = rxStock(med);
      let remaining = needed;
      for (const batch of usable) {
        if (remaining <= 0) break;
        const take = Math.min(batch.qty_available, remaining);
        newCart.push({
          batch_id: batch.id,
          medicine_id: batch.medicine_id,
          medicine_name: batch.medicine_name,
          generic_name: batch.generic_name,
          batch_no: batch.batch_no,
          expiry_date: batch.expiry_date,
          available_qty: batch.qty_available,
          quantity: take,
          unit_price: batch.unit_price || 0,
          mrp: batch.mrp || batch.unit_price || 0,
          discount_percent: 0,
          gst_rate: batch.gst_rate || 12,
          stock_source: batch.stock_source || "CASH",
        });
        remaining -= take;
      }
      lines.push({ name: med.medicine_name, needed, batchIds: usable.map((b) => b.id) });
      if (remaining === needed) unavailable.push(med.medicine_name);
      else if (remaining > 0) short.push(`${med.medicine_name} (${needed - remaining} of ${needed})`);
    }

    setSaleMode("internal");
    setSelectedPatient(patient);
    setCart(newCart);
    setLoadedRx({ id: rx.id, patientId: rx.patient_id, lines });

    const issues = [
      unavailable.length ? `Not available: ${unavailable.join(", ")}` : "",
      short.length ? `Partially available: ${short.join(", ")}` : "",
    ].filter(Boolean).join(". ");
    setNotice(issues
      ? { type: "warning", message: `e-Rx #${rx.id} loaded with available stock. ${issues}.` }
      : { type: "success", message: `e-Rx #${rx.id} loaded - all ${rx.medicines.length} medicine(s) added to the cart.` });
  };

  const [dismissingRxId, setDismissingRxId] = useState<number | null>(null);
  const handleDismissRx = async (rx: IncomingRx) => {
    const who = [rx.patient_name, rx.patient_last_name].filter(Boolean).join(" ") || rx.patient_id;
    if (!window.confirm(`Remove e-Rx #${rx.id} for ${who} from the incoming list? Use this when the medicines cannot be supplied.`)) return;
    setDismissingRxId(rx.id);
    try {
      await apiFetch(`/api/pharmacy/prescriptions/${rx.id}/dismiss`, { method: "POST" });
      if (loadedRx?.id === rx.id) setLoadedRx(null);
      setNotice({ type: "success", message: `e-Rx #${rx.id} removed from incoming e-prescriptions.` });
      await loadIncomingRx();
    } catch (err) {
      reportError(setNotice, err as any, "Failed to remove the e-prescription");
    } finally {
      setDismissingRxId(null);
    }
  };

  // Forget the loaded e-Rx if the cart is emptied or another patient is chosen.
  useEffect(() => {
    if (loadedRx && (cart.length === 0 || selectedPatient?.patient_id !== loadedRx.patientId)) {
      setLoadedRx(null);
    }
  }, [cart.length, selectedPatient, loadedRx]);

  // Load available stock
  const loadStock = async () => {
    setLoadingBatches(true);
    try {
      const res = await apiFetch<{ batches: StockBatch[] }>("/api/pharmacy/stock");
      if (res?.batches) {
        setAllBatches(res.batches);
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load medicine stock");
    } finally {
      setLoadingBatches(false);
    }
  };

  useEffect(() => {
    void loadStock();
    const saved = localStorage.getItem("selected_pharmacy_patient");
    if (saved) {
      localStorage.removeItem("selected_pharmacy_patient");
      apiFetch<{ patient?: Patient }>(`/api/patients/${encodeURIComponent(saved)}`)
        .then((res) => {
          if (res?.patient?.patient_id) setSelectedPatient(res.patient);
        })
        .catch(() => {});
    }
  }, []);

  // Filtered medicines and FEFO batch sorting
  const filteredBatches = useMemo(() => {
    const q = searchMedQuery.trim().toLowerCase();
    if (!q) return [];

    const matches = allBatches.filter((b) => {
      const isNotExpired = !b.expiry_date || new Date(b.expiry_date) >= new Date();
      const hasStock = b.qty_available > 0;
      const matchText = (b.medicine_name || "").toLowerCase().includes(q) ||
        (b.generic_name || "").toLowerCase().includes(q) ||
        (b.batch_no || "").toLowerCase().includes(q);
      return matchText && hasStock && isNotExpired;
    });

    // FEFO: Sort by expiry date ascending
    return matches.sort((a, b) => {
      const dateA = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
      const dateB = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
      return dateA - dateB;
    });
  }, [allBatches, searchMedQuery]);

  // Add to cart
  const handleAddToCart = () => {
    if (!selectedBatch) return;
    const qty = parseInt(String(addQuantity).trim(), 10);
    if (isNaN(qty) || qty <= 0) {
      setNotice({ type: "warning", message: "Please enter a valid quantity greater than 0" });
      return;
    }
    if (qty > selectedBatch.qty_available) {
      setNotice({ type: "warning", message: `Quantity cannot exceed available stock (${selectedBatch.qty_available})` });
      return;
    }

    const existingIndex = cart.findIndex((c) => c.batch_id === selectedBatch.id);
    if (existingIndex >= 0) {
      const updated = [...cart];
      const newQty = updated[existingIndex].quantity + qty;
      if (newQty > selectedBatch.qty_available) {
        setNotice({ type: "warning", message: `Total in cart (${newQty}) exceeds stock (${selectedBatch.qty_available})` });
        return;
      }
      updated[existingIndex].quantity = newQty;
      setCart(updated);
    } else {
      setCart([
        ...cart,
        {
          batch_id: selectedBatch.id,
          medicine_id: selectedBatch.medicine_id,
          medicine_name: selectedBatch.medicine_name,
          generic_name: selectedBatch.generic_name,
          batch_no: selectedBatch.batch_no,
          expiry_date: selectedBatch.expiry_date,
          available_qty: selectedBatch.qty_available,
          quantity: qty,
          unit_price: selectedBatch.unit_price || 0,
          mrp: selectedBatch.mrp || selectedBatch.unit_price || 0,
          discount_percent: 0,
          gst_rate: selectedBatch.gst_rate || 12,
          stock_source: selectedBatch.stock_source || "CASH",
        },
      ]);
    }

    // Reset selection
    setSelectedBatch(null);
    setSearchMedQuery("");
    setAddQuantity("");
    setShowMedDropdown(false);
  };

  const handleRemoveFromCart = (index: number) => {
    setCart(cart.filter((_, idx) => idx !== index));
  };

  const handleUpdateCartQty = (index: number, qty: number) => {
    if (qty <= 0) return;
    const item = cart[index];
    if (qty > item.available_qty) {
      setNotice({ type: "warning", message: `Quantity cannot exceed available stock (${item.available_qty})` });
      return;
    }
    const updated = [...cart];
    updated[index].quantity = qty;
    setCart(updated);
  };

  const handleUpdateCartDiscount = (index: number, disc: number) => {
    const updated = [...cart];
    updated[index].discount_percent = Math.max(0, Math.min(100, disc));
    setCart(updated);
  };

  // Cart Calculations
  const cartTotals = useMemo(() => {
    let subtotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;

    for (const item of cart) {
      const basePrice = item.unit_price * item.quantity;
      const discount = basePrice * (item.discount_percent / 100);
      const afterDiscount = basePrice - discount;
      const tax = afterDiscount * (item.gst_rate / 100);

      subtotal += basePrice;
      totalDiscount += discount;
      totalTax += tax;
    }

    const grandTotal = subtotal - totalDiscount + totalTax;

    return {
      subtotal,
      totalDiscount,
      totalTax,
      grandTotal: Math.max(0, grandTotal),
    };
  }, [cart]);

  // Partial Payment calculations
  const effectivePaidAmount = useMemo(() => {
    if (paymentType === "full") return cartTotals.grandTotal;
    const parsed = parseFloat(paidAmountInput);
    if (isNaN(parsed) || parsed < 0) return 0;
    return Math.min(parsed, cartTotals.grandTotal);
  }, [paymentType, paidAmountInput, cartTotals.grandTotal]);

  const computedDue = useMemo(() => {
    return Math.max(0, cartTotals.grandTotal - effectivePaidAmount);
  }, [cartTotals.grandTotal, effectivePaidAmount]);

  useEffect(() => {
    if (paymentType === "full") {
      setPaidAmountInput(cartTotals.grandTotal > 0 ? cartTotals.grandTotal.toFixed(2) : "");
    }
  }, [cartTotals.grandTotal, paymentType]);

  // Check patient prior dues
  useEffect(() => {
    if (!selectedPatient) {
      setPatientOutstandingDue(0);
      return;
    }
    apiFetch<{ invoices: any[] }>(`/api/pharmacy/invoices?patient_id=${encodeURIComponent(selectedPatient.patient_id)}&payment_status=pending_due`)
      .then((res) => {
        const total = (res?.invoices || []).reduce((sum, inv) => sum + (parseFloat(inv.due_amount) || 0), 0);
        setPatientOutstandingDue(total);
      })
      .catch(() => {
        setPatientOutstandingDue(0);
      });
  }, [selectedPatient]);

  // Load Dues
  const loadDues = async (searchOverride?: string) => {
    setLoadingDues(true);
    try {
      const q = searchOverride !== undefined ? searchOverride : dueSearch;
      const params = new URLSearchParams();
      if (dueStatusFilter) params.set("payment_status", dueStatusFilter);
      if (q.trim()) params.set("search", q.trim());
      const res = await apiFetch<{ invoices: any[] }>(`/api/pharmacy/invoices?${params.toString()}`);
      if (res?.invoices) {
        setDueInvoices(res.invoices);
        if (dueStatusFilter === "pending_due" && !q.trim()) {
          setPendingDuesCount(res.invoices.length);
        }
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load pending dues");
    } finally {
      setLoadingDues(false);
    }
  };

  useEffect(() => {
    apiFetch<{ invoices: any[] }>("/api/pharmacy/invoices?payment_status=pending_due")
      .then((res) => {
        if (res?.invoices) setPendingDuesCount(res.invoices.length);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab === "dues") {
      void loadDues();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dueStatusFilter]);

  const handleOpenRepayModal = (inv: any) => {
    setSelectedDueInvoice(inv);
    const due = parseFloat(inv.due_amount || 0);
    setRepayAmount(due.toFixed(2));
    setRepayMode("cash");
    setRepayRef("");
    setRepayReceipt(null);
    setRepayModalOpen(true);
  };

  const closeRepayModal = () => {
    setRepayModalOpen(false);
    setSelectedDueInvoice(null);
    setRepayReceipt(null);
  };

  const dueCustomerName = (inv: any) =>
    [inv.name, inv.last_name].filter(Boolean).join(" ") || inv.referral_source || "Customer";
  const isExternalDueInvoice = (inv: any) =>
    !inv.patient_id || inv.patient_id.startsWith("EXT-") || inv.patient_id.startsWith("WALK-");

  const handlePrintRepaymentReceipt = () => {
    if (!repayReceipt) return;
    const { invoice, amount, mode, reference, paidBefore, remaining, status, paymentId, paidAt } = repayReceipt;
    const external = isExternalDueInvoice(invoice);
    const paidOn = `${paidAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} ${paidAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    try {
      printViaIframe(buildPrintDocumentHtml({
        title: "Pharmacy Due Repayment Receipt",
        subtitleLines: [`Invoice: ${invoice.invoice_no}`, `Paid on: ${paidOn}`],
        meta: [
          { label: external ? "Customer Name" : "Patient Name", value: dueCustomerName(invoice) },
          { label: external ? "Mobile Number" : "UHID / Patient ID", value: external ? (invoice.phone || invoice.patient_id || "Walk-in") : invoice.patient_id },
          { label: "Invoice Number", value: invoice.invoice_no },
          ...(paymentId ? [{ label: "Receipt / Payment ID", value: `PAY-${paymentId}` }] : []),
          { label: "Payment Mode", value: mode.toUpperCase() },
          ...(reference ? [{ label: "Payment Ref / Notes", value: reference }] : []),
        ],
        columns: ["Description", "Payment Mode", "Amount"],
        rows: [[`Due repayment against Invoice ${invoice.invoice_no}`, mode.toUpperCase(), `₹${amount.toFixed(2)}`]],
        totals: [
          { label: "Total Bill Amount", value: `₹${parseFloat(invoice.total_amount || 0).toFixed(2)}` },
          { label: "Paid Before", value: `₹${paidBefore.toFixed(2)}` },
          { label: "This Payment", value: `₹${amount.toFixed(2)}` },
          { label: "Remaining Due", value: `₹${remaining.toFixed(2)}`, grand: true },
          { label: "Payment Status", value: status },
        ],
      }));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to print the receipt." });
    }
  };

  const handleConfirmRepayment = async () => {
    if (!selectedDueInvoice) return;
    const amountNum = parseFloat(repayAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setNotice({ type: "warning", message: "Please enter a valid repayment amount greater than 0." });
      return;
    }
    const maxDue = parseFloat(selectedDueInvoice.due_amount || 0);
    if (amountNum > maxDue) {
      setNotice({ type: "warning", message: `Repayment amount cannot exceed current due balance of ₹${maxDue.toFixed(2)}` });
      return;
    }

    setRepaySubmitting(true);
    try {
      const res = await apiFetch<{ payment_id: number; due_amount: number; payment_status: string }>(
        `/api/pharmacy/invoices/${selectedDueInvoice.id}/payments`,
        {
          method: "POST",
          body: JSON.stringify({
            amount: amountNum,
            payment_mode: repayMode,
            gateway_ref: repayRef.trim() || undefined,
          }),
        }
      );

      const remaining = res?.due_amount ?? Math.max(0, maxDue - amountNum);
      const statusText = remaining <= 0 ? "Fully Settled" : `Remaining Due: ₹${remaining.toFixed(2)}`;
      setNotice({
        type: "success",
        message: `Payment of ₹${amountNum.toFixed(2)} received for Invoice #${selectedDueInvoice.invoice_no}! Status: ${statusText}`,
      });
      setRepayReceipt({
        invoice: selectedDueInvoice,
        paymentId: res?.payment_id,
        amount: amountNum,
        mode: repayMode,
        reference: repayRef.trim(),
        paidBefore: parseFloat(selectedDueInvoice.paid_amount || 0),
        remaining,
        status: remaining <= 0 ? "FULLY SETTLED" : "PARTIALLY PAID",
        paidAt: new Date(),
      });
      void loadDues();
      if (selectedPatient && selectedPatient.patient_id === selectedDueInvoice.patient_id) {
        setPatientOutstandingDue((prev) => Math.max(0, prev - amountNum));
      }
    } catch (err) {
      reportError(setNotice, err as any, "Failed to record due repayment");
    } finally {
      setRepaySubmitting(false);
    }
  };

  const remainingAfterRepay = useMemo(() => {
    if (!selectedDueInvoice) return 0;
    const currentDue = parseFloat(selectedDueInvoice.due_amount || 0);
    const paying = parseFloat(repayAmount);
    if (isNaN(paying) || paying < 0) return currentDue;
    return Math.max(0, currentDue - paying);
  }, [selectedDueInvoice, repayAmount]);

  const totalDueSum = useMemo(() => {
    return dueInvoices.reduce((sum, inv) => sum + (parseFloat(inv.due_amount) || 0), 0);
  }, [dueInvoices]);

  // Execute OP Dispense
  const handleExecuteDispense = async () => {
    if (saleMode === "internal") {
      if (!selectedPatient?.patient_id) {
        setNotice({ type: "warning", message: "Please search and select a patient first." });
        return;
      }
    } else {
      if (!customerName.trim()) {
        setNotice({ type: "warning", message: "Customer Name is required for external sale." });
        return;
      }
      if (!customerAge.trim()) {
        setNotice({ type: "warning", message: "Customer Age is required for external sale." });
        return;
      }
      if (!customerPhone.trim()) {
        setNotice({ type: "warning", message: "Primary Mobile Number is required for external sale." });
        return;
      }
      if (customerPhoneError) {
        setNotice({ type: "warning", message: customerPhoneError });
        return;
      }
    }
    if (cart.length === 0) {
      setNotice({ type: "warning", message: "Cart is empty. Add medicines to dispense." });
      return;
    }

    // Dispensing a loaded e-Rx: partial if any prescribed medicine isn't fully in the cart.
    const rxForDispense = saleMode === "internal" && loadedRx && selectedPatient?.patient_id === loadedRx.patientId ? loadedRx : null;
    const rxPartial = !!rxForDispense && rxForDispense.lines.some((line) =>
      cart.filter((c) => line.batchIds.includes(c.batch_id)).reduce((sum, c) => sum + c.quantity, 0) < line.needed);

    setSubmitting(true);
    try {
      const payload = {
        prescription_id: rxForDispense?.id,
        prescription_partial: rxPartial || undefined,
        patient_id: saleMode === "internal" ? selectedPatient?.patient_id : undefined,
        is_external: saleMode === "external",
        customer_name: saleMode === "external" ? customerName.trim() : undefined,
        customer_phone: saleMode === "external" ? withCountryCode(customerCountryCode, customerPhone) : undefined,
        customer_age: saleMode === "external" ? customerAge.trim() : undefined,
        customer_dob: saleMode === "external" ? customerDob.trim() : undefined,
        remarks: remarks.trim() || undefined,
        billing_type: "CASH_OPD",
        stock_source: dispenseStockSource,
        payment_mode: paymentMode,
        subtotal: cartTotals.subtotal,
        discount: cartTotals.totalDiscount,
        tax: cartTotals.totalTax,
        grand_total: cartTotals.grandTotal,
        paid_amount: effectivePaidAmount,
        due_amount: computedDue,
        items: cart.map((c) => ({
          batch_id: c.batch_id,
          medicine_name: c.medicine_name,
          quantity: c.quantity,
          price: c.unit_price,
          discount: (c.unit_price * c.quantity * (c.discount_percent / 100)),
          tax: ((c.unit_price * c.quantity * (1 - c.discount_percent / 100)) * (c.gst_rate / 100)),
        })),
      };

      const res = await apiFetch<DispenseResult>("/api/pharmacy/dispense", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const fullResult: DispenseResult = {
        ...res,
        total_amount: res.total_amount ?? cartTotals.grandTotal,
        paid_amount: res.paid_amount ?? effectivePaidAmount,
        due_amount: res.due_amount ?? computedDue,
        payment_status: res.payment_status ?? (computedDue > 0 ? (effectivePaidAmount > 0 ? "partial" : "due") : "paid"),
      };

      setDispenseResult(fullResult);
      setDispensedItems(cart);
      setDispensedPatient(saleMode === "internal" ? selectedPatient : null);
      setDispensedCustomer(
        saleMode === "external"
          ? {
              name: customerName.trim(),
              age: customerAge.trim(),
              phone: customerPhone.trim(),
              dob: customerDob.trim(),
            }
          : null
      );

      const invoiceLabel = res.invoice_no || `INV-${res.invoice_id}`;
      const customerDispLabel = saleMode === "external" ? customerName.trim() : (selectedPatient ? `${selectedPatient.name} ${selectedPatient.last_name || ''}`.trim() : "");
      if (computedDue > 0) {
        setNotice({
          type: "success",
          message: `Dispense complete for ${customerDispLabel}! Invoice #${invoiceLabel} created with ₹${effectivePaidAmount.toFixed(2)} paid and ₹${computedDue.toFixed(2)} recorded as pending due.`,
        });
        setPendingDuesCount((prev) => prev + 1);
        if (saleMode === "internal") {
          setPatientOutstandingDue((prev) => prev + computedDue);
        } else {
          setExternalCustomerDue((prev) => prev + computedDue);
        }
      } else {
        setNotice({ type: "success", message: `Successfully dispensed for ${customerDispLabel}! Invoice #${invoiceLabel}` });
      }

      setPrintModalOpen(true);
      setCart([]);
      setLoadedRx(null);
      setPaymentType("full");
      setPaidAmountInput("");
      setRemarks("");
      void loadStock();
      if (rxForDispense) void loadIncomingRx();
    } catch (err) {
      reportError(setNotice, err as any, "Dispense failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrintInvoice = () => {
    if (!dispenseResult) return;
    let subtotal = 0, totalDiscount = 0, totalTax = 0;
    const rows = dispensedItems.map((it) => {
      const basePrice = it.unit_price * it.quantity;
      const discount = basePrice * (it.discount_percent / 100);
      const afterDiscount = basePrice - discount;
      const tax = afterDiscount * (it.gst_rate / 100);
      subtotal += basePrice; totalDiscount += discount; totalTax += tax;
      return [
        it.medicine_name, it.batch_no || "-", it.stock_source === "CASH" ? "Cash Stock" : "Insurance Stock",
        it.quantity, `₹${it.unit_price.toFixed(2)}`, `${it.discount_percent}%`, `₹${(basePrice - discount + tax).toFixed(2)}`,
      ];
    });
    const grandTotal = subtotal - totalDiscount + totalTax;
    const isExt = Boolean(dispensedCustomer || (!dispensedPatient && dispenseResult));
    const customerFullName = dispensedPatient
      ? `${dispensedPatient.name || ""} ${dispensedPatient.last_name || ""}`.trim()
      : (dispensedCustomer?.name || "-");
    const customerIdentifier = dispensedPatient?.patient_id || (isExt ? "Walk-in Customer (No UHID)" : "-");
    const customerContact = dispensedPatient?.phone || dispensedCustomer?.phone || "-";
    const invoiceNumber = dispenseResult.invoice_no || `INV-${dispenseResult.invoice_id}`;
    const invoiceDate = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    try {
      printViaIframe(buildPrintDocumentHtml({
        title: "Pharmacy Dispense Invoice",
        subtitleLines: [
          `Sale Type: ${isExt ? "External Customer Sale (No UHID Required)" : "Internal Hospital Patient Sale"}`,
          `Invoice: ${invoiceNumber}`,
          `Date: ${invoiceDate}`,
        ],
        meta: [
          { label: isExt ? "Customer Name" : "Patient Name", value: customerFullName },
          { label: isExt ? "Sale Mode" : "UHID / Patient ID", value: customerIdentifier },
          ...(customerContact !== "-" ? [{ label: "Mobile Number", value: customerContact }] : []),
          { label: "Invoice Number", value: invoiceNumber },
          { label: "Payment Mode", value: paymentMode.toUpperCase() },
          { label: "Date & Time", value: `${invoiceDate} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` },
        ],
        columns: ["Medicine Name", "Batch", "Source", "Qty", "Unit Price", "Discount", "Total"],
        rows,
        totals: [
          { label: "Subtotal", value: `₹${subtotal.toFixed(2)}` },
          { label: "Discount", value: `-₹${totalDiscount.toFixed(2)}` },
          { label: "GST / Tax", value: `₹${totalTax.toFixed(2)}` },
          { label: "Grand Total", value: `₹${grandTotal.toFixed(2)}`, grand: true },
          { label: "Amount Received / Paid", value: `₹${(dispenseResult.paid_amount ?? grandTotal).toFixed(2)}` },
          { label: "Due Balance", value: `₹${(dispenseResult.due_amount ?? 0).toFixed(2)}` },
          { label: "Payment Status", value: (dispenseResult.payment_status || "paid").toUpperCase() },
        ],
      }));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to print the invoice." });
    }
  };

  const handlePrintLabels = () => {
    if (!dispenseResult) return;
    const isExt = Boolean(dispensedCustomer || (!dispensedPatient && dispenseResult));
    const customerFullName = dispensedPatient
      ? `${dispensedPatient.name || ""} ${dispensedPatient.last_name || ""}`.trim()
      : (dispensedCustomer?.name || "-");
    const customerIdentifier = dispensedPatient?.patient_id || (isExt ? "Walk-in" : "-");
    printViaIframe(buildPrintLabelsHtml({
      patientName: customerFullName || "-",
      patientId: customerIdentifier || "-",
      invoiceNo: dispenseResult.invoice_no || `INV-${dispenseResult.invoice_id}`,
      items: dispensedItems.map((it) => ({
        medicineName: it.medicine_name, batchNo: it.batch_no, expiryDate: it.expiry_date, quantity: it.quantity,
      })),
    }));
  };

  // Lookup Invoice for Return
  const handleLookupInvoice = async () => {
    const q = searchInvoiceNo.trim();
    if (!q) return;
    setInvoiceLookupLoading(true);
    try {
      // Try as an invoice number first; if that errors or matches nothing,
      // always fall through to a patient-UHID search rather than aborting --
      // staff type whatever is printed on the receipt or the patient's
      // UHID interchangeably in this one box.
      let sales: any[] = [];
      try {
        const res = await apiFetch<{ sales: any[] }>(`/api/pharmacy/sales?invoice_id=${encodeURIComponent(q)}`);
        sales = res?.sales || [];
      } catch {
        sales = [];
      }
      if (sales.length === 0) {
        const res2 = await apiFetch<{ sales: any[] }>(`/api/pharmacy/sales?patient_id=${encodeURIComponent(q)}`);
        sales = res2?.sales || [];
      }
      setFoundSales(sales);
      if (sales.length === 0) {
        setNotice({ type: "info", message: "No sales found for this invoice or UHID." });
      }
    } catch (err) {
      reportError(setNotice, err as any, "Error searching sales");
    } finally {
      setInvoiceLookupLoading(false);
    }
  };

  // Submit Return
  const handleProcessReturn = async () => {
    if (!returnItem) return;
    const qty = parseInt(returnQty, 10);
    const maxReturnable = returnItem.remaining_qty ?? returnItem.quantity;
    if (isNaN(qty) || qty <= 0 || qty > maxReturnable) {
      setNotice({ type: "warning", message: `Invalid return quantity (max: ${maxReturnable})` });
      return;
    }
    if (!returnReason.trim()) {
      setNotice({ type: "warning", message: "Reason for return is required." });
      return;
    }

    setReturnSubmitting(true);
    try {
      await apiFetch("/api/pharmacy/returns", {
        method: "POST",
        body: JSON.stringify({
          original_sale_id: returnItem.id,
          quantity: qty,
          reason: returnReason,
        }),
      });

      setNotice({ type: "success", message: `Return processed and refund applied for ${returnItem.medicine_name}.` });
      setReturnItem(null);
      setReturnReason("");
      setReturnQty("1");
      void handleLookupInvoice();
      void loadStock();
    } catch (err) {
      reportError(setNotice, err as any, "Failed to process return");
    } finally {
      setReturnSubmitting(false);
    }
  };

  // OP Dispense History -- daily list of OP counter sales
  const loadDispenseHistory = async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams({ billing_type: "CASH_OPD" });
      if (historyDate) {
        params.set("from_date", historyDate);
        params.set("to_date", historyDate);
      }
      if (historySearch.trim()) params.set("q", historySearch.trim());
      const res = await apiFetch<{ sales?: any[] }>(`/api/pharmacy/sales?${params.toString()}`);
      setDispenseHistory(res.sales || []);
    } catch (err) {
      reportError(setNotice, err as any, "Failed to load dispense history");
    } finally {
      setLoadingHistory(false);
      setHistoryLoaded(true);
    }
  };

  const handleExportHistoryCsv = () => {
    downloadCsv(
      `op_dispense_history_${historyDate || "all"}.csv`,
      ["Time", "Type", "Customer / Patient", "Identifier / Mobile", "Medicine", "Quantity", "Unit Price", "Amount", "Invoice No", "Status"],
      dispenseHistory.map((s) => {
        const isExt = (s.patient_id && s.patient_id.startsWith("EXT-")) || (!s.patient_id && s.customer_name);
        return [
          s.sold_at ? new Date(s.sold_at).toLocaleTimeString() : "",
          isExt ? "External Sale" : "Internal Patient",
          s.customer_name || (isExt ? "External Customer" : "-"),
          s.customer_mobile || s.patient_id || "-",
          s.medicine_name,
          s.quantity,
          s.unit_price,
          s.amount,
          s.invoice_no || (s.invoice_id ? `INV-${s.invoice_id}` : "-"),
          s.payment_status || "paid",
        ];
      })
    );
  };

  useEffect(() => {
    if (activeTab === "history" && !historyLoaded) {
      void loadDispenseHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  return (
    <div className="pharmacy-theme-page" style={{ padding: "1.5rem", maxWidth: "1400px", margin: "0 auto" }}>
      {/* Topbar / Breadcrumbs */}
      <div className="pharmacy-topbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <div className="pharmacy-breadcrumb" style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", color: "#64748b" }}>
          <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 600 }} onClick={() => window.history.back()}>HospAI</span>
          <span>/</span>
          <span style={{ cursor: "pointer", color: "#00828a", fontWeight: 600 }} onClick={() => onNavigate("pharmacy-overview")}>Pharmacy</span>
          <span>/</span>
          <span style={{ color: "#0f172a", fontWeight: 700 }}>OP Dispense</span>
        </div>

        {/* Tab switch: Dispense vs Dues vs Returns vs History */}
        <div style={{ display: "flex", background: "#e2e8f0", borderRadius: "8px", padding: "3px", gap: "2px" }}>
          <button
            type="button"
            style={{
              padding: "0.4rem 0.9rem",
              borderRadius: "6px",
              border: "none",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "dispense" ? "#00828a" : "transparent",
              color: activeTab === "dispense" ? "#ffffff" : "#475569",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("dispense")}
          >
            OP Dispense
          </button>
          <button
            type="button"
            style={{
              padding: "0.4rem 0.9rem",
              borderRadius: "6px",
              border: "none",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "dues" ? "#00828a" : "transparent",
              color: activeTab === "dues" ? "#ffffff" : "#475569",
              transition: "all 0.15s ease",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
            onClick={() => setActiveTab("dues")}
          >
            Pending Dues & Repayments
            {pendingDuesCount > 0 && (
              <span style={{
                background: activeTab === "dues" ? "#ffffff" : "#e11d48",
                color: activeTab === "dues" ? "#e11d48" : "#ffffff",
                borderRadius: "10px",
                padding: "1px 6px",
                fontSize: "0.7rem",
                fontWeight: 800,
              }}>
                {pendingDuesCount}
              </span>
            )}
          </button>
          <button
            type="button"
            style={{
              padding: "0.4rem 0.9rem",
              borderRadius: "6px",
              border: "none",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "returns" ? "#00828a" : "transparent",
              color: activeTab === "returns" ? "#ffffff" : "#475569",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("returns")}
          >
            OP Returns / Refunds
          </button>
          <button
            type="button"
            style={{
              padding: "0.4rem 0.9rem",
              borderRadius: "6px",
              border: "none",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: "pointer",
              background: activeTab === "history" ? "#00828a" : "transparent",
              color: activeTab === "history" ? "#ffffff" : "#475569",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("history")}
          >
            Dispense History
          </button>
        </div>
      </div>

      {activeTab === "dispense" ? (
        <>
          {/* Sale Mode Toggle: Internal Sale (with UHID) vs External Sale (without UHID) */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderRadius: "8px", overflow: "hidden", marginBottom: "1.25rem", border: "1px solid #cbd5e1" }}>
            <button
              type="button"
              style={{
                padding: "0.85rem 1rem",
                border: "none",
                borderRight: "1px solid #cbd5e1",
                cursor: "pointer",
                textAlign: "center",
                background: saleMode === "internal" ? "#00828a" : "#f1f5f9",
                color: saleMode === "internal" ? "#ffffff" : "#1e293b",
                transition: "all 0.15s ease",
              }}
              onClick={() => setSaleMode("internal")}
            >
              <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: "2px" }}>Internal Sale</div>
              <div style={{ fontSize: "0.78rem", color: saleMode === "internal" ? "#e0f2f1" : "#64748b" }}>
                Dispense to registered patient (with UHID)
              </div>
            </button>
            <button
              type="button"
              style={{
                padding: "0.85rem 1rem",
                border: "none",
                cursor: "pointer",
                textAlign: "center",
                background: saleMode === "external" ? "#00828a" : "#f1f5f9",
                color: saleMode === "external" ? "#ffffff" : "#1e293b",
                transition: "all 0.15s ease",
              }}
              onClick={() => setSaleMode("external")}
            >
              <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: "2px" }}>External Sale</div>
              <div style={{ fontSize: "0.78rem", color: saleMode === "external" ? "#e0f2f1" : "#64748b" }}>
                Sell medicines without patient registration
              </div>
            </button>
          </div>

          {/* Incoming doctor e-prescriptions with live stock status */}
          {saleMode === "internal" && (
            <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "0.85rem" }}>
                <div>
                  <h2 style={{ margin: "0 0 0.25rem 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                    Incoming e-Prescriptions {incomingRx.length > 0 && (
                      <span style={{ marginLeft: "6px", padding: "1px 8px", borderRadius: "999px", background: "#00828a", color: "#fff", fontSize: "0.75rem", verticalAlign: "middle" }}>{incomingRx.length}</span>
                    )}
                  </h2>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                    Prescriptions sent by doctors from Doctor Prescription. Stock status is live from pharmacy inventory.
                  </p>
                </div>
                <button
                  type="button"
                  style={{ padding: "0.35rem 0.85rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#00828a", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                  onClick={() => { void loadIncomingRx(); void loadStock(); }}
                  disabled={loadingIncomingRx}
                >
                  {loadingIncomingRx ? "Refreshing..." : "🔄 Refresh"}
                </button>
              </div>

              {incomingRx.length === 0 ? (
                <div style={{ padding: "1rem", textAlign: "center", color: "#94a3b8", fontSize: "0.875rem", border: "1px dashed #e2e8f0", borderRadius: "8px" }}>
                  {loadingIncomingRx ? "Loading e-prescriptions..." : "No pending e-prescriptions. They appear here when a doctor completes a consultation with \"Send electronic Rx to Pharmacy OP Dispense\" checked."}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", maxHeight: "460px", overflowY: "auto", paddingRight: "2px" }}>
                  {incomingRx.map((rx) => {
                    const isLoaded = loadedRx?.id === rx.id;
                    const lines = rx.medicines.map((med) => ({ med, stock: rxStock(med) }));
                    const allAvailable = lines.length > 0 && lines.every((l) => l.stock.status === "in_stock");
                    const noneAvailable = lines.every((l) => l.stock.available <= 0);
                    const patientLabel = [rx.patient_name, rx.patient_last_name].filter(Boolean).join(" ") || "Unregistered patient";
                    return (
                      <div key={rx.id} style={{ border: isLoaded ? "2px solid #00828a" : "1px solid #e2e8f0", borderRadius: "8px", padding: "0.85rem", background: isLoaded ? "#f0fdfa" : "#ffffff" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
                          <div style={{ fontSize: "0.85rem", color: "#334155", lineHeight: 1.5 }}>
                            <div>
                              <strong style={{ color: "#0f172a", fontSize: "0.95rem" }}>{patientLabel}</strong>
                              <span style={{ color: "#64748b" }}> · {rx.patient_id}</span>
                              {(rx.patient_age || rx.patient_gender) && (
                                <span style={{ color: "#64748b" }}> · {[rx.patient_age && `${rx.patient_age}y`, rx.patient_gender].filter(Boolean).join(" / ")}</span>
                              )}
                            </div>
                            <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                              e-Rx #{rx.id} · Dr. {rx.doctor_name || "-"}{rx.department ? ` (${rx.department})` : ""} · {new Date(rx.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                              {rx.diagnosis ? ` · Diagnosis: ${rx.diagnosis}` : ""}
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "0.72rem", fontWeight: 700, ...(rx.dispense_status === "partially_dispensed" ? { background: "#fef3c7", color: "#b45309" } : { background: "#e0f2fe", color: "#0369a1" }) }}>
                              {rx.dispense_status === "partially_dispensed" ? "Partially Dispensed" : "Pending"}
                            </span>
                            <button
                              type="button"
                              disabled={noneAvailable || isLoaded}
                              title={noneAvailable ? "None of these medicines are available in stock" : "Select this patient and add available medicines to the cart"}
                              style={{ padding: "0.4rem 0.85rem", borderRadius: "6px", border: "none", background: noneAvailable || isLoaded ? "#cbd5e1" : "#00828a", color: "#ffffff", fontSize: "0.8rem", fontWeight: 700, cursor: noneAvailable || isLoaded ? "not-allowed" : "pointer" }}
                              onClick={() => void handleLoadPrescription(rx)}
                            >
                              {isLoaded ? "✓ Loaded in Cart" : allAvailable ? "Load to Cart" : "Load Available to Cart"}
                            </button>
                            {!allAvailable && (
                              <button
                                type="button"
                                disabled={dismissingRxId === rx.id}
                                title="Medicines not available - remove this e-prescription from the list"
                                style={{ padding: "0.4rem 0.85rem", borderRadius: "6px", border: "1px solid #fecaca", background: "#fff1f2", color: "#b91c1c", fontSize: "0.8rem", fontWeight: 700, cursor: dismissingRxId === rx.id ? "wait" : "pointer" }}
                                onClick={() => void handleDismissRx(rx)}
                              >
                                {dismissingRxId === rx.id ? "Removing..." : "Remove"}
                              </button>
                            )}
                          </div>
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                          <thead>
                            <tr style={{ background: "#f8fafc", color: "#475569", textAlign: "left" }}>
                              <th style={{ padding: "6px 8px" }}>Medicine</th>
                              <th style={{ padding: "6px 8px" }}>Dosage / Frequency / Duration</th>
                              <th style={{ padding: "6px 8px", textAlign: "right" }}>Qty Needed</th>
                              <th style={{ padding: "6px 8px", textAlign: "right" }}>In Stock</th>
                              <th style={{ padding: "6px 8px" }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map(({ med, stock }) => {
                              const badge = RX_STOCK_BADGE[stock.status];
                              return (
                                <tr key={med.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                                  <td style={{ padding: "6px 8px", fontWeight: 600, color: "#0f172a" }}>
                                    {med.medicine_name}
                                    {stock.matchedName && stock.matchedName.toLowerCase() !== med.medicine_name.trim().toLowerCase() && (
                                      <div style={{ fontWeight: 400, color: "#64748b", fontSize: "0.75rem" }}>Stock item: {stock.matchedName}</div>
                                    )}
                                  </td>
                                  <td style={{ padding: "6px 8px", color: "#475569" }}>
                                    {[med.dosage, med.frequency, med.duration].filter(Boolean).join(" · ") || "-"}
                                    {med.instructions && <div style={{ color: "#94a3b8", fontStyle: "italic" }}>{med.instructions}</div>}
                                  </td>
                                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>{stock.needed}</td>
                                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{stock.status === "not_in_inventory" ? "-" : stock.available}</td>
                                  <td style={{ padding: "6px 8px" }}>
                                    <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "0.72rem", fontWeight: 700, color: badge.color, background: badge.background, whiteSpace: "nowrap" }}>
                                      {stock.status === "low_stock" ? `${badge.label} (${stock.available} of ${stock.needed})` : badge.label}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                            {lines.length === 0 && (
                              <tr><td colSpan={5} style={{ padding: "8px", color: "#94a3b8", textAlign: "center" }}>No medicines on this prescription.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Section 1: Customer Details (External) or Patient Details (Internal) */}
          {saleMode === "external" ? (
            <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
                <div>
                  <h2 style={{ margin: "0 0 0.25rem 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                    1. Customer Details (External Sale)
                  </h2>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                    Enter customer details for medicine sale (No UHID required)
                  </p>
                </div>
                <button
                  type="button"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "0.35rem 0.85rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#00828a",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  onClick={handleClearCustomer}
                >
                  <span>🔄</span> Clear
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "1rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Customer Name <span style={{ color: "#e11d48" }}>*</span>
                  </label>
                  <Input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Enter customer name"
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Age <span style={{ color: "#e11d48" }}>*</span>
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={125}
                    value={customerAge}
                    onChange={(e) => setCustomerAge(e.target.value)}
                    placeholder="Age"
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Date of Birth
                  </label>
                  <Input
                    type="date"
                    value={customerDob}
                    onChange={(e) => handleDobChange(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Primary Mobile Number <span style={{ color: "#e11d48" }}>*</span>
                  </label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <select
                      value={customerCountryCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        setCustomerCountryCode(code);
                        setCustomerPhone((current) => current.slice(0, (COUNTRY_CODE_RULES[code] || COUNTRY_CODE_RULES["+91"]).max));
                      }}
                      title={customerPhoneRule.label}
                      aria-label="Country code"
                      style={{ width: "84px", flexShrink: 0, borderRadius: "8px", border: "1px solid #cbd5e1", background: "#f8fafc", padding: "0 6px", fontSize: "0.85rem", fontWeight: 600, color: "#334155" }}
                    >
                      {COUNTRY_CODES.map((code) => (
                        <option key={code} value={code}>
                          {code} {COUNTRY_CODE_RULES[code].label.replace(/\s*\(\+\d+\)$/, "")}
                        </option>
                      ))}
                    </select>
                    <Input
                      type="tel"
                      inputMode="numeric"
                      maxLength={customerPhoneRule.max}
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(normalizePhoneNumber(e.target.value, customerCountryCode).slice(0, customerPhoneRule.max))}
                      placeholder={`${customerPhoneRule.min === customerPhoneRule.max ? customerPhoneRule.max : `${customerPhoneRule.min}-${customerPhoneRule.max}`}-digit mobile number`}
                      aria-invalid={!!customerPhoneError}
                      style={{ width: "100%", minWidth: 0, ...(customerPhoneError ? { borderColor: "#e11d48" } : {}) }}
                    />
                  </div>
                  {customerPhoneError && (
                    <div style={{ marginTop: "4px", fontSize: "0.75rem", color: "#e11d48", fontWeight: 600 }}>{customerPhoneError}</div>
                  )}
                </div>
              </div>

              {externalCustomerDue > 0 && (
                <div style={{ marginTop: "0.85rem", padding: "0.6rem 0.85rem", borderRadius: "6px", background: "#fff1f2", border: "1px solid #fecdd3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: "0.85rem", color: "#9f1239", fontWeight: 600 }}>
                    ⚠️ Notice: This external customer has an outstanding pharmacy due balance of <strong>₹{externalCustomerDue.toFixed(2)}</strong> from prior bill(s).
                  </div>
                  <button
                    type="button"
                    style={{ padding: "0.3rem 0.75rem", fontSize: "0.8rem", background: "#e11d48", color: "#ffffff", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 700 }}
                    onClick={() => {
                      setDueSearch(customerPhone.trim());
                      setActiveTab("dues");
                    }}
                  >
                    Settle Prior Due →
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                  1. Patient Details (Internal Sale)
                </h2>
                {selectedPatient && (
                  <button
                    type="button"
                    className="ui-button ghost"
                    style={{ color: "#e11d48", fontSize: "0.8rem", padding: 0 }}
                    onClick={() => setSelectedPatient(null)}
                  >
                    Change Patient
                  </button>
                )}
              </div>

              {!selectedPatient ? (
                <div>
                  <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.875rem", color: "#64748b" }}>
                    Search by UHID, Patient Name, or Mobile Number (from paper prescription or consultation record):
                  </p>
                  <PatientSearchPicker
                    onSelect={(patient) => setSelectedPatient(patient)}
                    placeholder="Enter UHID (e.g. HOSP-1001), Name, or Mobile..."
                  />
                </div>
              ) : (
                <>
                  <PatientIdentityBanner patient={selectedPatient} />
                  {patientOutstandingDue > 0 && (
                    <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.85rem", borderRadius: "6px", background: "#fff1f2", border: "1px solid #fecdd3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: "0.85rem", color: "#9f1239", fontWeight: 600 }}>
                        ⚠️ Notice: This patient has an outstanding pharmacy due balance of <strong>₹{patientOutstandingDue.toFixed(2)}</strong> from prior bill(s).
                      </div>
                      <button
                        type="button"
                        style={{ padding: "0.3rem 0.75rem", fontSize: "0.8rem", background: "#e11d48", color: "#ffffff", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 700 }}
                        onClick={() => {
                          setDueSearch(selectedPatient.patient_id);
                          setActiveTab("dues");
                        }}
                      >
                        Settle Prior Due →
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Main Dispensing Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1.2fr", gap: "1.5rem", alignItems: "start" }}>
            {/* Left: Section 2 - Select Medicines & Cart Table */}
            <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                  2. Select Medicines (FEFO Recommended)
                </h2>
                {cart.length > 0 && (
                  <button
                    type="button"
                    className="ui-button ghost"
                    style={{ color: "#e11d48", fontSize: "0.8rem", padding: 0 }}
                    onClick={() => setCart([])}
                  >
                    Clear Cart
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", alignItems: "flex-start" }}>
                <div style={{ flex: 1, position: "relative" }}>
                  <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                    <Input
                      value={searchMedQuery}
                      onChange={(e) => {
                        setSearchMedQuery(e.target.value);
                        setShowMedDropdown(true);
                        if (selectedBatch && e.target.value !== selectedBatch.medicine_name) {
                          setSelectedBatch(null);
                        }
                      }}
                      onFocus={() => {
                        if (searchMedQuery.trim()) setShowMedDropdown(true);
                      }}
                      placeholder="Search by Brand Name, Generic Name, Code, or scan Barcode..."
                      style={{ width: "100%", paddingRight: searchMedQuery ? "2.2rem" : "0.75rem" }}
                    />
                    {searchMedQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchMedQuery("");
                          setSelectedBatch(null);
                          setShowMedDropdown(false);
                          setAddQuantity("");
                        }}
                        style={{
                          position: "absolute",
                          right: "10px",
                          background: "#e2e8f0",
                          border: "none",
                          borderRadius: "50%",
                          width: "20px",
                          height: "20px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#475569",
                          cursor: "pointer",
                          fontSize: "0.75rem",
                          lineHeight: 1,
                        }}
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {showMedDropdown && !selectedBatch && filteredBatches.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        background: "#ffffff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "8px",
                        boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
                        zIndex: 50,
                        maxHeight: "260px",
                        overflowY: "auto",
                        marginTop: "4px",
                      }}
                    >
                      {filteredBatches.slice(0, 10).map((batch, idx) => (
                        <div
                          key={batch.id}
                          style={{
                            padding: "0.6rem 0.85rem",
                            borderBottom: "1px solid #f1f5f9",
                            cursor: "pointer",
                            background: selectedBatch?.id === batch.id ? "#f0fdfa" : "transparent",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                          onClick={() => {
                            setSelectedBatch(batch);
                            setSearchMedQuery(batch.medicine_name);
                            setShowMedDropdown(false);
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "0.875rem" }}>
                              {batch.medicine_name} {idx === 0 && <span style={{ fontSize: "0.7rem", background: "#ccfbf1", color: "#0f766e", padding: "1px 6px", borderRadius: "10px", fontWeight: 700 }}>FEFO Pick</span>}
                            </div>
                            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                              Batch: <strong>{batch.batch_no}</strong> · Exp: {batch.expiry_date || "N/A"} · Source: {batch.stock_source}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontWeight: 700, color: "#00828a", fontSize: "0.9rem" }}>₹{batch.unit_price}</div>
                            <div style={{ fontSize: "0.75rem", color: batch.qty_available <= 10 ? "#e11d48" : "#16a34a", fontWeight: 600 }}>
                              Stock: {batch.qty_available}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ width: "120px" }}>
                  <Input
                    type="number"
                    min={1}
                    max={selectedBatch?.qty_available || 999}
                    value={addQuantity}
                    onChange={(e) => setAddQuantity(e.target.value)}
                    placeholder="Enter qty"
                  />
                </div>

                <Button
                  type="button"
                  className="primary"
                  style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700, whiteSpace: "nowrap" }}
                  disabled={!selectedBatch || !addQuantity || parseInt(String(addQuantity).trim(), 10) <= 0}
                  onClick={handleAddToCart}
                >
                  Add
                </Button>
              </div>

              {selectedBatch && (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "0.6rem 0.85rem", fontSize: "0.825rem", color: "#166534", display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
                  <span>Selected: <strong>{selectedBatch.medicine_name}</strong> (Batch: {selectedBatch.batch_no}, Exp: {selectedBatch.expiry_date})</span>
                  <span>Available: <strong>{selectedBatch.qty_available}</strong> | Rate: <strong>₹{selectedBatch.unit_price}</strong></span>
                </div>
              )}

              {/* Table or Empty State matching screenshot */}
              {cart.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                        <th style={{ padding: "0.5rem" }}>#</th>
                        <th style={{ padding: "0.5rem" }}>Medicine Name</th>
                        <th style={{ padding: "0.5rem" }}>Batch No.</th>
                        <th style={{ padding: "0.5rem" }}>Exp Date</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Unit Price (₹)</th>
                        <th style={{ padding: "0.5rem", width: "70px", textAlign: "center" }}>Qty</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Total (₹)</th>
                        <th style={{ padding: "0.5rem", textAlign: "center" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cart.map((item, idx) => {
                        const basePrice = item.unit_price * item.quantity;
                        const disc = basePrice * (item.discount_percent / 100);
                        const tax = (basePrice - disc) * (item.gst_rate / 100);
                        const lineTotal = basePrice - disc + tax;

                        return (
                          <tr key={item.batch_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "0.5rem", color: "#64748b" }}>{idx + 1}</td>
                            <td style={{ padding: "0.5rem", fontWeight: 600 }}>{item.medicine_name}</td>
                            <td style={{ padding: "0.5rem", color: "#64748b" }}>{item.batch_no}</td>
                            <td style={{ padding: "0.5rem", color: "#64748b" }}>{item.expiry_date || "N/A"}</td>
                            <td style={{ padding: "0.5rem", textAlign: "right", color: "#334155" }}>₹{item.unit_price.toFixed(2)}</td>
                            <td style={{ padding: "0.5rem", textAlign: "center" }}>
                              <input
                                type="number"
                                min={1}
                                max={item.available_qty}
                                value={item.quantity}
                                onChange={(e) => handleUpdateCartQty(idx, parseInt(e.target.value) || 1)}
                                style={{ width: "55px", padding: "2px 4px", borderRadius: "4px", border: "1px solid #cbd5e1", textAlign: "center" }}
                              />
                            </td>
                            <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700, color: "#0f172a" }}>
                              ₹{lineTotal.toFixed(2)}
                            </td>
                            <td style={{ padding: "0.5rem", textAlign: "center" }}>
                              <button
                                type="button"
                                className="ui-button ghost"
                                style={{ color: "#e11d48", padding: "2px 6px", fontSize: "0.8rem", cursor: "pointer" }}
                                onClick={() => handleRemoveFromCart(idx)}
                                title="Remove item"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#64748b" }}>
                  <div style={{ fontSize: "2.75rem", marginBottom: "0.5rem" }}>💊</div>
                  <div style={{ fontWeight: 600, color: "#334155", fontSize: "0.95rem" }}>No medicines added yet.</div>
                  <div style={{ fontSize: "0.825rem", color: "#94a3b8" }}>Search and add medicines to cart.</div>
                </div>
              )}
            </div>

            {/* Right: Section 3 - Billing & Dispense Confirmation */}
            <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.25rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>
                3. Billing & Dispense Confirmation
              </h2>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginBottom: "1.25rem", fontSize: "0.9rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#475569" }}>
                  <span>Subtotal:</span>
                  <span style={{ fontWeight: 600 }}>₹{cartTotals.subtotal.toFixed(2)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a" }}>
                  <span>Discount:</span>
                  <span style={{ fontWeight: 600 }}>- ₹{cartTotals.totalDiscount.toFixed(2)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#475569" }}>
                  <span>GST / Tax:</span>
                  <span style={{ fontWeight: 600 }}>+ ₹{cartTotals.totalTax.toFixed(2)}</span>
                </div>
                <div style={{ height: "1px", background: "#e2e8f0", margin: "4px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "1.3rem", fontWeight: 800, color: "#0f172a" }}>
                  <span>Grand Total:</span>
                  <span style={{ color: "#00828a" }}>₹{cartTotals.grandTotal.toFixed(2)}</span>
                </div>
              </div>

              {/* Payment Option: Full Payment vs Partial / Due */}
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  Payment Option:
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                  <button
                    type="button"
                    style={{
                      padding: "0.5rem",
                      borderRadius: "6px",
                      border: paymentType === "full" ? "2px solid #00828a" : "1px solid #cbd5e1",
                      background: paymentType === "full" ? "#f0fdfa" : "#ffffff",
                      color: paymentType === "full" ? "#00828a" : "#475569",
                      fontWeight: paymentType === "full" ? 700 : 500,
                      fontSize: "0.82rem",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                    }}
                    onClick={() => {
                      setPaymentType("full");
                      setPaidAmountInput(cartTotals.grandTotal > 0 ? cartTotals.grandTotal.toFixed(2) : "");
                    }}
                  >
                    <span>●</span> Full Payment
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: "0.5rem",
                      borderRadius: "6px",
                      border: paymentType === "partial" ? "2px solid #e11d48" : "1px solid #cbd5e1",
                      background: paymentType === "partial" ? "#fff1f2" : "#ffffff",
                      color: paymentType === "partial" ? "#e11d48" : "#475569",
                      fontWeight: paymentType === "partial" ? 700 : 500,
                      fontSize: "0.82rem",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                    }}
                    onClick={() => {
                      setPaymentType("partial");
                      if (!paidAmountInput || parseFloat(paidAmountInput) >= cartTotals.grandTotal) {
                        setPaidAmountInput(cartTotals.grandTotal > 0 ? (cartTotals.grandTotal / 2).toFixed(2) : "");
                      }
                    }}
                  >
                    <span>◐</span> Partial / Due
                  </button>
                </div>
              </div>

              {/* Partial Payment Input Field & Live Due Balance */}
              {paymentType === "partial" && (
                <div style={{ background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: "8px", padding: "0.85rem", marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Amount Paying Now (₹):
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={cartTotals.grandTotal}
                    value={paidAmountInput}
                    onChange={(e) => setPaidAmountInput(e.target.value)}
                    placeholder="0.00"
                    style={{ fontWeight: 700, fontSize: "1.05rem", color: "#0f172a" }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.6rem", fontSize: "0.85rem" }}>
                    <span style={{ color: "#64748b" }}>Remaining Due Balance:</span>
                    <span style={{ fontWeight: 800, color: computedDue > 0 ? "#e11d48" : "#16a34a", fontSize: "1rem" }}>
                      ₹{computedDue.toFixed(2)}
                    </span>
                  </div>
                  {computedDue > 0 && (
                    <div style={{ marginTop: "4px", fontSize: "0.75rem", color: "#be123c", fontWeight: 500 }}>
                      ⚠️ Remaining ₹{computedDue.toFixed(2)} will be recorded as pending due and can be settled later via Pending Dues tab.
                    </div>
                  )}
                </div>
              )}

              {/* Payment Mode */}
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  Payment Method:
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
                  {["cash", "upi", "card"].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      style={{
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: paymentMode === mode ? "2px solid #00828a" : "1px solid #cbd5e1",
                        background: paymentMode === mode ? "#f0fdfa" : "#ffffff",
                        color: paymentMode === mode ? "#00828a" : "#334155",
                        fontWeight: paymentMode === mode ? 700 : 500,
                        textTransform: "uppercase",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                      onClick={() => setPaymentMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Remarks (Optional) */}
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  Remarks (Optional):
                </label>
                <textarea
                  className="ui-input"
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Enter any remarks..."
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #cbd5e1", resize: "vertical", fontSize: "0.85rem", fontFamily: "inherit" }}
                />
              </div>

              {/* Stock Source Classification */}
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  Stock Source / Payer Classification:
                </label>
                <div style={{ display: "flex", gap: "0.75rem" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="dispenseStockSource"
                      checked={dispenseStockSource === "CASH"}
                      onChange={() => setDispenseStockSource("CASH")}
                    />
                    Cash / General Stock
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="dispenseStockSource"
                      checked={dispenseStockSource === "INSURANCE"}
                      onChange={() => setDispenseStockSource("INSURANCE")}
                    />
                    Insurance / Scheme Stock
                  </label>
                </div>
              </div>

              {/* Action Button */}
              <Button
                type="button"
                className="primary"
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  fontSize: "1rem",
                  fontWeight: 700,
                  background: "#00828a",
                  borderColor: "#00828a",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
                disabled={
                  submitting ||
                  cart.length === 0 ||
                  (saleMode === "internal"
                    ? !selectedPatient
                    : !customerName.trim() || !customerAge.trim() || !customerPhone.trim())
                }
                onClick={handleExecuteDispense}
              >
                <span>🖨️</span>
                {submitting ? "Processing Transaction..." : "Confirm & Dispense"}
              </Button>

              <p style={{ margin: "0.75rem 0 0 0", fontSize: "0.75rem", color: "#64748b", textAlign: "center" }}>
                Atomically deducts stock, records stock ledger, generates tax invoice, and updates records.
              </p>
            </div>
          </div>
        </>
      ) : activeTab === "dues" ? (
        /* Pending Dues & Repayments Tab */
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem", flexWrap: "wrap", gap: "1rem" }}>
            <div>
              <h2 style={{ margin: "0 0 0.25rem 0", fontSize: "1.25rem", fontWeight: 700, color: "#0f172a" }}>
                Pharmacy Pending Dues & Repayments
              </h2>
              <p style={{ color: "#64748b", fontSize: "0.875rem", margin: 0 }}>
                Track partially paid & unpaid pharmacy bills, accept due repayments, and update invoice records instantly.
              </p>
            </div>

            <div style={{ display: "flex", gap: "1rem" }}>
              <div style={{ background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: "8px", padding: "0.5rem 1rem", textAlign: "right" }}>
                <div style={{ fontSize: "0.75rem", color: "#9f1239", fontWeight: 600 }}>Total Outstanding Due</div>
                <div style={{ fontSize: "1.2rem", fontWeight: 800, color: "#e11d48" }}>
                  ₹{totalDueSum.toFixed(2)}
                </div>
              </div>
              <div style={{ background: "#f0fdfa", border: "1px solid #ccfbf1", borderRadius: "8px", padding: "0.5rem 1rem", textAlign: "right" }}>
                <div style={{ fontSize: "0.75rem", color: "#0f766e", fontWeight: 600 }}>Invoices with Dues</div>
                <div style={{ fontSize: "1.2rem", fontWeight: 800, color: "#00828a" }}>
                  {dueInvoices.length}
                </div>
              </div>
            </div>
          </div>

          {/* Search & Filter Bar */}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", marginBottom: "1.25rem" }}>
            <Input
              value={dueSearch}
              onChange={(e) => setDueSearch(e.target.value)}
              placeholder="Search by UHID, Patient Name, or Invoice #..."
              style={{ width: "320px" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadDues();
              }}
            />
            <select
              className="ui-input"
              value={dueStatusFilter}
              onChange={(e) => setDueStatusFilter(e.target.value)}
              style={{ padding: "0.45rem 0.75rem", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "0.85rem" }}
            >
              <option value="pending_due">All Pending Dues (Partial & Unpaid)</option>
              <option value="partial">Partially Paid Only</option>
              <option value="due">Unpaid Due Only</option>
              <option value="paid">Fully Settled (Paid)</option>
            </select>
            <Button type="button" variant="secondary" onClick={() => void loadDues()} disabled={loadingDues}>
              {loadingDues ? "Searching..." : "Search"}
            </Button>
            {dueSearch && (
              <Button type="button" variant="secondary" onClick={() => { setDueSearch(""); void loadDues(""); }}>
                Clear Filter
              </Button>
            )}
          </div>

          {/* Dues Table */}
          <div style={{ overflowX: "auto" }}>
            <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Invoice #</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Date</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Patient UHID & Name</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Total Bill</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Paid So Far</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Outstanding Due</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>Status</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loadingDues && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                      Loading dues records...
                    </td>
                  </tr>
                )}
                {!loadingDues && dueInvoices.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
                      No invoices found matching the current filter. All dues settled!
                    </td>
                  </tr>
                )}
                {!loadingDues && dueInvoices.map((inv) => {
                  const patientFullName = [inv.name, inv.last_name].filter(Boolean).join(" ") || "-";
                  const isExtInv = !inv.patient_id || inv.patient_id.startsWith("EXT-") || inv.patient_id.startsWith("WALK-");
                  const total = parseFloat(inv.total_amount) || 0;
                  const paid = parseFloat(inv.paid_amount) || 0;
                  const due = parseFloat(inv.due_amount) || 0;
                  const status = (inv.payment_status || "due").toLowerCase();
                  return (
                    <tr key={inv.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.6rem 0.5rem", fontWeight: 700, color: "#00828a" }}>
                        {inv.invoice_no}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", color: "#64748b", fontSize: "0.8rem" }}>
                        {inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-"}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem" }}>
                        <div style={{ fontWeight: 600, color: "#0f172a", display: "flex", alignItems: "center", gap: "6px" }}>
                          {patientFullName}
                          {isExtInv && (
                            <span style={{ fontSize: "0.68rem", background: "#f0fdfa", color: "#0f766e", border: "1px solid #ccfbf1", padding: "1px 6px", borderRadius: "10px", fontWeight: 700 }}>
                              External Sale
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                          {isExtInv ? (inv.phone ? `Mobile: ${inv.phone}` : "Walk-in (No UHID)") : `UHID: ${inv.patient_id}`} {(!isExtInv && inv.phone) ? `• ${inv.phone}` : ""}
                        </div>
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: 600 }}>
                        ₹{total.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", color: "#16a34a", fontWeight: 600 }}>
                        ₹{paid.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: 800, color: due > 0 ? "#e11d48" : "#16a34a" }}>
                        ₹{due.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: "12px",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          background: status === "paid" ? "#dcfce7" : status === "partial" ? "#fef3c7" : "#fee2e2",
                          color: status === "paid" ? "#166534" : status === "partial" ? "#92400e" : "#991b1b",
                        }}>
                          {status}
                        </span>
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>
                        {due > 0 ? (
                          <Button
                            type="button"
                            className="primary"
                            style={{
                              padding: "0.35rem 0.75rem",
                              fontSize: "0.8rem",
                              fontWeight: 700,
                              background: "#00828a",
                              borderColor: "#00828a",
                            }}
                            onClick={() => handleOpenRepayModal(inv)}
                          >
                            Repay Due
                          </Button>
                        ) : (
                          <span style={{ fontSize: "0.8rem", color: "#16a34a", fontWeight: 600 }}>
                            Settled ✓
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeTab === "returns" ? (
        /* OP Returns Tab */
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
            OP Medicine Returns & Refunds
          </h2>
          <p style={{ color: "#64748b", fontSize: "0.875rem", margin: "0 0 1.25rem 0" }}>
            Find a completed OP sale by Invoice Number or Patient UHID to process return, refund, and traceable stock adjustment:
          </p>

          <div style={{ display: "flex", gap: "0.75rem", maxWidth: "500px", marginBottom: "1.5rem" }}>
            <Input
              value={searchInvoiceNo}
              onChange={(e) => setSearchInvoiceNo(e.target.value)}
              placeholder="Enter Invoice Number or Patient UHID..."
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleLookupInvoice();
              }}
            />
            <Button type="button" variant="secondary" onClick={() => void handleLookupInvoice()} disabled={invoiceLookupLoading}>
              {invoiceLookupLoading ? "Searching..." : "Find Invoice"}
            </Button>
          </div>

          {foundSales.length > 0 && (
            <div>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#0f172a", marginBottom: "0.75rem" }}>
                Matching Sold Items
              </h3>
              <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                    <th style={{ padding: "0.5rem" }}>Medicine</th>
                    <th style={{ padding: "0.5rem" }}>Patient UHID</th>
                    <th style={{ padding: "0.5rem" }}>Sold Qty</th>
                    <th style={{ padding: "0.5rem" }}>Returned</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Price</th>
                    <th style={{ padding: "0.5rem" }}>Date</th>
                    <th style={{ padding: "0.5rem", textAlign: "center" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {foundSales.map((sale) => {
                    const returned = Number(sale.returned_qty || 0);
                    const remaining = Math.max(0, sale.quantity - returned);
                    return (
                      <tr key={sale.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "0.5rem", fontWeight: 600 }}>{sale.medicine_name}</td>
                        <td style={{ padding: "0.5rem", color: "#64748b" }}>{sale.patient_id}</td>
                        <td style={{ padding: "0.5rem", fontWeight: 700 }}>{sale.quantity}</td>
                        <td style={{ padding: "0.5rem", color: returned > 0 ? "#c2410c" : "#94a3b8" }}>{returned}</td>
                        <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{sale.unit_price}</td>
                        <td style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem" }}>
                          {sale.sold_at ? new Date(sale.sold_at).toLocaleString() : "-"}
                        </td>
                        <td style={{ padding: "0.5rem", textAlign: "center" }}>
                          {remaining > 0 ? (
                            <Button
                              type="button"
                              variant="secondary"
                              style={{ padding: "2px 10px", fontSize: "0.78rem" }}
                              onClick={() => {
                                setReturnItem({ ...sale, remaining_qty: remaining });
                                setReturnQty("1");
                              }}
                            >
                              Select for Return
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
            </div>
          )}

          {returnItem && (
            <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "1.25rem", maxWidth: "600px" }}>
              <h4 style={{ margin: "0 0 0.75rem 0", color: "#0f172a" }}>
                Process Return: <strong>{returnItem.medicine_name}</strong>
              </h4>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1rem", marginBottom: "1rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Return Qty (Max {returnItem.remaining_qty ?? returnItem.quantity}):
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={returnItem.remaining_qty ?? returnItem.quantity}
                    value={returnQty}
                    onChange={(e) => setReturnQty(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Reason for Return:
                  </label>
                  <select
                    className="ui-input"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">Select reason...</option>
                    <option value="Wrong medicine dispensed">Wrong medicine dispensed</option>
                    <option value="Excess prescribed quantity">Excess prescribed quantity</option>
                    <option value="Doctor stopped medication">Doctor stopped medication</option>
                    <option value="Adverse reaction">Adverse reaction</option>
                    <option value="Billing correction">Billing correction</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                <Button type="button" variant="secondary" onClick={() => setReturnItem(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="primary"
                  style={{ background: "#00828a", borderColor: "#00828a" }}
                  disabled={returnSubmitting}
                  onClick={handleProcessReturn}
                >
                  {returnSubmitting ? "Submitting..." : "Confirm Return & Refund"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* OP Dispense History Tab */
        <div style={{ background: "#ffffff", borderRadius: "10px", padding: "1.5rem", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
            OP Dispense History
          </h2>
          <p style={{ color: "#64748b", fontSize: "0.875rem", margin: "0 0 1.25rem 0" }}>
            Every OP counter dispense for a given day, with patient, medicine, quantity and amount.
          </p>

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", marginBottom: "1.5rem" }}>
            <Input type="date" value={historyDate} onChange={(e) => setHistoryDate(e.target.value)} style={{ width: "160px" }} />
            <Input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Filter by patient UHID or medicine..."
              style={{ width: "260px" }}
            />
            <Button type="button" variant="secondary" onClick={() => void loadDispenseHistory()} disabled={loadingHistory}>
              {loadingHistory ? "Loading..." : "Search"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleExportHistoryCsv} disabled={dispenseHistory.length === 0}>
              Export CSV
            </Button>
          </div>

          <table className="pharmacy-data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "0.5rem" }}>Time</th>
                <th style={{ padding: "0.5rem" }}>Customer / Patient</th>
                <th style={{ padding: "0.5rem" }}>Medicine</th>
                <th style={{ padding: "0.5rem", textAlign: "center" }}>Qty</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Unit Price</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Amount</th>
                <th style={{ padding: "0.5rem" }}>Invoice & Status</th>
              </tr>
            </thead>
            <tbody>
              {loadingHistory && (
                <tr><td colSpan={7} style={{ textAlign: "center", padding: "1.5rem", color: "#94a3b8" }}>Loading…</td></tr>
              )}
              {!loadingHistory && dispenseHistory.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", padding: "1.5rem", color: "#94a3b8" }}>No OP dispenses found for this filter.</td></tr>
              )}
              {!loadingHistory && dispenseHistory.map((sale) => {
                const isExt = (sale.patient_id && sale.patient_id.startsWith("EXT-")) || (!sale.patient_id && sale.customer_name);
                const isDue = (sale.due_amount && Number(sale.due_amount) > 0) || sale.payment_status === "due" || sale.payment_status === "partial";
                return (
                  <tr key={sale.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.5rem", color: "#64748b", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                      {sale.sold_at ? new Date(sale.sold_at).toLocaleTimeString() : "-"}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <span style={{ fontWeight: 600, color: "#0f172a" }}>
                          {sale.customer_name || (isExt ? "External Customer" : sale.patient_id)}
                        </span>
                        {isExt ? (
                          <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontWeight: 700 }}>
                            EXTERNAL
                          </span>
                        ) : (
                          <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "4px", background: "#e0f2fe", color: "#0369a1", fontWeight: 600 }}>
                            UHID
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {isExt
                          ? (sale.customer_mobile ? `📱 ${sale.customer_mobile}` : "No UHID")
                          : (sale.patient_id ? `UHID: ${sale.patient_id}` : "")}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", fontWeight: 600 }}>{sale.medicine_name}</td>
                    <td style={{ padding: "0.5rem", textAlign: "center" }}>{sale.quantity}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>₹{sale.unit_price}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: 700 }}>₹{sale.amount}</td>
                    <td style={{ padding: "0.5rem" }}>
                      <div style={{ fontSize: "0.75rem", color: "#475569", fontWeight: 600 }}>
                        {sale.invoice_no || (sale.invoice_id ? `INV-${sale.invoice_id}` : "-")}
                      </div>
                      {isDue ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginTop: "2px" }}>
                          <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "4px", background: "#fee2e2", color: "#dc2626", fontWeight: 700 }}>
                            DUE: ₹{sale.due_amount || sale.amount}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveTab("dues");
                              if (sale.invoice_no) setDueSearch(sale.invoice_no);
                              else if (sale.customer_mobile) setDueSearch(sale.customer_mobile);
                            }}
                            style={{ background: "none", border: "none", color: "#00828a", fontSize: "0.7rem", fontWeight: 600, cursor: "pointer", textDecoration: "underline", padding: 0 }}
                          >
                            Collect
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "4px", background: "#dcfce7", color: "#16a34a", fontWeight: 700, display: "inline-block", marginTop: "2px" }}>
                          PAID
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoice & Label Print Confirmation Modal */}
      {printModalOpen && dispenseResult && (
        <Modal open={printModalOpen} onClose={() => setPrintModalOpen(false)}>
          <div style={{ padding: "1.5rem", textAlign: "center" }}>
            <div style={{ width: "50px", height: "50px", borderRadius: "50%", background: "#dcfce7", color: "#16a34a", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "1.75rem", marginBottom: "1rem" }}>
              ✓
            </div>
            <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.3rem", fontWeight: 800, color: "#0f172a" }}>
              Dispense Complete!
            </h2>
            <p style={{ color: "#64748b", margin: "0 0 1.5rem 0", fontSize: "0.95rem" }}>
              Invoice <strong>{dispenseResult.invoice_no || `INV-${dispenseResult.invoice_id}`}</strong> has been generated and stock has been updated.
            </p>

            <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "0.75rem 1rem", marginBottom: "1.5rem", border: "1px solid #e2e8f0", textAlign: "left", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ color: "#64748b" }}>Total Bill:</span>
                <span style={{ fontWeight: 700 }}>₹{(dispenseResult.total_amount ?? 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ color: "#64748b" }}>Amount Received:</span>
                <span style={{ fontWeight: 700, color: "#16a34a" }}>₹{(dispenseResult.paid_amount ?? 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "4px", borderTop: "1px solid #e2e8f0" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>Due Balance:</span>
                <span style={{ fontWeight: 800, color: (dispenseResult.due_amount ?? 0) > 0 ? "#e11d48" : "#16a34a" }}>
                  ₹{(dispenseResult.due_amount ?? 0).toFixed(2)}
                </span>
              </div>
              {(dispenseResult.due_amount ?? 0) > 0 && (
                <div style={{ marginTop: "6px", fontSize: "0.75rem", color: "#b91c1c" }}>
                  ℹ️ Pending due recorded. Settle anytime via the <strong>Pending Dues & Repayments</strong> tab.
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a" }}
                onClick={handlePrintInvoice}
              >
                Print Invoice
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handlePrintLabels}
              >
                Print Labels
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPrintModalOpen(false)}
              >
                Done
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Due Repayment Modal */}
      {repayModalOpen && selectedDueInvoice && (
        <Modal open={repayModalOpen} onClose={closeRepayModal}>
          <div style={{ padding: "1.5rem", maxWidth: "480px" }}>
            {repayReceipt ? (
              <>
                <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
                  <div style={{ width: "52px", height: "52px", margin: "0 auto 0.75rem", borderRadius: "50%", background: "#dcfce7", color: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <h3 style={{ margin: "0 0 0.35rem 0", fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
                    {repayReceipt.remaining <= 0 ? "Due Fully Settled" : "Partial Payment Recorded"}
                  </h3>
                  <p style={{ color: "#64748b", fontSize: "0.85rem", margin: 0 }}>
                    ₹{repayReceipt.amount.toFixed(2)} received via {repayReceipt.mode.toUpperCase()} for Invoice <strong>{repayReceipt.invoice.invoice_no}</strong>.
                  </p>
                </div>

                <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "0.85rem", border: "1px solid #e2e8f0", marginBottom: "1.25rem", fontSize: "0.875rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ color: "#64748b" }}>Customer / Patient:</span>
                    <span style={{ fontWeight: 600, color: "#0f172a" }}>{dueCustomerName(repayReceipt.invoice)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ color: "#64748b" }}>This Payment:</span>
                    <span style={{ fontWeight: 600, color: "#16a34a" }}>₹{repayReceipt.amount.toFixed(2)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "4px", borderTop: "1px solid #e2e8f0" }}>
                    <span style={{ fontWeight: 700, color: repayReceipt.remaining > 0 ? "#e11d48" : "#16a34a" }}>Remaining Due:</span>
                    <span style={{ fontWeight: 800, fontSize: "1.05rem", color: repayReceipt.remaining > 0 ? "#e11d48" : "#16a34a" }}>
                      ₹{repayReceipt.remaining.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                  <Button type="button" variant="secondary" onClick={closeRepayModal}>
                    Close
                  </Button>
                  <Button
                    type="button"
                    className="primary"
                    style={{ background: "#00828a", borderColor: "#00828a" }}
                    onClick={handlePrintRepaymentReceipt}
                  >
                    🖨️ Print Receipt
                  </Button>
                </div>
              </>
            ) : (
            <>
            <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
              Repay Pharmacy Due Balance
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.85rem", margin: "0 0 1.25rem 0" }}>
              Collect full or partial payment against Invoice <strong>{selectedDueInvoice.invoice_no}</strong>.
            </p>

            <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "0.85rem", border: "1px solid #e2e8f0", marginBottom: "1.25rem", fontSize: "0.875rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ color: "#64748b" }}>Customer / Patient:</span>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>
                  {[selectedDueInvoice.name, selectedDueInvoice.last_name].filter(Boolean).join(" ") || selectedDueInvoice.referral_source || "Customer"} {(!selectedDueInvoice.patient_id || selectedDueInvoice.patient_id.startsWith("EXT-") || selectedDueInvoice.patient_id.startsWith("WALK-")) ? `(External • ${selectedDueInvoice.phone || selectedDueInvoice.patient_id || "Walk-in"})` : `(${selectedDueInvoice.patient_id})`}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ color: "#64748b" }}>Total Bill Amount:</span>
                <span style={{ fontWeight: 600 }}>₹{parseFloat(selectedDueInvoice.total_amount || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ color: "#64748b" }}>Paid So Far:</span>
                <span style={{ fontWeight: 600, color: "#16a34a" }}>₹{parseFloat(selectedDueInvoice.paid_amount || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "4px", borderTop: "1px solid #e2e8f0" }}>
                <span style={{ color: "#e11d48", fontWeight: 700 }}>Current Due Balance:</span>
                <span style={{ fontWeight: 800, color: "#e11d48", fontSize: "1.05rem" }}>
                  ₹{parseFloat(selectedDueInvoice.due_amount || 0).toFixed(2)}
                </span>
              </div>
            </div>

            {/* Repay Amount */}
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                Repayment Amount (₹):
              </label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                max={parseFloat(selectedDueInvoice.due_amount || 0)}
                value={repayAmount}
                onChange={(e) => setRepayAmount(e.target.value)}
                placeholder="Enter amount..."
                style={{ fontWeight: 700, fontSize: "1.1rem" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "0.78rem" }}>
                <span style={{ color: "#64748b" }}>
                  Balance remaining after this payment:
                </span>
                <span style={{ fontWeight: 700, color: remainingAfterRepay > 0 ? "#e11d48" : "#16a34a" }}>
                  ₹{remainingAfterRepay.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Repay Payment Method */}
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                Repayment Method:
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
                {["cash", "upi", "card"].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    style={{
                      padding: "0.5rem",
                      borderRadius: "6px",
                      border: repayMode === mode ? "2px solid #00828a" : "1px solid #cbd5e1",
                      background: repayMode === mode ? "#f0fdfa" : "#ffffff",
                      color: repayMode === mode ? "#00828a" : "#334155",
                      fontWeight: repayMode === mode ? 700 : 500,
                      textTransform: "uppercase",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                    onClick={() => setRepayMode(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {/* Reference */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Payment Ref / Notes (Optional):
              </label>
              <Input
                value={repayRef}
                onChange={(e) => setRepayRef(e.target.value)}
                placeholder="Transaction ID, UPI Ref, or remarks..."
              />
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={closeRepayModal}>
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#00828a", borderColor: "#00828a" }}
                disabled={repaySubmitting}
                onClick={handleConfirmRepayment}
              >
                {repaySubmitting ? "Recording..." : "Confirm & Settle Due"}
              </Button>
            </div>
            </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
