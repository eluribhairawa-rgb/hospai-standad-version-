import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Modal } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import OpQueueTvDisplay from "./OpQueueTvDisplay";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onOpenPatient?: (patientId: string) => void;
  onNavigate?: (pageId: string) => void;
  /** Set when the logged-in employee is linked to a doctor; the API already limits the queue to them. */
  scopedDoctor?: string | null;
};

export type QueueStatus = "Waiting" | "In Consultation" | "Completed";

export type QueueItem = {
  id: string;
  token: string;
  name: string;
  uhid: string;
  ageGender: string;
  doctor: string;
  department: string;
  appointmentTime: string;
  status: QueueStatus;
  visitType: string;
  phone?: string;
  appointmentId?: number;
  called?: boolean;
  consultationFee?: number | string;
  paymentMode?: string;
  symptoms?: string;
  notes?: string;
  appointmentDate?: string;
};


export default function OpQueuePage({ setNotice, onOpenPatient, scopedDoctor }: Props) {
  // Queue list state -- starts empty and is populated from the real
  // /api/appointments fetch below; never seeded with fabricated patients.
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [showTv, setShowTv] = useState(false);

  // Filters state
  const [selectedDate, setSelectedDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [selectedDepartment, setSelectedDepartment] = useState("All Departments");
  const [selectedDoctor, setSelectedDoctor] = useState("All Doctors");
  const [selectedVisitType, setSelectedVisitType] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusTab, setStatusTab] = useState<"ALL" | "Waiting" | "In Consultation" | "Completed">("ALL");

  // Interactive status dropdown state
  const [openStatusDropdownId, setOpenStatusDropdownId] = useState<string | null>(null);
  const [openActionDropdownId, setOpenActionDropdownId] = useState<string | null>(null);

  // Calling state animation
  const [callingId, setCallingId] = useState<string | null>(null);

  // Patient Details Modal state (shows details on-screen without navigating away)
  const [detailsPatient, setDetailsPatient] = useState<QueueItem | null>(null);
  const [patientProfile, setPatientProfile] = useState<any | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [copiedUhid, setCopiedUhid] = useState(false);

  // Real doctor/department roster -- loaded from the actual Doctor Scheduling
  // data, never a hardcoded fake list, so "Add to Queue" only ever offers
  // doctors that genuinely have a schedule configured.
  type RealDoctor = { doctor_name: string; department: string; consultation_fee?: number; review_fee?: number; status?: string };
  const [realDoctors, setRealDoctors] = useState<RealDoctor[]>([]);
  const [realDepartments, setRealDepartments] = useState<string[]>([]);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".opq-status-dropdown-wrap") && !target.closest(".opq-action-dropdown-wrap")) {
        setOpenStatusDropdownId(null);
        setOpenActionDropdownId(null);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, []);

  // Sync to local storage
  const saveQueue = (updated: QueueItem[]) => {
    setQueue(updated);
    try {
      localStorage.setItem("hospai_op_queue_v2", JSON.stringify(updated));
    } catch {
      // silent
    }
  };

  // Real backend sync -- the queue is driven entirely by real appointments
  // for the selected date, never left on the fake seed once this resolves.
  const fetchLiveAppointments = async (dateOverride?: string) => {
    const targetDate = dateOverride || selectedDate;
    try {
      const data = await apiFetch<{ appointments?: Array<any> }>(`/api/appointments?date=${targetDate}`);
      // Emergency and Inpatient (IP) pre-admission appointments share this
      // same endpoint but belong to the Emergency Worklist / IPD Admission
      // modules, not the OP queue -- exclude them here rather than filtering
      // server-side, since legacy rows use inconsistent visit_type casing
      // ("OP", "op", even blank) that a strict server filter would drop.
      const appointments = (data?.appointments || []).filter((a) => {
        const vt = String(a.visit_type || "").trim().toLowerCase();
        return vt !== "emergency" && vt !== "ip";
      });
      const mapped: QueueItem[] = appointments.map((a) => {
        const ag = [a.age, a.gender].filter(Boolean).join(" / ");
        const rawStatus = String(a.status || "").trim().toLowerCase();
        const status: QueueStatus =
          ["in_consultation", "in consultation", "consulting"].includes(rawStatus)
            ? "In Consultation"
            : ["completed", "done", "consulted", "finished"].includes(rawStatus)
            ? "Completed"
            : "Waiting";
        const timeStr = a.appointment_time || (a.appointment_date ? new Date(a.appointment_date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-");
        return {
          id: String(a.id),
          token: String(a.token_no || a.id),
          name: a.patient_name || a.registered_patient_name || a.patient_id || "Patient",
          uhid: a.patient_id || "",
          ageGender: ag,
          doctor: a.doctor_name || "-",
          department: a.department || "-",
          appointmentTime: timeStr,
          status,
          visitType: a.visit_type || "OP",
          phone: a.phone || a.mobile || "",
          appointmentId: a.id,
          consultationFee: a.consultation_fee ?? a.fee,
          paymentMode: a.payment_mode,
          symptoms: a.symptoms || a.chief_complaint,
          notes: a.notes,
          appointmentDate: a.appointment_date,
        };
      });
      saveQueue(mapped);
    } catch {
      // Keep whatever was already shown (e.g. offline) rather than blocking the page.
    }
  };

  useEffect(() => {
    void fetchLiveAppointments(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  useEffect(() => {
    const loadRoster = async () => {
      try {
        const [deptData, docData, schedData] = await Promise.all([
          apiFetch<{ departments?: { department_name?: string }[] }>("/api/registration/departments").catch(() => ({ departments: [] })),
          apiFetch<{ doctors?: RealDoctor[] }>("/api/op/doctors").catch(() => ({ doctors: [] })),
          apiFetch<{ schedules?: Array<{ doctor_name: string; department: string }> }>("/api/op/doctor-schedules").catch(() => ({ schedules: [] })),
        ]);
        
        const rawDocs: RealDoctor[] = [
          ...(docData?.doctors || []),
          ...(schedData?.schedules || []).map((s) => ({ doctor_name: s.doctor_name, department: s.department })),
        ];

        const docMap = new Map<string, RealDoctor>();
        rawDocs.forEach((d) => {
          const status = String(d.status || "available").trim().toLowerCase();
          if (!["inactive", "disabled", "leave", "full", "unavailable", "false", "0", "cancelled"].includes(status)) {
            const nameKey = (d.doctor_name || "").trim().toLowerCase();
            if (nameKey && !docMap.has(nameKey)) {
              docMap.set(nameKey, d);
            }
          }
        });
        const availableDocs = Array.from(docMap.values());
        setRealDoctors(availableDocs);

        const allDepts = Array.from(
          new Set([
            ...(deptData?.departments || []).map((d) => (d.department_name || "").trim()),
            ...availableDocs.map((d) => (d.department || "").trim()),
          ])
        ).filter(Boolean).sort((a, b) => a.localeCompare(b));
        setRealDepartments(allDepts);
      } catch {
        setRealDepartments([]);
        setRealDoctors([]);
      }
    };
    void loadRoster();
  }, []);

  const doctorsList = useMemo(() => {
    return realDoctors.map((d) => ({ name: d.doctor_name, department: d.department }));
  }, [realDoctors]);

  const departmentList = realDepartments;

  const availableDoctorsForFilter = useMemo(() => {
    if (selectedDepartment === "All Departments") {
      return doctorsList;
    }
    const targetDept = selectedDepartment.trim().toLowerCase();
    return doctorsList.filter(
      (d) => d.department && d.department.trim().toLowerCase() === targetDept
    );
  }, [doctorsList, selectedDepartment]);

  // Dynamic filter lists
  const filteredQueue = useMemo(() => {
    const norm = (s?: string) => (s || "").trim().toLowerCase();
    const normDoc = (s?: string) => (s || "").toLowerCase().replace(/^dr\.?\s*/i, "").trim();

    return queue.filter((item) => {
      // Resolve item's department, falling back to doctor's roster department if empty
      let itemDept = item.department && item.department !== "-" ? item.department : "";
      if (!itemDept && item.doctor && item.doctor !== "-") {
        const found = doctorsList.find((d) => normDoc(d.name) === normDoc(item.doctor));
        if (found?.department) itemDept = found.department;
      }

      // Department filter
      if (selectedDepartment !== "All Departments") {
        const targetDept = norm(selectedDepartment);
        const matchesDept = norm(itemDept) === targetDept;
        const docObj = doctorsList.find((d) => normDoc(d.name) === normDoc(item.doctor));
        const docMatchesDept = docObj ? norm(docObj.department) === targetDept : false;
        if (!matchesDept && !docMatchesDept) {
          return false;
        }
      }

      // Doctor filter
      if (selectedDoctor !== "All Doctors") {
        const targetDoc = normDoc(selectedDoctor);
        const itemDoc = normDoc(item.doctor);
        if (itemDoc !== targetDoc && norm(item.doctor) !== norm(selectedDoctor)) {
          return false;
        }
      }

      // Visit Type filter
      if (selectedVisitType !== "All") {
        const normVisit = norm(item.visitType);
        const normTarget = norm(selectedVisitType);
        if (normVisit !== normTarget && !normVisit.includes(normTarget)) {
          return false;
        }
      }

      // Status Tab filter
      if (statusTab !== "ALL" && item.status !== statusTab) {
        return false;
      }

      // Search query (name, UHID, or phone)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesUhid = item.uhid.toLowerCase().includes(q);
        const matchesPhone = item.phone?.toLowerCase().includes(q);
        if (!matchesName && !matchesUhid && !matchesPhone) return false;
      }

      return true;
    });
  }, [queue, selectedDepartment, selectedDoctor, selectedVisitType, statusTab, searchQuery, doctorsList]);

  // Status counts
  const counts = useMemo(() => {
    const waiting = queue.filter((q) => q.status === "Waiting").length;
    const inConsultation = queue.filter((q) => q.status === "In Consultation").length;
    const completed = queue.filter((q) => q.status === "Completed").length;
    return {
      all: queue.length,
      waiting,
      inConsultation,
      completed,
    };
  }, [queue]);

  // Update Status handler
  const handleStatusChange = async (id: string, newStatus: QueueStatus): Promise<boolean> => {
    const item = queue.find((q) => q.id === id);
    setOpenStatusDropdownId(null);
    if (!item || item.status === newStatus) return false;

    // Completed is terminal -- a finished consultation can't be reopened or sent back to waiting.
    if (item.status === "Completed") {
      setNotice({
        type: "error",
        message: `Token ${item.token} (${item.name}) is already completed. Its status can no longer be changed.`,
      });
      return false;
    }

    // Enforce single active consultation limit per doctor
    if (newStatus === "In Consultation") {
      const targetDoctor = item.doctor && item.doctor !== "-" ? item.doctor : "";
      if (targetDoctor) {
        const existingActive = queue.find(
          (q) =>
            q.id !== id &&
            q.status === "In Consultation" &&
            q.doctor &&
            q.doctor.trim().toLowerCase() === targetDoctor.trim().toLowerCase()
        );
        if (existingActive) {
          setNotice({
            type: "error",
            message: "Already a patient is present in consultation.",
          });
          return false;
        }
      }
    }

    // Persist first; only reflect the change on screen once the backend accepts it.
    if (item.appointmentId) {
      try {
        const backendStatus =
          newStatus === "Waiting"
            ? "pending"
            : newStatus === "In Consultation"
            ? "in_consultation"
            : "completed";
        await apiFetch(`/api/appointments/${item.appointmentId}`, {
          method: "PUT",
          body: JSON.stringify({ status: backendStatus }),
        });
      } catch (err: any) {
        setNotice({
          type: "error",
          message: err?.message || (err instanceof Error ? err.message : "Could not update queue status. Please try again."),
        });
        return false;
      }
    }

    saveQueue(queue.map((q) => (q.id === id ? { ...q, status: newStatus } : q)));
    setDetailsPatient((prev) => (prev && prev.id === id ? { ...prev, status: newStatus } : prev));

    setNotice({
      type: "success",
      message: `Token ${item?.token || ""} (${item?.name || "Patient"}) status updated to ${newStatus}.`,
    });
    return true;
  };

  // Workflow Action Handler (No voice/audio):
  // - When status is "Waiting": Clicking "Call Patient" moves patient to "In Consultation"
  // - When status is "In Consultation": Clicking "Completed" moves patient to "Completed"
  const handleWorkflowAction = async (patient: QueueItem) => {
    if (patient.status === "Waiting") {
      const targetDoctor = patient.doctor && patient.doctor !== "-" ? patient.doctor : "";
      if (targetDoctor) {
        const existingActive = queue.find(
          (q) =>
            q.id !== patient.id &&
            q.status === "In Consultation" &&
            q.doctor &&
            q.doctor.trim().toLowerCase() === targetDoctor.trim().toLowerCase()
        );
        if (existingActive) {
          setNotice({
            type: "error",
            message: "Already a patient is present in consultation.",
          });
          return;
        }
      }
      setCallingId(patient.id);
      setTimeout(() => setCallingId(null), 1200);
      const ok = await handleStatusChange(patient.id, "In Consultation");
      if (ok) {
        setNotice({
          type: "success",
          message: `Patient ${patient.name} (${patient.token}) moved to In Consultation.`,
        });
      }
    } else if (patient.status === "In Consultation") {
      const ok = await handleStatusChange(patient.id, "Completed");
      if (ok) {
        setNotice({
          type: "success",
          message: `Consultation for ${patient.name} (${patient.token}) completed. Patient carries physical prescription paper to Pharmacy / Lab.`,
        });
      }
    }
  };

  // Clear filters
  const handleClearFilters = () => {
    setSelectedDepartment("All Departments");
    setSelectedDoctor("All Doctors");
    setSelectedVisitType("All");
    setSearchQuery("");
    setStatusTab("ALL");
    setNotice({ type: "info", message: "Filters reset to default view." });
  };

  // Open on-screen Patient Details Modal without leaving Queue Management
  const handleOpenPatientDetails = async (patient: QueueItem) => {
    setDetailsPatient(patient);
    setPatientProfile(null);
    setCopiedUhid(false);

    const uhidOrId = (patient.uhid || patient.name || "").trim();
    if (!uhidOrId) return;

    setLoadingProfile(true);
    try {
      const res = await apiFetch<{ patient?: any }>(`/api/patients/${encodeURIComponent(uhidOrId)}`);
      if (res?.patient) {
        setPatientProfile(res.patient);
        return;
      }
    } catch {
      // fallback
    }

    try {
      const searchRes = await apiFetch<{ patients?: any[] }>(`/api/patients?q=${encodeURIComponent(uhidOrId)}`);
      if (searchRes?.patients && searchRes.patients.length > 0) {
        setPatientProfile(searchRes.patients[0]);
      }
    } catch {
      // silent fallback
    } finally {
      setLoadingProfile(false);
    }
  };

  const getInitials = (name?: string) => {
    if (!name) return "PT";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const handleCopyUhid = (uhid: string) => {
    if (!uhid) return;
    void navigator.clipboard?.writeText(uhid);
    setCopiedUhid(true);
    setTimeout(() => setCopiedUhid(false), 2000);
  };

  const handleModalWorkflowAction = async () => {
    if (!detailsPatient) return;
    const current = detailsPatient;
    if (current.status === "Waiting") {
      const targetDoctor = current.doctor && current.doctor !== "-" ? current.doctor : "";
      if (targetDoctor) {
        const existingActive = queue.find(
          (q) =>
            q.id !== current.id &&
            q.status === "In Consultation" &&
            q.doctor &&
            q.doctor.trim().toLowerCase() === targetDoctor.trim().toLowerCase()
        );
        if (existingActive) {
          setNotice({
            type: "error",
            message: "Already a patient is present in consultation.",
          });
          return;
        }
      }
    }
    const nextStatus: QueueStatus = current.status === "Waiting" ? "In Consultation" : current.status === "In Consultation" ? "Completed" : current.status;
    const ok = await handleStatusChange(current.id, nextStatus);
    if (ok) {
      setDetailsPatient((prev) => (prev ? { ...prev, status: nextStatus } : null));
    }
  };

  return (
    <div className="opq-page-root">
      {showTv && <OpQueueTvDisplay onClose={() => setShowTv(false)} />}
      {/* Top Header Row */}
      <div className="opq-top-row">
        <div className="opq-top-left">
          {/* Breadcrumbs */}
          <div className="opq-breadcrumbs">
            <span className="opq-crumb-root" onClick={() => window.history.back()}>
              HospAI
            </span>
            <span className="opq-crumb-sep">/</span>
            <span className="opq-crumb-module">OP Management</span>
            <span className="opq-crumb-sep">/</span>
            <div className="opq-crumb-badge">
              <span className="opq-crumb-badge-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00828a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <span>Queue Management</span>
              <span className="opq-crumb-badge-chevron">▾</span>
            </div>
          </div>

          {/* Title & Subtitle */}
          <h1 className="opq-page-title">OP Queue Management</h1>
          <p className="opq-page-subtitle">Manage OP patient queue and consultation status.</p>
        </div>

        {/* Top-Right: Date Picker */}
        <div className="opq-top-right">
          <button type="button" className="opq-tv-btn" onClick={() => setShowTv(true)} title="Open waiting-hall TV screen (next patient per doctor)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="13" rx="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
            TV Display
          </button>
          <div className="opq-date-pill">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00828a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                const newDate = e.target.value;
                setSelectedDate(newDate);
                setStatusTab("Completed");
                if (newDate) {
                  void fetchLiveAppointments(newDate);
                }
              }}
              className="opq-date-input"
            />
          </div>
        </div>
      </div>

      {scopedDoctor && (
        <div className="opq-scoped-doctor" role="status">
          Showing only patients assigned to <strong>{scopedDoctor}</strong>
        </div>
      )}

      {/* Filter Bar Card */}
      <div className="opq-filter-card">
        <div className="opq-filter-field">
          <label className="opq-filter-label">Department</label>
          <div className="opq-select-wrap">
            <select
              value={selectedDepartment}
              onChange={(e) => {
                const newDept = e.target.value;
                setSelectedDepartment(newDept);
                setSelectedDoctor("All Doctors");
              }}
              className="opq-select"
            >
              <option value="All Departments">All Departments</option>
              {departmentList.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="opq-filter-field">
          <label className="opq-filter-label">Doctor</label>
          <div className="opq-select-wrap">
            <select
              value={scopedDoctor || selectedDoctor}
              disabled={!!scopedDoctor}
              title={scopedDoctor ? "Your login only shows your own patients." : undefined}
              onChange={(e) => {
                const newDoc = e.target.value;
                setSelectedDoctor(newDoc);
                if (newDoc !== "All Doctors") {
                  const docObj = doctorsList.find((d) => d.name === newDoc);
                  if (docObj?.department) {
                    setSelectedDepartment(docObj.department);
                  }
                }
              }}
              className="opq-select"
            >
              <option value="All Doctors">
                {selectedDepartment !== "All Departments" ? `All Doctors (${selectedDepartment})` : "All Doctors"}
              </option>
              {scopedDoctor && <option value={scopedDoctor}>{scopedDoctor}</option>}
              {!scopedDoctor && availableDoctorsForFilter.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="opq-filter-field">
          <label className="opq-filter-label">Visit Type</label>
          <div className="opq-select-wrap">
            <select
              value={selectedVisitType}
              onChange={(e) => setSelectedVisitType(e.target.value)}
              className="opq-select"
            >
              <option value="All">All</option>
              <option value="OP">OP</option>
              <option value="Follow-up">Follow-up</option>
              <option value="Emergency">Emergency</option>
              <option value="Review">Review</option>
            </select>
          </div>
        </div>

        <div className="opq-filter-search-group">
          <div className="opq-search-box">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opq-search-icon">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, UHID or phone..."
              className="opq-search-input"
              style={{ paddingLeft: "42px", height: "40px" }}
            />
          </div>

          <button
            type="button"
            className="opq-btn-clear"
            onClick={handleClearFilters}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Status Filter Tabs Row */}
      <div className="opq-status-tabs-row">
        <button
          type="button"
          className={`opq-status-pill ${statusTab === "ALL" ? "active" : ""}`}
          onClick={() => setStatusTab("ALL")}
        >
          <span className="opq-status-icon">●</span>
          <span>All ({counts.all})</span>
        </button>

        <button
          type="button"
          className={`opq-status-pill ${statusTab === "Waiting" ? "active" : ""}`}
          onClick={() => setStatusTab("Waiting")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Waiting ({counts.waiting})</span>
        </button>

        <button
          type="button"
          className={`opq-status-pill ${statusTab === "In Consultation" ? "active" : ""}`}
          onClick={() => setStatusTab("In Consultation")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>In Consultation ({counts.inConsultation})</span>
        </button>

        <button
          type="button"
          className={`opq-status-pill ${statusTab === "Completed" ? "active" : ""}`}
          onClick={() => setStatusTab("Completed")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>Completed ({counts.completed})</span>
        </button>
      </div>

      {/* Main Queue Data Table Card */}
      <div className="opq-table-card">
        <table className="opq-table">
          <thead>
            <tr>
              <th style={{ width: "9%" }}>Token</th>
              <th style={{ width: "15%" }}>Patient Name</th>
              <th style={{ width: "16%" }}>UHID</th>
              <th style={{ width: "12%" }}>Age / Gender</th>
              <th style={{ width: "16%" }}>Doctor</th>
              <th style={{ width: "13%" }}>Appointment Time</th>
              <th style={{ width: "11%" }}>Status</th>
              <th style={{ width: "8%", textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredQueue.map((patient) => {
              const isStatusDropdownOpen = openStatusDropdownId === patient.id;
              const isActionDropdownOpen = openActionDropdownId === patient.id;
              const isCalling = callingId === patient.id;

              return (
                <tr key={patient.id} className={isCalling ? "opq-row-calling" : ""}>
                  {/* Token */}
                  <td>
                    <span className="opq-token-badge">{patient.token}</span>
                  </td>

                  {/* Patient Name */}
                  <td>
                    <span
                      className="opq-patient-name"
                      style={{ cursor: "pointer" }}
                      onClick={() => handleOpenPatientDetails(patient)}
                      title="Click to view patient details"
                    >
                      {patient.name}
                    </span>
                  </td>

                  {/* UHID */}
                  <td>
                    <span
                      className="opq-uhid-text"
                      style={{ cursor: "pointer", textDecoration: "underline dotted" }}
                      onClick={() => handleOpenPatientDetails(patient)}
                      title="Click to view patient details"
                    >
                      {patient.uhid}
                    </span>
                  </td>

                  {/* Age / Gender */}
                  <td>
                    <span className="opq-age-gender">{patient.ageGender}</span>
                  </td>

                  {/* Doctor & Department */}
                  <td>
                    <div className="opq-doctor-cell">
                      <span className="opq-doctor-name">{patient.doctor}</span>
                      <span className="opq-doctor-dept">{patient.department}</span>
                    </div>
                  </td>

                  {/* Appointment Time */}
                  <td>
                    <span className="opq-time-text">{patient.appointmentTime}</span>
                  </td>

                  {/* Interactive Status Dropdown Pill */}
                  <td>
                    <div className="opq-status-dropdown-wrap">
                      <button
                        type="button"
                        className={`opq-status-btn status-${patient.status.toLowerCase().replace(/\s+/g, "-")}${patient.status === "Completed" ? " is-locked" : ""}`}
                        disabled={patient.status === "Completed"}
                        title={patient.status === "Completed" ? "Consultation completed - status is locked" : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (patient.status === "Completed") return;
                          setOpenActionDropdownId(null);
                          setOpenStatusDropdownId(isStatusDropdownOpen ? null : patient.id);
                        }}
                      >
                        <span className="status-dot">●</span>
                        <span className="status-label">{patient.status}</span>
                        {patient.status !== "Completed" && (
                          <span className="status-arrow">{isStatusDropdownOpen ? "▴" : "▾"}</span>
                        )}
                      </button>

                      {/* Dropdown Menu */}
                      {isStatusDropdownOpen && patient.status !== "Completed" && (
                        <div className="opq-status-menu" onClick={(e) => e.stopPropagation()}>
                          {/* Option 1: Waiting */}
                          <div
                            className={`opq-status-option ${patient.status === "Waiting" ? "active" : ""}`}
                            onClick={() => handleStatusChange(patient.id, "Waiting")}
                          >
                            <div className="option-title-row">
                              <span className="option-dot dot-waiting">●</span>
                              <span className="option-title">Waiting</span>
                            </div>
                            <div className="option-desc">Patient is waiting for consultation</div>
                          </div>

                          {/* Option 2: In Consultation */}
                          <div
                            className={`opq-status-option ${patient.status === "In Consultation" ? "active" : ""}`}
                            onClick={() => handleStatusChange(patient.id, "In Consultation")}
                          >
                            <div className="option-title-row">
                              <span className="option-dot dot-in-consultation">●</span>
                              <span className="option-title">In Consultation</span>
                            </div>
                            <div className="option-desc">Patient is currently with doctor</div>
                          </div>

                          {/* Option 3: Completed */}
                          <div
                            className="opq-status-option"
                            onClick={() => handleStatusChange(patient.id, "Completed")}
                          >
                            <div className="option-title-row">
                              <span className="option-dot dot-completed">●</span>
                              <span className="option-title">Completed</span>
                            </div>
                            <div className="option-desc">Consultation finished</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Actions: Call Patient / Completed & ... More Menu */}
                  <td>
                    <div className="opq-actions-cell">
                      {patient.status === "Waiting" && (
                        <button
                          type="button"
                          className={`opq-btn-action opq-btn-call-patient ${isCalling ? "calling" : ""}`}
                          onClick={() => handleWorkflowAction(patient)}
                          title={`Call ${patient.name} into consultation`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                            <circle cx="8.5" cy="7" r="4" />
                            <polyline points="17 11 19 13 23 9" />
                          </svg>
                          <span>{isCalling ? "Moving..." : "Call Patient"}</span>
                        </button>
                      )}

                      {patient.status === "In Consultation" && (
                        <button
                          type="button"
                          className="opq-btn-action opq-btn-completed"
                          onClick={() => handleWorkflowAction(patient)}
                          title={`Mark consultation finished for ${patient.name}`}
                        >
                          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                            <circle cx="4" cy="4" r="4" fill="currentColor" />
                          </svg>
                          <span>Complete</span>
                        </button>
                      )}

                      {patient.status === "Completed" && (
                        <span className="opq-badge-done">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span>Done</span>
                        </span>
                      )}


                    </div>
                  </td>
                </tr>
              );
            })}

            {filteredQueue.length === 0 && (
              <tr>
                <td colSpan={8} className="opq-empty-cell">
                  No patients matching the selected filters. Click &quot;Clear&quot; to restore all queue items.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Patient Details Modal (Shows on-screen details when clicking UHID or Patient Name) */}
      <Modal
        open={!!detailsPatient}
        onClose={() => setDetailsPatient(null)}
        title="Patient Details & Queue Status"
        className="ui-modal-wide"
      >
        {detailsPatient && (
          <div className="opq-details-modal">
            {/* Hero Card */}
            <div className="opq-details-hero">
              <div className="opq-details-hero-left">
                <div className="opq-details-avatar">
                  {getInitials(patientProfile?.name || detailsPatient.name)}
                </div>
                <div className="opq-details-hero-info">
                  <div className="opq-details-hero-title-row">
                    <span className="opq-details-patient-name">
                      {patientProfile?.name || detailsPatient.name}
                    </span>
                    {detailsPatient.uhid && (
                      <button
                        type="button"
                        className="opq-details-uhid-badge"
                        onClick={() => handleCopyUhid(detailsPatient.uhid)}
                        title="Click to copy UHID"
                      >
                        <span>{detailsPatient.uhid}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        {copiedUhid && <span style={{ color: "#16a34a", fontSize: "11px", fontWeight: "bold" }}>Copied!</span>}
                      </button>
                    )}
                  </div>
                  <div className="opq-details-meta-row">
                    <span className="opq-details-meta-item">
                      <strong>Age / Gender:</strong> {patientProfile ? [patientProfile.age ? `${patientProfile.age} Yrs` : null, patientProfile.gender].filter(Boolean).join(" / ") : detailsPatient.ageGender || "-"}
                    </span>
                    {(patientProfile?.phone || detailsPatient.phone) && (
                      <span className="opq-details-meta-item">
                        <strong>Phone:</strong> {patientProfile?.phone || detailsPatient.phone}
                      </span>
                    )}
                    {patientProfile?.blood_group && (
                      <span className="opq-details-meta-item">
                        <strong>Blood:</strong> <span style={{ color: "#dc2626", fontWeight: "bold" }}>{patientProfile.blood_group}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="opq-details-hero-right">
                <div className="opq-details-token-pill">
                  Token #{detailsPatient.token}
                </div>
                <div className={`opq-status-btn status-${detailsPatient.status.toLowerCase().replace(/\s+/g, "-")}`} style={{ cursor: "default" }}>
                  <span className="status-dot">●</span>
                  <span className="status-label">{detailsPatient.status}</span>
                </div>
              </div>
            </div>

            {loadingProfile && (
              <div style={{ textAlign: "center", padding: "8px", fontSize: "12.5px", color: "#64748b" }}>
                Fetching comprehensive patient records...
              </div>
            )}

            {/* 3 Grid Cards */}
            <div className="opq-details-grid">
              {/* Card 1: Personal & Contact Information */}
              <div className="opq-details-card">
                <div className="opq-details-card-header">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opq-details-card-icon">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  <span>Personal Information</span>
                </div>
                <div className="opq-details-rows">
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Full Name</span>
                    <span className="opq-details-row-val">{patientProfile?.name || detailsPatient.name}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">UHID</span>
                    <span className="opq-details-row-val" style={{ fontFamily: "monospace" }}>{detailsPatient.uhid || patientProfile?.patient_id || "-"}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Date of Birth</span>
                    <span className="opq-details-row-val">{patientProfile?.dob || "-"}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Age / Gender</span>
                    <span className="opq-details-row-val">
                      {patientProfile ? [patientProfile.age ? `${patientProfile.age} Yrs` : null, patientProfile.gender].filter(Boolean).join(" / ") : detailsPatient.ageGender || "-"}
                    </span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Mobile Number</span>
                    <span className="opq-details-row-val">{patientProfile?.phone || detailsPatient.phone || "-"}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Alternate / Emergency</span>
                    <span className="opq-details-row-val">
                      {[patientProfile?.emergency_phone, patientProfile?.family_mobile, patientProfile?.emergency_contact].filter(Boolean).join(" • ") || "-"}
                    </span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Address</span>
                    <span className="opq-details-row-val">{patientProfile?.address || "-"}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Insurance</span>
                    <span className="opq-details-row-val">
                      {patientProfile?.insurance_provider ? `${patientProfile.insurance_provider} (${patientProfile.insurance_policy_no || "Active"})` : "Self-Pay / Cash"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 2: Consultation & Queue Details */}
              <div className="opq-details-card">
                <div className="opq-details-card-header">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opq-details-card-icon">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                  </svg>
                  <span>Queue & Consultation</span>
                </div>
                <div className="opq-details-rows">
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Doctor</span>
                    <span className="opq-details-row-val" style={{ color: "#00828a" }}>{detailsPatient.doctor}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Department</span>
                    <span className="opq-details-row-val">{detailsPatient.department}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Appointment Time</span>
                    <span className="opq-details-row-val">{detailsPatient.appointmentTime}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Visit Type</span>
                    <span className="opq-details-row-val">{detailsPatient.visitType}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Consultation Fee</span>
                    <span className="opq-details-row-val">
                      {detailsPatient.consultationFee !== undefined && detailsPatient.consultationFee !== null
                        ? `₹${detailsPatient.consultationFee}`
                        : patientProfile?.consultation_fee
                        ? `₹${patientProfile.consultation_fee}`
                        : "₹0"}
                    </span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Payment Mode</span>
                    <span className="opq-details-row-val">
                      {detailsPatient.paymentMode || patientProfile?.payment_mode || "Cash"}
                    </span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Status</span>
                    <span className="opq-details-row-val" style={{ fontWeight: 700 }}>{detailsPatient.status}</span>
                  </div>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Chief Complaint / Notes</span>
                    <span className="opq-details-row-val">
                      {detailsPatient.symptoms || detailsPatient.notes || patientProfile?.chief_complaint || "-"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 3: Clinical Snapshot & Vitals */}
              <div className="opq-details-card">
                <div className="opq-details-card-header">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opq-details-card-icon">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  <span>Recorded Vitals</span>
                </div>
                <div className="opq-details-vitals-container">
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.bp || "—"}</span>
                    <span className="opq-details-vital-lbl">BP (mmHg)</span>
                  </div>
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.pulse ? `${patientProfile.pulse} bpm` : "—"}</span>
                    <span className="opq-details-vital-lbl">Pulse</span>
                  </div>
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.temperature ? `${patientProfile.temperature} °F` : "—"}</span>
                    <span className="opq-details-vital-lbl">Temp</span>
                  </div>
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.spo2 ? `${patientProfile.spo2}%` : "—"}</span>
                    <span className="opq-details-vital-lbl">SpO2</span>
                  </div>
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.weight ? `${patientProfile.weight} kg` : "—"}</span>
                    <span className="opq-details-vital-lbl">Weight</span>
                  </div>
                  <div className="opq-details-vital-tile">
                    <span className="opq-details-vital-val">{patientProfile?.height ? `${patientProfile.height} cm` : "—"}</span>
                    <span className="opq-details-vital-lbl">Height</span>
                  </div>
                </div>
                <div className="opq-details-rows" style={{ marginTop: "4px" }}>
                  <div className="opq-details-row">
                    <span className="opq-details-row-label">Allergies</span>
                    <span className="opq-details-row-val" style={{ color: patientProfile?.allergies ? "#dc2626" : undefined }}>
                      {patientProfile?.allergies || (patientProfile?.allergy_status === "confirmed_none" ? "No known allergies" : "None recorded")}
                    </span>
                  </div>
                  {patientProfile?.last_consultation_date && (
                    <div className="opq-details-row">
                      <span className="opq-details-row-label">Last Visit</span>
                      <span className="opq-details-row-val">{patientProfile.last_consultation_date}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="opq-details-footer">
              <div>
                {onOpenPatient && (
                  <button
                    type="button"
                    className="opq-details-link-btn"
                    onClick={() => {
                      const uhid = detailsPatient.uhid || detailsPatient.name;
                      setDetailsPatient(null);
                      onOpenPatient(uhid);
                    }}
                    title="Open complete patient profile in Patients module"
                  >
                    <span>Open in Patients Module</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="opq-details-footer-actions">
                {detailsPatient.status === "Waiting" && (
                  <button
                    type="button"
                    className="opq-btn-action opq-btn-call-patient"
                    onClick={handleModalWorkflowAction}
                    style={{ height: "36px", padding: "0 16px", fontSize: "13px" }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                      <polyline points="17 11 19 13 23 9" />
                    </svg>
                    <span>Call Patient</span>
                  </button>
                )}

                {detailsPatient.status === "In Consultation" && (
                  <button
                    type="button"
                    className="opq-btn-action opq-btn-completed"
                    onClick={handleModalWorkflowAction}
                    style={{ height: "36px", padding: "0 16px", fontSize: "13px" }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>Mark Completed</span>
                  </button>
                )}

                <button
                  type="button"
                  className="opq-modal-cancel"
                  onClick={() => setDetailsPatient(null)}
                  style={{ height: "36px", padding: "0 18px" }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
