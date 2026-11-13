import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select } from "../components/ui";
import PatientSearchPicker from "../components/PatientSearchPicker";
import { apiFetch, reportError } from "../lib/api";
import type { Notice, Patient } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

export type HospitalBed = {
  id: number;
  ward: string;
  room_no: string;
  bed_no: string;
  bed_type: string;
  daily_rate: number;
  status: "available" | "occupied" | "maintenance" | string;
  notes?: string;
  allocation_id?: number | null;
  patient_id?: string | null;
  patient_name?: string | null;
  patient_age?: number | null;
  patient_gender?: string | null;
  patient_phone?: string | null;
  allocated_at?: string | null;
  alloc_rate?: number | null;
  discharge_date?: string | null;
  admission_notes?: string | null;
};

type BedSummary = {
  total: number;
  occupied: number;
  available: number;
  occupancy_rate: number;
};

type WardStat = {
  ward: string;
  total: number;
  available: number;
  occupied: number;
  maintenance: number;
};

type DischargeBillPreview = {
  patient: { patient_id: string; name?: string; age?: number; gender?: string; phone?: string };
  admission_date_formatted?: string;
  discharge_date_formatted?: string;
  hours_stayed: number;
  days_stayed: number;
  rate_per_day: number;
  bed_total: number;
  pharmacy_items: { id: number; medicine_name: string; quantity: number; amount: number; sold_at_formatted?: string }[];
  pharmacy_total: number;
  diag_items: { id: number; service_name: string; amount: number }[];
  diag_total: number;
  grand_total: number;
};

export default function BedManagementPage({ setNotice, onNavigate }: Props) {
  const [beds, setBeds] = useState<HospitalBed[]>([]);
  const [summary, setSummary] = useState<BedSummary>({ total: 15, occupied: 0, available: 15, occupancy_rate: 0 });
  const [wardStats, setWardStats] = useState<WardStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedWardFilter, setSelectedWardFilter] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("all");

  // ---------- Modals ----------
  // 1. Allocate Bed Modal
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [allocatePatient, setAllocatePatient] = useState<Patient | null>(null);
  const [allocateForm, setAllocateForm] = useState({
    ward: "General Ward",
    room_no: "GW-Wing A",
    bed_no: "",
    amount_per_day: "800",
    total_days: "1",
    triage_acuity: "Stable",
  });
  const [allocating, setAllocating] = useState(false);

  // 2. Add New Bed Modal
  const [addBedOpen, setAddBedOpen] = useState(false);
  const [addBedForm, setAddBedForm] = useState({
    ward: "General Ward",
    custom_ward: "",
    room_no: "GW-Wing A",
    bed_no: "",
    bed_type: "Standard Ward",
    daily_rate: "800",
    notes: "Equipped with oxygen & semi-fowler controls",
  });
  const [addingBed, setAddingBed] = useState(false);

  // 3. Bed Details / Quick Action Modal
  const [viewBed, setViewBed] = useState<HospitalBed | null>(null);
  // Live stay figures (days so far, running charges) for the occupied bed being viewed.
  const [stayBill, setStayBill] = useState<DischargeBillPreview | null>(null);
  const [loadingStayBill, setLoadingStayBill] = useState(false);
  useEffect(() => {
    setStayBill(null);
    if (!viewBed || viewBed.status !== "occupied" || !viewBed.allocation_id) return;
    let cancelled = false;
    setLoadingStayBill(true);
    apiFetch<DischargeBillPreview>(`/api/bed/allocations/${viewBed.allocation_id}/discharge-bill`)
      .then((r) => { if (!cancelled) setStayBill(r); })
      .catch(() => { /* needs billing access; the rest of the details still show */ })
      .finally(() => { if (!cancelled) setLoadingStayBill(false); });
    return () => { cancelled = true; };
  }, [viewBed?.id, viewBed?.allocation_id, viewBed?.status]);

  // 4. Discharge & Bill Modal
  const [dischargeBed, setDischargeBed] = useState<HospitalBed | null>(null);
  const [dischargePreview, setDischargePreview] = useState<DischargeBillPreview | null>(null);
  const [loadingDischargePreview, setLoadingDischargePreview] = useState(false);
  const [dischargeForm, setDischargeForm] = useState({
    discount: "0",
    advance_paid: "0",
    payment_mode: "cash",
    notes: "Discharged in stable condition",
  });
  const [submittingDischarge, setSubmittingDischarge] = useState(false);

  const loadBeds = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        beds: HospitalBed[];
        summary: BedSummary;
        wards: WardStat[];
      }>("/api/beds");
      setBeds(res.beds || []);
      if (res.summary) setSummary(res.summary);
      if (res.wards) setWardStats(res.wards);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load bed inventory.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBeds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quick helper to determine triage styling for each bed
  const getTriageStyle = (bed: HospitalBed) => {
    if (bed.status === "maintenance") {
      return {
        label: "Maintenance / Sanitizing",
        bg: "#f8fafc",
        border: "#cbd5e1",
        color: "#475569",
        badgeBg: "#f1f5f9",
        badgeText: "#334155",
        dotColor: "#94a3b8",
        level: "Maintenance",
      };
    }
    if (bed.status === "available") {
      return {
        label: "Available & Ready",
        bg: "#f0fdf4",
        border: "#86efac",
        color: "#166534",
        badgeBg: "#dcfce7",
        badgeText: "#15803d",
        dotColor: "#22c55e",
        level: "Available",
      };
    }
    // Occupied beds: color code by Ward / Acuity
    const isIcu = bed.ward.toLowerCase().includes("icu") || bed.bed_type.toLowerCase().includes("critical");
    const isSingle = bed.ward.toLowerCase().includes("single") || bed.bed_type.toLowerCase().includes("deluxe");

    if (isIcu) {
      return {
        label: "Critical Care / Resuscitation",
        bg: "#fef2f2",
        border: "#fca5a5",
        color: "#991b1b",
        badgeBg: "#fee2e2",
        badgeText: "#b91c1c",
        dotColor: "#ef4444",
        level: "Critical",
      };
    }
    if (isSingle) {
      return {
        label: "Deluxe Inpatient Care",
        bg: "#eff6ff",
        border: "#93c5fd",
        color: "#1e40af",
        badgeBg: "#dbeafe",
        badgeText: "#1d4ed8",
        dotColor: "#3b82f6",
        level: "Deluxe",
      };
    }
    return {
      label: "General Inpatient Care",
      bg: "#fffbeb",
      border: "#fde68a",
      color: "#92400e",
      badgeBg: "#fef3c7",
      badgeText: "#b45309",
      dotColor: "#f59e0b",
      level: "Standard",
    };
  };

  // Open allocate modal with optional pre-filled bed
  const handleOpenAllocate = (bed?: HospitalBed) => {
    setAllocatePatient(null);
    if (bed) {
      setAllocateForm({
        ward: bed.ward,
        room_no: bed.room_no,
        bed_no: bed.bed_no,
        amount_per_day: String(bed.daily_rate),
        total_days: "1",
        triage_acuity: bed.ward.toLowerCase().includes("icu") ? "Critical" : "Stable",
      });
    } else {
      const firstAvailable = beds.find((b) => b.status === "available");
      setAllocateForm({
        ward: firstAvailable?.ward || "General Ward",
        room_no: firstAvailable?.room_no || "GW-Wing A",
        bed_no: firstAvailable?.bed_no || "",
        amount_per_day: String(firstAvailable?.daily_rate || 800),
        total_days: "1",
        triage_acuity: "Stable",
      });
    }
    setAllocateOpen(true);
  };

  const handleBedSelectInAllocate = (bedNo: string) => {
    const target = beds.find((b) => b.bed_no === bedNo);
    if (target) {
      setAllocateForm((p) => ({
        ...p,
        ward: target.ward,
        room_no: target.room_no,
        bed_no: target.bed_no,
        amount_per_day: String(target.daily_rate),
        triage_acuity: target.ward.toLowerCase().includes("icu") ? "Critical" : p.triage_acuity,
      }));
    }
  };

  const submitAllocate = async () => {
    if (!allocatePatient) {
      setNotice({ type: "warning", message: "Search and select a patient first." });
      return;
    }
    if (!allocateForm.ward.trim() || !allocateForm.room_no.trim() || !allocateForm.bed_no.trim()) {
      setNotice({ type: "warning", message: "Ward, room number, and bed number are required." });
      return;
    }
    setAllocating(true);
    try {
      const amountPerDay = Number(allocateForm.amount_per_day) || 0;
      const totalDays = Number(allocateForm.total_days) || 1;
      await apiFetch("/api/bed/allot", {
        method: "POST",
        body: JSON.stringify({
          patient_id: allocatePatient.patient_id,
          ward: allocateForm.ward.trim(),
          room_no: allocateForm.room_no.trim(),
          bed_no: allocateForm.bed_no.trim(),
          amount_per_day: amountPerDay,
          total_days: totalDays,
          total_amount: amountPerDay * totalDays,
        }),
      });
      setNotice({
        type: "success",
        message: `Bed ${allocateForm.bed_no} (${allocateForm.ward}) allocated to ${allocatePatient.name} [${allocatePatient.patient_id}].`,
      });
      setAllocateOpen(false);
      await loadBeds();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to allocate bed.");
    } finally {
      setAllocating(false);
    }
  };

  // Add / Expand more beds dynamically
  const submitAddBed = async () => {
    const wardName = addBedForm.ward === "Other" ? addBedForm.custom_ward.trim() : addBedForm.ward.trim();
    if (!wardName || !addBedForm.room_no.trim() || !addBedForm.bed_no.trim()) {
      setNotice({ type: "warning", message: "Please fill in Ward, Room No, and Bed No." });
      return;
    }
    setAddingBed(true);
    try {
      await apiFetch("/api/beds", {
        method: "POST",
        body: JSON.stringify({
          ward: wardName,
          room_no: addBedForm.room_no.trim(),
          bed_no: addBedForm.bed_no.trim().toUpperCase(),
          bed_type: addBedForm.bed_type,
          daily_rate: Number(addBedForm.daily_rate) || 1000,
          notes: addBedForm.notes.trim(),
        }),
      });
      setNotice({
        type: "success",
        message: `New bed ${addBedForm.bed_no.toUpperCase()} created in ${wardName}. Hospital capacity expanded.`,
      });
      setAddBedOpen(false);
      setAddBedForm({
        ward: "General Ward",
        custom_ward: "",
        room_no: "GW-Wing A",
        bed_no: "",
        bed_type: "Standard Ward",
        daily_rate: "800",
        notes: "Equipped with oxygen & semi-fowler controls",
      });
      await loadBeds();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create new bed.");
    } finally {
      setAddingBed(false);
    }
  };

  // Toggle Maintenance / Available status
  const handleToggleBedStatus = async (bed: HospitalBed, newStatus: string) => {
    try {
      await apiFetch("/api/beds/status", {
        method: "POST",
        body: JSON.stringify({
          ward: bed.ward,
          bed_no: bed.bed_no,
          status: newStatus,
        }),
      });
      setNotice({
        type: "success",
        message: `Bed ${bed.bed_no} marked as ${newStatus}.`,
      });
      if (viewBed && viewBed.id === bed.id) {
        setViewBed(null);
      }
      await loadBeds();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update bed status.");
    }
  };

  // Discharge & Bill: open the preview modal (computes bed + running pharmacy
  // + diagnostics charges) before actually releasing the bed. Settlement
  // (invoice creation, admission discharge_date, bed release) only happens
  // once the user confirms in the modal -- see confirmDischargeBill below.
  const openDischargeBill = async (bed: HospitalBed) => {
    if (!bed.allocation_id) {
      // Legacy bed record with no linked allocation -- nothing to bill.
      await handleToggleBedStatus(bed, "available");
      return;
    }
    setDischargeBed(bed);
    setDischargePreview(null);
    setDischargeForm({ discount: "0", advance_paid: "0", payment_mode: "cash", notes: "Discharged in stable condition" });
    setLoadingDischargePreview(true);
    try {
      const preview = await apiFetch<DischargeBillPreview>(`/api/bed/allocations/${bed.allocation_id}/discharge-bill`);
      setDischargePreview(preview);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to compute the discharge bill.");
      setDischargeBed(null);
    } finally {
      setLoadingDischargePreview(false);
    }
  };

  const confirmDischargeBill = async () => {
    if (!dischargeBed?.allocation_id) return;
    setSubmittingDischarge(true);
    try {
      const res = await apiFetch<{ invoice_no: string; total_amount: number; paid_amount: number }>(
        `/api/bed/allocations/${dischargeBed.allocation_id}/discharge`,
        {
          method: "POST",
          body: JSON.stringify({
            discount: Number(dischargeForm.discount) || 0,
            advance_paid: Number(dischargeForm.advance_paid) || 0,
            payment_mode: dischargeForm.payment_mode,
            notes: dischargeForm.notes,
          }),
        }
      );
      setNotice({
        type: "success",
        message: `${dischargeBed.patient_name || "Patient"} discharged from ${dischargeBed.ward} / ${dischargeBed.bed_no}. Invoice ${res.invoice_no} generated for ₹${res.total_amount.toFixed(2)} (₹${res.paid_amount.toFixed(2)} collected now).`,
      });
      setDischargeBed(null);
      setDischargePreview(null);
      if (viewBed) setViewBed(null);
      await loadBeds();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to settle the discharge bill.");
    } finally {
      setSubmittingDischarge(false);
    }
  };

  // Filtered beds
  const filteredBeds = beds.filter((b) => {
    if (selectedWardFilter !== "all" && b.ward !== selectedWardFilter) return false;
    if (selectedStatusFilter !== "all" && b.status !== selectedStatusFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      b.bed_no.toLowerCase().includes(q) ||
      b.ward.toLowerCase().includes(q) ||
      b.room_no.toLowerCase().includes(q) ||
      (b.patient_name && b.patient_name.toLowerCase().includes(q)) ||
      (b.patient_id && b.patient_id.toLowerCase().includes(q))
    );
  });

  // Group filtered beds by ward for structured ward displays
  const wardGroups: Record<string, HospitalBed[]> = {};
  filteredBeds.forEach((bed) => {
    if (!wardGroups[bed.ward]) {
      wardGroups[bed.ward] = [];
    }
    wardGroups[bed.ward].push(bed);
  });

  // Ensure ICU, General Ward, and Single Room always have their dedicated section order
  const standardWards = ["ICU", "General Ward", "Single Room"];
  const allWardNames = Array.from(new Set([...standardWards, ...Object.keys(wardGroups)]));

  const availableBedsList = beds.filter((b) => b.status === "available");
  const occupiedBedsList = beds.filter((b) => b.status === "occupied");

  return (
    <div className="hosp-dashboard" style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* 1. TOP HEADER & BREADCRUMB - Matching DashboardPage */}
      <div className="hosp-dashboard-top" style={{ marginBottom: "18px" }}>
        <div>
          <div className="hosp-dashboard-eyebrow">
            <span>HospAI</span>
            <span>/</span>
            <span>IP Management</span>
            <span>/</span>
            <span style={{ color: "#0f172a", fontWeight: 700 }}>Bed Management</span>
          </div>
          <h1 className="hosp-dashboard-page-title" style={{ fontSize: "28px", fontWeight: 800, margin: "2px 0 4px", color: "#0f172a" }}>
            Bed Management & Ward Allocation
          </h1>
          <p className="hosp-dashboard-page-subtitle" style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
            Real-time occupancy, triage acuity tracking, and ward expansion capacity.
          </p>
        </div>

        <div className="hosp-dashboard-top-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Button
            variant="ghost"
            onClick={() => void loadBeds()}
            style={{ display: "flex", alignItems: "center", gap: "6px", background: "#ffffff", border: "1px solid #cbd5e1" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>Refresh</span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => setAddBedOpen(true)}
            style={{ background: "#ffffff", border: "1.5px solid #00828a", color: "#00828a", fontWeight: 700 }}
          >
            + Add / Expand More Beds
          </Button>
          <Button
            variant="primary"
            onClick={() => handleOpenAllocate()}
            style={{ background: "#00828a", borderColor: "#00828a", fontWeight: 700 }}
          >
            + Allocate Bed
          </Button>
        </div>
      </div>

      {/* 2. EXECUTIVE KPI ROW - Using exact 6-card .hosp-kpi-row matching Main Dashboard */}
      <div className="hosp-kpi-row" style={{ marginBottom: "20px" }}>
        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#3b82f6,#2563eb)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#3b82f6,#2563eb)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Total Bed Capacity</p>
            <h3 className="hosp-kpi-value">{summary.total} Beds</h3>
            <span className="hosp-kpi-sub">Hospital-wide configured</span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#10b981,#059669)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#10b981,#059669)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Available & Ready</p>
            <h3 className="hosp-kpi-value" style={{ color: "#16a34a" }}>{summary.available} Beds</h3>
            <span className="hosp-kpi-sub" style={{ color: "#16a34a", fontWeight: 600 }}>
              {summary.total > 0 ? ((summary.available / summary.total) * 100).toFixed(0) : 0}% ready for admission
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#ef4444,#dc2626)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#ef4444,#dc2626)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Occupied Inpatients</p>
            <h3 className="hosp-kpi-value" style={{ color: "#dc2626" }}>{summary.occupied} Beds</h3>
            <span className="hosp-kpi-sub" style={{ color: "#dc2626", fontWeight: 600 }}>
              {summary.occupancy_rate}% occupancy rate
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#dc2626,#991b1b)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#dc2626,#991b1b)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">ICU Beds</p>
            <h3 className="hosp-kpi-value">{beds.filter((b) => b.ward.toLowerCase().includes("icu")).length || 5} Beds</h3>
            <span className="hosp-kpi-sub" style={{ color: "#b91c1c", fontWeight: 600 }}>
              {beds.filter((b) => b.ward.toLowerCase().includes("icu") && b.status === "available").length} Critical Available
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#f59e0b,#d97706)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">General Ward</p>
            <h3 className="hosp-kpi-value">{beds.filter((b) => b.ward.toLowerCase().includes("general")).length || 5} Beds</h3>
            <span className="hosp-kpi-sub" style={{ color: "#b45309", fontWeight: 600 }}>
              {beds.filter((b) => b.ward.toLowerCase().includes("general") && b.status === "available").length} Ward Available
            </span>
          </div>
        </div>

        <div className="hosp-kpi-card" style={{ "--kpi-accent": "linear-gradient(135deg,#8b5cf6,#6d28d9)" } as React.CSSProperties}>
          <div className="hosp-kpi-icon" style={{ background: "linear-gradient(135deg,#8b5cf6,#6d28d9)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <div className="hosp-kpi-body">
            <p className="hosp-kpi-label">Single Room</p>
            <h3 className="hosp-kpi-value">{beds.filter((b) => b.ward.toLowerCase().includes("single")).length || 5} Rooms</h3>
            <span className="hosp-kpi-sub" style={{ color: "#6d28d9", fontWeight: 600 }}>
              {beds.filter((b) => b.ward.toLowerCase().includes("single") && b.status === "available").length} Deluxe Available
            </span>
          </div>
        </div>
      </div>

      {/* 3. TRIAGE ACUITY COLOR CODING LEGEND (Prominent Banner) */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "14px 20px",
          marginBottom: "20px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <span style={{ fontSize: "12px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>
              Clinical Triage & Bed Status Guide:
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 0 2px #bbf7d0" }} />
              <strong style={{ color: "#166534" }}>Available & Ready</strong>
              <span style={{ color: "#64748b", fontSize: "11.5px" }}>(Prepped)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "50%", background: "#ef4444", boxShadow: "0 0 0 2px #fecaca" }} />
              <strong style={{ color: "#991b1b" }}>Critical / ICU</strong>
              <span style={{ color: "#64748b", fontSize: "11.5px" }}>(High Acuity)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "50%", background: "#f59e0b", boxShadow: "0 0 0 2px #fde68a" }} />
              <strong style={{ color: "#92400e" }}>Urgent / Step-down</strong>
              <span style={{ color: "#64748b", fontSize: "11.5px" }}>(General IP)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "50%", background: "#3b82f6", boxShadow: "0 0 0 2px #bfdbfe" }} />
              <strong style={{ color: "#1e40af" }}>Deluxe Private</strong>
              <span style={{ color: "#64748b", fontSize: "11.5px" }}>(Single Room)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "50%", background: "#94a3b8", boxShadow: "0 0 0 2px #e2e8f0" }} />
              <strong style={{ color: "#475569" }}>Maintenance / Sanitizing</strong>
            </div>
          </div>
        </div>
      </div>

      {/* 4. FILTER & SEARCH BAR */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "14px 18px",
          marginBottom: "20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#334155" }}>Filter Ward:</span>
          <button
            type="button"
            onClick={() => setSelectedWardFilter("all")}
            style={{
              padding: "5px 12px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: 700,
              border: "1px solid",
              cursor: "pointer",
              background: selectedWardFilter === "all" ? "#00828a" : "#ffffff",
              color: selectedWardFilter === "all" ? "#ffffff" : "#64748b",
              borderColor: selectedWardFilter === "all" ? "#00828a" : "#cbd5e1",
            }}
          >
            All Wards ({beds.length})
          </button>
          {allWardNames.map((w) => {
            const count = beds.filter((b) => b.ward === w).length;
            if (count === 0) return null;
            const isSelected = selectedWardFilter === w;
            return (
              <button
                key={w}
                type="button"
                onClick={() => setSelectedWardFilter(w)}
                style={{
                  padding: "5px 12px",
                  borderRadius: "20px",
                  fontSize: "12px",
                  fontWeight: 700,
                  border: "1px solid",
                  cursor: "pointer",
                  background: isSelected ? "#00828a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#64748b",
                  borderColor: isSelected ? "#00828a" : "#cbd5e1",
                }}
              >
                {w} ({count})
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <select
            value={selectedStatusFilter}
            onChange={(e) => setSelectedStatusFilter(e.target.value)}
            style={{
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              fontSize: "12.5px",
              fontWeight: 600,
              background: "#ffffff",
              color: "#334155",
            }}
          >
            <option value="all">All Bed Statuses</option>
            <option value="available">Available ({summary.available})</option>
            <option value="occupied">Occupied ({summary.occupied})</option>
            <option value="maintenance">Maintenance</option>
          </select>

          <div style={{ width: "240px" }}>
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bed no, patient, UHID..."
              style={{ height: "34px", fontSize: "12.5px" }}
            />
          </div>
        </div>
      </div>

      {/* 5. VISUAL BED GRIDS GROUPED BY WARD */}
      {loading && beds.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
          <p style={{ color: "#64748b", fontSize: "14px" }}>Loading real-time bed occupancy...</p>
        </div>
      ) : (
        allWardNames.map((wardName) => {
          const wardBeds = wardGroups[wardName] || [];
          if (wardBeds.length === 0 && selectedWardFilter !== "all" && selectedWardFilter !== wardName) {
            return null;
          }
          const wardAvailable = wardBeds.filter((b) => b.status === "available").length;
          const wardOccupied = wardBeds.filter((b) => b.status === "occupied").length;
          const isIcu = wardName.toLowerCase().includes("icu");
          const isSingle = wardName.toLowerCase().includes("single");

          return (
            <div
              key={wardName}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "14px",
                padding: "20px 24px",
                marginBottom: "24px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              {/* Ward Header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderBottom: "1px solid #f1f5f9",
                  paddingBottom: "14px",
                  marginBottom: "16px",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "8px",
                      background: isIcu ? "#fee2e2" : isSingle ? "#dbeafe" : "#fef3c7",
                      color: isIcu ? "#b91c1c" : isSingle ? "#1d4ed8" : "#b45309",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                    }}
                  >
                    {isIcu ? "ICU" : isSingle ? "SR" : "GW"}
                  </div>
                  <div>
                    <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
                      {wardName}
                    </h2>
                    <span style={{ fontSize: "12px", color: "#64748b" }}>
                      {isIcu
                        ? "Critical Care Unit • Ventilator & Telemetry Monitoring • 5 Core Beds"
                        : isSingle
                        ? "Deluxe Private Suite • Attendant Bed & Dedicated AC • 5 Core Rooms"
                        : "General Inpatient Ward • 24/7 Nursing Supervision • 5 Core Beds"}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ fontSize: "12.5px", color: "#64748b" }}>
                    <span style={{ color: "#16a34a", fontWeight: 700 }}>{wardAvailable} Available</span> ·{" "}
                    <span style={{ color: "#dc2626", fontWeight: 700 }}>{wardOccupied} Occupied</span> ·{" "}
                    <span style={{ color: "#0f172a", fontWeight: 700 }}>{wardBeds.length} Total</span>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAddBedForm((p) => ({
                        ...p,
                        ward: wardName,
                        bed_type: isIcu ? "Critical Care" : isSingle ? "Deluxe Private" : "Standard Ward",
                        daily_rate: isIcu ? "3500" : isSingle ? "2000" : "800",
                      }));
                      setAddBedOpen(true);
                    }}
                    style={{ fontSize: "12px", height: "30px", padding: "0 10px", color: "#00828a", border: "1px solid #99f6e4" }}
                  >
                    + Add Bed in {wardName}
                  </Button>
                </div>
              </div>

              {/* Bed Cards Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: "16px",
                }}
              >
                {wardBeds.map((bed) => {
                  const triage = getTriageStyle(bed);
                  const isOccupied = bed.status === "occupied";
                  const isMaintenance = bed.status === "maintenance";

                  return (
                    <div
                      key={bed.id}
                      style={{
                        background: triage.bg,
                        border: `1.5px solid ${triage.border}`,
                        borderRadius: "12px",
                        padding: "16px",
                        position: "relative",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        minHeight: "170px",
                        transition: "transform 0.15s ease, box-shadow 0.15s ease",
                      }}
                    >
                      {/* Top Row: Bed No & Triage Status Badge */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span
                                style={{
                                  width: "8px",
                                  height: "8px",
                                  borderRadius: "50%",
                                  background: triage.dotColor,
                                  boxShadow: isOccupied ? `0 0 0 3px ${triage.border}` : "none",
                                }}
                              />
                              <span style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", letterSpacing: "-0.01em" }}>
                                {bed.bed_no}
                              </span>
                            </div>
                            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>
                              {bed.room_no} · ₹{bed.daily_rate}/day
                            </span>
                          </div>

                          <span
                            style={{
                              background: triage.badgeBg,
                              color: triage.badgeText,
                              fontSize: "11px",
                              fontWeight: 700,
                              padding: "2px 8px",
                              borderRadius: "12px",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                            }}
                          >
                            {isOccupied ? "Occupied" : isMaintenance ? "Cleaning" : "Ready"}
                          </span>
                        </div>

                        {/* Bed Content */}
                        {isOccupied ? (
                          <div style={{ marginTop: "8px", padding: "8px 10px", background: "#ffffff", borderRadius: "8px", border: `1px solid ${triage.border}` }}>
                            <div style={{ fontSize: "13px", fontWeight: 800, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {bed.patient_name || "Patient Admitted"}
                            </div>
                            <div style={{ fontSize: "11px", color: "#64748b", display: "flex", justifyContent: "space-between", marginTop: "2px" }}>
                              <span>{bed.patient_id}</span>
                              {bed.patient_age && <span>{bed.patient_age}y / {bed.patient_gender}</span>}
                            </div>
                            {bed.allocated_at && (
                              <div style={{ fontSize: "10.5px", color: "#94a3b8", marginTop: "4px" }}>
                                Admitted: {new Date(bed.allocated_at).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ marginTop: "10px", padding: "8px 10px", background: "#ffffff", borderRadius: "8px", border: "1px dashed #cbd5e1" }}>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: "#166534" }}>
                              {isMaintenance ? "Terminally Sanitizing" : "Prepped for Admission"}
                            </div>
                            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                              {bed.notes || bed.bed_type}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Bottom Quick Action Buttons */}
                      <div style={{ display: "flex", gap: "6px", marginTop: "12px", paddingTop: "8px", borderTop: `1px solid ${triage.border}` }}>
                        {isOccupied ? (
                          <>
                            <Button
                              variant="ghost"
                              onClick={() => setViewBed(bed)}
                              style={{ flex: 1, height: "30px", fontSize: "11.5px", padding: 0 }}
                            >
                              Details
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => void openDischargeBill(bed)}
                              style={{ flex: 1, height: "30px", fontSize: "11.5px", padding: 0, color: "#dc2626", borderColor: "#fca5a5" }}
                            >
                              Discharge
                            </Button>
                          </>
                        ) : isMaintenance ? (
                          <Button
                            variant="primary"
                            onClick={() => void handleToggleBedStatus(bed, "available")}
                            style={{ width: "100%", height: "30px", fontSize: "11.5px", background: "#16a34a", borderColor: "#16a34a" }}
                          >
                            Mark Ready & Cleaned
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="primary"
                              onClick={() => handleOpenAllocate(bed)}
                              style={{ flex: 2, height: "30px", fontSize: "11.5px", background: "#00828a", borderColor: "#00828a" }}
                            >
                              + Allocate
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => void handleToggleBedStatus(bed, "maintenance")}
                              style={{ flex: 1, height: "30px", fontSize: "11px", padding: 0, color: "#64748b" }}
                              title="Mark under cleaning/sanitization"
                            >
                              Cleaning
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {/* 6. ACTIVE ALLOCATIONS AUDIT TABLE */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "14px",
          padding: "20px 24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
              Active Inpatient Bed Allocations ({occupiedBedsList.length})
            </h2>
            <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
              Live census of patients currently occupying inpatient beds.
            </p>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="sent-rx-table" style={{ width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                <th>Patient Details</th>
                <th>Ward & Bed</th>
                <th>Daily Rate</th>
                <th>Admission Date</th>
                <th>Triage Status</th>
                <th style={{ textAlign: "center" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {occupiedBedsList.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                    No beds are currently occupied. All 15 core beds are available.
                  </td>
                </tr>
              )}
              {occupiedBedsList.map((b) => (
                <tr key={b.id}>
                  <td>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{b.patient_name || "Patient"}</div>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>
                      {b.patient_id} {b.patient_phone ? `· ${b.patient_phone}` : ""}
                    </div>
                  </td>
                  <td>
                    <span style={{ fontWeight: 700, color: "#00828a" }}>{b.bed_no}</span>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>
                      {b.ward} · {b.room_no}
                    </div>
                  </td>
                  <td style={{ fontWeight: 600, color: "#0f172a" }}>
                    ₹{(b.alloc_rate || b.daily_rate).toFixed(2)}/day
                  </td>
                  <td style={{ color: "#64748b" }}>
                    {b.allocated_at ? new Date(b.allocated_at).toLocaleString() : "Active"}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "12px",
                        fontSize: "11.5px",
                        fontWeight: 700,
                        background: b.ward.toLowerCase().includes("icu") ? "#fee2e2" : "#dbeafe",
                        color: b.ward.toLowerCase().includes("icu") ? "#b91c1c" : "#1d4ed8",
                      }}
                    >
                      {b.ward.toLowerCase().includes("icu") ? "🔴 ICU Acuity" : "🔵 Inpatient Care"}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <div style={{ display: "inline-flex", gap: "6px" }}>
                      <Button variant="ghost" onClick={() => setViewBed(b)} style={{ height: "28px", fontSize: "12px" }}>
                        View
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void openDischargeBill(b)}
                        style={{ height: "28px", fontSize: "12px", color: "#dc2626", borderColor: "#fca5a5" }}
                      >
                        Discharge
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: ALLOCATE BED MODAL */}
      {/* ========================================================================= */}
      <Modal
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
        title="Allocate Bed to Inpatient"
        description="Search patient, select available ward/bed, and confirm daily rate."
        className="hosp-revenue-pop-modal"
      >
        <div style={{ marginBottom: "16px" }}>
          <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#334155", display: "block", marginBottom: "6px" }}>
            1. Select Patient (UHID / Name / Phone)
          </label>
          {!allocatePatient ? (
            <PatientSearchPicker onSelect={setAllocatePatient} placeholder="Type name, phone (+91), or UHID..." />
          ) : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#f0fdf4",
                border: "1.5px solid #86efac",
                borderRadius: "8px",
                padding: "10px 14px",
              }}
            >
              <div>
                <strong style={{ color: "#166534", fontSize: "14px" }}>
                  {allocatePatient.name} {allocatePatient.last_name || ""}
                </strong>
                <div style={{ fontSize: "12px", color: "#15803d" }}>
                  UHID: {allocatePatient.patient_id} · Phone: {allocatePatient.phone || "Not recorded"}
                </div>
              </div>
              <Button variant="ghost" onClick={() => setAllocatePatient(null)} style={{ height: "28px", fontSize: "11.5px" }}>
                Change Patient
              </Button>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
          <div>
            <Label>
              Choose Bed <span style={{ color: "#ef4444" }}>*</span>
            </Label>
            <select
              value={allocateForm.bed_no}
              onChange={(e) => handleBedSelectInAllocate(e.target.value)}
              className="pharmacy-rx-search-input"
              style={{ height: "38px", width: "100%", padding: "0 10px", fontSize: "13px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
            >
              <option value="">Select an available bed</option>
              {availableBedsList.map((b) => (
                <option key={b.id} value={b.bed_no}>
                  {b.bed_no} ({b.ward} · {b.room_no}) - ₹{b.daily_rate}/day
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Ward</Label>
            <Input value={allocateForm.ward} readOnly style={{ background: "#f8fafc" }} />
          </div>

          <div>
            <Label>Room / Unit</Label>
            <Input value={allocateForm.room_no} readOnly style={{ background: "#f8fafc" }} />
          </div>

          <div>
            <Label>Daily Rate (₹)</Label>
            <Input
              type="number"
              value={allocateForm.amount_per_day}
              onChange={(e) => setAllocateForm((p) => ({ ...p, amount_per_day: e.target.value }))}
            />
          </div>

          <div>
            <Label>Expected Stay (Days)</Label>
            <Input
              type="number"
              min={1}
              value={allocateForm.total_days}
              onChange={(e) => setAllocateForm((p) => ({ ...p, total_days: e.target.value }))}
            />
          </div>

          <div>
            <Label>Clinical Triage Priority</Label>
            <select
              value={allocateForm.triage_acuity}
              onChange={(e) => setAllocateForm((p) => ({ ...p, triage_acuity: e.target.value }))}
              className="pharmacy-rx-search-input"
              style={{ height: "38px", width: "100%", padding: "0 10px", fontSize: "13px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
            >
              <option value="Critical">🔴 Critical (ICU Acuity)</option>
              <option value="Urgent">🟡 Urgent (High Dependency)</option>
              <option value="Stable">🔵 Stable (Standard Inpatient)</option>
            </select>
          </div>
        </div>

        <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Estimated Bed Charges</div>
            <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>
              ₹{((Number(allocateForm.amount_per_day) || 0) * (Number(allocateForm.total_days) || 1)).toLocaleString("en-IN")}
            </div>
          </div>
          <div style={{ fontSize: "12px", color: "#64748b" }}>
            Billed to running inpatient folio upon discharge
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <Button variant="ghost" onClick={() => setAllocateOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={allocating || !allocatePatient || !allocateForm.bed_no}
            onClick={() => void submitAllocate()}
            style={{ background: "#00828a", borderColor: "#00828a" }}
          >
            {allocating ? "Allocating…" : "Confirm Bed Allocation"}
          </Button>
        </div>
      </Modal>

      {/* ========================================================================= */}
      {/* MODAL 2: ADD / EXPAND MORE BEDS MODAL */}
      {/* ========================================================================= */}
      <Modal
        open={addBedOpen}
        onClose={() => setAddBedOpen(false)}
        title="Add & Expand Hospital Beds"
        description="Configure additional beds dynamically for ICU, General Ward, Single Room, or new specialty units."
        className="hosp-revenue-pop-modal"
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
          <div>
            <Label>
              Ward / Specialty Unit <span style={{ color: "#ef4444" }}>*</span>
            </Label>
            <select
              value={addBedForm.ward}
              onChange={(e) => {
                const val = e.target.value;
                setAddBedForm((p) => ({
                  ...p,
                  ward: val,
                  bed_type: val === "ICU" ? "Critical Care" : val === "Single Room" ? "Deluxe Private" : "Standard Ward",
                  daily_rate: val === "ICU" ? "3500" : val === "Single Room" ? "2000" : "800",
                }));
              }}
              className="pharmacy-rx-search-input"
              style={{ height: "38px", width: "100%", padding: "0 10px", fontSize: "13px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
            >
              <option value="ICU">ICU (Intensive Care Unit)</option>
              <option value="General Ward">General Ward</option>
              <option value="Single Room">Single Room (Deluxe Private)</option>
              <option value="NICU">NICU (Neonatal ICU)</option>
              <option value="Emergency Ward">Emergency Ward</option>
              <option value="Other">+ Other / Custom Ward</option>
            </select>
          </div>

          {addBedForm.ward === "Other" && (
            <div>
              <Label>
                Custom Ward Name <span style={{ color: "#ef4444" }}>*</span>
              </Label>
              <Input
                value={addBedForm.custom_ward}
                onChange={(e) => setAddBedForm((p) => ({ ...p, custom_ward: e.target.value }))}
                placeholder="e.g. Post-Op Recovery"
              />
            </div>
          )}

          <div>
            <Label>
              Room / Wing No. <span style={{ color: "#ef4444" }}>*</span>
            </Label>
            <Input
              value={addBedForm.room_no}
              onChange={(e) => setAddBedForm((p) => ({ ...p, room_no: e.target.value }))}
              placeholder="e.g. ICU-Unit 2, GW-Wing B, SR-Floor 3"
            />
          </div>

          <div>
            <Label>
              Bed Identifier <span style={{ color: "#ef4444" }}>*</span>
            </Label>
            <Input
              value={addBedForm.bed_no}
              onChange={(e) => setAddBedForm((p) => ({ ...p, bed_no: e.target.value }))}
              placeholder="e.g. ICU-06, GW-06, SR-06"
            />
          </div>

          <div>
            <Label>Daily Inpatient Tariff (₹)</Label>
            <Input
              type="number"
              value={addBedForm.daily_rate}
              onChange={(e) => setAddBedForm((p) => ({ ...p, daily_rate: e.target.value }))}
            />
          </div>

          <div>
            <Label>Bed Class / Type</Label>
            <Input
              value={addBedForm.bed_type}
              onChange={(e) => setAddBedForm((p) => ({ ...p, bed_type: e.target.value }))}
              placeholder="e.g. Critical Care, Standard, Deluxe"
            />
          </div>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <Label>Equipment / Amenities Notes</Label>
          <Input
            value={addBedForm.notes}
            onChange={(e) => setAddBedForm((p) => ({ ...p, notes: e.target.value }))}
            placeholder="e.g. Equipped with ventilator, multipara monitor, oxygen port"
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <Button variant="ghost" onClick={() => setAddBedOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={addingBed || !addBedForm.room_no.trim() || !addBedForm.bed_no.trim()}
            onClick={() => void submitAddBed()}
            style={{ background: "#00828a", borderColor: "#00828a" }}
          >
            {addingBed ? "Creating Bed…" : "Add Bed to Inventory"}
          </Button>
        </div>
      </Modal>

      {/* ========================================================================= */}
      {/* MODAL 3: BED DETAILS & MANAGEMENT POPUP */}
      {/* ========================================================================= */}
      {viewBed && (
        <Modal
          open={!!viewBed}
          onClose={() => setViewBed(null)}
          title={`Bed Details - ${viewBed.bed_no}`}
          description={`${viewBed.ward} · ${viewBed.room_no}`}
          className="hosp-revenue-pop-modal"
        >
          <div className="hosp-revenue-pop-summary" style={{ marginBottom: "16px" }}>
            <div>
              <span>Status</span>
              <strong style={{ color: viewBed.status === "occupied" ? "#dc2626" : "#16a34a", fontSize: "17px" }}>
                {viewBed.status.toUpperCase()}
              </strong>
            </div>
            <div>
              <span>Daily Rate</span>
              <strong style={{ fontSize: "17px" }}>₹{viewBed.daily_rate}/day</strong>
            </div>
            <div>
              <span>Bed Type</span>
              <strong style={{ fontSize: "17px" }}>{viewBed.bed_type}</strong>
            </div>
          </div>

          {viewBed.status === "occupied" && (
            <div style={{ background: "#f8fafc", padding: "14px", borderRadius: "8px", border: "1px solid #e2e8f0", marginBottom: "16px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "6px" }}>
                Active Patient Information
              </div>
              <div style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>
                {viewBed.patient_name || "Patient"}
              </div>
              <div style={{ fontSize: "12.5px", color: "#334155", marginTop: "2px" }}>
                UHID: {viewBed.patient_id} {viewBed.patient_phone ? `· Phone: ${viewBed.patient_phone}` : ""}
              </div>
              {viewBed.allocated_at && (
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  Admitted On: {new Date(viewBed.allocated_at).toLocaleString()}
                </div>
              )}
              {loadingStayBill && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "8px" }}>Calculating current stay...</div>}
              {stayBill && (
                <div style={{ marginTop: "12px", borderTop: "1px dashed #cbd5e1", paddingTop: "10px", fontSize: "13px", display: "grid", gap: "5px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Current stay</span>
                    <strong>{stayBill.days_stayed} day{stayBill.days_stayed === 1 ? "" : "s"} ({stayBill.hours_stayed} hrs)</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Bed charges ({stayBill.days_stayed} × ₹{stayBill.rate_per_day.toFixed(2)}/day)</span>
                    <strong>₹{stayBill.bed_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Unbilled pharmacy ({stayBill.pharmacy_items.length} item{stayBill.pharmacy_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{stayBill.pharmacy_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Unbilled lab / imaging ({stayBill.diag_items.length} item{stayBill.diag_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{stayBill.diag_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #e2e8f0", paddingTop: "6px" }}>
                    <strong>Running total</strong>
                    <strong style={{ color: "#00828a" }}>₹{stayBill.grand_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>As of {stayBill.discharge_date_formatted}</div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px" }}>
            <div>
              {viewBed.status === "available" && (
                <Button
                  variant="ghost"
                  onClick={() => void handleToggleBedStatus(viewBed, "maintenance")}
                  style={{ color: "#64748b" }}
                >
                  Mark Under Sanitization
                </Button>
              )}
              {viewBed.status === "maintenance" && (
                <Button
                  variant="primary"
                  onClick={() => void handleToggleBedStatus(viewBed, "available")}
                  style={{ background: "#16a34a", borderColor: "#16a34a" }}
                >
                  Mark Available & Sanitized
                </Button>
              )}
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <Button variant="ghost" onClick={() => setViewBed(null)}>
                Close
              </Button>
              {viewBed.status === "occupied" && (
                <Button
                  variant="secondary"
                  onClick={() => void openDischargeBill(viewBed)}
                  style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                >
                  Discharge Patient
                </Button>
              )}
              {viewBed.status === "available" && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setViewBed(null);
                    handleOpenAllocate(viewBed);
                  }}
                  style={{ background: "#00828a", borderColor: "#00828a" }}
                >
                  Allocate This Bed
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ========================================================================= */}
      {/* MODAL 4: DISCHARGE & BILL MODAL */}
      {/* ========================================================================= */}
      {dischargeBed && (
        <Modal open={!!dischargeBed} onClose={() => { setDischargeBed(null); setDischargePreview(null); }}>
          <div style={{ padding: "4px 2px", minWidth: "420px", maxWidth: "560px" }}>
            <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px 0" }}>
              Discharge & Settle Bill
            </h2>
            <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 16px 0" }}>
              {dischargeBed.patient_name || "Patient"} · {dischargeBed.ward} / {dischargeBed.room_no} / {dischargeBed.bed_no}
            </p>

            {loadingDischargePreview && (
              <p style={{ color: "#64748b", fontSize: "13px" }}>Computing stay duration and unbilled charges...</p>
            )}

            {!loadingDischargePreview && dischargePreview && (
              <>
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 16px", marginBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Bed charges ({dischargePreview.days_stayed} day{dischargePreview.days_stayed === 1 ? "" : "s"} × ₹{dischargePreview.rate_per_day.toFixed(2)}/day)</span>
                    <strong>₹{dischargePreview.bed_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Unbilled pharmacy ({dischargePreview.pharmacy_items.length} item{dischargePreview.pharmacy_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{dischargePreview.pharmacy_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Unbilled lab / imaging ({dischargePreview.diag_items.length} item{dischargePreview.diag_items.length === 1 ? "" : "s"})</span>
                    <strong>₹{dischargePreview.diag_total.toFixed(2)}</strong>
                  </div>
                  <div style={{ borderTop: "1px dashed #cbd5e1", marginTop: "8px", paddingTop: "8px", display: "flex", justifyContent: "space-between", fontSize: "14.5px" }}>
                    <span style={{ fontWeight: 700, color: "#0f172a" }}>Grand Total</span>
                    <strong style={{ color: "#00828a" }}>₹{dischargePreview.grand_total.toFixed(2)}</strong>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                  <div>
                    <Label>Discount (₹)</Label>
                    <Input
                      type="number"
                      name="discount"
                      aria-label="Discount"
                      min={0}
                      value={dischargeForm.discount}
                      onChange={(e) => setDischargeForm((p) => ({ ...p, discount: e.target.value.replace(/[^0-9.]/g, "") }))}
                    />
                  </div>
                  <div>
                    <Label>Advance already paid (₹)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={dischargeForm.advance_paid}
                      onChange={(e) => setDischargeForm((p) => ({ ...p, advance_paid: e.target.value }))}
                    />
                  </div>
                </div>

                <div style={{ marginBottom: "12px" }}>
                  <Label>Payment mode for balance collected now</Label>
                  <Select
                    value={dischargeForm.payment_mode}
                    onChange={(e) => setDischargeForm((p) => ({ ...p, payment_mode: e.target.value }))}
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                    <option value="upi">UPI</option>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cheque">Cheque</option>
                  </Select>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <Label>Discharge notes</Label>
                  <Input
                    value={dischargeForm.notes}
                    onChange={(e) => setDischargeForm((p) => ({ ...p, notes: e.target.value }))}
                  />
                </div>

                <div style={{ background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: "8px", padding: "10px 12px", marginBottom: "16px", fontSize: "12.5px", color: "#1e40af" }}>
                  Amount to collect now: <strong>₹{Math.max(0, dischargePreview.grand_total - (Number(dischargeForm.discount) || 0) - (Number(dischargeForm.advance_paid) || 0)).toFixed(2)}</strong>.
                  Confirming will generate the final invoice, mark this admission discharged, and free the bed.
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                  <Button variant="ghost" onClick={() => { setDischargeBed(null); setDischargePreview(null); }}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={submittingDischarge}
                    onClick={() => void confirmDischargeBill()}
                    style={{ background: "#00828a", borderColor: "#00828a" }}
                  >
                    {submittingDischarge ? "Settling..." : "Confirm Discharge & Generate Bill"}
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
