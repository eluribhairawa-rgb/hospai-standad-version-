import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { generatePDFBlob, exportPDF, patientFilename } from "../lib/exportService";
import type { Notice, User } from "../types";
import { fullPatientName, lookupPatientByUhid, normalizeUhidLookup } from "../lib/patientLookup";
import { PRINT_BRAND_HEADER_DATA_URI, PRINT_WATERMARK_DATA_URI } from "../lib/printBrand";
import { printViaIframe } from "../lib/printViaIframe";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  user?: User | null;
};

type ServiceItem = {
  code: string;
  name: string;
  category: string;
  rate: number | "";
  quantity: number | "";
};

type DiagnosticRecord = {
  id: number;
  invoice_no?: string;
  patient_id?: string;
  patient_name?: string;
  age?: number;
  gender?: string;
  visit_id?: string;
  doctor_name?: string;
  department?: string;
  visit_type?: string;
  test_name: string;
  amount: number;
  paid_amount?: number;
  due_amount?: number;
  status?: string;
  sample_barcode?: string;
  order_status?: string;
  bill_date?: string;
  due_date?: string;
  payment_mode?: string;
  transaction_id?: string;
  discount_percentage?: number;
  discount_amount?: number;
  tax_percentage?: number;
  tax_amount?: number;
  report_delivery_mode?: string;
  report_delivery_date?: string;
  remarks?: string;
  created_at?: string;
  quantity?: number;
  unit_rate?: number;
};

// Categories are loaded dynamically from the backend
const PAYMENT_MODES = ["UPI", "Cash", "Card"];
const DELIVERY_MODES = ["Email", "Physical", "Both"];

function formatAmount(amount: number) {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
}

function getCurrentDate() {
  return new Date().toISOString().split("T")[0];
}

function compactDate() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function buildInvoiceNo(type: "lab" | "diagnostic", index: number) {
  const prefix = type === "lab" ? "LAB" : "DIA";
  return `${prefix}-${compactDate()}-${String(Date.now()).slice(-5)}-${index + 1}`;
}

const safeText = (value: unknown) => String(value ?? "-")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const printField = (label: string, value: unknown) => `
  <div class="lab-print-field">
    <span>${safeText(label)}</span>
    <strong>${safeText(value === "" || value === null || value === undefined ? "-" : value)}</strong>
  </div>
`;

export default function LabPage({ setNotice, user }: Props) {
  const [activeTab, setActiveTab] = useState<"lab" | "diagnostic" | null>("lab");
  const [labItems, setLabItems] = useState<ServiceItem[]>([]);
  const [diagnosticItems, setDiagnosticItems] = useState<ServiceItem[]>([]);
  const [records, setRecords] = useState<DiagnosticRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [savingBill, setSavingBill] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<DiagnosticRecord | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<number[]>([]);

  const [billingTab, setBillingTab] = useState<"all" | "due" | "partial" | "paid">("all");
  const [collectPaymentModalOpen, setCollectPaymentModalOpen] = useState(false);
  const [collectPaymentRecord, setCollectPaymentRecord] = useState<DiagnosticRecord | null>(null);
  const [collectAmount, setCollectAmount] = useState("");
  const [collectPaymentMode, setCollectPaymentMode] = useState("");
  const [collectTxRef, setCollectTxRef] = useState("");
  const [collectNotes, setCollectNotes] = useState("");
  const [collectLoading, setCollectLoading] = useState(false);
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [collectReceiptRecord, setCollectReceiptRecord] = useState<any | null>(null);

  const handleOpenCollectPayment = (record: DiagnosticRecord) => {
    setCollectPaymentRecord(record);
    const remainingDue = Number(record.due_amount || 0);
    setCollectAmount(String(remainingDue));
    setCollectPaymentMode("");
    setCollectTxRef("");
    setCollectNotes("");
    setCollectPaymentModalOpen(true);
  };

  const handleCollectPaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!collectPaymentRecord) return;
    
    const amt = Number(collectAmount);
    const dueLimit = Number(collectPaymentRecord.due_amount || 0);
    
    if (isNaN(amt) || amt <= 0) {
      setNotice({ type: "error", message: "Payment amount must be greater than zero." });
      return;
    }
    if (amt > dueLimit) {
      setNotice({ type: "error", message: `Payment amount cannot exceed remaining due amount (₹${dueLimit}).` });
      return;
    }
    if (!collectPaymentMode) {
      setNotice({ type: "error", message: "Payment mode is mandatory." });
      return;
    }
    
    setCollectLoading(true);
    try {
      const data = await apiFetch<{ status: string; record: any }>(
        `/api/lab/diagnostics/${collectPaymentRecord.id}/payments`,
        {
          method: "POST",
          body: JSON.stringify({
            amount: amt,
            payment_mode: collectPaymentMode,
            transaction_ref: collectTxRef,
            notes: collectNotes
          })
        }
      );
      
      if (data.status === "ok") {
        setNotice({ type: "success", message: "Payment recorded successfully." });
        setCollectPaymentModalOpen(false);
        
        // Refresh diagnostics list in place
        void loadDiagnostics();
        
        // Build receipt object
        const recordNetAmount = Number(collectPaymentRecord.amount || 0) 
          - Number(collectPaymentRecord.discount_amount || 0)
          + Number(collectPaymentRecord.tax_amount || 0);
          
        const newlyCollected = amt;
        const prevPaid = Number(collectPaymentRecord.paid_amount || 0);
        const remainingDue = Math.max(recordNetAmount - (prevPaid + newlyCollected), 0);
        
        const receipt = {
          invoice_no: collectPaymentRecord.invoice_no || `DIAG-${collectPaymentRecord.id}`,
          patient_id: collectPaymentRecord.patient_id || "-",
          patient_name: collectPaymentRecord.patient_name || "-",
          age: collectPaymentRecord.age || "-",
          gender: collectPaymentRecord.gender || "-",
          doctor_name: collectPaymentRecord.doctor_name || "-",
          department: collectPaymentRecord.department || "-",
          test_name: collectPaymentRecord.test_name,
          amount: collectPaymentRecord.amount,
          payable_amount: recordNetAmount,
          prev_paid: prevPaid,
          newly_collected: newlyCollected,
          remaining_due: remainingDue,
          payment_mode: collectPaymentMode,
          payment_id: data.record.id || collectPaymentRecord.id,
          payment_date: new Date().toLocaleDateString("en-CA"),
          operator_name: data.record.operator_name || "System"
        };
        
        setCollectReceiptRecord(receipt);
        setReceiptModalOpen(true);
      }
    } catch (err: any) {
      reportError(setNotice, err, "Unable to record payment.");
    } finally {
      setCollectLoading(false);
    }
  };

  const printReceiptHTML = (receipt: any) => {
    const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Receipt - ${safeText(receipt.invoice_no)}</title>
          <style>
            @page { size: A5 landscape; margin: 5mm; }
            body { font-family: Arial, sans-serif; font-size: 9pt; line-height: 1.3; color: #333; margin: 0; }
            .receipt-box { width: 100%; border: 1px solid #ccc; padding: 5mm; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.05); }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #3b82f6; padding-bottom: 2mm; margin-bottom: 4mm; }
            .header h1 { font-size: 14pt; margin: 0; color: #1d4ed8; font-weight: bold; }
            .meta { font-size: 8pt; text-align: right; }
            .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2mm 6mm; margin-bottom: 4mm; }
            .grid div { display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 0.5mm; }
            .grid div span { color: #64748b; font-weight: 600; }
            .grid div strong { color: #0f172a; font-weight: 700; }
            .table-wrap { margin-top: 4mm; border-top: 1px solid #e2e8f0; padding-top: 2mm; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 4mm; }
            th, td { padding: 2mm; text-align: left; border-bottom: 1px solid #f1f5f9; }
            th { background: #f8fafc; font-weight: 700; color: #1e3a8a; }
            .totals { display: flex; flex-direction: column; align-items: flex-end; gap: 1mm; font-size: 10pt; }
            .totals div { display: flex; justify-content: space-between; width: 60mm; padding: 1mm 0; border-bottom: 1px solid #f1f5f9; }
            .totals div.grand { border-bottom: 2px solid #000; font-weight: bold; font-size: 11pt; color: #1e3a8a; }
            .footer { margin-top: 6mm; text-align: center; font-size: 8pt; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 2mm; }
          </style>
        </head>
        <body>
          <div class="receipt-box">
            <div class="header">
              <div>
                <h1>PAYMENT RECEIPT</h1>
                <div style="font-size: 8pt; color:#64748b;">HospAI</div>
              </div>
              <div class="meta">
                <div>Receipt: <strong>REC-${receipt.payment_id}</strong></div>
                <div>Date: <strong>${safeText(receipt.payment_date)}</strong></div>
                <div>Time: <strong>${safeText(printedAt)}</strong></div>
              </div>
            </div>
            
            <div class="grid">
              <div><span>Invoice No.</span><strong>${safeText(receipt.invoice_no)}</strong></div>
              <div><span>Patient ID / UHID</span><strong>${safeText(receipt.patient_id)}</strong></div>
              <div><span>Patient Name</span><strong>${safeText(receipt.patient_name)}</strong></div>
              <div><span>Doctor</span><strong>${safeText(receipt.doctor_name || "-")}</strong></div>
              <div><span>Department</span><strong>${safeText(receipt.department || "-")}</strong></div>
              <div><span>Payment Mode</span><strong>${safeText(receipt.payment_mode.toUpperCase())}</strong></div>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Test / Diagnostic Service</th>
                    <th style="text-align: right;">Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>${safeText(receipt.test_name)}</td>
                    <td style="text-align: right;">₹${safeText(formatAmount(receipt.amount))}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="totals">
              <div><span>Total Amount</span><strong>₹${safeText(formatAmount(receipt.payable_amount))}</strong></div>
              <div><span>Previously Paid</span><strong>₹${safeText(formatAmount(receipt.prev_paid))}</strong></div>
              <div style="background: #ecfdf5; padding: 1mm 2mm; border-radius: 4px;">
                <span style="color:#047857; font-weight:bold;">Amount Collected</span>
                <strong style="color:#047857; font-weight:bold;">₹${safeText(formatAmount(receipt.newly_collected))}</strong>
              </div>
              <div class="grand"><span>Remaining Due</span><strong>₹${safeText(formatAmount(receipt.remaining_due))}</strong></div>
            </div>

            <div class="footer">
              <div>Processed by operator: <strong>${safeText(receipt.operator_name)}</strong></div>
            </div>
          </div>
        </body>
      </html>`;
    printViaIframe(html);
  };

  const downloadReceiptPDF = async (receipt: any) => {
    try {
      const { blob, filename } = await generatePDFBlob({
        title: "Lab & Diagnostics Payment Receipt",
        subtitle: "Payment Acknowledgment",
        filename: patientFilename(receipt.patient_name, receipt.patient_id, receipt.invoice_no),
        operator_name: receipt.operator_name,
        invoice_meta: {
          invoice_number: receipt.invoice_no,
          invoice_date: receipt.payment_date,
        },
        patient_info: {
          patient_name: receipt.patient_name,
          patient_id: receipt.patient_id,
          age: receipt.age,
          gender: receipt.gender,
        },
        totals: {
          subtotal: formatAmount(receipt.amount),
          grand_total: formatAmount(receipt.payable_amount),
          amount_received: formatAmount(receipt.newly_collected),
          balance: formatAmount(receipt.remaining_due),
        },
        payment_details: {
          receipt_number: `REC-${receipt.payment_id}`,
          payment_date: receipt.payment_date,
          payment_mode: receipt.payment_mode,
          amount_paid: formatAmount(receipt.newly_collected),
        },
        sections: [
          {
            title: "Test Details",
            headers: ["Test Name", "Department", "Amount (₹)"],
            rows: [
              [receipt.test_name, receipt.department || "-", formatAmount(receipt.amount)]
            ]
          }
        ]
      }, { dated: false });
      await exportPDF(blob, filename, "Lab & Diagnostics Payment Receipt", "Payment Acknowledgment", setNotice);
    } catch (err: any) {
      reportError(setNotice, err, "Unable to download PDF receipt.");
    }
  };

  const filteredRecords = useMemo(() => {
    const query = historySearchQuery.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) => {
      const nameMatch = (record.patient_name || "").toLowerCase().includes(query);
      const uhid = (record.patient_id || "").toLowerCase();
      const normalizedQuery = normalizeUhidLookup(query);
      const uhidMatch = uhid && (uhid.includes(query) || (normalizedQuery && uhid.endsWith(normalizedQuery)));
      return nameMatch || uhidMatch;
    });
  }, [records, historySearchQuery]);

  const displayedRecords = useMemo(() => {
    return filteredRecords.filter((record) => {
      const status = (record.status || "due").toLowerCase();
      const dueAmt = Number(record.due_amount || 0);
      const paidAmt = Number(record.paid_amount || 0);
      if (billingTab === "due") {
        return status === "due" && dueAmt > 0 && paidAmt === 0;
      }
      if (billingTab === "partial") {
        return status === "partial" && paidAmt > 0 && dueAmt > 0;
      }
      if (billingTab === "paid") {
        return status === "paid" && dueAmt === 0;
      }
      return true; // "all"
    });
  }, [filteredRecords, billingTab]);

  const counts = useMemo(() => {
    let due = 0;
    let partial = 0;
    let paid = 0;
    filteredRecords.forEach((r) => {
      const status = (r.status || "due").toLowerCase();
      const dueAmt = Number(r.due_amount || 0);
      const paidAmt = Number(r.paid_amount || 0);
      if (status === "due" && dueAmt > 0 && paidAmt === 0) {
        due += 1;
      } else if (status === "partial" && paidAmt > 0 && dueAmt > 0) {
        partial += 1;
      } else if (status === "paid" && dueAmt === 0) {
        paid += 1;
      }
    });
    return { all: filteredRecords.length, due, partial, paid };
  }, [filteredRecords]);
  
  
  // Patient & Visit Information
  const [patientUhid, setPatientUhid] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientEmail, setPatientEmail] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [patientGender, setPatientGender] = useState("");
  const [visitId, setVisitId] = useState("");
  const [department, setDepartment] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [visitType, setVisitType] = useState("");
  const [visitDateTime, setVisitDateTime] = useState("");
  const [reportDeliveryMode, setReportDeliveryMode] = useState("");
  const [reportDeliveryDate, setReportDeliveryDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [doctorSchedules, setDoctorSchedules] = useState<Array<{ doctor_name?: string | null; department?: string | null }>>([]);

  const [labCategories, setLabCategories] = useState<string[]>([]);
  const [diagnosticCategories, setDiagnosticCategories] = useState<string[]>([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [deleteCategoryName, setDeleteCategoryName] = useState("");

  useEffect(() => {
    const loadDeps = async () => {
      try {
        const data = await apiFetch<{ departments?: { id: number; department_name?: string }[] }>("/api/registration/departments");
        setDepartments((data.departments || []).map((d) => (d.department_name || "").trim()).filter(Boolean));
      } catch {
        setDepartments([]);
      }
    };
    const loadCategories = async () => {
      try {
        const [labRes, diagRes] = await Promise.all([
          apiFetch<{ categories?: string[] }>("/api/lab/categories?type=lab"),
          apiFetch<{ categories?: string[] }>("/api/lab/categories?type=diagnostic")
        ]);
        setLabCategories(labRes.categories || []);
        setDiagnosticCategories(diagRes.categories || []);
      } catch (err) {
        console.error("Error loading categories", err);
      }
    };
    void loadDeps();
    void loadCategories();
  }, []);

  useEffect(() => {
    if (!department) {
      setDoctorSchedules([]);
      return;
    }
    let isMounted = true;
    const loadDoctorSchedules = async () => {
      try {
        const data = await apiFetch<{ schedules?: { doctor_name?: string | null; department?: string | null; status?: string | null }[] }>(`/api/op/doctor-schedules?department=${encodeURIComponent(department)}`);
        if (!isMounted) return;
        const schedules = (data.schedules || []).filter(s => {
          const status = String(s.status || 'available').trim().toLowerCase();
          return !['inactive', 'disabled', 'leave', 'full', 'unavailable', 'false', '0', 'cancelled'].includes(status);
        });
        setDoctorSchedules(schedules);
        
        const uniqueDocs = Array.from(new Set(schedules.map(s => String(s.doctor_name || "").trim()).filter(Boolean)));
        
        setDoctorName(prev => {
           if (prev && uniqueDocs.includes(prev)) return prev;
           if (uniqueDocs.length === 1) return uniqueDocs[0];
           return "";
        });
      } catch {
        if (isMounted) setDoctorSchedules([]);
      }
    };
    loadDoctorSchedules();
    return () => { isMounted = false; };
  }, [department]);
  
  // Payment & Billing Information
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [paymentMode, setPaymentMode] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [taxPercentage, setTaxPercentage] = useState("");
  const [discountPercentage, setDiscountPercentage] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [payingDueAmount, setPayingDueAmount] = useState("");
  const [billNotes, setBillNotes] = useState("");
  
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountFixedAmount, setDiscountFixedAmount] = useState("");


  const labTotal = useMemo(() => labItems.reduce((sum, item) => sum + Number(item.rate) * Number(item.quantity), 0), [labItems]);
  const diagnosticTotal = useMemo(() => diagnosticItems.reduce((sum, item) => sum + Number(item.rate) * Number(item.quantity), 0), [diagnosticItems]);
  const subtotal = labTotal + diagnosticTotal;
  const discountAmount = discountType === "fixed" 
    ? Number(discountFixedAmount || 0) 
    : (subtotal * Number(discountPercentage || 0)) / 100;
  const afterDiscount = subtotal - discountAmount;
  const taxAmount = (afterDiscount * Number(taxPercentage || 0)) / 100;
  // For new bills, grandTotal is computed from form; for existing records, use stored net_amount
  const formGrandTotal = afterDiscount + taxAmount;
  const existingRecordNetAmount = selectedRecord
    ? Math.max(
        Number(selectedRecord.amount || 0)
        - Number(selectedRecord.discount_amount || 0)
        + Number(selectedRecord.tax_amount || 0),
        0
      )
    : 0;
  const grandTotal = selectedRecord ? existingRecordNetAmount : formGrandTotal;
  const totalPaidAfterUpdate = selectedRecord
    ? Number(paidAmount || 0) + Number(payingDueAmount || 0)
    : Number(paidAmount || 0);
  const balanceAmount = grandTotal - totalPaidAfterUpdate;
  // Live payment calculations for change / remaining due
  const cashReceived = Number(paidAmount || 0) + Number(payingDueAmount || 0);
  const changeReturnedLive = Math.max(cashReceived - grandTotal, 0);
  const remainingDueLive = Math.max(grandTotal - cashReceived, 0);


  const loadDiagnostics = async () => {
    setLoadingRecords(true);
    try {
      const data = await apiFetch<{ diagnostics?: DiagnosticRecord[] }>("/api/lab/diagnostics");
      setRecords(data.diagnostics || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load lab diagnostics.");
    } finally {
      setLoadingRecords(false);
    }
  };

  useEffect(() => {
    void loadDiagnostics();
  }, []);

  const fillBillingPatient = async (value: string) => {
    const lookup = normalizeUhidLookup(value);
    if (!lookup) {
      setPatientName("");
      setPatientEmail("");
      return;
    }
    try {
      const patient = await lookupPatientByUhid(lookup);
      if (!patient) {
        setPatientName("");
        setPatientEmail("");
        setNotice({ type: "warning", message: "No patient found for that UHID / last 4 digits." });
        return;
      }
      const name = fullPatientName(patient) || patient.patient_id;
      setPatientUhid(patient.patient_id);
      setPatientName(name);
      setPatientAge(patient.age?.toString() || "");
      setPatientGender(patient.gender || "");
      setPatientEmail(patient.email || "");
      
      const patientDept = String((patient as any).department || "").trim();
      if (patientDept) {
        setDepartment(departments.find(d => d.toLowerCase() === patientDept.toLowerCase()) || patientDept);
      }
      
      const patientDoc = String((patient as any).consulting_doctor || "").trim();
      if (patientDoc) {
        setDoctorName(patientDoc);
      }
      
      setNotice({ type: "success", message: `Patient auto-filled: ${name}.` });
    } catch {
      setPatientName("");
      setPatientEmail("");
      setNotice({ type: "error", message: "Unable to auto-fill patient details." });
    }
  };

  const uniqueDoctorNames = useMemo(() => {
    return Array.from(new Set(doctorSchedules.map((s) => String(s.doctor_name || "").trim()).filter(Boolean)));
  }, [doctorSchedules]);

  const addBlankItem = () => {
    const target = activeTab === "lab" ? labItems : diagnosticItems;
    const nextItem: ServiceItem = {
      code: activeTab === "lab" ? `LAB${String(target.length + 1).padStart(3, "0")}` : `IMG${String(target.length + 1).padStart(3, "0")}`,
      name: search.trim() || "",
      category: category || subCategory || "",
      rate: "",
      quantity: "",
    };
    if (activeTab === "lab") setLabItems((current) => [...current, nextItem]);
    else setDiagnosticItems((current) => [...current, nextItem]);
    setSearch("");
    setNotice({ type: "success", message: "Blank service row added. Enter service details to continue." });
  };

  const renderChangeOrRemaining = () => {
    if (changeReturnedLive > 0) {
      return (
        <div className="billing-change-row">
          <strong>Change Returned:</strong>
          <span>₹{formatAmount(changeReturnedLive)}</span>
        </div>
      );
    }
    return (
      <div className="billing-remaining-row">
        <strong>Remaining Due:</strong>
        <span>₹{formatAmount(remainingDueLive)}</span>
      </div>
    );
  };

  const updateItem = (type: "lab" | "diagnostic", index: number, key: keyof ServiceItem, value: string) => {
    const setter = type === "lab" ? setLabItems : setDiagnosticItems;
    setter((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              [key]: key === "rate" || key === "quantity"
                ? value === ""
                  ? ""
                  : Number(value)
                : value,
            }
          : item
      )
    );
  };

  const createCategory = async () => {
    if (!newCategoryName.trim() || !activeTab) return;
    try {
      await apiFetch("/api/lab/categories", {
        method: "POST",
        body: JSON.stringify({ category_type: activeTab, category_name: newCategoryName.trim() })
      });
      if (activeTab === "lab") {
        setLabCategories(prev => [...prev, newCategoryName.trim()].sort());
      } else {
        setDiagnosticCategories(prev => [...prev, newCategoryName.trim()].sort());
      }
      setCategory(newCategoryName.trim());
      setNewCategoryName("");
      setNotice({ type: "success", message: "Category added successfully." });
    } catch (err) {
      setNotice({ type: "error", message: "Failed to add category. It may already exist." });
    }
  };

  const removeCategory = async () => {
    if (!deleteCategoryName.trim() || !activeTab) return;
    try {
      const res = await apiFetch<{ status: string }>("/api/lab/categories", {
        method: "DELETE",
        body: JSON.stringify({ category_type: activeTab, category_name: deleteCategoryName.trim() })
      });
      if (res.status === "ok") {
        setNotice({ type: "success", message: `Category "${deleteCategoryName.trim()}" deleted successfully.` });
        if (activeTab === "lab") {
          setLabCategories(prev => prev.filter(c => c !== deleteCategoryName.trim()));
        } else {
          setDiagnosticCategories(prev => prev.filter(c => c !== deleteCategoryName.trim()));
        }
        if (category === deleteCategoryName.trim()) {
          setCategory("");
        }
        setDeleteCategoryName("");
      }
    } catch (err: any) {
      reportError(setNotice, err, "Unable to delete category.");
    }
  };

  const removeItem = (type: "lab" | "diagnostic", index: number) => {
    const setter = type === "lab" ? setLabItems : setDiagnosticItems;
    setter((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const servicePayloads = () => {
    const build = (type: "lab" | "diagnostic", items: ServiceItem[]) =>
      items
        .filter((item) => item.name.trim() && Number(item.rate || 0) > 0 && Number(item.quantity || 0) > 0)
        .map((item, index) => {
          const grossAmount = Number(item.rate || 0) * Number(item.quantity || 0);
          const proportion = subtotal > 0 ? grossAmount / subtotal : 0;
          const lineDiscount = Number((discountAmount * proportion).toFixed(2));
          const lineTax = Number((taxAmount * proportion).toFixed(2));
          const linePayable = Number(Math.max(grossAmount - lineDiscount + lineTax, 0).toFixed(2));
          return {
            invoice_no: buildInvoiceNo(type, index),
            patient_id: patientUhid.trim(),
            patient_name: patientName.trim() || undefined,
            age: patientAge ? Number(patientAge) : undefined,
            gender: patientGender,
            visit_id: visitId.trim() || undefined,
            doctor_name: doctorName.trim() || undefined,
            department: department.trim() || undefined,
            visit_type: visitType,
            test_name: `${type === "lab" ? "Lab" : "Diagnostic"} - ${item.name.trim()}`,
            amount: grossAmount,
            payable_amount: linePayable,
            paid_amount: 0,
            sample_barcode: item.code.trim() || undefined,
            order_status: "ordered",
            bill_date: billDate || undefined,
            due_date: dueDate || undefined,
            payment_mode: paymentMode || undefined,
            transaction_id: transactionId.trim() || undefined,
            discount_percentage: discountType === "percentage" ? Number(discountPercentage || 0) : 0,
            discount_amount: lineDiscount,
            tax_percentage: Number(taxPercentage || 0),
            tax_amount: lineTax,
            report_delivery_mode: reportDeliveryMode || undefined,
            report_delivery_date: reportDeliveryDate || undefined,
            remarks: remarks.trim() || undefined,
            quantity: Number(item.quantity || 1),
            unit_rate: Number(item.rate || 0),
          };
        });
    return [...build("lab", labItems), ...build("diagnostic", diagnosticItems)];
  };

  const loadBillIntoSummary = (record: DiagnosticRecord) => {
    setSelectedRecord(record);
    setPayingDueAmount("");

    // 1. Patient & Visit Info
    setPatientUhid(record.patient_id || "");
    setPatientName(record.patient_name || "");
    setPatientAge(record.age?.toString() || "");
    setPatientGender(record.gender || "");
    setVisitId(record.visit_id || "");
    setDepartment(record.department || "");
    setDoctorName(record.doctor_name || "");
    setVisitType(record.visit_type || "");
    setVisitDateTime(record.created_at || "");
    setReportDeliveryMode(record.report_delivery_mode || "");
    setReportDeliveryDate(record.report_delivery_date || "");
    setRemarks(record.remarks || "");

    // 2. Payment & Billing Info
    setBillDate(record.bill_date || "");
    setDueDate(record.due_date || "");
    setPaymentMode(record.payment_mode || "Cash");
    setTransactionId(record.transaction_id || "");
    setTaxPercentage(record.tax_percentage?.toString() || "");
    setDiscountPercentage(record.discount_percentage?.toString() || "");
    setPaidAmount(record.paid_amount?.toString() || "");
    setBillNotes(record.remarks || "");

    // 3. Service Items
    const testName = record.test_name || "";
    let isLab = true;
    let displayName = testName;
    if (testName.startsWith("Lab - ")) {
      isLab = true;
      displayName = testName.substring(6);
    } else if (testName.startsWith("Diagnostic - ")) {
      isLab = false;
      displayName = testName.substring(13);
    }

    const serviceItem: ServiceItem = {
      code: record.sample_barcode || "",
      name: displayName,
      category: record.department || "",
      rate: (record.unit_rate && record.unit_rate > 0) ? record.unit_rate : record.amount,
      quantity: (record.quantity && record.quantity > 0) ? record.quantity : 1,
    };

    if (isLab) {
      setLabItems([serviceItem]);
      setDiagnosticItems([]);
      setActiveTab("lab");
    } else {
      setLabItems([]);
      setDiagnosticItems([serviceItem]);
      setActiveTab("diagnostic");
    }

    setNotice({ type: "success", message: `Loaded bill ${record.invoice_no || `DIAG-${record.id}`} into summary.` });
    
    // Focus or scroll to 3. Payment & Billing Information section
    const element = document.getElementById("payment-billing-section");
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  const printRecordBill = (record: DiagnosticRecord) => {
    const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const row = (label: string, value: unknown) => `
      <div class="journey-print-field">
        <span>${safeText(label)}</span>
        <strong>${safeText(value === "" || value === null || value === undefined ? "-" : value)}</strong>
      </div>`;

    const testName = record.test_name || "";
    let isLab = true;
    let displayName = testName;
    if (testName.startsWith("Lab - ")) {
      isLab = true;
      displayName = testName.substring(6);
    } else if (testName.startsWith("Diagnostic - ")) {
      isLab = false;
      displayName = testName.substring(13);
    }

    const testType = isLab ? "Lab" : "Diagnostic";
    const testCode = record.sample_barcode || "-";

    const recordQty = (record.quantity && record.quantity > 0) ? record.quantity : 1;
    const recordUnitRate = (record.unit_rate && record.unit_rate > 0) ? record.unit_rate : (recordQty > 1 ? record.amount / recordQty : record.amount);

    const serviceRows = `
      <tr>
        <td>1</td>
        <td>${safeText(testType)}</td>
        <td>${safeText(testCode)}</td>
        <td>${safeText(displayName)}</td>
        <td>${safeText(record.department || "-")}</td>
        <td>${safeText(recordQty)}</td>
        <td>₹${safeText(formatAmount(recordUnitRate))}</td>
        <td>₹${safeText(formatAmount(record.amount))}</td>
      </tr>`;

    const recordPatientName = record.patient_name || "-";
    const recordPatientUhid = record.patient_id || "-";
    const recordPatientAge = record.age?.toString() || "";
    const recordPatientGender = record.gender || "";
    const recordDoctorName = record.doctor_name || "-";
    const recordDepartment = record.department || "-";
    
    const recordGrossAmount = record.amount;
    const recordDiscountAmount = record.discount_amount || 0;
    const recordTaxAmount = record.tax_amount || 0;
    const recordGrandTotal = recordGrossAmount - recordDiscountAmount + recordTaxAmount;
    const recordPaidAmount = record.paid_amount || 0;
    const recordBalanceAmount = record.due_amount || 0;
    const recordChange = Math.max(Number(recordPaidAmount || 0) - Number(recordGrandTotal || 0), 0);
    const recordRemaining = Math.max(Number(recordGrandTotal || 0) - Number(recordPaidAmount || 0), 0);

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Lab &amp; Diagnostics Bill - ${safeText(recordPatientUhid)}</title>
          <style>
            @page { size: A4 portrait; margin: 4mm 5mm 5mm; }
            * { box-sizing: border-box; }
            html { margin: 0; background: transparent; color: #000; font-family: Arial, Helvetica, sans-serif; }
            body { margin: 0; font-size: 8.5pt; background: transparent; line-height: 1.25; }
            .report { width: 100%; position: relative; z-index: 1; min-height: 265mm; display: flex; flex-direction: column; }
            
            /* Header */
            .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2mm; margin-top: 5mm; width: 100%; }
            .brand-logo { width: auto; height: 24mm; object-fit: contain; }
            .title-block { display: none; }
            
            .title-block h1 { font-size: 13pt; font-weight: 800; margin: 0 0 2mm; text-align: left; }
            .meta-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
            .meta-table td { padding: 0.5mm 0; border: none !important; }
            .meta-table td:nth-child(1) { width: 15mm; }
            .meta-table td:nth-child(2) { width: 5mm; text-align: center; }
            
            .thick-line { border-top: 1.2mm solid #000; margin: 1.5mm 0 6mm 0; }
            
            /* Sections */
            .section { margin-bottom: 6mm; }
            .section-heading { font-size: 9pt; font-weight: 800; text-transform: uppercase; margin: 0 0 0.5mm; padding-left: 1mm; }
            .thin-line { border-top: 0.3mm solid #000; margin-top: 1.5mm; margin-bottom: 3mm; }
            
            /* Detail Grids */
            .grid-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .grid-table td { padding: 2.5mm 0; vertical-align: top; border: none !important; }
            .detail-label { font-weight: 800; width: 32mm; font-size: 8pt; }
            .colon { width: 3mm; text-align: center; font-weight: 800; }
            .detail-val { font-size: 8pt; }
            
            /* Summary Grid */
            .summary-wrap { display: grid; grid-template-columns: repeat(4, 1fr); align-items: center; margin: 2mm 0; text-align: center; }
            .summary-box { padding: 2mm; border-right: 0.3mm solid #ccc; }
            .summary-box:last-child { border-right: none; }
            .summary-box span { display: block; font-size: 8pt; font-weight: 800; margin-bottom: 2mm; text-transform: uppercase; }
            .summary-box strong { display: block; font-size: 11pt; font-weight: 900; }
            
            /* Table */
            .items-table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
            .items-table th, .items-table td { padding: 3mm 2mm; text-align: left; font-size: 8pt; }
            .items-table th { font-weight: 800; text-transform: uppercase; border-top: 0.3mm dashed #000; border-bottom: 0.3mm dashed #000; }
            .items-table td { border-bottom: 0.3mm dotted #ccc; }
            
            /* Payment Info Grid */
            .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-top: 2mm; margin-bottom: 4mm; }
            .info-cell span { display: block; font-size: 8pt; font-weight: 800; text-transform: uppercase; margin-bottom: 1.5mm; }
            .info-cell strong { display: block; font-size: 8pt; font-weight: normal; }
            
            .remaining-box { border: 0.3mm solid #999; border-radius: 4px; padding: 2mm 3mm; display: inline-block; font-size: 10pt; }
            
            /* Signatures */
            .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15mm; margin-top: auto; padding-top: 15mm; padding-bottom: 5mm; text-align: center; font-size: 8.5pt; font-weight: 800; }
            .sign-line { border-top: 0.3mm solid #000; padding-top: 2mm; }
            
            .operator { font-size: 9.5pt; margin-bottom: 5mm; padding-left: 4mm; margin-top: auto; padding-bottom: 15mm; }
            
            .hospai-shared-watermark {
              position: fixed;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              width: 145mm;
              max-width: 70%;
              opacity: 0.65;
              z-index: -1;
              pointer-events: none;
              display: block !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          </style>
        </head>
        <body>
          <main class="report" data-hospai-shared-print-shell>
            <img class="hospai-shared-watermark" src="${PRINT_WATERMARK_DATA_URI}" alt="HospAI Watermark" />
            
            <header class="header-container">
              <div>
                <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI Logo" />
              </div>
              <div class="title-block"></div>
            </header>
            
            <div class="thick-line"></div>

            <div class="section">
              <div class="section-heading">1. PATIENT INFORMATION</div>
              <div class="thin-line" style="margin-bottom: 1mm;"></div>
              <table class="grid-table"><tbody>
                <tr>
                  <td class="detail-label">Patient Name</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientName)}</td>
                  <td class="detail-label">Department</td><td class="colon">:</td><td class="detail-val">${safeText(recordDepartment || "-")}</td>
                </tr>
                <tr>
                  <td class="detail-label">UHID / Patient ID</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientUhid)}</td>
                  <td class="detail-label">Doctor</td><td class="colon">:</td><td class="detail-val">${safeText(recordDoctorName || "-")}</td>
                </tr>
                <tr>
                  <td class="detail-label">Age / Gender</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientAge || "-")} / ${safeText(recordPatientGender || "-")}</td>
                  <td></td><td></td><td></td>
                </tr>
              </tbody></table>
            </div>

            <div class="section">
              <div class="section-heading">2. TEST-WISE PAYMENT DETAILS</div>
              <table class="items-table">
                <thead><tr><th>#</th><th>TYPE</th><th>CODE</th><th>TEST</th><th>CATEGORY</th><th>QTY</th><th>RATE</th><th>AMOUNT</th></tr></thead>
                <tbody>${serviceRows}</tbody>
              </table>
            </div>

            <div class="section">
              <div class="section-heading">3. BILL SUMMARY</div>
              <div class="thin-line" style="margin-bottom: 1mm;"></div>
              <table class="grid-table" style="width: 100%; border-collapse: collapse;">
                <tbody>
                  <tr>
                    <td class="detail-label" style="padding: 2mm 0; width: 40mm;">Total Billed</td>
                    <td class="colon" style="padding: 2mm 0; width: 5mm;">:</td>
                    <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(recordGrandTotal)}</td>
                  </tr>
                  <tr>
                    <td class="detail-label" style="padding: 2mm 0;">Total Paid</td>
                    <td class="colon" style="padding: 2mm 0;">:</td>
                    <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(recordPaidAmount)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div class="operator">
              <p style="margin: 0 0 10mm 0;">Operator: ${safeText(user?.full_name || user?.username || "HospAI System")}</p>
              <p style="margin: 0; font-weight: bold; letter-spacing: 2px;">........................................</p>
            </div>
            
          </main>
        </body>
      </html>`;
    printViaIframe(html);
  };

  const saveBill = async () => {
    if (!patientUhid.trim() || !patientName.trim()) {
      setNotice({ type: "warning", message: "Enter UHID / last 4 digits and auto-fill patient before saving." });
      return;
    }
    const payloads = servicePayloads();
    if (payloads.length === 0) {
      setNotice({ type: "warning", message: "Add at least one lab or diagnostic service with amount." });
      return;
    }
    if (!paymentMode) {
      setNotice({ type: "warning", message: "Please select a Payment Mode before generating the bill." });
      return;
    }

    const paid = selectedRecord
      ? Math.max(Number(paidAmount || 0) + Number(payingDueAmount || 0), 0)
      : Math.max(Number(paidAmount) || 0, 0);
      
    if (paid > grandTotal) {
      setNotice({ type: "error", message: `Paid amount cannot exceed the total bill amount (₹${grandTotal.toFixed(2)}).` });
      return;
    }

    let remainingPaid = Math.min(paid, grandTotal);
    setSavingBill(true);
    try {
      if (selectedRecord) {
        // For existing records, preserve the original amount/discount/tax so the backend
        // recalculates the same net_amount and correctly sets due_amount = net_amount - paid.
        const existingNetAmount = Math.max(
          Number(selectedRecord.amount || 0)
          - Number(selectedRecord.discount_amount || 0)
          + Number(selectedRecord.tax_amount || 0),
          0
        );
        const clampedPaid = Math.min(paid, existingNetAmount);
        await apiFetch(`/api/lab/diagnostics/${selectedRecord.id}`, {
          method: "PUT",
          body: JSON.stringify({
            // Preserve original billing fields unchanged
            amount: selectedRecord.amount,
            discount_percentage: selectedRecord.discount_percentage ?? 0,
            discount_amount: selectedRecord.discount_amount ?? 0,
            tax_percentage: selectedRecord.tax_percentage ?? 0,
            tax_amount: selectedRecord.tax_amount ?? 0,
            // Update payment fields
            paid_amount: clampedPaid,
            payment_mode: paymentMode || selectedRecord.payment_mode,
            transaction_id: transactionId.trim() || selectedRecord.transaction_id,
            bill_date: billDate || selectedRecord.bill_date,
            due_date: dueDate || selectedRecord.due_date,
            // Preserve record identity fields
            patient_id: selectedRecord.patient_id,
            patient_name: selectedRecord.patient_name,
            age: selectedRecord.age,
            gender: selectedRecord.gender,
            test_name: selectedRecord.test_name,
            invoice_no: selectedRecord.invoice_no,
            doctor_name: selectedRecord.doctor_name,
            department: selectedRecord.department,
            visit_type: selectedRecord.visit_type,
            visit_id: selectedRecord.visit_id,
            sample_barcode: selectedRecord.sample_barcode,
            order_status: selectedRecord.order_status,
            report_delivery_mode: reportDeliveryMode || selectedRecord.report_delivery_mode,
            report_delivery_date: reportDeliveryDate || selectedRecord.report_delivery_date,
            remarks: remarks.trim() || selectedRecord.remarks,
            quantity: selectedRecord.quantity ?? 1,
            unit_rate: selectedRecord.unit_rate ?? 0,
          }),
        });
        setSelectedRecord(null);
        setLabItems([]);
        setDiagnosticItems([]);
        setPaidAmount("");
        setPayingDueAmount("");
        await loadDiagnostics();
        setNotice({ type: "success", message: "Lab and diagnostic bill updated successfully." });
      } else {
        for (const payload of payloads) {
          const linePayable = Math.max(Number(payload.payable_amount ?? payload.amount ?? 0), 0);
          const linePaid = Math.min(remainingPaid, linePayable);
          remainingPaid -= linePaid;
          await apiFetch("/api/lab/diagnostics", {
            method: "POST",
            body: JSON.stringify({ ...payload, paid_amount: linePaid }),
          });
        }
        setLabItems([]);
        setDiagnosticItems([]);
        setPaidAmount("");
        setPayingDueAmount("");
        await loadDiagnostics();
        setNotice({ type: "success", message: "Lab and diagnostic bill saved successfully." });
      }
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save lab bill.");
    } finally {
      setSavingBill(false);
    }
  };



  const printSelectedInvoices = () => {
    const selectedRecords = records.filter(record => selectedInvoiceIds.includes(record.id));
    if (selectedRecords.length === 0) {
      setNotice({ type: "warning", message: "No invoices selected for printing." });
      return;
    }
    
    const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const row = (label: string, value: unknown) => `
      <div class="journey-print-field">
        <span>${safeText(label)}</span>
        <strong>${safeText(value === "" || value === null || value === undefined ? "-" : value)}</strong>
      </div>`;

    // Group records by patient_id
    const groups: { [key: string]: DiagnosticRecord[] } = {};
    selectedRecords.forEach(record => {
      const pid = record.patient_id || "unknown";
      if (!groups[pid]) {
        groups[pid] = [];
      }
      groups[pid].push(record);
    });

    const patientIds = Object.keys(groups);

    const pagesHtml = patientIds.map((pid, groupIndex) => {
      const groupRecords = groups[pid];
      const firstRec = groupRecords[0];

      const recordPatientName = firstRec.patient_name || "-";
      const recordPatientUhid = firstRec.patient_id || "-";
      const recordPatientAge = firstRec.age?.toString() || "";
      const recordPatientGender = firstRec.gender || "";

      // Aggregate invoices, doctor names, departments
      const invoiceNos = groupRecords.map(r => r.invoice_no || `DIAG-${r.id}`).join(", ");
      const recordDoctorName = Array.from(new Set(groupRecords.map(r => r.doctor_name).filter(Boolean))).join(", ") || "-";
      const recordDepartment = Array.from(new Set(groupRecords.map(r => r.department).filter(Boolean))).join(", ") || "-";

      let totalGrossAmount = 0;
      let totalDiscountAmount = 0;
      let totalTaxAmount = 0;
      let totalPaidAmount = 0;
      let totalBalanceAmount = 0;

      const serviceRows = groupRecords.map((record, index) => {
        const testName = record.test_name || "";
        let isLab = true;
        let displayName = testName;
        if (testName.startsWith("Lab - ")) {
          isLab = true;
          displayName = testName.substring(6);
        } else if (testName.startsWith("Diagnostic - ")) {
          isLab = false;
          displayName = testName.substring(13);
        }

        const testType = isLab ? "Lab" : "Diagnostic";
        const testCode = record.sample_barcode || "-";

        totalGrossAmount += record.amount || 0;
        totalDiscountAmount += record.discount_amount || 0;
        totalTaxAmount += record.tax_amount || 0;
        totalPaidAmount += record.paid_amount || 0;
        totalBalanceAmount += record.due_amount || 0;

        const recordQty = (record.quantity && record.quantity > 0) ? record.quantity : 1;
        const recordUnitRate = (record.unit_rate && record.unit_rate > 0) ? record.unit_rate : (recordQty > 1 ? record.amount / recordQty : record.amount);

        return `
          <tr>
            <td>${index + 1}</td>
            <td>${safeText(testType)}</td>
            <td>${safeText(testCode)}</td>
            <td>${safeText(displayName)}</td>
            <td>${safeText(record.department || "-")}</td>
            <td>${safeText(recordQty)}</td>
            <td>₹${safeText(formatAmount(recordUnitRate))}</td>
            <td>₹${safeText(formatAmount(record.amount))}</td>
          </tr>`;
      }).join("");

      const recordGrandTotal = totalGrossAmount - totalDiscountAmount + totalTaxAmount;
      const recordChange = Math.max(Number(totalPaidAmount || 0) - Number(recordGrandTotal || 0), 0);
      const recordRemaining = Math.max(Number(recordGrandTotal || 0) - Number(totalPaidAmount || 0), 0);

      // Unique billing fields across records for display
      const billDates = Array.from(new Set(groupRecords.map(r => r.bill_date).filter(Boolean))).join(", ") || "-";
      const dueDates = Array.from(new Set(groupRecords.map(r => r.due_date).filter(Boolean))).join(", ") || "-";
      const paymentModes = Array.from(new Set(groupRecords.map(r => r.payment_mode).filter(Boolean))).join(", ") || "-";
      const transactionIds = Array.from(new Set(groupRecords.map(r => r.transaction_id).filter(Boolean))).join(", ") || "-";
      const reportDeliveries = Array.from(new Set(groupRecords.map(r => r.report_delivery_mode).filter(Boolean))).join(", ") || "-";
      const reportDeliveryDates = Array.from(new Set(groupRecords.map(r => r.report_delivery_date).filter(Boolean))).join(", ") || "-";
      const remarksList = groupRecords.map(r => r.remarks).filter(Boolean);
      const remarksStr = remarksList.length > 0 ? remarksList.join(" | ") : "-";

      const pageBreakStyle = groupIndex < patientIds.length - 1 ? 'page-break-after: always;' : '';

      return `
        <main class="report" data-hospai-shared-print-shell style="${pageBreakStyle}">
          <img class="hospai-shared-watermark" src="${PRINT_WATERMARK_DATA_URI}" alt="HospAI Watermark" />
          
          <header class="header-container">
            <div>
              <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI Logo" />
            </div>
            <div class="title-block"></div>
          </header>
          
          <div class="thick-line"></div>

          <div class="section">
            <div class="section-heading">1. PATIENT INFORMATION</div>
            <div class="thin-line" style="margin-bottom: 1mm;"></div>
            <table class="grid-table"><tbody>
              <tr>
                <td class="detail-label">Patient Name</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientName)}</td>
                <td class="detail-label">Department</td><td class="colon">:</td><td class="detail-val">${safeText(recordDepartment)}</td>
              </tr>
              <tr>
                <td class="detail-label">UHID / Patient ID</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientUhid)}</td>
                <td class="detail-label">Doctor</td><td class="colon">:</td><td class="detail-val">${safeText(recordDoctorName)}</td>
              </tr>
              <tr>
                <td class="detail-label">Age / Gender</td><td class="colon">:</td><td class="detail-val">${safeText(recordPatientAge || "-")} / ${safeText(recordPatientGender || "-")}</td>
                <td></td><td></td><td></td>
              </tr>
            </tbody></table>
          </div>

          <div class="section">
            <div class="section-heading">2. TEST-WISE PAYMENT DETAILS</div>
            <table class="items-table">
              <thead><tr><th>#</th><th>TYPE</th><th>CODE</th><th>TEST</th><th>CATEGORY</th><th>QTY</th><th>RATE</th><th>AMOUNT</th></tr></thead>
              <tbody>${serviceRows}</tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-heading">3. BILL SUMMARY</div>
            <div class="thin-line" style="margin-bottom: 1mm;"></div>
            <table class="grid-table" style="width: 100%; border-collapse: collapse;">
              <tbody>
                <tr>
                  <td class="detail-label" style="padding: 2mm 0; width: 40mm;">Total Billed</td>
                  <td class="colon" style="padding: 2mm 0; width: 5mm;">:</td>
                  <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(recordGrandTotal)}</td>
                </tr>
                <tr>
                  <td class="detail-label" style="padding: 2mm 0;">Total Paid</td>
                  <td class="colon" style="padding: 2mm 0;">:</td>
                  <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(Number(totalPaidAmount || 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <div class="operator">
            <p style="margin: 0 0 10mm 0;">Operator: ${safeText(user?.full_name || user?.username || "HospAI System")}</p>
            <p style="margin: 0; font-weight: bold; letter-spacing: 2px;">........................................</p>
          </div>
          
        </main>
      `;
    }).join("");

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Selected Lab &amp; Diagnostics Bills</title>
          <style>
            @page { size: A4 portrait; margin: 4mm 5mm 5mm; }
            * { box-sizing: border-box; }
            html { margin: 0; background: transparent; color: #000; font-family: Arial, Helvetica, sans-serif; }
            body { margin: 0; font-size: 8.5pt; background: transparent; line-height: 1.25; }
            .report { width: 100%; position: relative; z-index: 1; min-height: 265mm; display: flex; flex-direction: column; }
            
            /* Header */
            .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2mm; margin-top: 5mm; width: 100%; }
            .brand-logo { width: auto; height: 24mm; object-fit: contain; mix-blend-mode: multiply; }
            .title-block { display: none; }
            
            .title-block h1 { font-size: 13pt; font-weight: 800; margin: 0 0 2mm; text-align: left; }
            .meta-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
            .meta-table td { padding: 0.5mm 0; border: none !important; }
            .meta-table td:nth-child(1) { width: 15mm; }
            .meta-table td:nth-child(2) { width: 5mm; text-align: center; }
            
            .thick-line { border-top: 1.2mm solid #000; margin: 1.5mm 0 6mm 0; }
            
            /* Sections */
            .section { margin-bottom: 6mm; }
            .section-heading { font-size: 9pt; font-weight: 800; text-transform: uppercase; margin: 0 0 0.5mm; padding-left: 1mm; }
            .thin-line { border-top: 0.3mm solid #000; margin-top: 1.5mm; margin-bottom: 3mm; }
            
            /* Detail Grids */
            .grid-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .grid-table td { padding: 2.5mm 0; vertical-align: top; border: none !important; }
            .detail-label { font-weight: 800; width: 32mm; font-size: 8pt; }
            .colon { width: 3mm; text-align: center; font-weight: 800; }
            .detail-val { font-size: 8pt; }
            
            /* Summary Grid */
            .summary-wrap { display: grid; grid-template-columns: repeat(4, 1fr); align-items: center; margin: 2mm 0; text-align: center; }
            .summary-box { padding: 2mm; border-right: 0.3mm solid #ccc; }
            .summary-box:last-child { border-right: none; }
            .summary-box span { display: block; font-size: 8pt; font-weight: 800; margin-bottom: 2mm; text-transform: uppercase; }
            .summary-box strong { display: block; font-size: 11pt; font-weight: 900; }
            
            /* Table */
            .items-table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
            .items-table th, .items-table td { padding: 3mm 2mm; text-align: left; font-size: 8pt; }
            .items-table th { font-weight: 800; text-transform: uppercase; border-top: 0.3mm dashed #000; border-bottom: 0.3mm dashed #000; }
            .items-table td { border-bottom: 0.3mm dotted #ccc; }
            
            /* Payment Info Grid */
            .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-top: 2mm; margin-bottom: 4mm; }
            .info-cell span { display: block; font-size: 8pt; font-weight: 800; text-transform: uppercase; margin-bottom: 1.5mm; }
            .info-cell strong { display: block; font-size: 8pt; font-weight: normal; }
            
            .remaining-box { border: 0.3mm solid #999; border-radius: 4px; padding: 2mm 3mm; display: inline-block; font-size: 10pt; }
            
            /* Signatures */
            .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15mm; margin-top: auto; padding-top: 15mm; padding-bottom: 5mm; text-align: center; font-size: 8.5pt; font-weight: 800; }
            .sign-line { border-top: 0.3mm solid #000; padding-top: 2mm; }
            
            .operator { font-size: 9.5pt; margin-bottom: 5mm; padding-left: 4mm; margin-top: auto; padding-bottom: 15mm; }
            
            .hospai-shared-watermark {
              position: fixed;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              width: 145mm;
              max-width: 70%;
              opacity: 0.65;
              z-index: -1;
              pointer-events: none;
              display: block !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          </style>
        </head>
        <body>
          ${pagesHtml}
        </body>
      </html>`;
      
    printViaIframe(html, "__hospai_lab2_print_frame__");
  };

  const printLabBill = () => {
    if (!patientUhid.trim() || !patientName.trim()) {
      setNotice({ type: "warning", message: "Enter UHID / last 4 digits and auto-fill patient before printing." });
      return;
    }
    const items = [...labItems.map((item) => ({ ...item, type: "Lab" })), ...diagnosticItems.map((item) => ({ ...item, type: "Diagnostic" }))]
      .filter((item) => item.name.trim() && Number(item.rate) > 0 && Number(item.quantity) > 0);
    if (!items.length) {
      setNotice({ type: "warning", message: "Add at least one lab or diagnostic service with amount before printing." });
      return;
    }
    const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const row = (label: string, value: unknown) => `
      <div class="journey-print-field">
        <span>${safeText(label)}</span>
        <strong>${safeText(value === "" || value === null || value === undefined ? "-" : value)}</strong>
      </div>`;
    const serviceRows = items.map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${safeText(item.type)}</td>
        <td>${safeText(item.code)}</td>
        <td>${safeText(item.name)}</td>
        <td>${safeText(item.category || "-")}</td>
        <td>${safeText(item.quantity)}</td>
        <td>₹${safeText(formatAmount(Number(item.rate)))}</td>
        <td>₹${safeText(formatAmount(Number(item.rate) * Number(item.quantity)))}</td>
      </tr>`).join("");
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Lab &amp; Diagnostics Bill - ${safeText(patientUhid)}</title>
          <style>
            @page { size: A4 portrait; margin: 4mm 5mm 5mm; }
            * { box-sizing: border-box; }
            html { margin: 0; background: transparent; color: #000; font-family: Arial, Helvetica, sans-serif; }
            body { margin: 0; font-size: 8.5pt; background: transparent; line-height: 1.25; }
            .report { width: 100%; position: relative; z-index: 1; min-height: 265mm; display: flex; flex-direction: column; }
            
            /* Header */
            .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2mm; margin-top: 5mm; width: 100%; }
            .brand-logo { width: auto; height: 24mm; object-fit: contain; mix-blend-mode: multiply; }
            .title-block { display: none; }
            
            .title-block h1 { font-size: 13pt; font-weight: 800; margin: 0 0 2mm; text-align: left; }
            .meta-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
            .meta-table td { padding: 0.5mm 0; border: none !important; }
            .meta-table td:nth-child(1) { width: 15mm; }
            .meta-table td:nth-child(2) { width: 5mm; text-align: center; }
            
            .thick-line { border-top: 1.2mm solid #000; margin: 1.5mm 0 6mm 0; }
            
            /* Sections */
            .section { margin-bottom: 6mm; }
            .section-heading { font-size: 9pt; font-weight: 800; text-transform: uppercase; margin: 0 0 0.5mm; padding-left: 1mm; }
            .thin-line { border-top: 0.3mm solid #000; margin-top: 1.5mm; margin-bottom: 3mm; }
            
            /* Detail Grids */
            .grid-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .grid-table td { padding: 2.5mm 0; vertical-align: top; border: none !important; }
            .detail-label { font-weight: 800; width: 32mm; font-size: 8pt; }
            .colon { width: 3mm; text-align: center; font-weight: 800; }
            .detail-val { font-size: 8pt; }
            
            /* Summary Grid */
            .summary-wrap { display: grid; grid-template-columns: repeat(4, 1fr); align-items: center; margin: 2mm 0; text-align: center; }
            .summary-box { padding: 2mm; border-right: 0.3mm solid #ccc; }
            .summary-box:last-child { border-right: none; }
            .summary-box span { display: block; font-size: 8pt; font-weight: 800; margin-bottom: 2mm; text-transform: uppercase; }
            .summary-box strong { display: block; font-size: 11pt; font-weight: 900; }
            
            /* Table */
            .items-table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
            .items-table th, .items-table td { padding: 3mm 2mm; text-align: left; font-size: 8pt; }
            .items-table th { font-weight: 800; text-transform: uppercase; border-top: 0.3mm dashed #000; border-bottom: 0.3mm dashed #000; }
            .items-table td { border-bottom: 0.3mm dotted #ccc; }
            
            /* Payment Info Grid */
            .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-top: 2mm; margin-bottom: 4mm; }
            .info-cell span { display: block; font-size: 8pt; font-weight: 800; text-transform: uppercase; margin-bottom: 1.5mm; }
            .info-cell strong { display: block; font-size: 8pt; font-weight: normal; }
            
            .remaining-box { border: 0.3mm solid #999; border-radius: 4px; padding: 2mm 3mm; display: inline-block; font-size: 10pt; }
            
            /* Signatures */
            .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15mm; margin-top: auto; padding-top: 15mm; padding-bottom: 5mm; text-align: center; font-size: 8.5pt; font-weight: 800; }
            .sign-line { border-top: 0.3mm solid #000; padding-top: 2mm; }
            
            .operator { font-size: 9.5pt; margin-bottom: 5mm; padding-left: 4mm; margin-top: auto; padding-bottom: 15mm; }
            
            .hospai-shared-watermark {
              position: fixed;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              width: 145mm;
              max-width: 70%;
              opacity: 0.65;
              z-index: -1;
              pointer-events: none;
              display: block !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          </style>
        </head>
        <body>
          <main class="report" data-hospai-shared-print-shell>
            <img class="hospai-shared-watermark" src="${PRINT_WATERMARK_DATA_URI}" alt="HospAI Watermark" />
            
            <header class="header-container">
              <div>
                <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI Logo" />
              </div>
              <div class="title-block"></div>
            </header>
            
            <div class="thick-line"></div>

            <div class="section">
              <div class="section-heading">1. PATIENT INFORMATION</div>
              <div class="thin-line" style="margin-bottom: 1mm;"></div>
              <table class="grid-table"><tbody>
                <tr>
                  <td class="detail-label">Patient Name</td><td class="colon">:</td><td class="detail-val">${safeText(patientName)}</td>
                  <td class="detail-label">Department</td><td class="colon">:</td><td class="detail-val">${safeText(department || "-")}</td>
                </tr>
                <tr>
                  <td class="detail-label">UHID / Patient ID</td><td class="colon">:</td><td class="detail-val">${safeText(patientUhid)}</td>
                  <td class="detail-label">Doctor</td><td class="colon">:</td><td class="detail-val">${safeText(doctorName || "-")}</td>
                </tr>
                <tr>
                  <td class="detail-label">Age / Gender</td><td class="colon">:</td><td class="detail-val">${safeText(patientAge || "-")} / ${safeText(patientGender || "-")}</td>
                  <td></td><td></td><td></td>
                </tr>
              </tbody></table>
            </div>

            <div class="section">
              <div class="section-heading">2. TEST-WISE PAYMENT DETAILS</div>
              <table class="items-table">
                <thead><tr><th>#</th><th>TYPE</th><th>CODE</th><th>TEST</th><th>CATEGORY</th><th>QTY</th><th>RATE</th><th>AMOUNT</th></tr></thead>
                <tbody>${serviceRows}</tbody>
              </table>
            </div>

            <div class="section">
              <div class="section-heading">3. BILL SUMMARY</div>
              <div class="thin-line" style="margin-bottom: 1mm;"></div>
              <table class="grid-table" style="width: 100%; border-collapse: collapse;">
                <tbody>
                  <tr>
                    <td class="detail-label" style="padding: 2mm 0; width: 40mm;">Total Billed</td>
                    <td class="colon" style="padding: 2mm 0; width: 5mm;">:</td>
                    <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(grandTotal)}</td>
                  </tr>
                  <tr>
                    <td class="detail-label" style="padding: 2mm 0;">Total Paid</td>
                    <td class="colon" style="padding: 2mm 0;">:</td>
                    <td class="detail-val" style="padding: 2mm 0; text-align: right; font-weight: 800; font-size: 8.5pt;">₹${formatAmount(Number(paidAmount || 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div class="operator">
              <p style="margin: 0 0 10mm 0;">Operator: ${safeText(user?.full_name || user?.username || "HospAI System")}</p>
              <p style="margin: 0; font-weight: bold; letter-spacing: 2px;">........................................</p>
            </div>
            
          </main>
        </body>
      </html>`;
    printViaIframe(html, "__hospai_lab2_print_frame__");
  };

  const saveBillAndPrint = async () => {
    printLabBill();
    await saveBill();
  };

  const resetForm = () => {
    setSelectedRecord(null);
    setPatientUhid("");
    setPatientName("");
    setPatientEmail("");
    setPatientAge("");
    setPatientGender("");
    setVisitId("");
    setDepartment("");
    setDoctorName("");
    setVisitType("");
    setVisitDateTime("");
    setReportDeliveryMode("");
    setReportDeliveryDate("");
    setRemarks("");
    setBillDate("");
    setDueDate("");
    setPaymentMode("");
    setTransactionId("");
    setTaxPercentage("");
    setDiscountPercentage("");
    setPaidAmount("");
    setPayingDueAmount("");
    setBillNotes("");
    setLabItems([]);
    setDiagnosticItems([]);
    setActiveTab(null);
    setNotice({ type: "success", message: "Form reset." });
  };

  const sendBillViaEmail = () => {
    if (!patientUhid.trim() || !patientName.trim()) {
      setNotice({ type: "warning", message: "Enter UHID / last 4 digits and auto-fill patient before emailing." });
      return;
    }
    const items = [...labItems.map((item) => ({ ...item, type: "Lab" })), ...diagnosticItems.map((item) => ({ ...item, type: "Diagnostic" }))]
      .filter((item) => item.name.trim() && Number(item.rate) > 0 && Number(item.quantity) > 0);
    if (!items.length) {
      setNotice({ type: "warning", message: "Add at least one lab or diagnostic service with amount before emailing." });
      return;
    }

    const emailToUse = window.prompt("Enter recipient email address:", patientEmail || "");
    if (emailToUse === null) return;
    const trimmedEmail = emailToUse.trim();
    if (!trimmedEmail) {
      setNotice({ type: "warning", message: "Recipient email is required to send the bill." });
      return;
    }

    const subject = encodeURIComponent(`HospAI - Lab & Diagnostics Bill [${patientUhid}]`);
    const body = encodeURIComponent(
      `Dear ${patientName},\n\n` +
      `Please find below the bill details for your recent Lab & Diagnostics booking at HospAI:\n\n` +
      `Patient Name: ${patientName}\n` +
      `UHID / Patient ID: ${patientUhid}\n` +
      `Department: ${department || "-"}\n` +
      `Doctor: ${doctorName || "-"}\n\n` +
      `SERVICES DETAILS:\n` +
      items.map((item, index) => `${index + 1}. ${item.name} (${item.type}) - Rate: ₹${formatAmount(Number(item.rate))} x Qty: ${item.quantity} = ₹${formatAmount(Number(item.rate) * Number(item.quantity))}`).join("\n") + "\n\n" +
      `BILL SUMMARY:\n` +
      `Total Billed: ₹${formatAmount(grandTotal)}\n` +
      `Total Paid: ₹${formatAmount(Number(paidAmount || 0))}\n\n` +
      `Thank you for choosing HospAI.\n` +
      `Valid for 7 days or 2 times.`
    );
    window.location.href = `mailto:${trimmedEmail}?subject=${subject}&body=${body}`;
    setNotice({ type: "success", message: `Drafted invoice email for ${trimmedEmail}.` });
  };

  const renderRows = (type: "lab" | "diagnostic", items: ServiceItem[]) => {
    if (items.length === 0) {
      return (
        <tr>
          <td colSpan={8} className="lab-empty-row">No services added yet. Use search/category and Add Test to create a row.</td>
        </tr>
      );
    }

    return items.map((item, index) => (
      <tr key={`${type}-${index}-${item.code}`}>
        <td>{index + 1}</td>
        <td>
          <Input value={item.code} onChange={(event) => updateItem(type, index, "code", event.target.value)} aria-label={`${type} code`} />
        </td>
        <td>
          <Input value={item.name} onChange={(event) => updateItem(type, index, "name", event.target.value)} aria-label={`${type} name`} />
        </td>
        <td>
          <Input value={item.category} onChange={(event) => updateItem(type, index, "category", event.target.value)} aria-label={`${type} category`} />
        </td>
        <td>
          <Input type="number" min={0} value={item.rate} onChange={(event) => updateItem(type, index, "rate", event.target.value)} aria-label={`${type} rate`} placeholder="Enter amount" className="no-spin" onWheel={(e) => (e.target as HTMLElement).blur()} />
        </td>
        <td>
          <Input type="number" min={1} value={item.quantity} onChange={(event) => updateItem(type, index, "quantity", event.target.value)} aria-label={`${type} quantity`} placeholder="Qty" className="no-spin" onWheel={(e) => (e.target as HTMLElement).blur()} />
        </td>
        <td className="lab-service-amount">{formatAmount(Number(item.rate || 0) * Number(item.quantity || 0))}</td>
        <td>
          <button className="lab-delete-btn" type="button" onClick={() => removeItem(type, index)} aria-label="Delete row">×</button>
        </td>
      </tr>
    ));
  };

  return (
    <section className="module-page lab-billing-page">
      <div className="lab-layout single-column-lab">
        <div className="lab-card lab-services-card provided-services-card">
          
          {/* 1. PATIENT & VISIT INFORMATION */}
          <h3 className="lab-section-header">1. Patient & Visit Information</h3>
          <div className="lab-patient-grid">
            <div className="lab-field">
              <Label>UHID / Patient ID<Input 
                value={patientUhid} 
                onChange={(event) => { setPatientUhid(event.target.value); setPatientName(""); }} 
                onBlur={(event) => void fillBillingPatient(event.target.value)} 
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void fillBillingPatient((event.currentTarget as HTMLInputElement).value); } }} 
                placeholder="Enter UHID or last 4 digits" 
                aria-label="Patient UHID"
                required
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Visit Type<Select value={visitType} onChange={(event) => setVisitType(event.target.value)} aria-label="Visit Type" required>
                <option value="OPD">OPD</option>
                <option value="IPD">IPD</option>
                <option value="Emergency">Emergency</option>
              </Select></Label>
            </div>
            <div className="lab-field">
              <Label>Date / Time<Input 
                type="datetime-local"
                value={visitDateTime}
                onChange={(event) => setVisitDateTime(event.target.value)}
                aria-label="Visit Date Time"
              /></Label>
            </div>

            <div className="lab-field">
              <Label>Patient Name<Input 
                value={patientName} 
                onChange={(event) => setPatientName(event.target.value)} 
                placeholder="Auto-filled" 
                aria-label="Patient name"
                required
                readOnly
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Age<Input 
                type="number"
                value={patientAge}
                onChange={(event) => setPatientAge(event.target.value)}
                placeholder="Auto-filled"
                className="no-spin"
                onWheel={(e) => (e.target as HTMLElement).blur()}
                aria-label="Age"
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Gender<Select value={patientGender} onChange={(event) => setPatientGender(event.target.value)} aria-label="Gender">
                <option value="" disabled>Select Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </Select></Label>
            </div>


            <div className="lab-field">
              <Label>Department<Select
                value={department}
                onChange={(event) => {
                  setDepartment(event.target.value);
                }}
                aria-label="Department"
                required
              >
                <option value="">Select Department</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select></Label>
            </div>
            <div className="lab-field">
              <Label>Doctor<Select
                value={doctorName}
                onChange={(event) => {
                  setDoctorName(event.target.value);
                }}
                aria-label="Doctor name"
                required
              >
                <option value="" disabled={uniqueDoctorNames.length > 0}>
                  {uniqueDoctorNames.length ? "Select Doctor" : "No doctors available"}
                </option>
                {uniqueDoctorNames.map((dn) => <option key={dn} value={dn}>{dn}</option>)}
              </Select></Label>
            </div>


          </div>

          {/* 2. SELECT SERVICES */}
          <h3 className="lab-section-header">2. Select Services</h3>
          <div className="lab-tabs">
            <button className={activeTab === "lab" ? "active" : ""} type="button" onClick={() => setActiveTab("lab")}>Lab Tests</button>
            <button className={activeTab === "diagnostic" ? "active diagnostic" : "diagnostic"} type="button" onClick={() => { setActiveTab("diagnostic"); }}>Diagnostic (Imaging)</button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr auto", gap: "10px" }}>
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search test by name or code..." aria-label="Lab service search" />
              <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Lab category">
                <option value="">Select Category</option>
                {(activeTab === "lab" ? labCategories : diagnosticCategories).map((item) => <option key={item}>{item}</option>)}
              </Select>
              <Select value={subCategory} onChange={(event) => setSubCategory(event.target.value)} aria-label="Lab sub category">
                <option value="">Select Sub-Category</option>
                <option value="Routine">Routine</option>
                <option value="Emergency">Emergency</option>
                <option value="Special">Special</option>
              </Select>
              <Button type="button" onClick={addBlankItem} style={{ height: "38px" }}>+ Add Test</Button>
            </div>
            
            <div style={{ display: "flex", gap: "15px", alignItems: "center", background: "#f8fafc", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0", flexWrap: "wrap" }}>
              <span style={{ fontSize: "12px", fontWeight: "600", color: "#64748b" }}>Manage Categories:</span>
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                <Input 
                  value={newCategoryName} 
                  onChange={e => setNewCategoryName(e.target.value)} 
                  placeholder="New Category Name" 
                  style={{ width: "150px", height: "32px", fontSize: "12px" }}
                />
                <Button type="button" onClick={() => void createCategory()} disabled={!newCategoryName.trim()} style={{ height: "32px", padding: "0 10px", fontSize: "12px" }}>Add</Button>
              </div>
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                <Select 
                  value={deleteCategoryName} 
                  onChange={e => setDeleteCategoryName(e.target.value)} 
                  aria-label="Delete Category"
                  style={{ width: "170px", height: "32px", fontSize: "12px" }}
                >
                  <option value="">Select Category to Delete</option>
                  {(activeTab === "lab" ? labCategories : diagnosticCategories).map((item) => <option key={item}>{item}</option>)}
                </Select>
                <Button type="button" onClick={() => void removeCategory()} disabled={!deleteCategoryName} style={{ height: "32px", padding: "0 10px", fontSize: "12px", background: "#ef4444", color: "#fff" }}>Delete</Button>
              </div>
            </div>
          </div>

          {(activeTab === "lab" || labItems.length > 0) && (
            <div className="lab-table-section blue-section">
              <div className="lab-section-title">Lab Tests</div>
              <table className="lab-billing-table">
                <thead>
                  <tr><th>#</th><th>Test Code</th><th>Test Name</th><th>Category</th><th>Rate (₹)</th><th>Qty</th><th>Amount (₹)</th><th>Action</th></tr>
                </thead>
                <tbody>{renderRows("lab", labItems)}</tbody>
              </table>
              <div className="lab-total-row"><span>Total Lab Tests Amount</span><strong>₹ {formatAmount(labTotal)}</strong></div>
            </div>
          )}

          {(activeTab === "diagnostic" || diagnosticItems.length > 0) && (
            <div className="lab-table-section purple-section">
              <div className="lab-section-title">Diagnostic Imaging</div>
              <table className="lab-billing-table">
                <thead>
                  <tr><th>#</th><th>Procedure Code</th><th>Procedure Name</th><th>Category</th><th>Rate (₹)</th><th>Qty</th><th>Amount (₹)</th><th>Action</th></tr>
                </thead>
                <tbody>{renderRows("diagnostic", diagnosticItems)}</tbody>
              </table>
              <div className="lab-total-row purple"><span>Total Diagnostic Amount</span><strong>₹ {formatAmount(diagnosticTotal)}</strong></div>
            </div>
          )}

          {/* 3. PAYMENT & BILLING INFORMATION */}
          <h3 id="payment-billing-section" className="lab-section-header">3. Payment & Billing Information</h3>
          <div className="lab-patient-grid">
            <div className="lab-field">
              <label>Bill Date</label>
              <Input 
                type="date"
                value={billDate}
                onChange={(event) => setBillDate(event.target.value)}
                aria-label="Bill Date"
              />
            </div>
            <div className="lab-field">
              <Label>Payment Mode<Select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)} aria-label="Payment Mode" required>
                <option value="" disabled>Select Payment Mode</option>
                {PAYMENT_MODES.map(mode => <option key={mode}>{mode}</option>)}
              </Select></Label>
            </div>
            <div className="lab-field">
              <Label>Total Lab Tests Amount (₹)<Input 
                type="text"
                value={formatAmount(labTotal)}
                aria-label="Total Lab Tests Amount"
                disabled
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Total Diagnostic Amount (₹)<Input 
                type="text"
                value={formatAmount(diagnosticTotal)}
                aria-label="Total Diagnostic Amount"
                disabled
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Total Services Amount (₹)<Input 
                type="text"
                value={formatAmount(subtotal)}
                aria-label="Total Services Amount"
                disabled
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Paid Amount (₹) *<Input 
                type="number"
                className="no-spin"
                onWheel={(e) => (e.target as HTMLElement).blur()}
                min={0}
                max={grandTotal}
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.target.value)}
                placeholder="0.00"
                aria-label="Paid Amount"
                disabled={selectedRecord !== null}
                required
              /></Label>
            </div>
            {selectedRecord && (
              <div className="lab-field">
                <label style={{ color: "#2563eb", fontWeight: "bold" }}>Paying Due Amount (₹)</label>
                <Input 
                  type="number"
                  min={0}
                  max={selectedRecord.due_amount}
                  value={payingDueAmount}
                  onChange={(event) => setPayingDueAmount(event.target.value)}
                  placeholder={`Max ${selectedRecord.due_amount}`}
                  aria-label="Paying Due Amount"
                  style={{ border: "2px solid #2563eb" }}
                />
              </div>
            )}

            <div className="lab-field">
              <Label>Transaction / Reference No.<Input 
                value={transactionId}
                onChange={(event) => setTransactionId(event.target.value)}
                placeholder="e.g., TXN123456789"
                aria-label="Transaction ID"
              /></Label>
            </div>
            <div className="lab-field">
              <Label>Discount Type
                <Select 
                  value={discountType} 
                  onChange={(event) => {
                    setDiscountType(event.target.value as "percentage" | "fixed");
                    setDiscountPercentage("");
                    setDiscountFixedAmount("");
                  }} 
                  aria-label="Discount Type"
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed Amount</option>
                </Select>
              </Label>
            </div>
            {discountType === "percentage" ? (
              <div className="lab-field">
                <Label>Percentage / Discount (%)<Input 
                  type="number"
                  min={0}
                  max={100}
                  value={discountPercentage}
                  onChange={(event) => setDiscountPercentage(event.target.value)}
                  placeholder="0"
                  className="no-spin"
                  onWheel={(e) => (e.target as HTMLElement).blur()}
                  aria-label="Discount Percentage"
                /></Label>
              </div>
            ) : (
              <div className="lab-field">
                <Label>Fixed Discount (₹)<Input 
                  type="number"
                  min={0}
                  value={discountFixedAmount}
                  onChange={(event) => setDiscountFixedAmount(event.target.value)}
                  placeholder="0.00"
                  className="no-spin"
                  onWheel={(e) => (e.target as HTMLElement).blur()}
                  aria-label="Fixed Discount Amount"
                /></Label>
              </div>
            )}
            <div className="lab-field">
              <Label>Calculated Discount (₹)<Input 
                type="text"
                value={formatAmount(discountAmount)}
                disabled
                aria-label="Discount Amount"
              /></Label>
            </div>

            <div className="lab-field">
              <label>Tax (%)</label>
              <Input 
                type="number"
                min={0}
                value={taxPercentage}
                onChange={(event) => setTaxPercentage(event.target.value)}
                placeholder="5"
                className="no-spin"
                onWheel={(e) => (e.target as HTMLElement).blur()}
                aria-label="Tax Percentage"
              />
            </div>

          </div>

          {/* 4. BILL SUMMARY */}
          <h3 className="lab-section-header">4. Bill Summary</h3>
          <div className="lab-bill-summary">
            <div className="summary-row">
              <span>Total Lab Tests Amount (₹)</span>
              <strong>{formatAmount(labTotal)}</strong>
            </div>
            <div className="summary-row">
              <span>Total Diagnostic Amount (₹)</span>
              <strong>{formatAmount(diagnosticTotal)}</strong>
            </div>
            <div className="summary-row">
              <span>Sub Total (₹)</span>
              <strong>{formatAmount(subtotal)}</strong>
            </div>
            <div className="summary-row">
              <span>Discount (₹)</span>
              <strong>-{formatAmount(discountAmount)}</strong>
            </div>
            <div className="summary-row">
              <span>Tax ({taxPercentage}%) (₹)</span>
              <strong>{formatAmount(taxAmount)}</strong>
            </div>
            <div className="summary-row summary-total">
              <span>Total Amount (₹)</span>
              <strong>{formatAmount(grandTotal)}</strong>
            </div>
            <div className="summary-row summary-paid">
              <span>Paid Amount (₹)</span>
              <strong>{formatAmount(totalPaidAfterUpdate)}</strong>
            </div>
            {balanceAmount < 0 ? (
              <div className="summary-row summary-change">
                <span>Change to Return (₹)</span>
                <strong>{formatAmount(Math.abs(balanceAmount))}</strong>
              </div>
            ) : (
              <div className="summary-row summary-balance">
                <span>Balance Amount (₹)</span>
                <strong>{formatAmount(balanceAmount)}</strong>
              </div>
            )}
          </div>

          {/* ACTION BUTTONS */}
          <div className="lab-action-buttons">
            <Button className="btn-generate" type="button" onClick={() => void saveBill()} disabled={savingBill}>
              {savingBill ? "Generating..." : "📄 Generate Bill"}
            </Button>
            <Button className="btn-generate" type="button" onClick={() => void saveBillAndPrint()} disabled={savingBill} style={{ background: "#e8612d", borderColor: "#e8612d" }}>
              🖨️ Save & Print
            </Button>
            <Button className="btn-email" variant="secondary" type="button" onClick={sendBillViaEmail}>
              ✉️ Send via Email
            </Button>
            <Button className="btn-reset" variant="ghost" type="button" onClick={resetForm}>
              ⟲ Reset
            </Button>
          </div>
        </div>

        {/* EXISTING RECORDS */}
        <div className="lab-card lab-services-card provided-services-card">
          <h3>Existing Lab and Diagnostic Records</h3>

          {/* Billing List Status Tabs */}
          <div className="lab-tabs-row" style={{ display: "flex", gap: "8px", marginBottom: "16px", borderBottom: "1px solid #e2e8f0", paddingBottom: "8px", flexWrap: "wrap" }}>
            <button 
              className={`lab-tab-btn ${billingTab === "all" ? "active" : ""}`}
              type="button"
              onClick={() => setBillingTab("all")}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "13px",
                border: "none",
                cursor: "pointer",
                background: billingTab === "all" ? "#2563eb" : "#f1f5f9",
                color: billingTab === "all" ? "#fff" : "#475569",
                transition: "all 0.2s"
              }}
            >
              All Records ({counts.all})
            </button>
            <button 
              className={`lab-tab-btn ${billingTab === "due" ? "active" : ""}`}
              type="button"
              onClick={() => setBillingTab("due")}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "13px",
                border: "none",
                cursor: "pointer",
                background: billingTab === "due" ? "#dc2626" : "#f1f5f9",
                color: billingTab === "due" ? "#fff" : "#475569",
                transition: "all 0.2s"
              }}
            >
              Due Payments ({counts.due})
            </button>
            <button 
              className={`lab-tab-btn ${billingTab === "partial" ? "active" : ""}`}
              type="button"
              onClick={() => setBillingTab("partial")}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "13px",
                border: "none",
                cursor: "pointer",
                background: billingTab === "partial" ? "#ea580c" : "#f1f5f9",
                color: billingTab === "partial" ? "#fff" : "#475569",
                transition: "all 0.2s"
              }}
            >
              Partial Payments ({counts.partial})
            </button>
            <button 
              className={`lab-tab-btn ${billingTab === "paid" ? "active" : ""}`}
              type="button"
              onClick={() => setBillingTab("paid")}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "13px",
                border: "none",
                cursor: "pointer",
                background: billingTab === "paid" ? "#16a34a" : "#f1f5f9",
                color: billingTab === "paid" ? "#fff" : "#475569",
                transition: "all 0.2s"
              }}
            >
              Paid Payments ({counts.paid})
            </button>
          </div>
          
          <div className="lab-service-toolbar" style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Input 
              value={historySearchQuery} 
              onChange={(event) => setHistorySearchQuery(event.target.value)} 
              placeholder="Search by patient name or last 4 digit UHID..." 
              aria-label="Search records by name or UHID" 
              style={{ flex: 1 }}
            />
            <Button 
              type="button" 
              onClick={printSelectedInvoices} 
              disabled={selectedInvoiceIds.length === 0}
              style={{ minWidth: "150px" }}
            >
              🖨️ Print Selected ({selectedInvoiceIds.length})
            </Button>
          </div>

          <div className="lab-table-section blue-section" style={{maxHeight: "400px", overflowY: "auto"}}>
            <table className="lab-billing-table">
              <thead>
                <tr>
                  <th style={{ width: "40px", textAlign: "center" }}>
                    <input 
                      type="checkbox" 
                      checked={displayedRecords.length > 0 && displayedRecords.every(r => selectedInvoiceIds.includes(r.id))} 
                      onChange={(e) => {
                        if (e.target.checked) {
                          const allIds = displayedRecords.map(r => r.id);
                          setSelectedInvoiceIds(prev => Array.from(new Set([...prev, ...allIds])));
                        } else {
                          const allIds = displayedRecords.map(r => r.id);
                          setSelectedInvoiceIds(prev => prev.filter(id => !allIds.includes(id)));
                        }
                      }}
                      style={{ cursor: "pointer", width: "16px", height: "16px" }}
                      aria-label="Select all records"
                    />
                  </th>
                  <th>Invoice</th>
                  <th>UHID</th>
                  <th>Patient</th>
                  <th>Doctor</th>
                  <th>Test</th>
                  <th>Amount (₹)</th>
                  <th>Paid (₹)</th>
                  <th>Due (₹)</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingRecords ? (
                  <tr><td colSpan={11} className="lab-empty-row">Loading records...</td></tr>
                ) : displayedRecords.length === 0 ? (
                  <tr><td colSpan={11} className="lab-empty-row">No lab or diagnostic records available.</td></tr>
                ) : (
                  displayedRecords.slice(0, 50).map((record) => (
                    <tr key={record.id}>
                      <td style={{ textAlign: "center" }}>
                        <input 
                          type="checkbox" 
                          checked={selectedInvoiceIds.includes(record.id)} 
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedInvoiceIds([...selectedInvoiceIds, record.id]);
                            } else {
                              setSelectedInvoiceIds(selectedInvoiceIds.filter(id => id !== record.id));
                            }
                          }}
                          style={{ cursor: "pointer", width: "16px", height: "16px" }}
                          aria-label="Select record"
                        />
                      </td>
                      <td>{record.invoice_no || `DIAG-${record.id}`}</td>
                      <td>{record.patient_id || "-"}</td>
                      <td>{record.patient_name || "-"}</td>
                      <td>{record.doctor_name || "-"}</td>
                      <td>{record.test_name}</td>
                      <td>{formatAmount(Number(record.amount || 0))}</td>
                      <td>{formatAmount(Number(record.paid_amount || 0))}</td>
                      <td 
                        style={{ cursor: record.due_amount > 0 ? "pointer" : "default", color: record.due_amount > 0 ? "#2563eb" : "inherit", textDecoration: record.due_amount > 0 ? "underline" : "none" }}
                        onClick={() => {
                          if (record.due_amount > 0) {
                            loadBillIntoSummary(record);
                          }
                        }}
                      >
                        {formatAmount(Number(record.due_amount || 0))}
                      </td>
                      <td><span className={`status-badge status-${record.status || "due"}`}>{record.status || "due"}</span></td>
                      <td>
                        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                          <Button 
                            type="button" 
                            variant="secondary" 
                            size="sm" 
                            onClick={() => printRecordBill(record)} 
                            style={{ padding: "2px 8px", fontSize: "12px", border: "1px solid #ccc" }}
                          >
                            🖨️ Print
                          </Button>
                          {record.due_amount > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => handleOpenCollectPayment(record)}
                              style={{ padding: "2px 8px", fontSize: "12px", background: "#2563eb", color: "#fff" }}
                            >
                              💵 Collect
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* COLLECT PAYMENT DIALOG */}
      <Modal 
        open={collectPaymentModalOpen} 
        onClose={() => setCollectPaymentModalOpen(false)} 
        title="Collect Payment" 
        description="Enter payment information to update this bill."
      >
        {collectPaymentRecord && (
          <form onSubmit={handleCollectPaymentSubmit} style={{ display: "grid", gap: "16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", background: "#f8fafc", padding: "12px", borderRadius: "8px", fontSize: "13px" }}>
              <div><strong>Invoice:</strong> {collectPaymentRecord.invoice_no || `DIAG-${collectPaymentRecord.id}`}</div>
              <div><strong>Patient ID / UHID:</strong> {collectPaymentRecord.patient_id || "-"}</div>
              <div style={{ gridColumn: "span 2" }}><strong>Patient Name:</strong> {collectPaymentRecord.patient_name || "-"}</div>
              <div><strong>Doctor:</strong> {collectPaymentRecord.doctor_name || "-"}</div>
              <div><strong>Department:</strong> {collectPaymentRecord.department || "-"}</div>
              <div style={{ gridColumn: "span 2" }}><strong>Test Name:</strong> {collectPaymentRecord.test_name}</div>
              <div><strong>Total Amount:</strong> ₹{formatAmount(collectPaymentRecord.amount)}</div>
              <div><strong>Already Paid:</strong> ₹{formatAmount(collectPaymentRecord.paid_amount || 0)}</div>
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <Label>Remaining Due Amount (₹)</Label>
              <Input 
                value={formatAmount(Number(collectPaymentRecord.due_amount || 0))} 
                readOnly 
                disabled 
                style={{ background: "#e2e8f0", cursor: "not-allowed" }}
              />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <Label>Amount to Collect (₹) <span style={{ color: "#dc2626" }}>*</span></Label>
              <Input 
                type="number"
                step="any"
                min="0.01"
                max={collectPaymentRecord.due_amount}
                value={collectAmount}
                onChange={(e) => setCollectAmount(e.target.value)}
                required
                placeholder="Enter collection amount"
              />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <Label>Payment Mode <span style={{ color: "#dc2626" }}>*</span></Label>
              <Select 
                value={collectPaymentMode} 
                onChange={(e) => setCollectPaymentMode(e.target.value)}
                required
              >
                <option value="" disabled>Select Payment Mode</option>
                <option value="UPI">UPI</option>
                <option value="Cash">Cash</option>
                <option value="Card">Card</option>
              </Select>
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <Label>Transaction Reference (Optional)</Label>
              <Input 
                value={collectTxRef}
                onChange={(e) => setCollectTxRef(e.target.value)}
                placeholder="Transaction ID / Reference Number"
              />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <Label>Notes / Remarks (Optional)</Label>
              <Input 
                value={collectNotes}
                onChange={(e) => setCollectNotes(e.target.value)}
                placeholder="Payment notes"
              />
            </div>

            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "8px" }}>
              <Button type="button" variant="ghost" onClick={() => setCollectPaymentModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={collectLoading} style={{ background: "#2563eb", color: "#fff" }}>
                {collectLoading ? "Saving..." : "💾 Save Payment"}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* RECEIPT MODAL */}
      <Modal 
        open={receiptModalOpen} 
        onClose={() => setReceiptModalOpen(false)} 
        title="Payment Recorded" 
      >
        {collectReceiptRecord && (
          <div style={{ display: "grid", gap: "16px" }}>
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "16px", borderRadius: "8px", textAlign: "center" }}>
              <span style={{ fontSize: "24px" }}>✅</span>
              <h4 style={{ margin: "8px 0 4px", color: "#16a34a" }}>Payment Recorded Successfully</h4>
              <p style={{ margin: 0, fontSize: "13px", color: "#15803d" }}>
                Collected ₹{formatAmount(collectReceiptRecord.newly_collected)} for Invoice {collectReceiptRecord.invoice_no}
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button type="button" onClick={() => setReceiptModalOpen(false)} style={{ background: "#2563eb", color: "#fff" }}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
