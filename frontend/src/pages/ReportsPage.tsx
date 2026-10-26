import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Input, Label, Modal, Table, TableCell, TableHead, TableRow } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { Notice, ReportsOverview } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

type DoctorPayout = {
  id: number;
  doctor_name: string;
  payout_month: string;
  amount: number;
  paid_amount: number;
  due_amount: number;
  status?: string | null;
  paid_date?: string | null;
};

type BillingReportSummary = ReportsOverview["billing_summary"];

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default function ReportsPage({ setNotice }: Props) {
  const [overview, setOverview] = useState<ReportsOverview | null>(null);
  const [doctorPayouts, setDoctorPayouts] = useState<DoctorPayout[]>([]);
  const [selectedReportDate, setSelectedReportDate] = useState(() => toDateInputValue(new Date()));
  const [datedBillingSummary, setDatedBillingSummary] = useState<BillingReportSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<{ type: "module" | "payment_mode"; value: string } | null>(null);
  const [historyData, setHistoryData] = useState<Array<{
    patient_id: string;
    patient_name: string;
    date: string;
    source: string;
    reference: string;
    amount: number;
    payment_mode: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!historyFilter) return;
    let active = true;
    const loadHistory = async () => {
      setHistoryLoading(true);
      try {
        const url = `/api/reports/patient-history?type=${historyFilter.type}&value=${encodeURIComponent(historyFilter.value)}&date=${encodeURIComponent(selectedReportDate || "")}`;
        const data = await apiFetch<any[]>(url);
        if (active) setHistoryData(data);
      } catch (error) {
        if (active) {
          reportError(setNotice, error as { message?: string; status?: number }, "Unable to load patient history.");
          setHistoryData([]);
        }
      } finally {
        if (active) setHistoryLoading(false);
      }
    };
    void loadHistory();
    return () => {
      active = false;
    };
  }, [historyFilter, selectedReportDate, setNotice]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const [data, doctorData] = await Promise.all([
          apiFetch<ReportsOverview>("/api/reports/overview", { signal: controller.signal }),
          apiFetch<{ payouts?: DoctorPayout[] }>("/api/accounts/doctors", { signal: controller.signal }).catch(() => ({ payouts: [] as DoctorPayout[] })),
        ]);
        if (!controller.signal.aborted) {
          setOverview(data);
          setDoctorPayouts(doctorData.payouts || []);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          reportError(setNotice, error as { message?: string; status?: number }, "Unable to load reports overview.");
          setOverview(null);
          setDoctorPayouts([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [setNotice]);

  useEffect(() => {
    const controller = new AbortController();
    const loadDatedSummary = async () => {
      if (!selectedReportDate) {
        setDatedBillingSummary(null);
        return;
      }
      try {
        const data = await apiFetch<BillingReportSummary>(`/api/reports/revenue-summary?date=${encodeURIComponent(selectedReportDate)}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setDatedBillingSummary(data);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          reportError(setNotice, error as { message?: string; status?: number }, "Unable to load day-wise collections.");
          setDatedBillingSummary(null);
        }
      }
    };
    void loadDatedSummary();
    return () => controller.abort();
  }, [selectedReportDate, setNotice]);

  const activeBillingSummary = datedBillingSummary || overview?.billing_summary;
  const collectionsByModule = useMemo(() => {
    const raw = activeBillingSummary?.collections_by_module || [];
    const map = new Map<string, number>();
    for (const item of raw) {
      let key = (item.label || "").trim();
      const lower = key.toLowerCase();
      if (lower === "pharmacy") key = "Pharmacy";
      else if (lower.includes("lab") || lower.includes("diag")) key = "Lab / Diagnostics";
      else if (lower.includes("op") || lower.includes("consult") || lower.includes("billing")) key = "OP / Billing";
      else if (lower.includes("ip") || lower.includes("inpatient") || lower.includes("bed")) key = "IP / Inpatient";
      map.set(key, (map.get(key) || 0) + Number(item.count || 0));
    }
    return Array.from(map.entries()).map(([label, count]) => ({ label, count }));
  }, [activeBillingSummary]);
  const paymentMethodRows = useMemo(() => activeBillingSummary?.payment_mode_breakdown || [], [activeBillingSummary]);
  const doctorPayoutRows = useMemo(() => {
    const grouped = new Map<string, { doctor_name: string; amount: number; paid_amount: number; due_amount: number; latest_month: string; status: string }>();
    doctorPayouts.forEach((payout) => {
      const name = (payout.doctor_name || "Unassigned Doctor").trim();
      const current = grouped.get(name) || { doctor_name: name, amount: 0, paid_amount: 0, due_amount: 0, latest_month: "", status: "pending" };
      current.amount += Number(payout.amount || 0);
      current.paid_amount += Number(payout.paid_amount || 0);
      current.due_amount += Number(payout.due_amount || 0);
      if (String(payout.payout_month || "") > current.latest_month) current.latest_month = String(payout.payout_month || "");
      current.status = current.due_amount <= 0 && current.paid_amount > 0 ? "paid" : current.paid_amount > 0 ? "partial" : "pending";
      grouped.set(name, current);
    });
    return Array.from(grouped.values()).sort((a, b) => b.paid_amount - a.paid_amount || a.doctor_name.localeCompare(b.doctor_name));
  }, [doctorPayouts]);
  const maxModuleCollectionValue = Math.max(1, ...collectionsByModule.map((row) => Number(row.count || 0)));
  const maxPaymentMethodValue = Math.max(1, ...paymentMethodRows.map((row) => Number(row.count || 0)));

  return (
    <section className="module-page revenue-reports-page">
      <span style={{ display: "none" }}>Revenue Reports</span>

      <div className="revenue-reports-subhead">
        <h3>Collections by Module</h3>
        <p className="muted">Monitor amount collected per billing module and payment method.</p>
      </div>

      <div className="panel revenue-report-calendar-card">
        <Label>
          Select Collection Date
          <Input
            type="date"
            value={selectedReportDate}
            onChange={(event) => setSelectedReportDate(event.target.value)}
            aria-label="Reports collection date"
          />
        </Label>
        <div>
          <span>Day-wise Collected</span>
          <strong>{formatCurrency(activeBillingSummary?.total_collected)}</strong>
        </div>
        <div>
          <span>Day-wise Due</span>
          <strong>{formatCurrency(activeBillingSummary?.total_due)}</strong>
        </div>
      </div>

      {loading ? <p className="muted">Loading reports...</p> : null}

      <div className="stat-grid module-stat-grid revenue-report-summary-grid">
        <StatCard label="Total Billed" value={formatCurrency(activeBillingSummary?.total_billed)} />
        <StatCard label="Collected" value={formatCurrency(activeBillingSummary?.total_collected)} />
        <StatCard label="Pending Due" value={formatCurrency(activeBillingSummary?.total_due)} />
      </div>

      <div className="panel revenue-module-chart-card">
        <div className="module-panel-head">
          <h3>Collections by Module</h3>
        </div>
        {collectionsByModule.length === 0 ? (
          <p className="muted">No collection records available.</p>
        ) : (
          <div className="revenue-module-bars">
            {collectionsByModule.map((row) => (
              <div
                key={row.label}
                className="revenue-module-bar-row"
                onClick={() => {
                  setHistoryFilter({ type: "module", value: row.label });
                  setHistoryModalOpen(true);
                }}
              >
                <span>{row.label}</span>
                <div className="revenue-module-bar-track">
                  <div className="revenue-module-bar-fill" style={{ width: `${Number(row.count || 0) <= 0 ? 0 : Math.max(4, (Number(row.count || 0) / maxModuleCollectionValue) * 100)}%` }} />
                </div>
                <strong>{formatCurrency(row.count)}</strong>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel revenue-module-chart-card">
        <div className="module-panel-head">
          <h3>Collections by Payment Method</h3>
        </div>
        {paymentMethodRows.length === 0 ? (
          <p className="muted">No payment method records available.</p>
        ) : (
          <div className="revenue-module-bars">
            {paymentMethodRows.map((row) => (
              <div
                key={row.label}
                className="revenue-module-bar-row"
                onClick={() => {
                  setHistoryFilter({ type: "payment_mode", value: row.label });
                  setHistoryModalOpen(true);
                }}
              >
                <span>{row.label}</span>
                <div className="revenue-module-bar-track">
                  <div className="revenue-module-bar-fill payment-method-fill" style={{ width: `${Number(row.count || 0) <= 0 ? 0 : Math.max(4, (Number(row.count || 0) / maxPaymentMethodValue) * 100)}%` }} />
                </div>
                <strong>{formatCurrency(row.count)}</strong>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel revenue-doctor-payout-card">
        <div className="module-panel-head">
          <h3>Doctors Payout</h3>
        </div>
        {doctorPayoutRows.length === 0 ? (
          <p className="muted">No doctor payout records available.</p>
        ) : (
          <div className="doctor-payout-report-list">
            {doctorPayoutRows.map((payout) => (
              <div key={payout.doctor_name} className="doctor-payout-report-row">
                <div>
                  <strong>{payout.doctor_name}</strong>
                  <span>{payout.latest_month || "No month"} · {payout.status}</span>
                </div>
                <div>
                  <span>Paid</span>
                  <strong>{formatCurrency(payout.paid_amount)}</strong>
                </div>
                <div>
                  <span>Due</span>
                  <strong>{formatCurrency(payout.due_amount)}</strong>
                </div>
                <div>
                  <span>Total</span>
                  <strong>{formatCurrency(payout.amount)}</strong>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={historyModalOpen}
        onClose={() => {
          setHistoryModalOpen(false);
          setHistoryFilter(null);
          setHistoryData([]);
        }}
        title={`Patient History - ${historyFilter?.value || ""}`}
        description={`Showing patient records for ${selectedReportDate}`}
        className="revenue-history-modal"
      >
        {historyLoading ? (
          <p className="muted" style={{ padding: "1rem 0" }}>Loading patient details...</p>
        ) : historyData.length === 0 ? (
          <p className="muted" style={{ padding: "1rem 0" }}>No patient history found for this selection.</p>
        ) : (
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            <Table className="module-table module-table-history" aria-label="Transaction history table">
              <TableHead>
                <TableCell>Date & Time</TableCell>
                <TableCell>Patient ID</TableCell>
                <TableCell>Patient Name</TableCell>
                <TableCell>Reference</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Payment Mode</TableCell>
                <TableCell style={{ textAlign: "right" }}>Amount</TableCell>
              </TableHead>
              {historyData.map((item, idx) => (
                <TableRow key={idx}>
                  <TableCell>{formatDateTime(item.date)}</TableCell>
                  <TableCell>{item.patient_id}</TableCell>
                  <TableCell>{item.patient_name}</TableCell>
                  <TableCell>{item.reference}</TableCell>
                  <TableCell>{item.source}</TableCell>
                  <TableCell>{item.payment_mode}</TableCell>
                  <TableCell style={{ textAlign: "right", fontWeight: "bold" }}>{formatCurrency(item.amount)}</TableCell>
                </TableRow>
              ))}
            </Table>
            <div className="module-mobile-list" style={{ gap: "0.5rem" }} aria-label="Transaction history cards">
              {historyData.map((item, idx) => (
                <article className="module-mobile-card" key={`hist-${idx}`} style={{ padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(0,0,0,0.08)", background: "#fafafa" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                    <strong>{item.patient_name}</strong>
                    <span style={{ fontWeight: "bold", color: "#0d5d65" }}>{formatCurrency(item.amount)}</span>
                  </div>
                  <p style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}><strong>ID:</strong> {item.patient_id}</p>
                  <p style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}><strong>When:</strong> {formatDateTime(item.date)}</p>
                  <p style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}><strong>Reference:</strong> {item.reference}</p>
                  <p style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}><strong>Module:</strong> {item.source}</p>
                  <p style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}><strong>Paid via:</strong> {item.payment_mode}</p>
                </article>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
