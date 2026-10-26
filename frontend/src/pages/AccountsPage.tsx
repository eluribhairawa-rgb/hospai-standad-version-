import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Button, Input, Label, Select, Table, TableCell, TableHead, TableRow } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Notice } from "../types";

export type AccountsView = "overview" | "ledger" | "vendor-payments" | "doctor-payouts";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  view?: AccountsView;
};

type AccountsSummary = {
  ledger_income: number;
  ledger_expense: number;
  net_position: number;
  vendor_paid_total: number;
  doctor_paid_total: number;
  doctor_due_total: number;
};

type LedgerEntry = {
  id: number;
  entry_date: string;
  entry_type: string;
  category: string;
  reference_no?: string | null;
  counterparty_name?: string | null;
  amount: number;
  notes?: string | null;
};

type VendorPayment = {
  id: number;
  vendor_name: string;
  invoice_ref?: string | null;
  amount: number;
  payment_date: string;
  payment_mode?: string | null;
  status?: string | null;
  notes?: string | null;
};

type DoctorPayout = {
  id: number;
  doctor_name: string;
  payout_month: string;
  amount: number;
  paid_amount: number;
  due_amount: number;
  status?: string | null;
  paid_date?: string | null;
  notes?: string | null;
  payments?: Array<{
    id: number;
    amount: number;
    paid_date: string;
    notes?: string | null;
  }>;
};

type LedgerForm = {
  id: string;
  entry_date: string;
  entry_type: string;
  category: string;
  reference_no: string;
  counterparty_name: string;
  amount: string;
  notes: string;
};

type VendorForm = {
  id: string;
  vendor_name: string;
  invoice_ref: string;
  amount: string;
  payment_date: string;
  payment_mode: string;
  status: string;
  notes: string;
};

type DoctorSchedule = {
  doctor_name?: string | null;
  department?: string | null;
};

type DoctorForm = {
  id: string;
  doctor_name: string;
  department: string;
  payout_month: string;
  amount: string;
  paid_amount: string;
  amount_to_pay: string;
  paid_date: string;
  status: string;
  notes: string;
};

const EMPTY_SUMMARY: AccountsSummary = {
  ledger_income: 0,
  ledger_expense: 0,
  net_position: 0,
  vendor_paid_total: 0,
  doctor_paid_total: 0,
  doctor_due_total: 0,
};

const DEFAULT_LEDGER_FORM: LedgerForm = {
  id: "",
  entry_date: "",
  entry_type: "",
  category: "",
  reference_no: "",
  counterparty_name: "",
  amount: "",
  notes: "",
};

const DEFAULT_VENDOR_FORM: VendorForm = {
  id: "",
  vendor_name: "",
  invoice_ref: "",
  amount: "",
  payment_date: "",
  payment_mode: "",
  status: "",
  notes: "",
};

const DEFAULT_DOCTOR_FORM: DoctorForm = {
  id: "",
  doctor_name: "",
  department: "",
  payout_month: "",
  amount: "",
  paid_amount: "",
  amount_to_pay: "",
  paid_date: "",
  status: "",
  notes: "",
};

const ACCOUNTS_VIEW_CONFIG: Record<AccountsView, { title: string; subtitle: string }> = {
  overview: {
    title: "Accounts Overview",
    subtitle: "Track core account balances and latest financial records.",
  },
  ledger: {
    title: "General Ledger",
    subtitle: "Create and manage journal entries.",
  },
  "vendor-payments": {
    title: "Vendor Payments",
    subtitle: "Record and reconcile supplier settlements.",
  },
  "doctor-payouts": {
    title: "Doctor Payouts",
    subtitle: "Manage monthly payouts and due balances.",
  },
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

export default function AccountsPage({ setNotice, view = "ledger" }: Props) {
  const [summary, setSummary] = useState<AccountsSummary>(EMPTY_SUMMARY);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [vendorPayments, setVendorPayments] = useState<VendorPayment[]>([]);
  const [doctorPayouts, setDoctorPayouts] = useState<DoctorPayout[]>([]);
  const [doctorSchedules, setDoctorSchedules] = useState<DoctorSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [ledgerForm, setLedgerForm] = useState<LedgerForm>(DEFAULT_LEDGER_FORM);
  const [vendorForm, setVendorForm] = useState<VendorForm>(DEFAULT_VENDOR_FORM);
  const [doctorForm, setDoctorForm] = useState<DoctorForm>(DEFAULT_DOCTOR_FORM);
  const [savingLedger, setSavingLedger] = useState(false);
  const [savingVendor, setSavingVendor] = useState(false);
  const [savingDoctor, setSavingDoctor] = useState(false);

  const currentDate = new Date();
  const [filterMonth, setFilterMonth] = useState<string>(String(currentDate.getMonth() + 1).padStart(2, "0"));
  const [filterYear, setFilterYear] = useState<string>(String(currentDate.getFullYear()));

  const needsLedger = view === "overview" || view === "ledger";
  const needsVendors = view === "overview" || view === "vendor-payments";
  const needsDoctors = view === "overview" || view === "doctor-payouts";

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const summaryRequest = apiFetch<AccountsSummary>("/api/accounts/summary");
      const ledgerRequest = needsLedger
        ? apiFetch<{ entries?: LedgerEntry[] }>("/api/accounts/ledger")
        : Promise.resolve({ entries: [] as LedgerEntry[] });
      const vendorRequest = needsVendors
        ? apiFetch<{ payments?: VendorPayment[] }>("/api/accounts/vendors")
        : Promise.resolve({ payments: [] as VendorPayment[] });
      const doctorRequest = needsDoctors
        ? apiFetch<{ payouts?: DoctorPayout[] }>("/api/accounts/doctors")
        : Promise.resolve({ payouts: [] as DoctorPayout[] });
      const schedulesRequest = needsDoctors
        ? apiFetch<{ schedules?: DoctorSchedule[] }>("/api/op/doctor-schedules").catch(() => ({ schedules: [] }))
        : Promise.resolve({ schedules: [] as DoctorSchedule[] });

      const [summaryData, ledgerData, vendorData, doctorData, schedulesData] = await Promise.all([
        summaryRequest,
        ledgerRequest,
        vendorRequest,
        doctorRequest,
        schedulesRequest,
      ]);
      setSummary({ ...EMPTY_SUMMARY, ...summaryData });
      setLedgerEntries(ledgerData.entries || []);
      setVendorPayments(vendorData.payments || []);
      setDoctorPayouts(doctorData.payouts || []);
      setDoctorSchedules(schedulesData.schedules || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load accounts data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAccounts();
  }, [view]);

  const filteredPayouts = doctorPayouts.filter((p) => {
    if (view !== "doctor-payouts") return true;
    if (!p.payout_month) return true;
    const [y, m] = p.payout_month.split("-");
    if (filterYear && y !== filterYear) return false;
    if (filterMonth && m !== filterMonth) return false;
    return true;
  });

  const filteredLedger = ledgerEntries.filter((e) => {
    if (view !== "doctor-payouts") return true;
    if (!e.entry_date) return true;
    const [y, m] = e.entry_date.split("-");
    if (filterYear && y !== filterYear) return false;
    if (filterMonth && m !== filterMonth) return false;
    return true;
  });

  let displaySummary = summary;
  if (view === "doctor-payouts") {
    const doctor_paid_total = filteredPayouts.reduce((sum, p) => sum + (Number(p.paid_amount) || 0), 0);
    const doctor_due_total = filteredPayouts.reduce((sum, p) => sum + (Number(p.due_amount) || 0), 0);
    const ledger_expense = filteredLedger
      .filter((e) => e.entry_type === "expense")
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const ledger_income = filteredLedger
      .filter((e) => e.entry_type === "income")
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    
    displaySummary = {
      ...summary,
      doctor_paid_total,
      doctor_due_total,
      ledger_expense,
      net_position: ledger_income - ledger_expense,
    };
  }

  const handleLedgerSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ledgerForm.entry_date || !ledgerForm.category.trim() || (Number(ledgerForm.amount) || 0) <= 0) {
      setNotice({ type: "error", message: "Entry date, category, and amount are required." });
      return;
    }
    setSavingLedger(true);
    try {
      const entryId = Number(ledgerForm.id);
      const path = entryId ? `/api/accounts/ledger/${entryId}` : "/api/accounts/ledger";
      await apiFetch(path, {
        method: entryId ? "PUT" : "POST",
        body: JSON.stringify({
          entry_date: ledgerForm.entry_date,
          entry_type: ledgerForm.entry_type,
          category: ledgerForm.category.trim(),
          reference_no: ledgerForm.reference_no.trim() || undefined,
          counterparty_name: ledgerForm.counterparty_name.trim() || undefined,
          amount: Number(ledgerForm.amount) || 0,
          notes: ledgerForm.notes.trim() || undefined,
        }),
      });
      setLedgerForm({ ...DEFAULT_LEDGER_FORM });
      setNotice({ type: "success", message: entryId ? "Ledger entry updated." : "Ledger entry recorded." });
      await loadAccounts();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save ledger entry.");
    } finally {
      setSavingLedger(false);
    }
  };

  const handleVendorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vendorForm.vendor_name.trim() || !vendorForm.payment_date || (Number(vendorForm.amount) || 0) <= 0) {
      setNotice({ type: "error", message: "Vendor, payment date, and amount are required." });
      return;
    }
    setSavingVendor(true);
    try {
      const paymentId = Number(vendorForm.id);
      const path = paymentId ? `/api/accounts/vendors/${paymentId}` : "/api/accounts/vendors";
      await apiFetch(path, {
        method: paymentId ? "PUT" : "POST",
        body: JSON.stringify({
          vendor_name: vendorForm.vendor_name.trim(),
          invoice_ref: vendorForm.invoice_ref.trim() || undefined,
          amount: Number(vendorForm.amount) || 0,
          payment_date: vendorForm.payment_date,
          payment_mode: vendorForm.payment_mode,
          status: vendorForm.status,
          notes: vendorForm.notes.trim() || undefined,
        }),
      });
      setVendorForm({ ...DEFAULT_VENDOR_FORM });
      setNotice({ type: "success", message: paymentId ? "Vendor payment updated." : "Vendor payment recorded." });
      await loadAccounts();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save vendor payment.");
    } finally {
      setSavingVendor(false);
    }
  };

  const handleDoctorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!doctorForm.doctor_name.trim() || !doctorForm.payout_month || (Number(doctorForm.amount) || 0) <= 0) {
      setNotice({ type: "error", message: "Doctor, payout month, and amount are required." });
      return;
    }
    const totalAmount = Number(doctorForm.amount) || 0;
    const paymentDelta = doctorForm.id ? (Number(doctorForm.amount_to_pay) || 0) : (Number(doctorForm.paid_amount) || 0);
    const basePaid = doctorForm.id ? (Number(doctorForm.paid_amount) || 0) : 0;
    const finalPaid = basePaid + paymentDelta;
    if (finalPaid > totalAmount) {
      setNotice({ type: "error", message: "Paid Amount cannot be greater than Total Payout Amount." });
      return;
    }
    setSavingDoctor(true);
    try {
      const payoutId = Number(doctorForm.id);
      const path = payoutId ? `/api/accounts/doctors/${payoutId}` : "/api/accounts/doctors";
      
      const payload: any = {
        doctor_name: doctorForm.doctor_name.trim(),
        payout_month: doctorForm.payout_month,
        amount: Number(doctorForm.amount) || 0,
        paid_date: doctorForm.paid_date || undefined,
        notes: doctorForm.notes.trim() || undefined,
      };

      if (payoutId) {
        payload.amount_to_pay = Number(doctorForm.amount_to_pay) || 0;
      } else {
        payload.paid_amount = Number(doctorForm.paid_amount) || 0;
      }

      await apiFetch(path, {
        method: payoutId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setDoctorForm({ ...DEFAULT_DOCTOR_FORM });
      setNotice({ type: "success", message: payoutId ? "Doctor payout updated." : "Doctor payout recorded." });
      await loadAccounts();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save doctor payout.");
    } finally {
      setSavingDoctor(false);
    }
  };

  const deleteRecord = async (path: string, label: string) => {
    if (!window.confirm(`Delete ${label}?`)) return;
    try {
      await apiFetch(path, { method: "DELETE" });
      setNotice({ type: "success", message: `${label} deleted.` });
      await loadAccounts();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, `Unable to delete ${label.toLowerCase()}.`);
    }
  };

  const renderOverview = () => (
    <div className="split">
      <div className="panel">
        <div className="module-panel-head">
          <h3>Recent Ledger Entries</h3>
        </div>
        {ledgerEntries.length === 0 ? (
          <p className="muted">No ledger entries yet.</p>
        ) : (
          <Table className="module-table module-table-accounts-ledger" aria-label="Accounts ledger table">
            <TableHead>
              <TableCell>Date</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Reference</TableCell>
              <TableCell>Amount</TableCell>
            </TableHead>
            {ledgerEntries.slice(0, 8).map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{formatDate(entry.entry_date)}</TableCell>
                <TableCell>{entry.entry_type}</TableCell>
                <TableCell>{entry.category}</TableCell>
                <TableCell>{entry.reference_no || "-"}</TableCell>
                <TableCell>{formatCurrency(entry.amount)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </div>

      <div className="panel">
        <div className="module-panel-head">
          <h3>Recent Vendor Payments</h3>
        </div>
        {vendorPayments.length === 0 ? (
          <p className="muted">No vendor payments yet.</p>
        ) : (
          <Table className="module-table module-table-accounts-vendors" aria-label="Vendor payments table">
            <TableHead>
              <TableCell>Vendor</TableCell>
              <TableCell>Date</TableCell>
              <TableCell>Amount</TableCell>
              <TableCell>Mode</TableCell>
              <TableCell>Status</TableCell>
            </TableHead>
            {vendorPayments.slice(0, 8).map((payment) => (
              <TableRow key={payment.id}>
                <TableCell>{payment.vendor_name}</TableCell>
                <TableCell>{formatDate(payment.payment_date)}</TableCell>
                <TableCell>{formatCurrency(payment.amount)}</TableCell>
                <TableCell>{payment.payment_mode || "bank"}</TableCell>
                <TableCell>{payment.status || "paid"}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </div>
    </div>
  );

  const renderLedger = () => (
    <div className="panel">
      <div className="module-panel-head">
        <h3>General Ledger</h3>
      </div>
      <form className="module-form-grid module-sales-grid" onSubmit={handleLedgerSubmit}>
        <Label>
          Entry Date
          <Input type="date" value={ledgerForm.entry_date} onChange={(event) => setLedgerForm((current) => ({ ...current, entry_date: event.target.value }))} aria-label="Ledger date" />
        </Label>
        <Label>
          Entry Type
          <Select value={ledgerForm.entry_type} onChange={(event) => setLedgerForm((current) => ({ ...current, entry_type: event.target.value }))} aria-label="Ledger type">
            <option value="income">Income</option>
            <option value="expense">Expense</option>
            <option value="adjustment">Adjustment</option>
          </Select>
        </Label>
        <Label>
          Category
          <Input value={ledgerForm.category} onChange={(event) => setLedgerForm((current) => ({ ...current, category: event.target.value }))} placeholder="Category" aria-label="Ledger category" />
        </Label>
        <Label>
          Reference
          <Input value={ledgerForm.reference_no} onChange={(event) => setLedgerForm((current) => ({ ...current, reference_no: event.target.value }))} placeholder="Reference" aria-label="Ledger reference" />
        </Label>
        <Label>
          Amount
          <Input type="number" min={0} value={ledgerForm.amount} onChange={(event) => setLedgerForm((current) => ({ ...current, amount: event.target.value }))} placeholder="Amount" aria-label="Ledger amount" />
        </Label>
        <Label>
          Counterparty
          <Input value={ledgerForm.counterparty_name} onChange={(event) => setLedgerForm((current) => ({ ...current, counterparty_name: event.target.value }))} placeholder="Counterparty" aria-label="Ledger counterparty" />
        </Label>
        <Label>
          Notes
          <Input value={ledgerForm.notes} onChange={(event) => setLedgerForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Notes" aria-label="Ledger notes" />
        </Label>
        <Button type="submit" variant="primary" disabled={savingLedger}>
          {savingLedger ? "Saving..." : ledgerForm.id ? "Update Entry" : "Add Entry"}
        </Button>
      </form>

      {ledgerEntries.length === 0 ? (
        <p className="muted">No ledger entries yet.</p>
      ) : (
        <Table className="module-table module-table-accounts-ledger" aria-label="Accounts ledger table">
          <TableHead>
            <TableCell>Date</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Category</TableCell>
            <TableCell>Reference</TableCell>
            <TableCell>Amount</TableCell>
            <TableCell>Actions</TableCell>
          </TableHead>
          {ledgerEntries.slice(0, 12).map((entry) => (
            <TableRow key={entry.id}>
              <TableCell>{formatDate(entry.entry_date)}</TableCell>
              <TableCell>{entry.entry_type}</TableCell>
              <TableCell>{entry.category}</TableCell>
              <TableCell>{entry.reference_no || "-"}</TableCell>
              <TableCell>{formatCurrency(entry.amount)}</TableCell>
              <TableCell>
                <div className="module-inline-actions">
                  <Button
                    type="button"
                    onClick={() =>
                      setLedgerForm({
                        id: String(entry.id),
                        entry_date: entry.entry_date,
                        entry_type: entry.entry_type,
                        category: entry.category,
                        reference_no: entry.reference_no || "",
                        counterparty_name: entry.counterparty_name || "",
                        amount: String(entry.amount || 0),
                        notes: entry.notes || "",
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button type="button" variant="destructive" onClick={() => void deleteRecord(`/api/accounts/ledger/${entry.id}`, "ledger entry")}>
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );

  const renderVendors = () => (
    <div className="panel">
      <div className="module-panel-head">
        <h3>Vendor Payments</h3>
      </div>
      <form className="module-form-grid module-sales-grid" onSubmit={handleVendorSubmit}>
        <Label>
          Vendor Name
          <Input value={vendorForm.vendor_name} onChange={(event) => setVendorForm((current) => ({ ...current, vendor_name: event.target.value }))} placeholder="Vendor" aria-label="Vendor name" />
        </Label>
        <Label>
          Invoice Reference
          <Input value={vendorForm.invoice_ref} onChange={(event) => setVendorForm((current) => ({ ...current, invoice_ref: event.target.value }))} placeholder="Invoice ref" aria-label="Vendor invoice reference" />
        </Label>
        <Label>
          Amount
          <Input type="number" min={0} value={vendorForm.amount} onChange={(event) => setVendorForm((current) => ({ ...current, amount: event.target.value }))} placeholder="Amount" aria-label="Vendor payment amount" />
        </Label>
        <Label>
          Payment Date
          <Input type="date" value={vendorForm.payment_date} onChange={(event) => setVendorForm((current) => ({ ...current, payment_date: event.target.value }))} aria-label="Vendor payment date" />
        </Label>
        <Label>
          Payment Mode
          <Select value={vendorForm.payment_mode} onChange={(event) => setVendorForm((current) => ({ ...current, payment_mode: event.target.value }))} aria-label="Vendor payment mode">
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
          </Select>
        </Label>
        <Label>
          Status
          <Select value={vendorForm.status} onChange={(event) => setVendorForm((current) => ({ ...current, status: event.target.value }))} aria-label="Vendor payment status">
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="pending">Pending</option>
          </Select>
        </Label>
        <Label>
          Notes
          <Input value={vendorForm.notes} onChange={(event) => setVendorForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Notes" aria-label="Vendor payment notes" />
        </Label>
        <Button type="submit" variant="primary" disabled={savingVendor}>
          {savingVendor ? "Saving..." : vendorForm.id ? "Update Payment" : "Record Payment"}
        </Button>
      </form>

      {vendorPayments.length === 0 ? (
        <p className="muted">No vendor payments yet.</p>
      ) : (
        <Table className="module-table module-table-accounts-vendors" aria-label="Vendor payments table">
          <TableHead>
            <TableCell>Vendor</TableCell>
            <TableCell>Date</TableCell>
            <TableCell>Amount</TableCell>
            <TableCell>Mode</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Actions</TableCell>
          </TableHead>
          {vendorPayments.slice(0, 10).map((payment) => (
            <TableRow key={payment.id}>
              <TableCell>{payment.vendor_name}</TableCell>
              <TableCell>{formatDate(payment.payment_date)}</TableCell>
              <TableCell>{formatCurrency(payment.amount)}</TableCell>
              <TableCell>{payment.payment_mode || "bank"}</TableCell>
              <TableCell>{payment.status || "paid"}</TableCell>
              <TableCell>
                <div className="module-inline-actions">
                  <Button
                    type="button"
                    onClick={() =>
                      setVendorForm({
                        id: String(payment.id),
                        vendor_name: payment.vendor_name,
                        invoice_ref: payment.invoice_ref || "",
                        amount: String(payment.amount || 0),
                        payment_date: payment.payment_date,
                        payment_mode: payment.payment_mode || "bank",
                        status: payment.status || "paid",
                        notes: payment.notes || "",
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button type="button" variant="destructive" onClick={() => void deleteRecord(`/api/accounts/vendors/${payment.id}`, "vendor payment")}>
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );

  const renderDoctors = () => {
    const selectedPayout = filteredPayouts.find((p) => String(p.id) === doctorForm.id);
    const currentDue = Math.max((Number(doctorForm.amount) || 0) - (Number(doctorForm.paid_amount) || 0), 0);
    
    const currentTotal = Number(doctorForm.amount) || 0;
    const paymentDelta = doctorForm.id ? (Number(doctorForm.amount_to_pay) || 0) : (Number(doctorForm.paid_amount) || 0);
    const basePaid = doctorForm.id ? (Number(doctorForm.paid_amount) || 0) : 0;
    const finalPaid = basePaid + paymentDelta;
    let displayStatus = "Pending";
    if (finalPaid > 0 && finalPaid < currentTotal) displayStatus = "Partially Paid";
    if (finalPaid > 0 && finalPaid >= currentTotal) displayStatus = "Paid";

    const uniqueDepartments = Array.from(new Set(doctorSchedules.map(s => s.department).filter(Boolean))) as string[];
    uniqueDepartments.sort();
    
    const availableDoctors = doctorSchedules.filter(s => 
      !doctorForm.department || s.department === doctorForm.department
    ).map(s => s.doctor_name).filter(Boolean) as string[];
    
    const uniqueDoctors = Array.from(new Set(availableDoctors));
    uniqueDoctors.sort();
    
    const handleDepartmentChange = (dept: string) => {
      const deptDoctors = doctorSchedules.filter(s => s.department === dept).map(s => s.doctor_name).filter(Boolean);
      const uniqueDeptDoctors = Array.from(new Set(deptDoctors));
      setDoctorForm(prev => ({
        ...prev,
        department: dept,
        doctor_name: uniqueDeptDoctors.length === 1 ? uniqueDeptDoctors[0]! : ""
      }));
    };
    
    const handleDoctorChange = (docName: string) => {
      const docRecord = doctorSchedules.find(s => s.doctor_name === docName);
      setDoctorForm(prev => ({
        ...prev,
        doctor_name: docName,
        department: docRecord?.department || prev.department
      }));
    };

    return (
      <div className="panel">
        <div className="module-panel-head">
          <h3>Doctor Payouts</h3>
        </div>
        <form className="module-form-grid module-sales-grid" onSubmit={handleDoctorSubmit}>
          <Label>
            Doctor Name
            <Select
              value={doctorForm.doctor_name}
              onChange={(event) => handleDoctorChange(event.target.value)}
              aria-label="Doctor name"
              disabled={!!doctorForm.id}
              required
            >
              <option value="">Select Doctor</option>
              {uniqueDoctors.map(doc => (
                <option key={doc} value={doc}>{doc}</option>
              ))}
            </Select>
          </Label>
          <Label>
            Department
            <Select
              value={doctorForm.department}
              onChange={(event) => handleDepartmentChange(event.target.value)}
              aria-label="Department"
              disabled={!!doctorForm.id}
            >
              <option value="">All Departments</option>
              {uniqueDepartments.map(dept => (
                <option key={dept} value={dept}>{dept}</option>
              ))}
            </Select>
          </Label>
          <Label>
            Payout Month
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Select
                value={doctorForm.payout_month ? doctorForm.payout_month.split("-")[1] : ""}
                onChange={(event) => setDoctorForm((current) => ({
                  ...current,
                  payout_month: `${current.payout_month ? current.payout_month.split("-")[0] : String(currentDate.getFullYear())}-${event.target.value}`
                }))}
                aria-label="Doctor payout month"
                disabled={!!doctorForm.id}
                required
              >
                <option value="">Month</option>
                <option value="01">January</option>
                <option value="02">February</option>
                <option value="03">March</option>
                <option value="04">April</option>
                <option value="05">May</option>
                <option value="06">June</option>
                <option value="07">July</option>
                <option value="08">August</option>
                <option value="09">September</option>
                <option value="10">October</option>
                <option value="11">November</option>
                <option value="12">December</option>
              </Select>
              <Select
                value={doctorForm.payout_month ? doctorForm.payout_month.split("-")[0] : ""}
                onChange={(event) => setDoctorForm((current) => ({
                  ...current,
                  payout_month: `${event.target.value}-${current.payout_month ? current.payout_month.split("-")[1] : String(currentDate.getMonth() + 1).padStart(2, "0")}`
                }))}
                aria-label="Doctor payout year"
                disabled={!!doctorForm.id}
                required
              >
                <option value="">Year</option>
                {Array.from({ length: 5 }, (_, i) => String(currentDate.getFullYear() - 2 + i)).map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </Select>
            </div>
          </Label>
          <Label>
            Total Payout Amount
            <Input
              type="number"
              min={0}
              value={doctorForm.amount}
              onChange={(event) => setDoctorForm((current) => ({ ...current, amount: event.target.value }))}
              placeholder="Total amount"
              aria-label="Doctor payout amount"
            />
          </Label>
          
          {doctorForm.id ? (
            <>
              <Label>
                Paid so far
                <Input
                  type="text"
                  value={formatCurrency(Number(doctorForm.paid_amount) || 0)}
                  disabled
                  aria-label="Doctor payout paid amount"
                />
              </Label>
              <Label>
                Due Amount
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <Input
                    type="text"
                    value={formatCurrency(currentDue)}
                    disabled
                    aria-label="Remaining due amount"
                  />
                  {currentDue > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setDoctorForm((curr) => ({ ...curr, amount_to_pay: String(currentDue) }))}
                    >
                      Clear Due
                    </Button>
                  )}
                </div>
              </Label>
              <Label>
                Amount to Pay Now
                <Input
                  type="number"
                  min={0}
                  max={currentDue}
                  value={doctorForm.amount_to_pay}
                  onChange={(event) => setDoctorForm((current) => ({ ...current, amount_to_pay: event.target.value }))}
                  placeholder="Amount to pay now"
                  aria-label="Amount to pay now"
                  style={{ borderColor: finalPaid > currentTotal ? "var(--error)" : undefined }}
                />
              </Label>
            </>
          ) : (
            <Label>
              Paid Amount
              <Input
                type="number"
                min={0}
                value={doctorForm.paid_amount}
                onChange={(event) => setDoctorForm((current) => ({ ...current, paid_amount: event.target.value }))}
                placeholder="Paid amount"
                aria-label="Doctor payout paid amount"
                style={{ borderColor: finalPaid > currentTotal ? "var(--error)" : undefined }}
              />
            </Label>
          )}

          <Label>
            Payment Date
            <Input
              type="date"
              value={doctorForm.paid_date}
              onChange={(event) => setDoctorForm((current) => ({ ...current, paid_date: event.target.value }))}
              aria-label="Doctor paid date"
            />
          </Label>
          <Label>
            Status
            <Input 
              value={displayStatus}
              disabled
              aria-label="Doctor payout status" 
            />
          </Label>
          <Label>
            Notes
            <Input value={doctorForm.notes} onChange={(event) => setDoctorForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Notes" aria-label="Doctor payout notes" />
          </Label>
          <div style={{ display: "flex", gap: "0.5rem", gridColumn: "span 2" }}>
            <Button type="submit" variant="primary" disabled={savingDoctor}>
              {savingDoctor ? "Saving..." : doctorForm.id ? "Update Payout" : "Record Payout"}
            </Button>
            {doctorForm.id && (
              <Button type="button" variant="secondary" onClick={() => setDoctorForm(DEFAULT_DOCTOR_FORM)}>
                Cancel Edit
              </Button>
            )}
          </div>
        </form>

        {doctorForm.id && selectedPayout?.payments && selectedPayout.payments.length > 0 && (
          <div style={{ marginTop: "2rem", marginBottom: "2rem" }}>
            <h4 style={{ marginBottom: "0.75rem", fontWeight: 600 }}>Payment History Timeline</h4>
            <Table className="module-table" aria-label="Payment history table">
              <TableHead>
                <TableCell>Date & Time</TableCell>
                <TableCell>Amount Paid</TableCell>
                <TableCell>Notes</TableCell>
              </TableHead>
              {selectedPayout.payments.map((pmt: any) => (
                <TableRow key={pmt.id}>
                  <TableCell>{new Date(pmt.paid_date).toLocaleString("en-IN")}</TableCell>
                  <TableCell>{formatCurrency(pmt.amount)}</TableCell>
                  <TableCell>{pmt.notes || "-"}</TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        )}

        {filteredPayouts.length === 0 ? (
          <p className="muted">No doctor payouts yet.</p>
        ) : (
          <Table className="module-table module-table-accounts-doctors" aria-label="Doctor payouts table">
            <TableHead>
              <TableCell>Doctor</TableCell>
              <TableCell>Month</TableCell>
              <TableCell>Total</TableCell>
              <TableCell>Paid</TableCell>
              <TableCell>Due</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Actions</TableCell>
            </TableHead>
            {filteredPayouts.map((payout) => (
              <TableRow key={payout.id}>
                <TableCell>{payout.doctor_name}</TableCell>
                <TableCell>{payout.payout_month}</TableCell>
                <TableCell>{formatCurrency(payout.amount)}</TableCell>
                <TableCell>{formatCurrency(payout.paid_amount)}</TableCell>
                <TableCell>{formatCurrency(payout.due_amount)}</TableCell>
                <TableCell style={{ textTransform: "capitalize", fontWeight: 500, color: payout.status === "paid" ? "var(--accent)" : payout.status === "partial" ? "var(--warning)" : "var(--muted)" }}>{payout.status || "Pending"}</TableCell>
                <TableCell>
                  <div className="module-inline-actions">
                    <Button
                      type="button"
                      onClick={() =>
                        setDoctorForm({
                          id: String(payout.id),
                          doctor_name: payout.doctor_name,
                          payout_month: payout.payout_month,
                          amount: String(payout.amount || 0),
                          paid_amount: String(payout.paid_amount || 0),
                          amount_to_pay: "",
                          paid_date: new Date().toISOString().slice(0, 10),
                          status: payout.status || "pending",
                          notes: payout.notes || "",
                          department: doctorSchedules.find(s => s.doctor_name === payout.doctor_name)?.department || "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button type="button" variant="destructive" onClick={() => void deleteRecord(`/api/accounts/doctors/${payout.id}`, "doctor payout")}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </div>
    );
  };

  const meta = ACCOUNTS_VIEW_CONFIG[view];

  const dataYears = doctorPayouts
    .map((p) => parseInt((p.payout_month || "").substring(0, 4), 10))
    .filter((y) => !isNaN(y));
    
  const currentY = currentDate.getFullYear();
  let minYear = dataYears.length > 0 ? Math.min(...dataYears) : currentY;
  let maxYear = dataYears.length > 0 ? Math.max(...dataYears) : currentY;
  
  if (minYear > currentY - 2) minYear = currentY - 2;
  if (maxYear < currentY + 1) maxYear = currentY + 1;
  
  const availableYears = [];
  for (let y = minYear; y <= maxYear; y++) {
    availableYears.push(String(y));
  }

  return (
    <section className="module-page">
      <div className="module-panel-head" style={{ display: "flex", justifyContent: view === "doctor-payouts" ? "flex-end" : "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
        {view !== "doctor-payouts" && (
          <div>
            <h3>{meta.title}</h3>
            <p className="muted">{meta.subtitle}</p>
          </div>
        )}
        {view === "doctor-payouts" && (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} aria-label="Filter Month" style={{ width: "130px" }}>
              <option value="">All Months</option>
              <option value="01">January</option>
              <option value="02">February</option>
              <option value="03">March</option>
              <option value="04">April</option>
              <option value="05">May</option>
              <option value="06">June</option>
              <option value="07">July</option>
              <option value="08">August</option>
              <option value="09">September</option>
              <option value="10">October</option>
              <option value="11">November</option>
              <option value="12">December</option>
            </Select>
            <Select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} aria-label="Filter Year" style={{ width: "100px" }}>
              {availableYears.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </Select>
            <Button variant="secondary" onClick={() => { 
              setFilterMonth(String(currentDate.getMonth() + 1).padStart(2, "0")); 
              setFilterYear(String(currentDate.getFullYear())); 
            }}>
              Reset
            </Button>
          </div>
        )}
      </div>

      <div className="stat-grid module-stat-grid">
        {view !== "doctor-payouts" && (
          <>
            <StatCard label="Ledger Expense" value={formatCurrency(displaySummary.ledger_expense)} />
            <StatCard label="Net Position" value={formatCurrency(displaySummary.net_position)} />
          </>
        )}
        <StatCard label="Doctor Paid" value={formatCurrency(displaySummary.doctor_paid_total)} />
        <StatCard label="Doctor Due" value={formatCurrency(displaySummary.doctor_due_total)} />
      </div>

      {loading ? <p className="muted">Loading accounts...</p> : null}
      {view === "overview" ? renderOverview() : null}
      {view === "ledger" ? renderLedger() : null}
      {view === "vendor-payments" ? renderVendors() : null}
      {view === "doctor-payouts" ? renderDoctors() : null}
    </section>
  );
}
