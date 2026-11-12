import { useEffect, useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Button, Input, Select, Table, TableCell, TableHead, TableRow } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { openRazorpayCheckout } from "../lib/razorpay";
import { fullPatientName, lookupPatientByUhid, normalizeUhidLookup } from "../lib/patientLookup";
import type { Appointment, DoctorSchedule, Notice, OpSummary } from "../types";
import { PRINT_BRAND_HEADER_DATA_URI } from "../lib/printBrand";
import { printViaIframe } from "../lib/printViaIframe";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  canEdit: boolean;
};

type Department = {
  id: number;
  department_name?: string;
};

type DepartmentForm = {
  department_name: string;
};

type ScheduleForm = {
  id: string;
  doctor_name: string;
  department: string;
  schedule_date: string;
  start_time: string;
  end_time: string;
  consultation_fee: string;
  review_fee: string;
  status: string;
  notes: string;
};

type Doctor = {
  doctor_name: string;
  department?: string | null;
  consultation_fee?: number | null;
  review_fee?: number | null;
  status?: string | null;
};

type AppointmentForm = {
  id: string;
  patient_id: string;
  patient_name: string;
  visit_type: string;
  department: string;
  doctor_name: string;
  appointment_date: string;
  status: string;
  appointment_kind: string;
  follow_up_for: string;
  consultation_fee: string;
  payment_mode: string;
  notes: string;
};

const EMPTY_SUMMARY: OpSummary = {
  date: "",
  total_appointments: 0,
  follow_ups: 0,
  active_queue: 0,
  no_shows: 0,
  reminders_sent: 0,
  available_doctors: 0,
};

const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  id: "",
  doctor_name: "",
  department: "",
  schedule_date: "",
  start_time: "09:00",
  end_time: "13:00",
  consultation_fee: "",
  review_fee: "",
  status: "available",
  notes: "",
};

const DEFAULT_APPOINTMENT_FORM: AppointmentForm = {
  id: "",
  patient_id: "",
  patient_name: "",
  visit_type: "OP",
  department: "",
  doctor_name: "",
  appointment_date: "",
  status: "scheduled",
  appointment_kind: "new",
  follow_up_for: "",
  consultation_fee: "",
  payment_mode: "",
  notes: "",
};

const todayIsoDate = () => new Date().toLocaleDateString('en-CA');

const OP_PAYMENT_METHODS = [
  { value: "upi", label: "UPI", detail: "QR / UPI ID" },
  { value: "card", label: "Card", detail: "Debit / Credit" },
  { value: "bank", label: "Bank Transfer", detail: "NEFT / IMPS" },
  { value: "cash", label: "Cash", detail: "Counter paid" },
];

function toDateTimeLocalValue(value?: string | null) {
  if (!value) return "";
  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

const safeText = (value: unknown) => String(value ?? "-")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

function getAmPmLabel(value?: string | null) {
  if (!value) return "Select time";
  const timePart = value.includes("T") ? value.split("T")[1] : value;
  const hour = Number((timePart || "").split(":")[0]);
  if (Number.isNaN(hour)) return "Select time";
  return hour >= 12 ? "PM" : "AM";
}

function getAppointmentTimeLabel(value?: string | null) {
  if (!value) return "No appointment time selected";
  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return `Time: ${value}`;
  return parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function printTokenSlip(appointment: { token_no?: number | string; patient_id?: string; patient_name?: string; doctor_name?: string; department?: string; appointment_date?: string; appointment_kind?: string; visit_type?: string; status?: string; notes?: string }, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!appointment.token_no) {
    setNotice({ type: "warning", message: "Generate a token before printing." });
    return;
  }
  const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const row = (label: string, value: unknown) => `<div class="token-field"><span>${safeText(label)}</span><strong>${safeText(value || "-")}</strong></div>`;
  const html = `<!doctype html><html><head><title>Token ${safeText(appointment.token_no)} OP Visit</title><style>
    @page { size: A5 portrait; margin: 10mm; } *{box-sizing:border-box} body{margin:0;background:#fff;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:11px}.token-sheet{width:100%}.token-head{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-bottom:12px}.token-brand{display:flex;align-items:center;gap:10px;width:100%;max-width:none}.token-brand img{display:block;width:100%;max-height:86px;height:auto;object-fit:contain;object-position:left center}.token-brand strong{display:block;color:#062f56;font-size:22px;line-height:1}.token-brand span{display:block;margin-top:4px;color:#475569;font-size:10px;letter-spacing:.04em;text-transform:uppercase}.token-title{text-align:right;border-top:1px solid #e5e7eb;padding-top:5px}.token-title h1{margin:0 0 5px;font-size:16px;text-decoration:underline}.token-title p{margin:2px 0;color:#475569}.token-no{margin:0 0 12px;padding:12px;border:2px solid #111827;text-align:center}.token-no span{display:block;color:#334155;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.token-no strong{display:block;margin-top:4px;color:#062f56;font-size:34px;line-height:1}.token-section{border:1px solid #111827;border-bottom:0}.token-section:last-child{border-bottom:1px solid #111827}.token-section h2{margin:0;padding:6px 8px;border-bottom:1px solid #111827;background:#eef7fb;color:#062f56;font-size:12px;letter-spacing:.02em;text-transform:uppercase}.token-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.token-field{min-height:32px;padding:6px 8px;border-right:1px solid #111827;border-bottom:1px solid #111827}.token-field:nth-child(2n){border-right:0}.token-field span{display:block;margin-bottom:3px;color:#334155;font-size:9px;font-weight:700;text-transform:uppercase}.token-field strong{display:block;color:#111827;font-size:11px}.token-note{padding:8px;border-bottom:1px solid #111827;color:#334155;line-height:1.45}.token-sign{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:24px}.token-sign div{padding-top:22px;border-top:1px solid #111827;text-align:center;font-weight:700}
  </style></head><body><main class="token-sheet"><header class="token-head"><div class="token-brand"><img src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI, Pharmacy, Diagnostics"/></div><div class="token-title"><h1>OP Visit Token</h1><p><strong>Printed:</strong> ${safeText(printedAt)}</p></div></header><div class="token-no"><span>Token Number</span><strong>${safeText(appointment.token_no)}</strong></div><section class="token-section"><h2>Patient Information</h2><div class="token-grid">${row("Patient Name", appointment.patient_name)}${row("UHID / Patient ID", appointment.patient_id)}${row("Visit Type", appointment.visit_type || "OP")}${row("Status", appointment.status || "scheduled")}</div></section><section class="token-section"><h2>Appointment Information</h2><div class="token-grid">${row("Department", appointment.department)}${row("Doctor", appointment.doctor_name)}${row("Appointment Time", getAppointmentTimeLabel(appointment.appointment_date))}${row("Appointment Kind", appointment.appointment_kind || "new")}</div></section><section class="token-section"><h2>Instructions</h2><div class="token-note">Please keep this token and wait until your number is called at the OP queue desk.</div></section><div class="token-sign"><div>Patient / Guardian</div><div>OP Desk</div></div></main></body></html>`;
  printViaIframe(html, "__hospai_op_print_frame__");
}

export default function OpPage({ setNotice, canEdit }: Props) {
  const [summary, setSummary] = useState<OpSummary>(EMPTY_SUMMARY);
  const [schedules, setSchedules] = useState<DoctorSchedule[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentForm, setDepartmentForm] = useState<DepartmentForm>({ department_name: "" });
  const [deleteDepartmentId, setDeleteDepartmentId] = useState("");
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(DEFAULT_SCHEDULE_FORM);
  const [appointmentForm, setAppointmentForm] = useState<AppointmentForm>(DEFAULT_APPOINTMENT_FORM);
  const [appointmentPatientName, setAppointmentPatientName] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingAppointment, setSavingAppointment] = useState(false);
  const [isRazorpayReady, setIsRazorpayReady] = useState(true);
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [lastGeneratedToken, setLastGeneratedToken] = useState<any | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);

  const loadOpDesk = async (date = selectedDate, doctorName = selectedDoctor) => {
    setLoading(true);
    try {
      const doctorQuery = doctorName ? `doctor_name=${encodeURIComponent(doctorName)}` : "";
      const [summaryData, scheduleData, appointmentData] = await Promise.all([
        apiFetch<OpSummary>(`/api/op/summary?date=${date}`),
        apiFetch<{ schedules?: DoctorSchedule[] }>(`/api/op/doctor-schedules?${doctorQuery}`),
        apiFetch<{ appointments?: Appointment[] }>(`/api/appointments?date=${date}&visit_type=OP,Emergency,IP${doctorQuery ? "&" + doctorQuery : ""}`),
      ]);
      const nextSchedules = scheduleData.schedules || [];
      const nextAppointments = appointmentData.appointments || [];
      setSummary({ ...EMPTY_SUMMARY, ...summaryData });
      setSchedules(nextSchedules);
      setAppointments(nextAppointments);
      setAppointmentForm((current) => {
        if (current.doctor_name || !nextSchedules[0]) return current;
        return {
          ...current,
          doctor_name: nextSchedules[0].doctor_name,
          department: nextSchedules[0].department || current.department,
        };
      });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load OP desk.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOpDesk(selectedDate, selectedDoctor);
  }, [selectedDate, selectedDoctor]);

  const refreshDepartments = async () => {
    const data = await apiFetch<{ departments?: Department[] }>("/api/registration/departments");
    setDepartments(data.departments || []);
  };

  const refreshDoctors = async () => {
    try {
      const data = await apiFetch<{ doctors?: Doctor[] }>("/api/op/doctors");
      const activeDoctors = (data.doctors || [])
        .filter((doc) => doc.status !== "inactive" && doc.status !== "leave")
        .sort((a, b) => (a.doctor_name || "").localeCompare(b.doctor_name || ""));
      setDoctors(activeDoctors);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load doctors.");
    }
  };

  useEffect(() => {
    void refreshDepartments().catch(() => setDepartments([]));
    void refreshDoctors();
  }, []);

  useEffect(() => {
    apiFetch<{ configured?: boolean }>("/api/payments/razorpay/config")
      .then((data) => setIsRazorpayReady(data.configured !== false))
      .catch(() => setIsRazorpayReady(true));
  }, []);

  const ensureRazorpayConfigured = async () => {
    try {
      const config = await apiFetch<{ configured?: boolean }>("/api/payments/razorpay/config");
      const configured = config.configured !== false;
      setIsRazorpayReady(configured);
      if (!configured) {
        setNotice({ type: "error", message: "Razorpay is not configured. Add keys in backend .env." });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const doctorNames = useMemo(() => {
    const names = new Set<string>();
    schedules.forEach((item) => names.add(item.doctor_name));
    appointments.forEach((item) => {
      if (item.doctor_name) names.add(item.doctor_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [schedules, appointments]);

  const handleDepartmentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = departmentForm.department_name.trim();
    if (!name) {
      setNotice({ type: "error", message: "Department name is required." });
      return;
    }
    setSavingDepartment(true);
    try {
      await apiFetch("/api/registration/departments", {
        method: "POST",
        body: JSON.stringify({ department_name: name }),
      });
      setDepartmentForm({ department_name: "" });
      setNotice({ type: "success", message: "Department saved. It will now appear in Patient Registration and OP Queue filters." });
      await refreshDepartments();
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save department.");
    } finally {
      setSavingDepartment(false);
    }
  };

  const handleScheduleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!scheduleForm.department.trim()) {
      setNotice({ type: "error", message: "Please select a department." });
      return;
    }
    if (!scheduleForm.doctor_name.trim()) {
      setNotice({ type: "error", message: "Please select a doctor." });
      return;
    }
    setSavingSchedule(true);
    try {
      const scheduleId = Number(scheduleForm.id);
      const path = scheduleId ? `/api/op/doctor-schedules/${scheduleId}` : "/api/op/doctor-schedules";
      await apiFetch(path, {
        method: scheduleId ? "PUT" : "POST",
        body: JSON.stringify({
          doctor_name: scheduleForm.doctor_name.trim(),
          department: scheduleForm.department.trim() || undefined,
          // Do NOT send a fixed schedule_date – the backend treats date-less
          // entries as permanent roster records and skips the overlap check.
          // Sending a dummy date like "2000-01-01" caused duplicate-name errors.
          consultation_fee: Number(scheduleForm.consultation_fee) || undefined,
          review_fee: Number(scheduleForm.review_fee) || undefined,
          status: scheduleForm.status,
          notes: scheduleForm.notes.trim() || undefined,
        }),
      });
      setScheduleForm({ ...DEFAULT_SCHEDULE_FORM, schedule_date: "" });
      setNotice({ type: "success", message: scheduleId ? "Doctor schedule updated." : "Doctor schedule added." });
      await loadOpDesk(selectedDate, selectedDoctor);
      await refreshDoctors();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save doctor schedule.");
    } finally {
      setSavingSchedule(false);
    }
  };

  const fillAppointmentPatient = async (value: string) => {
    const lookup = normalizeUhidLookup(value);
    if (!lookup) {
      setAppointmentPatientName("");
      return;
    }
    try {
      const patient = await lookupPatientByUhid(lookup);
      if (!patient) {
        setAppointmentPatientName("");
        setNotice({ type: "warning", message: "No patient found for that UHID / last 4 digits." });
        return;
      }
      const name = fullPatientName(patient) || patient.patient_id;
      setAppointmentForm((current) => ({ 
        ...current, 
        patient_id: patient.patient_id, 
        patient_name: name,
        department: (patient as any).department || current.department,
        doctor_name: (patient as any).consulting_doctor || current.doctor_name
      }));
      setAppointmentPatientName(name);
      setNotice({ type: "success", message: `Patient auto-filled: ${name}.` });
    } catch {
      setAppointmentPatientName("");
      setNotice({ type: "error", message: "Unable to auto-fill patient details." });
    }
  };

  const handleAppointmentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!appointmentForm.patient_name.trim() || !appointmentForm.appointment_date) {
      setNotice({ type: "error", message: "Patient name and appointment date are required." });
      return;
    }
    setSavingAppointment(true);
    try {
      const appointmentId = Number(appointmentForm.id);
      const path = appointmentId ? `/api/appointments/${appointmentId}` : "/api/appointments";
      const appointmentPayload = {
        patient_id: appointmentForm.patient_id.trim() || undefined,
        patient_name: appointmentForm.patient_name.trim(),
        visit_type: "OP",
        department: appointmentForm.department.trim() || undefined,
        doctor_name: appointmentForm.doctor_name.trim() || undefined,
        appointment_date: appointmentForm.appointment_date,
        status: appointmentForm.status,
        appointment_kind: appointmentForm.appointment_kind,
        follow_up_for: appointmentForm.appointment_kind === "follow_up" && appointmentForm.follow_up_for ? Number(appointmentForm.follow_up_for) : undefined,
        notes: appointmentForm.notes.trim() || undefined,
        consultation_fee: Number(appointmentForm.consultation_fee) || undefined,
        payment_mode: appointmentForm.payment_mode || "cash",
      };
      const saved = await apiFetch<{ appointment_id?: number; token_no?: number }>(path, {
        method: appointmentId ? "PUT" : "POST",
        body: JSON.stringify(appointmentPayload),
      });
      if (!appointmentId && saved.token_no) {
        setLastGeneratedToken({ ...appointmentPayload, token_no: saved.token_no, status: appointmentPayload.status || "scheduled" });
      }
      setAppointmentForm({
        ...DEFAULT_APPOINTMENT_FORM,
        appointment_date: `${selectedDate || todayIsoDate()}T09:00`,
        doctor_name: appointmentForm.doctor_name,
        department: appointmentForm.department,
      });
      setNotice({ type: "success", message: appointmentId ? "Appointment updated." : `Appointment scheduled. Token #${saved.token_no || "generated"}.` });
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save appointment.");
    } finally {
      setSavingAppointment(false);
    }
  };

  const handleRazorpayAppointmentSubmit = async () => {
    if (!(await ensureRazorpayConfigured())) {
      return;
    }
    if (!appointmentForm.patient_name.trim() || !appointmentForm.appointment_date) {
      setNotice({ type: "error", message: "Patient name and appointment date are required." });
      return;
    }
    const consultationFee = Number(appointmentForm.consultation_fee) || 0;
    if (consultationFee <= 0) {
      setNotice({ type: "error", message: "Consultation fee must be greater than zero for Razorpay payment." });
      return;
    }
    setSavingAppointment(true);
    try {
      const appointmentPayload = {
        patient_id: appointmentForm.patient_id.trim() || undefined,
        patient_name: appointmentForm.patient_name.trim(),
        visit_type: "OP",
        department: appointmentForm.department.trim() || undefined,
        doctor_name: appointmentForm.doctor_name.trim() || undefined,
        appointment_date: appointmentForm.appointment_date,
        status: appointmentForm.status,
        appointment_kind: appointmentForm.appointment_kind,
        follow_up_for: appointmentForm.appointment_kind === "follow_up" && appointmentForm.follow_up_for ? Number(appointmentForm.follow_up_for) : undefined,
        notes: appointmentForm.notes.trim() || undefined,
      };

      const order = await apiFetch<{
        key_id: string;
        order_id: string;
        amount: number;
        currency: string;
      }>("/api/appointments/razorpay/order", {
        method: "POST",
        body: JSON.stringify({
          amount: consultationFee,
          notes: {
            patient_name: appointmentPayload.patient_name,
            doctor_name: appointmentPayload.doctor_name || "",
            appointment_date: appointmentPayload.appointment_date,
          },
        }),
      });

      const paymentResult = await openRazorpayCheckout({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency || "INR",
        name: "HospAI OP Desk",
        description: "OP Appointment Booking",
        order_id: order.order_id,
        prefill: {
          name: appointmentPayload.patient_name,
        },
        notes: {
          patient_id: appointmentPayload.patient_id || "",
        },
        theme: {
          color: "#0f766e",
        },
      });

      const verification = await apiFetch<{ appointment_id?: number; token_no?: number }>("/api/appointments/razorpay/verify", {
        method: "POST",
        body: JSON.stringify({
          amount: consultationFee,
          payment_mode: appointmentForm.payment_mode,
          appointment: appointmentPayload,
          razorpay_order_id: paymentResult.razorpay_order_id,
          razorpay_payment_id: paymentResult.razorpay_payment_id,
          razorpay_signature: paymentResult.razorpay_signature,
        }),
      });

      if (verification.token_no) {
        setLastGeneratedToken({ ...appointmentPayload, token_no: verification.token_no, status: appointmentPayload.status || "scheduled" });
      }
      setAppointmentForm({
        ...DEFAULT_APPOINTMENT_FORM,
        appointment_date: `${selectedDate || todayIsoDate()}T09:00`,
        doctor_name: appointmentForm.doctor_name,
        department: appointmentForm.department,
      });
      setNotice({ type: "success", message: `Appointment scheduled and paid via Razorpay. Token #${verification.token_no || "generated"}.` });
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to complete Razorpay appointment payment.");
    } finally {
      setSavingAppointment(false);
    }
  };

  const quickUpdateAppointment = async (appointment: Appointment, status: string) => {
    try {
      await apiFetch(`/api/appointments/${appointment.id}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      setNotice({ type: "success", message: `Appointment marked ${status.replace("_", " ")}.` });
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update appointment status.");
    }
  };

  const markReminderSent = async (appointment: Appointment) => {
    try {
      await apiFetch(`/api/appointments/${appointment.id}`, {
        method: "PUT",
        body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
      });
      setNotice({ type: "success", message: "Reminder marked as sent." });
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update reminder status.");
    }
  };

  const markNoShow = async (appointment: Appointment) => {
    try {
      await apiFetch(`/api/appointments/${appointment.id}`, {
        method: "PUT",
        body: JSON.stringify({ no_show_marked: true, status: "cancelled" }),
      });
      setNotice({ type: "success", message: "Appointment marked as no-show." });
      await loadOpDesk(selectedDate, selectedDoctor);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to mark no-show.");
    }
  };

  const handleDoctorChange = (doctorName: string) => {
    const selectedDoctor = doctors.find((d) => d.doctor_name === doctorName);
    if (selectedDoctor && selectedDoctor.department) {
      setScheduleForm((current) => ({
        ...current,
        doctor_name: doctorName,
        department: selectedDoctor.department || "",
      }));
    } else {
      setScheduleForm((current) => ({
        ...current,
        doctor_name: doctorName,
      }));
    }
  };

  const handleDepartmentChange = (department: string) => {
    setScheduleForm((current) => ({
      ...current,
      department,
    }));
  };

  const filteredDoctorsForDept = useMemo(
    () => doctors.filter((d) => !scheduleForm.department || d.department === scheduleForm.department),
    [doctors, scheduleForm.department]
  );

  const deleteSchedule = async (schedule: DoctorSchedule) => {
    if (!window.confirm(`Delete ${schedule.doctor_name} schedule?`)) return;
    try {
      await apiFetch(`/api/op/doctor-schedules/${schedule.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Doctor schedule deleted." });
      await loadOpDesk(selectedDate, selectedDoctor);
      await refreshDoctors();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete doctor schedule.");
    }
  };
  const handleDeleteDepartment = async () => {
    if (!deleteDepartmentId) return;
    const deptObj = departments.find(d => String(d.id) === String(deleteDepartmentId));
    if (!deptObj) {
      setNotice({ type: "error", message: "Department not found in records." });
      return;
    }

    if (!window.confirm(`Are you sure you want to delete the department "${deptObj.department_name}"?`)) return;

    setSavingDepartment(true);
    try {
      await apiFetch(`/api/registration/departments/${deptObj.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Department deleted successfully." });
      setDeleteDepartmentId("");
      await refreshDepartments();
      await loadOpDesk(selectedDate, selectedDoctor);
      await refreshDoctors();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete department.");
    } finally {
      setSavingDepartment(false);
    }
  };

  return (
    <section className="module-page">
      {loading ? <p className="muted">Loading Doctor Scheduling...</p> : null}

      <div className="op-desk-stack">
        <div className="panel">
          <div className="module-panel-head">
            <h3>Manage Departments</h3>
          </div>
          <form className="module-inline-actions" onSubmit={handleDepartmentSubmit} style={{ marginBottom: "16px" }}>
            <Input
              value={departmentForm.department_name}
              onChange={(event) => setDepartmentForm({ department_name: event.target.value })}
              placeholder="Enter new department name"
              aria-label="Department name"
              disabled={!canEdit}
            />
            <Button type="submit" variant="primary" disabled={!canEdit || savingDepartment || !departmentForm.department_name}>
              {savingDepartment ? "Saving..." : "Add Department"}
            </Button>
          </form>
          <div className="module-inline-actions" style={{ marginBottom: "16px" }}>
            <Select
              value={deleteDepartmentId}
              onChange={(event) => setDeleteDepartmentId(event.target.value)}
              aria-label="Select Department to Delete"
              disabled={!canEdit || savingDepartment}
            >
              <option value="">Select Department</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.department_name}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteDepartment}
              disabled={!canEdit || savingDepartment || !deleteDepartmentId}
            >
              Delete Department
            </Button>
          </div>
        </div>

        <div className="panel">
          <div className="module-panel-head">
            <h3>Doctor Schedule</h3>
          </div>
          <form className="module-form-grid module-sales-grid op-perfect-schedule-form" onSubmit={handleScheduleSubmit}>
            <Input
              value={scheduleForm.doctor_name}
              onChange={(event) => handleDoctorChange(event.target.value)}
              placeholder="Select Doctor"
              aria-label="Doctor name"
              disabled={!canEdit}
              list="op-doctor-suggestions"
            />
            <Select
              value={scheduleForm.department}
              onChange={(event) => handleDepartmentChange(event.target.value)}
              aria-label="Doctor department"
              disabled={!canEdit}
            >
              <option value="">Select department</option>
              {departments.map((department) => {
                const name = (department.department_name || "").trim();
                if (!name) return null;
                return (
                  <option key={department.id} value={name}>
                    {name}
                  </option>
                );
              })}
            </Select>
            <Input type="number" min={0} value={scheduleForm.consultation_fee} onChange={(event) => setScheduleForm((current) => ({ ...current, consultation_fee: event.target.value }))} placeholder="Consultation fee" aria-label="Consultation fee" disabled={!canEdit} />
            <Input type="number" min={0} value={scheduleForm.review_fee} onChange={(event) => setScheduleForm((current) => ({ ...current, review_fee: event.target.value }))} placeholder="Review fee" aria-label="Review fee" disabled={!canEdit} />
            <Select value={scheduleForm.status} onChange={(event) => setScheduleForm((current) => ({ ...current, status: event.target.value }))} aria-label="Schedule status" disabled={!canEdit}>
              <option value="available">Available</option>
              <option value="full">Full</option>
              <option value="leave">Leave</option>
            </Select>
            <Button type="submit" variant="primary" disabled={!canEdit || savingSchedule}>
              {savingSchedule ? "Saving..." : scheduleForm.id ? "Update" : "Add"}
            </Button>
          </form>
          <datalist id="op-doctor-suggestions">
            {filteredDoctorsForDept.map((doctor) => (
              <option key={doctor.doctor_name} value={doctor.doctor_name} />
            ))}
          </datalist>

          {schedules.length === 0 ? (
            <p className="muted">No doctor schedules for this day.</p>
          ) : (
            <Table className="module-table module-table-schedule" aria-label="Doctor schedules table">
              <TableHead>
                <TableCell>Doctor</TableCell>
                <TableCell>Department</TableCell>
                <TableCell>Consult Fee</TableCell>
                <TableCell>Review Fee</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableHead>
              {schedules.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell>{schedule.doctor_name}</TableCell>
                  <TableCell>{schedule.department || "-"}</TableCell>
                  <TableCell>{schedule.consultation_fee ? `₹${schedule.consultation_fee}` : "-"}</TableCell>
                  <TableCell>{schedule.review_fee ? `₹${schedule.review_fee}` : "-"}</TableCell>
                  <TableCell>{schedule.status || "available"}</TableCell>
                  <TableCell>
                    <div className="module-inline-actions">
                      {canEdit ? (
                        <>
                          <Button
                            type="button"
                            onClick={() =>
                              setScheduleForm({
                                id: String(schedule.id),
                                doctor_name: schedule.doctor_name,
                                department: schedule.department || "",
                                schedule_date: schedule.schedule_date,
                                start_time: schedule.start_time,
                                end_time: schedule.end_time,
                                consultation_fee: String(schedule.consultation_fee || ""),
                                review_fee: String(schedule.review_fee || ""),
                                status: schedule.status || "available",
                                notes: schedule.notes || "",
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button type="button" variant="destructive" onClick={() => void deleteSchedule(schedule)}>
                            Delete
                          </Button>
                        </>
                      ) : (
                        <span className="muted">Read only</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </div>

        <div className="panel">
          <div className="module-panel-head">
            <h3>Added Doctors</h3>
          </div>
          {doctors.length === 0 ? (
            <p className="muted">No doctors have been added yet.</p>
          ) : (
            <Table className="module-table" aria-label="Doctors list">
              <TableHead>
                <TableCell>Doctor Name</TableCell>
                <TableCell>Department</TableCell>
                <TableCell>Consultation Fee</TableCell>
                <TableCell>Review Fee</TableCell>
                <TableCell>Status</TableCell>
              </TableHead>
              {doctors.map((doctor) => (
                <TableRow key={doctor.doctor_name}>
                  <TableCell>{doctor.doctor_name}</TableCell>
                  <TableCell>{doctor.department || "-"}</TableCell>
                  <TableCell>{doctor.consultation_fee ? `₹${doctor.consultation_fee}` : "-"}</TableCell>
                  <TableCell>{doctor.review_fee ? `₹${doctor.review_fee}` : "-"}</TableCell>
                  <TableCell>{doctor.status ? doctor.status.charAt(0).toUpperCase() + doctor.status.slice(1) : "Active"}</TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </div>

      </div>
    </section>
  );
}
