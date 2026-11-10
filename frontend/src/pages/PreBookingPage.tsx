import React, { useState, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Notice, PreBookingRecord } from "../types";
import { apiFetch, reportError } from "../lib/api";
import { calculateAgeFromDob } from "../lib/format";
import { useDoctorDirectory, doctorsInDepartment } from "../lib/doctorDirectory";
import PhoneInput from "../components/PhoneInput";
import { formatPhone, toWhatsAppNumber, COUNTRY_CODE_RULES } from "../lib/phone";
import { Modal } from "../components/ui";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

export default function PreBookingPage({ setNotice, onNavigate }: Props) {
  // Tabs: 'book' | 'list'
  const [activeTab, setActiveTab] = useState<"book" | "list">("book");

  // Doctor & Department directory
  const { departments, doctors: doctorList, loading: directoryLoading } = useDoctorDirectory();

  // Tab 1 Form State
  const [patientName, setPatientName] = useState("");
  const [phoneCountryCode, setPhoneCountryCode] = useState("+91");
  const [phone, setPhone] = useState("");
  const [dob, setDob] = useState("");
  const [age, setAge] = useState("");
  const [email, setEmail] = useState("");
  const [appointmentDate, setAppointmentDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [timeHour, setTimeHour] = useState("10");
  const [timeMinute, setTimeMinute] = useState("00");
  const [timePeriod, setTimePeriod] = useState<"AM" | "PM">("AM");
  const [department, setDepartment] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Tab 2 List & Calendar State
  const [preBookings, setPreBookings] = useState<PreBookingRecord[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null);

  // Calendar Month Navigation
  const [currentCalendarMonth, setCurrentCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  // WhatsApp Follow-up Modal State
  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [selectedFollowUpItem, setSelectedFollowUpItem] = useState<PreBookingRecord | null>(null);
  const [customWhatsAppMsg, setCustomWhatsAppMsg] = useState("");

  // Auto-calculate Age when DOB changes
  const handleDobChange = (val: string) => {
    setDob(val);
    if (val) {
      const calculated = calculateAgeFromDob(val);
      setAge(calculated);
    }
  };

  // Filtered doctors for selected department
  const filteredDoctors = useMemo(() => {
    return doctorsInDepartment(doctorList, department);
  }, [doctorList, department]);

  // Load pre-bookings from backend
  const loadPreBookings = async () => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
      if (selectedCalendarDate) params.set("date", selectedCalendarDate);

      const res = await apiFetch<{ pre_bookings: PreBookingRecord[] }>(`/api/pre-bookings?${params.toString()}`);
      setPreBookings(res.pre_bookings || []);
    } catch (err) {
      reportError(setNotice, err);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    if (activeTab === "list") {
      void loadPreBookings();
    }
  }, [activeTab, statusFilter, selectedCalendarDate]);

  // Debounced search
  useEffect(() => {
    if (activeTab !== "list") return;
    const timer = setTimeout(() => {
      void loadPreBookings();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Handle Form Submission
  const handleBookAppointment = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!patientName.trim()) {
      setNotice({ type: "warning", message: "Patient Name is mandatory." });
      return;
    }

    const cleanDigits = phone.replace(/\D/g, "");
    if (!cleanDigits) {
      setNotice({ type: "warning", message: "Mobile Number is mandatory." });
      return;
    }

    const rule = COUNTRY_CODE_RULES[phoneCountryCode] || COUNTRY_CODE_RULES["+91"];
    if (cleanDigits.length < rule.min || cleanDigits.length > rule.max) {
      setNotice({
        type: "warning",
        message: `${rule.label} mobile number must be ${rule.max} digits.`,
      });
      return;
    }

    const appointmentTimeStr = `${timeHour}:${timeMinute} ${timePeriod}`;

    setIsSubmitting(true);
    try {
      const payload = {
        patient_name: patientName.trim(),
        phone: cleanDigits,
        phone_country_code: phoneCountryCode,
        dob: dob || undefined,
        age: age ? parseInt(age, 10) : undefined,
        email: email.trim() || undefined,
        appointment_date: appointmentDate || undefined,
        appointment_time: appointmentTimeStr,
        department: department || undefined,
        doctor_name: doctorName || undefined,
        reason: reason.trim() || undefined,
      };

      const res = await apiFetch<{ message: string; pre_booking: PreBookingRecord }>("/api/pre-bookings", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNotice({
        type: "success",
        message: `Appointment successfully pre-booked for ${patientName}! (Booking ID #${res.pre_booking.id})`,
      });

      // Reset form
      setPatientName("");
      setPhone("");
      setDob("");
      setAge("");
      setEmail("");
      setReason("");

      // Switch to list tab to inspect
      setActiveTab("list");
      void loadPreBookings();
    } catch (err) {
      reportError(setNotice, err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetForm = () => {
    setPatientName("");
    setPhone("");
    setPhoneCountryCode("+91");
    setDob("");
    setAge("");
    setEmail("");
    setAppointmentDate(new Date().toISOString().split("T")[0]);
    setTimeHour("10");
    setTimeMinute("00");
    setTimePeriod("AM");
    setDepartment("");
    setDoctorName("");
    setReason("");
    setNotice({ type: "info", message: "Form has been cleared." });
  };

  // Create Patient Data Flow
  const handleCreatePatient = (item: PreBookingRecord) => {
    try {
      sessionStorage.setItem("hospai_prefill_prebooking", JSON.stringify(item));
      setNotice({
        type: "info",
        message: `Transferring ${item.patient_name}'s pre-booking to official Patient Registration...`,
      });
      if (onNavigate) {
        onNavigate("add");
      } else {
        window.location.href = "/add";
      }
    } catch (e) {
      console.error("Failed to store pre-booking in session storage:", e);
    }
  };

  // WhatsApp Follow-up action
  const handleOpenWhatsAppModal = (item: PreBookingRecord) => {
    setSelectedFollowUpItem(item);
    const patientName = item.patient_name || "Patient";
    const appointmentDate = item.appointment_date || "scheduled date";
    const appointmentTime = item.appointment_time || "scheduled time";
    const doctorName = item.doctor_name
      ? item.doctor_name.replace(/^dr\.?\s*/i, "")
      : "our Specialist";

    const msg = `Dear ${patientName},\n\nThis is a gentle reminder regarding your upcoming pre-booked appointment at HospAI Hospital on ${appointmentDate} at ${appointmentTime} with Dr. ${doctorName}. \n\nPlease reply with "CONFIRM" to secure your slot or "RESCHEDULE" if you need to modify the timing. \n\nWe look forward to serving you. \nWarm regards,  \nHospAI Patient Care Team`;

    setCustomWhatsAppMsg(msg);
    setWhatsAppModalOpen(true);
  };

  const handleSendWhatsApp = () => {
    if (!selectedFollowUpItem) return;
    const waNumber = toWhatsAppNumber(
      selectedFollowUpItem.phone_country_code || "+91",
      selectedFollowUpItem.phone
    );
    if (!waNumber) {
      setNotice({ type: "warning", message: "Invalid phone number for WhatsApp." });
      return;
    }
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(customWhatsAppMsg)}`;
    window.open(url, "_blank");
    setWhatsAppModalOpen(false);
    setNotice({ type: "success", message: `WhatsApp follow-up opened for ${selectedFollowUpItem.patient_name}.` });
  };

  // Cancel Pre-booking
  const handleCancelBooking = async (id: number) => {
    if (!window.confirm("Are you sure you want to cancel this pre-booked appointment?")) return;
    try {
      await apiFetch(`/api/pre-bookings/${id}`, { method: "DELETE" });
      setNotice({ type: "info", message: "Pre-booking marked as Cancelled." });
      void loadPreBookings();
    } catch (err) {
      reportError(setNotice, err);
    }
  };

  // Calendar Calculations
  const calendarYear = currentCalendarMonth.getFullYear();
  const calendarMonthIndex = currentCalendarMonth.getMonth();

  const calendarDays = useMemo(() => {
    const firstDayOfMonth = new Date(calendarYear, calendarMonthIndex, 1);
    const lastDayOfMonth = new Date(calendarYear, calendarMonthIndex + 1, 0);

    const startDayOfWeek = firstDayOfMonth.getDay(); // 0 is Sun
    const totalDays = lastDayOfMonth.getDate();

    // Map counts of bookings by date string (YYYY-MM-DD)
    const countsMap: Record<string, number> = {};
    preBookings.forEach((b) => {
      if (b.appointment_date) {
        countsMap[b.appointment_date] = (countsMap[b.appointment_date] || 0) + 1;
      }
    });

    const days: Array<{
      dateStr: string;
      dayNum: number;
      isCurrentMonth: boolean;
      isToday: boolean;
      count: number;
    }> = [];

    // Prev month padding
    const prevMonthLastDay = new Date(calendarYear, calendarMonthIndex, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const d = prevMonthLastDay - i;
      const m = calendarMonthIndex === 0 ? 12 : calendarMonthIndex;
      const y = calendarMonthIndex === 0 ? calendarYear - 1 : calendarYear;
      const dateStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({
        dateStr,
        dayNum: d,
        isCurrentMonth: false,
        isToday: false,
        count: countsMap[dateStr] || 0,
      });
    }

    const todayStr = new Date().toISOString().split("T")[0];

    // Current month days
    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${calendarYear}-${String(calendarMonthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({
        dateStr,
        dayNum: d,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        count: countsMap[dateStr] || 0,
      });
    }

    // Next month padding to make full weeks
    const remaining = (7 - (days.length % 7)) % 7;
    for (let d = 1; d <= remaining; d++) {
      const m = calendarMonthIndex === 11 ? 1 : calendarMonthIndex + 2;
      const y = calendarMonthIndex === 11 ? calendarYear + 1 : calendarYear;
      const dateStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({
        dateStr,
        dayNum: d,
        isCurrentMonth: false,
        isToday: false,
        count: countsMap[dateStr] || 0,
      });
    }

    return days;
  }, [calendarYear, calendarMonthIndex, preBookings]);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const handlePrevMonth = () => {
    setCurrentCalendarMonth(new Date(calendarYear, calendarMonthIndex - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentCalendarMonth(new Date(calendarYear, calendarMonthIndex + 1, 1));
  };

  const handleTodayMonth = () => {
    const now = new Date();
    setCurrentCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedCalendarDate(now.toISOString().split("T")[0]);
  };

  // Stats summary for pre-bookings
  const statsSummary = useMemo(() => {
    const total = preBookings.length;
    const confirmed = preBookings.filter((b) => (b.status || "").toLowerCase() === "confirmed").length;
    const registered = preBookings.filter((b) => (b.status || "").toLowerCase() === "registered").length;
    const cancelled = preBookings.filter((b) => (b.status || "").toLowerCase() === "cancelled").length;
    return { total, confirmed, registered, cancelled };
  }, [preBookings]);

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1440px", margin: "0 auto", color: "#1e293b" }}>
      {/* Top Header & Breadcrumbs */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#64748b", marginBottom: "6px" }}>
          <span>HospAI</span>
          <span>/</span>
          <span>OP Management</span>
          <span>/</span>
          <span style={{ color: "#0284c7", fontWeight: 600 }}>Pre-booking</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0, color: "#102a43" }}>
              Pre-booking Management
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: "14px", color: "#64748b" }}>
              Fast-track patient pre-registration and appointment booking before formal hospital admission.
            </p>
          </div>

          {/* Quick Tab Switcher */}
          <div
            style={{
              display: "flex",
              background: "#f1f5f9",
              borderRadius: "10px",
              padding: "4px",
              gap: "4px",
              border: "1px solid #e2e8f0",
            }}
          >
            <button
              type="button"
              onClick={() => setActiveTab("book")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                borderRadius: "8px",
                border: "none",
                fontSize: "13.5px",
                fontWeight: 600,
                cursor: "pointer",
                background: activeTab === "book" ? "#102a43" : "transparent",
                color: activeTab === "book" ? "#ffffff" : "#475569",
                boxShadow: activeTab === "book" ? "0 2px 4px rgba(0,0,0,0.1)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              <span>📅</span>
              <span>Book a New Pre-Appointment</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("list");
                void loadPreBookings();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                borderRadius: "8px",
                border: "none",
                fontSize: "13.5px",
                fontWeight: 600,
                cursor: "pointer",
                background: activeTab === "list" ? "#102a43" : "transparent",
                color: activeTab === "list" ? "#ffffff" : "#475569",
                boxShadow: activeTab === "list" ? "0 2px 4px rgba(0,0,0,0.1)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              <span>📋</span>
              <span>List of Pre-booked Patients</span>
              {statsSummary.confirmed > 0 && (
                <span
                  style={{
                    background: activeTab === "list" ? "#0284c7" : "#0284c7",
                    color: "#ffffff",
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: "10px",
                  }}
                >
                  {statsSummary.confirmed}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: QUICK APPOINTMENT BOOKING FORM */}
      {/* ========================================================================= */}
      {activeTab === "book" && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "14px",
            border: "1px solid #e2e8f0",
            boxShadow: "0 4px 16px rgba(16, 42, 67, 0.05)",
            overflow: "hidden",
          }}
        >
          {/* Card Header */}
          <div
            style={{
              padding: "18px 24px",
              background: "linear-gradient(90deg, #102a43 0%, #1e3a5f 100%)",
              color: "#ffffff",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: "rgba(255, 255, 255, 0.15)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "18px",
                }}
              >
                📝
              </div>
              <div>
                <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>
                  Pre-Appointment Booking Form
                </h2>
                <p style={{ margin: "2px 0 0", fontSize: "12.5px", color: "#cbd5e1" }}>
                  Fields with <span style={{ color: "#f87171", fontWeight: 700 }}>*</span> are mandatory for pre-booking
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("list");
                  void loadPreBookings();
                }}
                style={{
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  padding: "6px 14px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>View All Pre-bookings →</span>
              </button>
            </div>
          </div>

          {/* Form Content */}
          <form onSubmit={handleBookAppointment} style={{ padding: "28px 28px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
              {/* Patient Name (Mandatory) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Patient Name <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Enter patient full name"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    outline: "none",
                    boxSizing: "border-box",
                    backgroundColor: "#ffffff",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                  onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                />
              </div>

              {/* Mobile Number with Country Code Dropdown (Mandatory) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Mobile Number <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <PhoneInput
                  countryCode={phoneCountryCode}
                  value={phone}
                  onChange={({ countryCode, value }) => {
                    setPhoneCountryCode(countryCode);
                    setPhone(value);
                  }}
                  required
                  placeholder="10-digit mobile number"
                />
              </div>

              {/* Date of Birth (Optional) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Date of Birth / DOB <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
                </label>
                <input
                  type="date"
                  max={new Date().toISOString().split("T")[0]}
                  value={dob}
                  onChange={(e) => handleDobChange(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    outline: "none",
                    boxSizing: "border-box",
                    backgroundColor: "#ffffff",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                  onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                />
              </div>

              {/* Age (Auto-calculated from DOB or manual) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Age <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Auto-calculated from DOB)</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="130"
                  placeholder="Age in years"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    outline: "none",
                    boxSizing: "border-box",
                    backgroundColor: dob ? "#f8fafc" : "#ffffff",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                  onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                />
              </div>

              {/* Email ID (Optional) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Email ID <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
                </label>
                <input
                  type="email"
                  placeholder="e.g. patient@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    outline: "none",
                    boxSizing: "border-box",
                    backgroundColor: "#ffffff",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                  onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                />
              </div>

              {/* Appointment Date (Optional) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Appointment Date <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
                </label>
                <input
                  type="date"
                  min={new Date().toISOString().split("T")[0]}
                  value={appointmentDate}
                  onChange={(e) => setAppointmentDate(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    outline: "none",
                    boxSizing: "border-box",
                    backgroundColor: "#ffffff",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                  onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                />
              </div>

              {/* Appointment Time & AM/PM Selector */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Appointment Time & AM/PM Selector
                </label>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  {/* Hour */}
                  <select
                    value={timeHour}
                    onChange={(e) => setTimeHour(e.target.value)}
                    style={{
                      flex: 1,
                      height: "40px",
                      padding: "0 8px",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      fontSize: "14px",
                      backgroundColor: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    {["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>

                  <span style={{ fontWeight: 700, color: "#64748b" }}>:</span>

                  {/* Minute */}
                  <select
                    value={timeMinute}
                    onChange={(e) => setTimeMinute(e.target.value)}
                    style={{
                      flex: 1,
                      height: "40px",
                      padding: "0 8px",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      fontSize: "14px",
                      backgroundColor: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    {["00", "15", "30", "45"].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>

                  {/* Active AM/PM Toggle */}
                  <div
                    style={{
                      display: "flex",
                      background: "#f1f5f9",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      overflow: "hidden",
                      height: "40px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setTimePeriod("AM")}
                      style={{
                        padding: "0 14px",
                        border: "none",
                        fontSize: "12.5px",
                        fontWeight: 700,
                        cursor: "pointer",
                        background: timePeriod === "AM" ? "#102a43" : "transparent",
                        color: timePeriod === "AM" ? "#ffffff" : "#475569",
                        transition: "all 0.15s ease",
                      }}
                    >
                      AM
                    </button>
                    <button
                      type="button"
                      onClick={() => setTimePeriod("PM")}
                      style={{
                        padding: "0 14px",
                        border: "none",
                        fontSize: "12.5px",
                        fontWeight: 700,
                        cursor: "pointer",
                        background: timePeriod === "PM" ? "#102a43" : "transparent",
                        color: timePeriod === "PM" ? "#ffffff" : "#475569",
                        transition: "all 0.15s ease",
                      }}
                    >
                      PM
                    </button>
                  </div>
                </div>
              </div>

              {/* Department (Optional) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Department <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
                </label>
                <select
                  value={department}
                  onChange={(e) => {
                    setDepartment(e.target.value);
                    setDoctorName("");
                  }}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    backgroundColor: "#ffffff",
                    cursor: "pointer",
                  }}
                >
                  <option value="">Select Department (All)</option>
                  {departments.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>
              </div>

              {/* Doctor Name (Optional) */}
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                  Doctor Name <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
                </label>
                <select
                  value={doctorName}
                  onChange={(e) => setDoctorName(e.target.value)}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "14px",
                    backgroundColor: "#ffffff",
                    cursor: "pointer",
                  }}
                >
                  <option value="">Select Doctor (Any Available)</option>
                  {filteredDoctors.map((doc) => (
                    <option key={doc.doctor_name} value={doc.doctor_name}>
                      Dr. {doc.doctor_name} ({doc.department || "General"})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Reason / Chief Complaint */}
            <div style={{ marginTop: "20px" }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
                Reason / Chief Complaint <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>(Optional)</span>
              </label>
              <textarea
                rows={3}
                placeholder="Brief reason for appointment, symptoms or clinical complaints..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1.5px solid #cbd5e1",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#0284c7")}
                onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
              />
            </div>

            {/* Form Actions */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "12px",
                marginTop: "28px",
                paddingTop: "20px",
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <button
                type="button"
                onClick={handleResetForm}
                disabled={isSubmitting}
                style={{
                  padding: "10px 20px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Clear Form
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 24px",
                  borderRadius: "8px",
                  border: "none",
                  background: isSubmitting ? "#64748b" : "linear-gradient(135deg, #102a43 0%, #0284c7 100%)",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                  boxShadow: "0 4px 12px rgba(2, 132, 199, 0.25)",
                }}
              >
                <span>{isSubmitting ? "Booking..." : "Book Appointment"}</span>
                <span>✓</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: LIST OF PRE-BOOKED PATIENTS & CALENDAR VIEW */}
      {/* ========================================================================= */}
      {activeTab === "list" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Quick Metrics Bar */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "14px",
            }}
          >
            <div
              style={{
                background: "#ffffff",
                padding: "16px 20px",
                borderRadius: "12px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>
                Total Pre-bookings
              </div>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#102a43", marginTop: "4px" }}>
                {statsSummary.total}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "16px 20px",
                borderRadius: "12px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
              }}
            >
              <div style={{ fontSize: "12px", color: "#059669", fontWeight: 600, textTransform: "uppercase" }}>
                Active Confirmed
              </div>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#059669", marginTop: "4px" }}>
                {statsSummary.confirmed}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "16px 20px",
                borderRadius: "12px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
              }}
            >
              <div style={{ fontSize: "12px", color: "#0284c7", fontWeight: 600, textTransform: "uppercase" }}>
                Converted to UHID
              </div>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#0284c7", marginTop: "4px" }}>
                {statsSummary.registered}
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                padding: "16px 20px",
                borderRadius: "12px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
              }}
            >
              <div style={{ fontSize: "12px", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>
                Cancelled / No-show
              </div>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#64748b", marginTop: "4px" }}>
                {statsSummary.cancelled}
              </div>
            </div>
          </div>

          {/* Main Dual Grid: Calendar on Left/Top + Table on Right/Bottom */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "360px 1fr",
              gap: "24px",
              alignItems: "start",
            }}
          >
            {/* Calendar Widget */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: "14px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 4px 16px rgba(16, 42, 67, 0.05)",
                padding: "20px",
              }}
            >
              {/* Calendar Header with Navigation */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                <div>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "#102a43" }}>
                    {monthNames[calendarMonthIndex]} {calendarYear}
                  </h3>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    Inspect scheduled appointments
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={handlePrevMonth}
                    style={{
                      width: "30px",
                      height: "30px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "14px",
                      fontWeight: 700,
                      color: "#475569",
                    }}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={handleTodayMonth}
                    style={{
                      padding: "0 10px",
                      height: "30px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "#102a43",
                    }}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={handleNextMonth}
                    style={{
                      width: "30px",
                      height: "30px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "14px",
                      fontWeight: 700,
                      color: "#475569",
                    }}
                  >
                    ›
                  </button>
                </div>
              </div>

              {/* Day of Week Headers */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  textAlign: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#64748b",
                  marginBottom: "8px",
                }}
              >
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                  <div key={day} style={{ padding: "4px 0" }}>
                    {day}
                  </div>
                ))}
              </div>

              {/* Days Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  gap: "4px",
                }}
              >
                {calendarDays.map((cell) => {
                  const isSelected = selectedCalendarDate === cell.dateStr;
                  const hasBookings = cell.count > 0;

                  return (
                    <button
                      key={cell.dateStr}
                      type="button"
                      onClick={() => {
                        // Toggle selected date filter
                        if (selectedCalendarDate === cell.dateStr) {
                          setSelectedCalendarDate(null);
                        } else {
                          setSelectedCalendarDate(cell.dateStr);
                        }
                      }}
                      style={{
                        height: "44px",
                        borderRadius: "8px",
                        border: isSelected ? "2px solid #0284c7" : "1px solid #f1f5f9",
                        background: isSelected
                          ? "#102a43"
                          : cell.isToday
                          ? "#eff6ff"
                          : cell.isCurrentMonth
                          ? "#ffffff"
                          : "#f8fafc",
                        color: isSelected
                          ? "#ffffff"
                          : cell.isToday
                          ? "#0284c7"
                          : cell.isCurrentMonth
                          ? "#1e293b"
                          : "#94a3b8",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "2px",
                        position: "relative",
                        transition: "all 0.1s ease",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: isSelected || cell.isToday ? 700 : 500 }}>
                        {cell.dayNum}
                      </span>
                      {hasBookings && (
                        <span
                          style={{
                            fontSize: "9.5px",
                            fontWeight: 800,
                            padding: "1px 5px",
                            borderRadius: "10px",
                            marginTop: "2px",
                            background: isSelected ? "#0284c7" : "#0d9488",
                            color: "#ffffff",
                          }}
                        >
                          {cell.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Selected Date Indicator & Clear */}
              <div
                style={{
                  marginTop: "16px",
                  paddingTop: "12px",
                  borderTop: "1px solid #f1f5f9",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ fontSize: "12.5px", color: "#475569" }}>
                  {selectedCalendarDate ? (
                    <span>
                      Filtered: <strong>{selectedCalendarDate}</strong>
                    </span>
                  ) : (
                    <span>Viewing all scheduled dates</span>
                  )}
                </div>

                {selectedCalendarDate && (
                  <button
                    type="button"
                    onClick={() => setSelectedCalendarDate(null)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#0284c7",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: "2px 6px",
                    }}
                  >
                    Clear Filter
                  </button>
                )}
              </div>
            </div>

            {/* Table of Pre-booked Patients */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: "14px",
                border: "1px solid #e2e8f0",
                boxShadow: "0 4px 16px rgba(16, 42, 67, 0.05)",
                overflow: "hidden",
              }}
            >
              {/* Filter Controls Bar */}
              <div
                style={{
                  padding: "16px 20px",
                  borderBottom: "1px solid #e2e8f0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                {/* Search Bar */}
                <div style={{ position: "relative", minWidth: "260px", flex: 1 }}>
                  <input
                    type="text"
                    placeholder="Search by patient name, mobile, doctor or reason..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      height: "38px",
                      padding: "0 12px 0 34px",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      fontSize: "13.5px",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      left: "11px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "#94a3b8",
                      fontSize: "14px",
                    }}
                  >
                    🔍
                  </span>
                </div>

                {/* Status Filter */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#64748b" }}>Status:</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{
                      height: "38px",
                      padding: "0 10px",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      fontSize: "13px",
                      backgroundColor: "#ffffff",
                      cursor: "pointer",
                      fontWeight: 600,
                      color: "#1e293b",
                    }}
                  >
                    <option value="all">All Statuses</option>
                    <option value="Confirmed">Confirmed</option>
                    <option value="Registered">Registered (UHID)</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => void loadPreBookings()}
                    style={{
                      height: "38px",
                      padding: "0 12px",
                      borderRadius: "8px",
                      border: "1px solid #cbd5e1",
                      background: "#f8fafc",
                      color: "#475569",
                      fontSize: "13px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    title="Refresh List"
                  >
                    🔄
                  </button>
                </div>
              </div>

              {/* Pre-booked Patients Table */}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13.5px" }}>
                  <thead>
                    <tr style={{ background: "#f8fafc", borderBottom: "1.5px solid #e2e8f0" }}>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Patient Name</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Mobile Number</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Appointment Date</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Time</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Reason & Doctor</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700 }}>Status</th>
                      <th style={{ padding: "12px 16px", color: "#475569", fontWeight: 700, textAlign: "right" }}>
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingList ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                          Loading pre-booked appointments...
                        </td>
                      </tr>
                    ) : preBookings.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "48px 20px" }}>
                          <div style={{ fontSize: "36px", marginBottom: "8px" }}>📅</div>
                          <div style={{ fontSize: "15px", fontWeight: 600, color: "#334155" }}>
                            No pre-booked appointments found
                          </div>
                          <p style={{ margin: "4px 0 16px", fontSize: "13px", color: "#64748b" }}>
                            {selectedCalendarDate
                              ? `No appointments scheduled for ${selectedCalendarDate}.`
                              : "Get started by adding a pre-booking in the booking tab."}
                          </p>
                          <button
                            type="button"
                            onClick={() => setActiveTab("book")}
                            style={{
                              padding: "8px 16px",
                              borderRadius: "8px",
                              border: "none",
                              background: "#102a43",
                              color: "#ffffff",
                              fontSize: "13px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            + Book a New Pre-Appointment
                          </button>
                        </td>
                      </tr>
                    ) : (
                      preBookings.map((item) => {
                        const isRegistered = (item.status || "").toLowerCase() === "registered";
                        const isCancelled = (item.status || "").toLowerCase() === "cancelled";

                        return (
                          <tr
                            key={item.id}
                            style={{
                              borderBottom: "1px solid #f1f5f9",
                              background: isCancelled ? "#fafafa" : "#ffffff",
                              transition: "background 0.1s ease",
                            }}
                          >
                            {/* Patient Name */}
                            <td style={{ padding: "12px 16px" }}>
                              <div style={{ fontWeight: 600, color: "#102a43" }}>{item.patient_name}</div>
                              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                                {item.age ? `Age: ${item.age}` : ""}
                                {item.age && item.email ? " • " : ""}
                                {item.email || ""}
                              </div>
                            </td>

                            {/* Mobile Number */}
                            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                              <span style={{ fontWeight: 500 }}>
                                {formatPhone(item.phone_country_code, item.phone)}
                              </span>
                            </td>

                            {/* Appointment Date */}
                            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                              {item.appointment_date ? (
                                <span style={{ fontWeight: 600, color: "#334155" }}>{item.appointment_date}</span>
                              ) : (
                                <span style={{ color: "#94a3b8" }}>—</span>
                              )}
                            </td>

                            {/* Appointment Time */}
                            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                              {item.appointment_time ? (
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "2px 8px",
                                    borderRadius: "6px",
                                    background: "#f1f5f9",
                                    fontWeight: 600,
                                    fontSize: "12px",
                                    color: "#334155",
                                  }}
                                >
                                  {item.appointment_time}
                                </span>
                              ) : (
                                <span style={{ color: "#94a3b8" }}>—</span>
                              )}
                            </td>

                            {/* Reason & Doctor */}
                            <td style={{ padding: "12px 16px" }}>
                              <div style={{ color: "#334155", fontWeight: 500 }}>{item.reason || "General Consultation"}</div>
                              {(item.doctor_name || item.department) && (
                                <div style={{ fontSize: "12px", color: "#0284c7", marginTop: "2px" }}>
                                  {item.doctor_name ? `Dr. ${item.doctor_name}` : ""}
                                  {item.doctor_name && item.department ? ` (${item.department})` : item.department || ""}
                                </div>
                              )}
                            </td>

                            {/* Status */}
                            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                              {isRegistered ? (
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    padding: "3px 8px",
                                    borderRadius: "12px",
                                    background: "#e0f2fe",
                                    color: "#0369a1",
                                    fontWeight: 700,
                                    fontSize: "11.5px",
                                  }}
                                >
                                  <span>✓ Registered</span>
                                  {item.patient_id && (
                                    <span style={{ fontSize: "10.5px", fontWeight: 600 }}>({item.patient_id})</span>
                                  )}
                                </span>
                              ) : isCancelled ? (
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "3px 8px",
                                    borderRadius: "12px",
                                    background: "#f1f5f9",
                                    color: "#64748b",
                                    fontWeight: 600,
                                    fontSize: "11.5px",
                                  }}
                                >
                                  Cancelled
                                </span>
                              ) : (
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "3px 8px",
                                    borderRadius: "12px",
                                    background: "#dcfce7",
                                    color: "#15803d",
                                    fontWeight: 700,
                                    fontSize: "11.5px",
                                  }}
                                >
                                  Confirmed
                                </span>
                              )}
                            </td>

                            {/* Actions */}
                            <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <div style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
                                {/* WhatsApp Follow-up Button */}
                                <button
                                  type="button"
                                  onClick={() => handleOpenWhatsAppModal(item)}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "5px",
                                    padding: "6px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #16a34a",
                                    background: "#f0fdf4",
                                    color: "#15803d",
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                  }}
                                  title="Send WhatsApp Follow-up reminder"
                                >
                                  <span>📱</span>
                                  <span>Follow-up</span>
                                </button>

                                {/* Create Patient Button */}
                                {!isRegistered && !isCancelled && (
                                  <button
                                    type="button"
                                    onClick={() => handleCreatePatient(item)}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "5px",
                                      padding: "6px 12px",
                                      borderRadius: "6px",
                                      border: "none",
                                      background: "#102a43",
                                      color: "#ffffff",
                                      fontSize: "12px",
                                      fontWeight: 600,
                                      cursor: "pointer",
                                    }}
                                    title="Auto-fill into official Patient Registration"
                                  >
                                    <span>Create Patient →</span>
                                  </button>
                                )}

                                {/* Cancel Button */}
                                {!isRegistered && !isCancelled && (
                                  <button
                                    type="button"
                                    onClick={() => handleCancelBooking(item.id)}
                                    style={{
                                      padding: "6px 8px",
                                      borderRadius: "6px",
                                      border: "1px solid #e2e8f0",
                                      background: "#ffffff",
                                      color: "#94a3b8",
                                      fontSize: "12px",
                                      cursor: "pointer",
                                    }}
                                    title="Cancel Pre-booking"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WHATSAPP FOLLOW-UP MODAL */}
      {/* ========================================================================= */}
      {whatsAppModalOpen && selectedFollowUpItem && (
        <Modal
          open={whatsAppModalOpen}
          onClose={() => setWhatsAppModalOpen(false)}
          title={`📱 WhatsApp Follow-up: ${selectedFollowUpItem.patient_name}`}
        >
          <div style={{ padding: "4px 0" }}>
            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#64748b" }}>
              Send an instant appointment confirmation and reminder directly to the patient's WhatsApp:
            </p>

            <div
              style={{
                background: "#f8fafc",
                padding: "12px 14px",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
                marginBottom: "16px",
                fontSize: "13px",
              }}
            >
              <div>
                <strong>Recipient:</strong> {selectedFollowUpItem.patient_name} (
                {formatPhone(selectedFollowUpItem.phone_country_code, selectedFollowUpItem.phone)})
              </div>
              <div style={{ marginTop: "4px", color: "#64748b" }}>
                <strong>Scheduled:</strong> {selectedFollowUpItem.appointment_date || "—"} at{" "}
                {selectedFollowUpItem.appointment_time || "—"}
              </div>
            </div>

            <label style={{ display: "block", fontSize: "12.5px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
              Message Content (Editable):
            </label>
            <textarea
              rows={9}
              value={customWhatsAppMsg}
              onChange={(e) => setCustomWhatsAppMsg(e.target.value)}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "1.5px solid #cbd5e1",
                fontSize: "13px",
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
                lineHeight: "1.5",
              }}
            />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "20px" }}>
              <button
                type="button"
                onClick={() => setWhatsAppModalOpen(false)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendWhatsApp}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 18px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                <span>Open in WhatsApp</span>
                <span>↗</span>
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
