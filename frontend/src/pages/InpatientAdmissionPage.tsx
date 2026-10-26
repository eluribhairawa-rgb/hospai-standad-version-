import { useState, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Notice } from "../types";
import { apiFetch, reportError } from "../lib/api";
import { printViaIframe } from "../lib/printViaIframe";
import { Button, Input, Label, Modal } from "../components/ui";
import PatientSearchPicker from "../components/PatientSearchPicker";
import type { HospitalBed } from "./BedManagementPage";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

const DEPARTMENTS = [
  "General Medicine",
  "Cardiology",
  "Orthopedics",
  "General Surgery",
  "ICU / Critical Care",
  "Pediatrics",
  "Obstetrics & Gynaecology",
  "Nephrology",
  "Pulmonology",
  "Neurology",
  "ENT",
  "Urology",
  "Dermatology",
];

const DOCTORS = [
  { doctor_name: "Dr. Arjun Mehta", department: "General Medicine" },
  { doctor_name: "Dr. Priya Sharma", department: "General Medicine" },
  { doctor_name: "Dr. Sameer Khan", department: "Cardiology" },
  { doctor_name: "Dr. Karan Bhatia", department: "Orthopedics" },
  { doctor_name: "Dr. Neha Gupta", department: "General Surgery" },
  { doctor_name: "Dr. Suresh Reddy", department: "ICU / Critical Care" },
  { doctor_name: "Dr. Sunita Rao", department: "Pediatrics" },
  { doctor_name: "Dr. Priya Nair", department: "Obstetrics & Gynaecology" },
  { doctor_name: "Dr. Ananya Rao", department: "Nephrology" },
  { doctor_name: "Dr. Rohit Verma", department: "Pulmonology" },
  { doctor_name: "Dr. Rajesh Kumar", department: "Neurology" },
  { doctor_name: "Dr. Vikram Singh", department: "ENT" },
  { doctor_name: "Dr. Pooja Iyer", department: "Urology" },
];

type SelectedPatient = {
  uhid: string;
  patientName: string;
  ageGender: string;
  mobile: string;
};

type DoctorOrder = {
  doctor: string;
  department: string;
  date: string;
};

export default function InpatientAdmissionPage({ setNotice, onNavigate }: Props) {
  // The patient being admitted -- always an already-registered patient,
  // found by search. Registration itself happens once, at the Registration
  // Desk (AddPatientPage); this page only records the doctor's admission
  // order and allocates a bed, it never creates a new patient.
  const [selectedPatient, setSelectedPatient] = useState<SelectedPatient | null>(null);
  const [doctorOrder, setDoctorOrder] = useState<DoctorOrder | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(false);

  // Clinical Admission Details (the doctor's order, recorded by staff)
  const [department, setDepartment] = useState("General Medicine");
  const [consultingDoctor, setConsultingDoctor] = useState("Dr. Priya Sharma");
  const [admissionType, setAdmissionType] = useState("Planned");
  const [triagePriority, setTriagePriority] = useState<"Critical" | "Urgent" | "Stable">("Stable");
  const [reasonForAdmission, setReasonForAdmission] = useState("");
  const [expectedStay, setExpectedStay] = useState("3");
  const [notes, setNotes] = useState("");

  // Bed Allocation
  const [wardFilter, setWardFilter] = useState("All Wards");
  const [selectedBedNo, setSelectedBedNo] = useState("");
  const [availableBeds, setAvailableBeds] = useState<HospitalBed[]>([]);
  const [loadingBeds, setLoadingBeds] = useState(false);

  // Confirmed admission record, for the confirmation panel / slip printing
  const [admittedRecord, setAdmittedRecord] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadBeds = async () => {
    setLoadingBeds(true);
    try {
      const res = await apiFetch<{ beds: HospitalBed[] }>("/api/beds?status=available");
      setAvailableBeds(res.beds || []);
    } catch {
      // Fallback
    } finally {
      setLoadingBeds(false);
    }
  };

  useEffect(() => {
    void loadBeds();
    const saved = localStorage.getItem("selected_admission_patient");
    if (saved) {
      localStorage.removeItem("selected_admission_patient");
      apiFetch<any>(`/api/patients/${encodeURIComponent(saved)}`)
        .then((res) => {
          const p = res?.patient || res;
          if (p && (p.patient_id || p.uhid)) {
            handleSelectPatient({
              uhid: p.patient_id || p.uhid,
              patientName: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.patient_id,
              ageGender: `${p.age || "-"} / ${p.gender || "-"}`,
              mobile: p.phone || "-",
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  // Filter doctors by department
  const filteredDoctors = useMemo(() => {
    const list = DOCTORS.filter((d) => d.department.toLowerCase() === department.toLowerCase());
    return list.length > 0 ? list : DOCTORS;
  }, [department]);

  useEffect(() => {
    if (filteredDoctors.length > 0 && !filteredDoctors.some((d) => d.doctor_name === consultingDoctor)) {
      setConsultingDoctor(filteredDoctors[0].doctor_name);
    }
  }, [department, filteredDoctors, consultingDoctor]);

  // Filtered available beds
  const displayBeds = useMemo(() => {
    if (wardFilter === "All Wards") return availableBeds;
    return availableBeds.filter((b) => b.ward.toLowerCase().includes(wardFilter.toLowerCase()));
  }, [availableBeds, wardFilter]);

  const chosenBed = availableBeds.find((b) => b.bed_no === selectedBedNo);

  // When staff selects a patient, look up their most recent IP pre-admission
  // appointment (booked at Registration Desk) so the department/doctor
  // fields reflect the doctor's actual order instead of an arbitrary
  // receptionist pick.
  const handleSelectPatient = async (pat: SelectedPatient) => {
    setSelectedPatient(pat);
    setAdmittedRecord(null);
    setDoctorOrder(null);
    setLoadingOrder(true);
    try {
      const res = await apiFetch<{ appointments?: any[] }>(
        `/api/appointments?patient_id=${encodeURIComponent(pat.uhid)}`
      );
      const appts = res.appointments || [];
      const latest = appts[appts.length - 1];
      if (latest) {
        const order: DoctorOrder = {
          doctor: latest.doctor_name || "",
          department: latest.department || "",
          date: latest.appointment_date || "",
        };
        setDoctorOrder(order);
        if (order.department) setDepartment(order.department);
        if (order.doctor) setConsultingDoctor(order.doctor);
      }
    } catch {
      // No appointment found is a normal outcome, not an error -- staff can
      // still record the admission manually.
    } finally {
      setLoadingOrder(false);
    }
  };

  // Resets the working admission form fields (patient search, clinical order,
  // bed selection) without touching admittedRecord -- used both by the manual
  // "Clear Form" action and automatically right after a successful admission
  // so staff can move straight into the next patient without an extra click.
  const resetWorkingFields = () => {
    setSelectedPatient(null);
    setDoctorOrder(null);
    setDepartment("General Medicine");
    setConsultingDoctor("Dr. Priya Sharma");
    setAdmissionType("Planned");
    setTriagePriority("Stable");
    setReasonForAdmission("");
    setExpectedStay("3");
    setNotes("");
    setSelectedBedNo("");
  };

  const handleClearForm = () => {
    resetWorkingFields();
    setAdmittedRecord(null);
    setNotice({ type: "info", message: "Admission form reset." });
  };

  // ==========================================
  // ADMIT ACTION -- records the doctor's clinical admission order and
  // allocates a bed for an already-registered patient.
  // ==========================================
  const handleCompleteAdmission = async () => {
    if (!selectedPatient?.uhid) {
      setNotice({ type: "warning", message: "Please search and select a registered patient first." });
      return;
    }
    if (!department) {
      setNotice({ type: "warning", message: "Please select an admitting clinical department." });
      return;
    }
    if (!consultingDoctor) {
      setNotice({ type: "warning", message: "Please select a consulting doctor." });
      return;
    }
    if (!reasonForAdmission.trim()) {
      setNotice({ type: "warning", message: "Please enter the clinical reason for inpatient admission." });
      return;
    }

    setSubmitting(true);
    try {
      const noteLines = [
        `Admission type: ${admissionType}`,
        `Department: ${department}`,
        `Consulting doctor: ${consultingDoctor}`,
        `Triage Acuity: ${triagePriority}`,
        `Reason: ${reasonForAdmission.trim()}`,
        expectedStay ? `Expected stay: ${expectedStay} day(s)` : null,
        chosenBed ? `Allocated Bed: ${chosenBed.bed_no} (${chosenBed.ward})` : null,
        notes.trim() ? `Notes: ${notes.trim()}` : null,
      ].filter(Boolean);

      const admRes = await apiFetch<{ admission_id?: number }>(`/api/patients/${encodeURIComponent(selectedPatient.uhid)}/admissions`, {
        method: "POST",
        body: JSON.stringify({ notes: noteLines.join(" | ") }),
      });

      if (chosenBed) {
        const stayDays = Math.max(1, Number(expectedStay) || 1);
        await apiFetch("/api/bed/allot", {
          method: "POST",
          body: JSON.stringify({
            patient_id: selectedPatient.uhid,
            ward: chosenBed.ward,
            room_no: chosenBed.room_no,
            bed_no: chosenBed.bed_no,
            amount_per_day: chosenBed.daily_rate,
            total_days: stayDays,
            total_amount: chosenBed.daily_rate * stayDays,
            admission_id: admRes.admission_id,
          }),
        });
      }

      const confirmedRecord = {
        uhid: selectedPatient.uhid,
        patientName: selectedPatient.patientName,
        ageGender: selectedPatient.ageGender,
        mobile: selectedPatient.mobile,
        admissionId: admRes.admission_id ? `ADM-${admRes.admission_id}` : "ADM-Confirmed",
        admissionDate: new Date().toLocaleString("en-IN"),
        department,
        doctor: consultingDoctor,
        ward: chosenBed ? chosenBed.ward : "Awaiting Bed Allotment",
        bedNo: chosenBed ? chosenBed.bed_no : "Queued",
        roomNo: chosenBed ? chosenBed.room_no : "-",
        triagePriority,
        reason: reasonForAdmission,
      };

      setAdmittedRecord(confirmedRecord);
      // Admission is recorded -- clear the working form right away so the
      // next patient can be searched and admitted immediately instead of
      // requiring a manual "Clear Form" click first.
      resetWorkingFields();

      setNotice({
        type: "success",
        message: `Inpatient Admission confirmed for ${confirmedRecord.patientName} (${confirmedRecord.uhid}) with Bed ${confirmedRecord.bedNo}!`,
      });

      void loadBeds();
    } catch (err: any) {
      reportError(setNotice, err, "Failed to complete inpatient admission.");
    } finally {
      setSubmitting(false);
    }
  };

  // Print Inpatient Admission Slip
  const handlePrintSlip = () => {
    if (!admittedRecord?.uhid) {
      setNotice({ type: "warning", message: "Please complete the admission first before printing slip." });
      return;
    }
    const rec = admittedRecord;
    const slipHtml = `
      <div data-hospai-shared-print-shell style="font-family: Arial, sans-serif; max-width: 520px; margin: 20px auto; padding: 24px; border: 2px solid #00828a; border-radius: 10px;">
        <div style="text-align: center; border-bottom: 2px solid #00828a; padding-bottom: 12px; margin-bottom: 16px;">
          <h2 style="margin: 0; color: #16324a;">HospAI</h2>
          <div style="font-size: 11px; color: #64748b; margin-top: 3px;">Inpatient Admission & Bed Allocation Slip</div>
        </div>
        <div style="font-size: 13.5px; line-height: 1.8; color: #1e293b;">
          <div style="background: #f0fdf4; border: 1.5px solid #86efac; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 10.5px; font-weight: 700; color: #15803d; text-transform: uppercase;">PATIENT UHID</div>
              <strong style="font-size: 17px; color: #00828a; font-family: monospace;">${rec.uhid}</strong>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 10.5px; font-weight: 700; color: #15803d; text-transform: uppercase;">ADMISSION #</div>
              <strong style="font-size: 15px; color: #15803d;">${rec.admissionId || "ADM-ACTIVE"}</strong>
            </div>
          </div>
          <div><strong>Admission Date:</strong> ${rec.admissionDate || new Date().toLocaleString("en-IN")}</div>
          <div><strong>Patient Name:</strong> ${rec.patientName}</div>
          <div><strong>Age / Gender:</strong> ${rec.ageGender}</div>
          <div><strong>Mobile:</strong> ${rec.mobile || "-"}</div>
          <div style="border-top: 1px dashed #cbd5e1; margin: 10px 0; padding-top: 8px;">
            <div><strong>Department:</strong> ${rec.department}</div>
            <div><strong>Consulting Doctor:</strong> ${rec.doctor}</div>
            <div><strong>Ward:</strong> ${rec.ward}</div>
            <div><strong>Room / Bed No:</strong> ${rec.roomNo || "-"} / <span style="font-size: 15px; font-weight: 800; color: #2563eb;">${rec.bedNo}</span></div>
            <div><strong>Acuity:</strong> ${rec.triagePriority || "Stable"}</div>
            <div><strong>Reason:</strong> ${rec.reason || "-"}</div>
          </div>
        </div>
        <div style="text-align: center; margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 10px; font-size: 11px; color: #64748b;">
          HospAI · 24x7 Inpatient Care & Bed Management · Computer Generated Slip
        </div>
      </div>
    `;
    // The slip keeps its own layout (data-hospai-shared-print-shell); printViaIframe adds the standard page footer.
    printViaIframe(`<html><head><title>IP Admission Slip - ${rec.uhid}</title></head><body>${slipHtml}</body></html>`);
  };

  return (
    <div className="ip-admission-page" style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* 1. TOP HEADER & BREADCRUMB - Matching DashboardPage */}
      <div className="hosp-dashboard-top" style={{ marginBottom: "18px" }}>
        <div>
          <div className="hosp-dashboard-eyebrow">
            <span>HospAI</span>
            <span>/</span>
            <span>IP Management</span>
            <span>/</span>
            <span style={{ color: "#0f172a", fontWeight: 700 }}>Inpatient Admission</span>
          </div>
          <h1 className="hosp-dashboard-page-title" style={{ fontSize: "28px", fontWeight: 800, margin: "2px 0 4px", color: "#0f172a" }}>
            Inpatient Admission & Bed Allocation
          </h1>
          <p className="hosp-dashboard-page-subtitle" style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
            Search an already-registered patient, record the doctor's admission order, and allocate a hospital bed.
          </p>
        </div>

        <div className="hosp-dashboard-top-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Button
            variant="ghost"
            onClick={() => onNavigate && onNavigate("inpatient-patients")}
            style={{ background: "#ffffff", border: "1px solid #cbd5e1", fontSize: "13px" }}
          >
            View Active Inpatients
          </Button>
          <Button
            variant="secondary"
            onClick={() => onNavigate && onNavigate("bed-management")}
            style={{ background: "#ffffff", border: "1.5px solid #00828a", color: "#00828a", fontWeight: 700, fontSize: "13px" }}
          >
            Open Bed Management
          </Button>
        </div>
      </div>

      {/* SEARCH & SELECT REGISTERED PATIENT */}
      <div
        style={{
          background: selectedPatient?.uhid ? "#f0fdf4" : "#ffffff",
          border: `1.5px solid ${selectedPatient?.uhid ? "#86efac" : "#e2e8f0"}`,
          borderRadius: "14px",
          padding: "20px 24px",
          marginBottom: "22px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ marginBottom: "12px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
            1. Search Registered Patient
          </h3>
          <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
            Lookup by UHID, Name, or Mobile number. Patients are registered once at the Registration Desk -- this page only records the admission order and bed.
          </p>
        </div>

        <PatientSearchPicker
          onSelect={(pat) => {
            const fullPatName = [pat.name, pat.last_name].filter(Boolean).join(" ");
            void handleSelectPatient({
              uhid: pat.patient_id,
              patientName: fullPatName,
              ageGender: `${pat.age ? pat.age + " yrs" : ""} / ${pat.gender || ""}`,
              mobile: pat.phone || "",
            });
            setNotice({ type: "success", message: `Selected patient: ${fullPatName} (${pat.patient_id})` });
          }}
        />

        {selectedPatient?.uhid && (
          <div style={{ marginTop: "16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong style={{ fontSize: "15px", color: "#0f172a" }}>{selectedPatient.patientName}</strong>
              <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "3px" }}>
                UHID: <span style={{ fontWeight: 700, color: "#2563eb" }}>{selectedPatient.uhid}</span> · {selectedPatient.ageGender} · Mobile: {selectedPatient.mobile}
              </div>
            </div>
            <Button variant="ghost" onClick={handleClearForm} style={{ fontSize: "12px" }}>
              Clear Selection
            </Button>
          </div>
        )}

        {/* Doctor's Order context -- pulled from the IP appointment booked at
            registration, so bed allocation follows what the doctor actually
            ordered rather than an arbitrary re-pick. */}
        {selectedPatient?.uhid && !loadingOrder && (
          doctorOrder ? (
            <div style={{ marginTop: "12px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "10px 16px", fontSize: "13px", color: "#1e40af" }}>
              <strong>Doctor Consultation Found:</strong> Previous booking with <strong>{doctorOrder.doctor}</strong> ({doctorOrder.department}){doctorOrder.date ? ` on ${new Date(doctorOrder.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}` : ""}. Department and Doctor have been pre-filled below and can be adjusted if needed.
            </div>
          ) : (
            <div style={{ marginTop: "12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "10px 16px", fontSize: "13px", color: "#166534" }}>
              <strong>Direct Inpatient Admission:</strong> Patient verified (UHID: <strong>{selectedPatient.uhid}</strong>). Select the admitting department, consulting doctor, and bed below to complete admission.
            </div>
          )
        )}
      </div>

      {/* ========================================================================= */}
      {/* SECTION 2: CLINICAL INPATIENT ADMISSION & BED ALLOTMENT */}
      {/* ========================================================================= */}
      <div
        style={{
          background: "#ffffff",
          border: "2px solid #2563eb",
          borderRadius: "14px",
          padding: "24px 28px",
          marginBottom: "24px",
          boxShadow: "0 2px 8px rgba(37,99,235,0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ width: "38px", height: "38px", borderRadius: "10px", background: "#eff6ff", color: "#2563eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
              </svg>
            </span>
            <div>
              <h2 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
                2. Inpatient Clinical Admission & Hospital Bed Allotment
              </h2>
              <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
                Record the admitting consultant, clinical reason, triage priority, and assign a vacant hospital bed.
              </p>
            </div>
          </div>
        </div>

        {/* Row A: Department *, Consulting Doctor *, Admission Type, Acuity */}
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <Label>Admitting Department <span style={{ color: "#ef4444" }}>*</span></Label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            >
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Consulting / Admitting Doctor <span style={{ color: "#ef4444" }}>*</span></Label>
            <select
              value={consultingDoctor}
              onChange={(e) => setConsultingDoctor(e.target.value)}
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            >
              {filteredDoctors.map((doc) => (
                <option key={doc.doctor_name} value={doc.doctor_name}>
                  {doc.doctor_name} ({doc.department})
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Admission Type <span style={{ color: "#ef4444" }}>*</span></Label>
            <select
              value={admissionType}
              onChange={(e) => setAdmissionType(e.target.value)}
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            >
              <option value="Planned">Planned / Elective</option>
              <option value="Emergency">Emergency</option>
              <option value="Day Care">Day Care Surgery</option>
              <option value="Transfer">Inter-facility Transfer</option>
            </select>
          </div>

          <div>
            <Label>Clinical Acuity / Triage</Label>
            <select
              value={triagePriority}
              onChange={(e) => setTriagePriority(e.target.value as any)}
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            >
              <option value="Critical">🔴 Critical (ICU Priority)</option>
              <option value="Urgent">🟡 Urgent (High Dependency)</option>
              <option value="Stable">🟢 Stable (Standard Ward)</option>
            </select>
          </div>
        </div>

        {/* Row B: Clinical Reason / Diagnosis *, Expected Stay */}
        <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <Label>Clinical Reason for Admission / Provisional Diagnosis <span style={{ color: "#ef4444" }}>*</span></Label>
            <Input
              type="text"
              value={reasonForAdmission}
              onChange={(e) => setReasonForAdmission(e.target.value)}
              placeholder="e.g. Acute exacerbation of COPD, Post-op monitoring, High grade fever investigation"
              style={{ height: "42px" }}
            />
          </div>

          <div>
            <Label>Expected Stay (Days)</Label>
            <Input
              type="number"
              min={1}
              max={60}
              value={expectedStay}
              onChange={(e) => setExpectedStay(e.target.value)}
              style={{ height: "42px" }}
            />
          </div>
        </div>

        {/* Clinical Notes / Pre-Op Instructions */}
        <div style={{ marginBottom: "22px" }}>
          <Label>Admission Directives / Pre-Op Instructions (optional)</Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Special instructions for nursing staff, dietary restrictions, baseline medications..."
            className="pharmacy-rx-search-input"
            style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", border: "1px solid #cbd5e1", boxSizing: "border-box", fontSize: "13px" }}
          />
        </div>

        {/* SECTION 6: HOSPITAL BED ALLOCATION */}
        <div style={{ borderTop: "1.5px solid #e2e8f0", paddingTop: "20px", marginTop: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
                Select Available Hospital Bed
              </h3>
              <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
                Select from configured ICU (5 Beds), General Ward (5 Beds), and Single Room (5 Rooms) units.
              </p>
            </div>

            {/* Ward Filter Buttons */}
            <div style={{ display: "flex", gap: "6px" }}>
              {["All Wards", "ICU", "General", "Single"].map((wf) => (
                <button
                  key={wf}
                  type="button"
                  onClick={() => setWardFilter(wf)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 700,
                    border: "1px solid #cbd5e1",
                    background: wardFilter === wf ? "#2563eb" : "#ffffff",
                    color: wardFilter === wf ? "#ffffff" : "#475569",
                    cursor: "pointer",
                  }}
                >
                  {wf}
                </button>
              ))}
            </div>
          </div>

          {loadingBeds ? (
            <div style={{ padding: "20px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
              Loading vacant hospital beds...
            </div>
          ) : displayBeds.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", background: "#fff7ed", border: "1px solid #ffedd5", borderRadius: "8px", color: "#c2410c", fontSize: "13px" }}>
              No available beds matching "{wardFilter}". Please add or clear beds from Bed Management.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "12px", marginBottom: "18px" }}>
              {displayBeds.map((bed) => {
                const isSelected = selectedBedNo === bed.bed_no;
                const isIcu = bed.ward.toLowerCase().includes("icu");
                const isSingle = bed.ward.toLowerCase().includes("single");
                const badgeColor = isIcu ? "#dc2626" : isSingle ? "#7c3aed" : "#d97706";
                const badgeBg = isIcu ? "#fee2e2" : isSingle ? "#f3e8ff" : "#fef3c7";

                return (
                  <div
                    key={bed.bed_no}
                    onClick={() => setSelectedBedNo(isSelected ? "" : bed.bed_no)}
                    style={{
                      border: isSelected ? "2.5px solid #2563eb" : "1.5px solid #e2e8f0",
                      background: isSelected ? "#eff6ff" : "#ffffff",
                      borderRadius: "10px",
                      padding: "12px 14px",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      boxShadow: isSelected ? "0 4px 12px rgba(37,99,235,0.15)" : "0 1px 3px rgba(0,0,0,0.02)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <span
                        style={{
                          fontSize: "10.5px",
                          fontWeight: 800,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          background: badgeBg,
                          color: badgeColor,
                          textTransform: "uppercase",
                        }}
                      >
                        {bed.ward}
                      </span>
                      {isSelected && (
                        <span style={{ background: "#2563eb", color: "#ffffff", width: "18px", height: "18px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 800 }}>
                          ✓
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>
                      Bed {bed.bed_no}
                    </div>
                    <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                      Room {bed.room_no} · ₹{bed.daily_rate.toLocaleString("en-IN")}/day
                    </div>
                    <div style={{ fontSize: "11px", color: "#16a34a", fontWeight: 600, marginTop: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#16a34a" }} />
                      Available & Ready
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {chosenBed && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", color: "#166534" }}>
              <span>
                Selected Bed: <strong>{chosenBed.bed_no}</strong> ({chosenBed.ward} - Room {chosenBed.room_no}) · Daily Rate: <strong>₹{chosenBed.daily_rate.toLocaleString("en-IN")}/day</strong>
              </span>
              <Button variant="ghost" onClick={() => setSelectedBedNo("")} style={{ height: "28px", fontSize: "12px", color: "#166534" }}>
                Clear Bed
              </Button>
            </div>
          )}
        </div>

        {/* ACTIONS FOOTER */}
        <div style={{ marginTop: "26px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", borderTop: "1px solid #e2e8f0", paddingTop: "20px" }}>
          <div style={{ display: "flex", gap: "10px" }}>
            <Button
              type="button"
              variant="primary"
              disabled={submitting}
              onClick={() => void handleCompleteAdmission()}
              style={{
                background: "#2563eb",
                borderColor: "#2563eb",
                padding: "12px 28px",
                fontSize: "14px",
                fontWeight: 800,
                boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
              }}
            >
              {submitting ? "Processing IP Admission…" : "Complete Admission & Allocate Bed ➔"}
            </Button>

            <button
              type="button"
              className="btn-clear-outlined"
              onClick={handlePrintSlip}
              style={{ padding: "10px 20px", fontSize: "13px", fontWeight: 700, borderRadius: "8px" }}
            >
              Print Admission Slip
            </button>
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={handleClearForm}
            style={{ fontSize: "13px", color: "#64748b" }}
          >
            Clear Form
          </Button>
        </div>
      </div>

      {/* Success confirmation -- the working form is already cleared for the
          next patient by this point, so dismissing this just closes it. */}
      {admittedRecord?.uhid && (
        <Modal
          open={!!admittedRecord?.uhid}
          onClose={() => setAdmittedRecord(null)}
          title="Inpatient Admission Confirmed"
        >
          <div style={{ padding: "0.5rem 0", maxWidth: "480px" }}>
            <div style={{ textAlign: "center", marginBottom: "1rem" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  background: "#dcfce7",
                  color: "#16a34a",
                  fontSize: "26px",
                  marginBottom: "8px",
                }}
              >
                ✓
              </div>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                Bed allocated and admission order recorded on the patient's account.
              </p>
            </div>

            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "1rem", marginBottom: "1.25rem", fontSize: "0.85rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>Patient: <strong>{admittedRecord.patientName}</strong></div>
                <div>UHID: <strong>{admittedRecord.uhid}</strong></div>
                <div>Admission #: <strong>{admittedRecord.admissionId}</strong></div>
                <div>Ward / Bed: <strong>{admittedRecord.ward} · {admittedRecord.bedNo}</strong></div>
                <div>Department: <strong>{admittedRecord.department}</strong></div>
                <div>Doctor: <strong>{admittedRecord.doctor}</strong></div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={handlePrintSlip}>
                🖨️ Print Admission Slip
              </Button>
              <Button
                type="button"
                className="primary"
                style={{ background: "#2563eb", borderColor: "#2563eb", fontWeight: 700 }}
                onClick={() => setAdmittedRecord(null)}
              >
                Admit Next Patient ➔
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
