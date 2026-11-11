import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Select, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { openRazorpayCheckout } from "../lib/razorpay";
import type { Appointment, Notice, Patient } from "../types";
import { PRINT_BRAND_HEADER_DATA_URI } from "../lib/printBrand";
import { printViaIframe } from "../lib/printViaIframe";
import { filterInteger, filterDecimal } from "../lib/format";
import { cleanCountryCode, formatPhone, normalizeSearchQuery, splitStoredPhone, toWhatsAppNumber } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";

type RegistrationMode = "appointment-in" | "appointment-out" | "consent" | "insurance";

type Props = {
  mode: RegistrationMode;
  selectedPatient: Patient | null;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

type Department = {
  id: number;
  department_name?: string;
status?: string;
  is_active?: boolean | number | string;
};

type DoctorSuggestionRow = {
  doctor_name?: string | null;
  department?: string | null;
  consultation_fee?: number | null;
  review_fee?: number | null;
status?: string | null;
};

type ConsentRecord = {
  id: number;
  patient_id?: string;
  patient_name: string;
  consent_type: string;
  signed_by: string;
  relation_to_patient?: string;
  status?: string;
  notes?: string;
  signed_at?: string;
};

type InsuranceRecord = {
  id: number;
  patient_name: string;
  insurer_name: string;
  verification_status: string;
};

const DEFAULT_APPOINTMENT_FORM = {
  patient_id: "",
  patient_name: "",
  patient_type: "",
  visit_type: "OP",
  department: "",
  doctor_name: "",
  appointment_date: "",
  appointment_kind: "new",
  chief_complaint: "",
  bp: "",
  temperature: "",
  pulse: "",
  spo2: "",
  weight: "",
  height: "",
  consultation_fee: "",
  payment_mode: "",
  notes: "",
  operator_name: "",
};

const DEFAULT_CONSENT_FORM = {
  patient_id: "",
  patient_name: "",
  age: "",
  gender: "",
  mobile: "",
  mobile_country_code: "+91",
  consent_type: "",
  doctor_name: "",
  signed_by: "",
  relation_to_patient: "",
  attender_mobile: "",
  attender_country_code: "+91",
  status: "",
  patient_signature: "",
  attender_signature: "",
  doctor_signature: "",
  document_reference: "",
  notes: "",
};

const CONSENT_TYPE_OPTIONS = [
  { value: "general", label: "General Consent" },
  { value: "surgery", label: "Surgery Consent" },
  { value: "procedure", label: "Procedure Consent" },
  { value: "icu", label: "ICU Consent" },
  { value: "blood_transfusion", label: "Blood Transfusion Consent" },
  { value: "anesthesia", label: "Anesthesia Consent" },
  { value: "teleconsultation", label: "Teleconsultation Consent" },
];

const CONSENT_STATUS_OPTIONS = ["pending", "signed", "approved", "cancelled"];

const DEFAULT_INSURANCE_FORM = {
  patient_id: "",
  patient_name: "",
  insurer_name: "",
  policy_number: "",
  member_id: "",
  verification_status: "pending",
  coverage_notes: "",
};

function patientFullName(patient: Patient | null) {
  return `${patient?.name || ""} ${patient?.middle_name || ""} ${patient?.last_name || ""}`.trim();
}

function normalizeConsentGender(gender?: string | null) {
  const value = String(gender || "").trim().toLowerCase();
  if (["male", "female", "other"].includes(value)) return value;
  return "";
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

function toggleAmPm(value?: string | null): string | undefined {
  if (!value || !value.includes("T")) return value || undefined;
  const [datePart, timePart] = value.split("T");
  const [hourStr, minuteStr] = timePart.split(":");
  if (!hourStr || !minuteStr) return value;
  let hour = parseInt(hourStr, 10);
  if (isNaN(hour)) return value;
  
  hour = (hour + 12) % 24;
  const newHourStr = hour.toString().padStart(2, "0");
  return `${datePart}T${newHourStr}:${minuteStr}`;
}

function getAppointmentTimeLabel(value?: string | null) {
  if (!value) return "No appointment time selected";
  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return `Time: ${value}`;
  return parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function openRegistrationDeskDocumentPrint(title: string, bodyHtml: string, _setNotice: Dispatch<SetStateAction<Notice | null>>) {
  const printedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const html = `<!doctype html><html><head><title>${safeText(title)}</title><style>@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:11px}.journey-print-sheet{width:100%}.journey-print-topline{display:flex;justify-content:space-between;margin-bottom:4px;color:#111827;font-size:9px}.journey-print-header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:14px}.journey-print-brand{display:flex;align-items:center;gap:12px}.journey-print-brand img{width:130px;height:auto;max-height:58px;object-fit:contain}.journey-print-title{text-align:right}.journey-print-title h1{margin:0 0 6px;color:#111827;font-size:18px;text-decoration:underline}.journey-print-title p{margin:2px 0;color:#334155}.journey-print-section{border:1px solid #111827;border-bottom:0;margin-top:0}.journey-print-section:last-child{border-bottom:1px solid #111827}.journey-print-section h2{margin:0;padding:6px 8px;border-bottom:1px solid #111827;background:#eef7fb;color:#062f56;font-size:12px;letter-spacing:.04em;text-transform:uppercase}.journey-print-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.journey-print-grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}.journey-print-field{min-height:36px;padding:7px 8px;border-right:1px solid #111827;border-bottom:1px solid #111827}.journey-print-field:nth-child(2n){border-right:0}.journey-print-grid.four .journey-print-field:nth-child(2n){border-right:1px solid #111827}.journey-print-grid.four .journey-print-field:nth-child(4n){border-right:0}.journey-print-field span{display:block;margin-bottom:4px;color:#334155;font-size:9px;font-weight:800;text-transform:uppercase}.journey-print-field strong{display:block;color:#111827;font-size:11px;line-height:1.35;white-space:pre-wrap}.journey-print-table{width:100%;border-collapse:collapse}.journey-print-table th,.journey-print-table td{padding:7px 8px;border-right:1px solid #111827;border-bottom:1px solid #111827;text-align:left;vertical-align:top}.journey-print-table th:last-child,.journey-print-table td:last-child{border-right:0}.journey-print-table th{color:#334155;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.journey-print-sign{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:28px}.journey-print-sign div{padding-top:24px;border-top:1px solid #111827;text-align:center;font-weight:700}.muted-note{padding:8px;border-bottom:1px solid #111827;line-height:1.45;color:#334155}</style></head><body><main class="journey-print-sheet"><div class="journey-print-topline"><span>${safeText(printedAt)}</span><span>${safeText(title)}</span></div><header class="journey-print-header"><div class="journey-print-brand"><img src="${PRINT_BRAND_HEADER_DATA_URI}" alt="Logo"/></div><div class="journey-print-title"><h1>${safeText(title)}</h1><p><strong>Printed:</strong> ${safeText(printedAt)}</p></div></header>${bodyHtml}<div class="journey-print-sign"><div>Patient / Guardian</div><div>Prepared By</div><div>Authorized Signatory</div></div></main></body></html>`;
  printViaIframe(html);
}

function printConsentDocument(form: typeof DEFAULT_CONSENT_FORM, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!form.patient_name.trim() && !form.patient_id.trim()) {
    setNotice({ type: "warning", message: "Select or enter patient details before printing consent." });
    return;
  }
  const field = (label: string, value: unknown) => `<div class="journey-print-field"><span>${safeText(label)}</span><strong>${safeText(value || "-")}</strong></div>`;
  const consentLabel = CONSENT_TYPE_OPTIONS.find((item) => item.value === form.consent_type)?.label || form.consent_type || "-";
  const body = `<section class="journey-print-section"><h2>Patient Information</h2><div class="journey-print-grid">${field("Patient Name", form.patient_name)}${field("UHID / Patient ID", form.patient_id)}${field("Mobile", formatPhone(form.mobile_country_code, form.mobile))}${field("Age / Gender", `${form.age || "-"} / ${form.gender || "-"}`)}</div></section><section class="journey-print-section"><h2>Consent Details</h2><div class="journey-print-grid">${field("Consent Type", consentLabel)}${field("Doctor / Consultant", form.doctor_name)}${field("Signed By", form.signed_by)}${field("Relationship", form.relation_to_patient)}${field("Attender Mobile", formatPhone(form.attender_country_code, form.attender_mobile))}${field("Consent Status", form.status)}${field("Document Reference", form.document_reference)}${field("Consent Summary", form.notes)}</div></section><section class="journey-print-section"><h2>Signatures</h2><div class="journey-print-grid">${field("Patient Signature", form.patient_signature)}${field("Attender Signature", form.attender_signature)}${field("Doctor Signature", form.doctor_signature)}${field("Date", new Date().toLocaleDateString("en-IN"))}</div></section>`;
  openRegistrationDeskDocumentPrint("Consent Desk Report", body, setNotice);
}

function printInsuranceDocument(form: typeof DEFAULT_INSURANCE_FORM & Record<string, string>, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!form.patient_name.trim() && !form.patient_id.trim()) {
    setNotice({ type: "warning", message: "Select or enter patient details before printing insurance verification." });
    return;
  }
  const field = (label: string, value: unknown) => `<div class="journey-print-field"><span>${safeText(label)}</span><strong>${safeText(value || "-")}</strong></div>`;
  const body = `<section class="journey-print-section"><h2>Patient Information</h2><div class="journey-print-grid">${field("Patient Name", form.patient_name)}${field("UHID / Patient ID", form.patient_id)}${field("Insurer", form.insurer_name)}${field("Status", form.verification_status)}</div></section><section class="journey-print-section"><h2>Insurance / TPA Details</h2><div class="journey-print-grid">${field("Policy Number", form.policy_number)}${field("Member ID", form.member_id)}${field("TPA Name", form.tpa_name)}${field("Pre-Authorization No", form.preauth_no)}${field("Approved Amount", form.approved_amount ? `₹${form.approved_amount}` : "-")}${field("Document Reference", form.document_reference)}${field("Coverage Notes", form.coverage_notes)}${field("Date", new Date().toLocaleDateString("en-IN"))}</div></section>`;
  openRegistrationDeskDocumentPrint("Insurance Desk Report", body, setNotice);
}

function printRegistrationToken(token: any, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!token) {
    setNotice({ type: "warning", message: "No appointment token available to print." });
    return;
  }
  const field = (label: string, value: unknown) => `<div class="journey-print-field"><span>${safeText(label)}</span><strong>${safeText(value || "-")}</strong></div>`;
  const body = `<section class="journey-print-section"><h2>Appointment Token</h2><div class="journey-print-grid">` +
    `${field("Patient Name", token.patient_name)}` +
    `${field("Patient ID", token.patient_id)}` +
    `${field("Doctor", token.doctor_name)}` +
    `${field("Department", token.department)}` +
    `${field("Date", formatDateTime(token.appointment_date))}` +
    `${field("Fee", token.consultation_fee ? "₹" + token.consultation_fee : "-")}` +
    `</div></section>`;
  openRegistrationDeskDocumentPrint("Registration Token", body, setNotice);
}

function shareConsentWhatsApp(form: typeof DEFAULT_CONSENT_FORM, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!form.patient_name.trim() && !form.patient_id.trim()) {
    setNotice({ type: "warning", message: "Select or enter patient details before sharing consent." });
    return;
  }
  const parts = splitStoredPhone(form.mobile, form.mobile_country_code);
  const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);
  const consentLabel = CONSENT_TYPE_OPTIONS.find((item) => item.value === form.consent_type)?.label || form.consent_type || "-";

  const lines = [
    `*HospAI Hospital - Clinical Consent Record*`,
    `----------------------------------------`,
    `Patient: ${form.patient_name} (UHID: ${form.patient_id})`,
    `Consent Type: ${consentLabel}`,
    form.doctor_name ? `Consultant: Dr. ${form.doctor_name}` : "",
    `Signed By: ${form.signed_by || "Self"} (${form.relation_to_patient || "Patient"})`,
    `Status: ${form.status}`,
    form.document_reference ? `Document Ref: ${form.document_reference}` : "",
    form.notes ? `Notes: ${form.notes}` : "",
    `Date: ${new Date().toLocaleDateString("en-IN")}`,
    `----------------------------------------`,
    `HospAI Hospital Care & Records Team`,
  ].filter(Boolean);

  const text = lines.join("\n");
  const url = waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  setNotice({ type: "success", message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened." });
}

function shareInsuranceWhatsApp(form: typeof DEFAULT_INSURANCE_FORM & Record<string, string>, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!form.patient_name.trim() && !form.patient_id.trim()) {
    setNotice({ type: "warning", message: "Select or enter patient details before sharing insurance." });
    return;
  }
  const parts = splitStoredPhone(form.mobile, form.mobile_country_code);
  const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

  const lines = [
    `*HospAI Hospital - Insurance & TPA Desk Verification*`,
    `----------------------------------------`,
    `Patient: ${form.patient_name} (UHID: ${form.patient_id})`,
    `Insurer: ${form.insurer_name}`,
    form.tpa_name ? `TPA: ${form.tpa_name}` : "",
    form.policy_number ? `Policy No: ${form.policy_number}` : "",
    form.preauth_no ? `Pre-Auth No: ${form.preauth_no}` : "",
    form.approved_amount ? `Approved Amount: ₹${form.approved_amount}` : "",
    `Status: ${form.verification_status}`,
    `Date: ${new Date().toLocaleDateString("en-IN")}`,
    `----------------------------------------`,
    `HospAI Insurance Desk`,
  ].filter(Boolean);

  const text = lines.join("\n");
  const url = waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  setNotice({ type: "success", message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened." });
}

function shareRegistrationTokenWhatsApp(token: any, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  if (!token) {
    setNotice({ type: "warning", message: "No appointment token available to share." });
    return;
  }
  const parts = splitStoredPhone(token.mobile || token.phone, token.country_code);
  const waNumber = toWhatsAppNumber(parts.countryCode, parts.value);

  const lines = [
    `*HospAI Hospital - Appointment Token*`,
    `----------------------------------------`,
    `Token: #${token.token_no || token.tokenNo || "-"}`,
    `Patient: ${token.patient_name} (UHID: ${token.patient_id})`,
    token.doctor_name ? `Doctor: Dr. ${token.doctor_name}` : "",
    token.department ? `Department: ${token.department}` : "",
    token.appointment_date ? `Appointment: ${formatDateTime(token.appointment_date)}` : "",
    token.consultation_fee ? `Fee: ₹${token.consultation_fee}` : "",
    `----------------------------------------`,
    `Please report to the OPD waiting lounge. Track your live queue status at HospAI.`,
  ].filter(Boolean);

  const text = lines.join("\n");
  const url = waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  setNotice({ type: "success", message: waNumber ? `WhatsApp chat opened for ${parts.countryCode} ${parts.value}.` : "WhatsApp opened." });
}

export default function RegistrationDeskPage({ mode, selectedPatient, setNotice }: Props) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [queueDate, setQueueDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [savingAppointment, setSavingAppointment] = useState(false);
  const [isRazorpayReady, setIsRazorpayReady] = useState(true);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentInput, setDepartmentInput] = useState("");
  const [savingDepartment, setSavingDepartment] = useState(false);

  const [doctorSuggestions, setDoctorSuggestions] = useState<string[]>([]);
  const [doctorFeeMap, setDoctorFeeMap] = useState<Record<string, { department?: string; consultation_fee?: number | null; review_fee?: number | null }>>({});

  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [insuranceChecks, setInsuranceChecks] = useState<InsuranceRecord[]>([]);
  const [savingConsent, setSavingConsent] = useState(false);
  const [savingInsurance, setSavingInsurance] = useState(false);

  const [appointmentForm, setAppointmentForm] = useState({ ...DEFAULT_APPOINTMENT_FORM });
  const [bpSys, setBpSys] = useState("");
  const [bpDia, setBpDia] = useState("");
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);
  const [selectedAppointmentPatient, setSelectedAppointmentPatient] = useState<Patient | null>(selectedPatient);
  const [lastGeneratedToken, setLastGeneratedToken] = useState<any | null>(null);
  const [selectedConsentPatient, setSelectedConsentPatient] = useState<Patient | null>(selectedPatient);
  const [selectedInsurancePatient, setSelectedInsurancePatient] = useState<Patient | null>(selectedPatient);
  const [consentForm, setConsentForm] = useState({ ...DEFAULT_CONSENT_FORM });
  const [insuranceForm, setInsuranceForm] = useState({ ...DEFAULT_INSURANCE_FORM });


  const loadAppointments = async (selectedDate = queueDate) => {
    setAppointmentsLoading(true);
    try {
      const data = await apiFetch<{ appointments?: Appointment[] }>(`/api/appointments?date=${selectedDate}`);
      setAppointments(data.appointments || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load appointments.");
    } finally {
      setAppointmentsLoading(false);
    }
  };

  const loadDepartmentOptions = async () => {
    try {
      const data = await apiFetch<{ departments?: Department[] }>("/api/registration/departments");
const activeDepartments = (data.departments || []).filter((department) => {
        const status = String(department.status || (department.is_active ?? "active")).trim().toLowerCase();
        return !["inactive", "disabled", "false", "0", "deleted"].includes(status);
      });
      const sortedDepartments = activeDepartments.sort((a, b) => String(a.department_name || "").localeCompare(String(b.department_name || "")));
      setDepartments(sortedDepartments);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load departments.");
    }
  };

  const loadDoctorSuggestions = async (deptFilter?: string) => {
    try {
      let url = `/api/op/doctor-schedules?date=${encodeURIComponent(queueDate)}`;
      if (deptFilter) {
        url += `&department=${encodeURIComponent(deptFilter)}`;
      }
      const scheduleData = await apiFetch<{ schedules?: { doctor_name?: string | null; department?: string | null; consultation_fee?: number | null; review_fee?: number | null; status?: string | null; start_time?: string | null; end_time?: string | null }[] }>(url);
      const names = new Set<string>();
      const feesByDoctor: Record<string, { department?: string; consultation_fee?: number | null; review_fee?: number | null }> = {};
      (scheduleData.schedules || [])
        .filter((row) => {
          const status = String(row.status || 'available').trim().toLowerCase();
          return !['inactive', 'disabled', 'leave', 'full', 'unavailable', 'false', '0', 'cancelled'].includes(status);
        })
        .forEach((row) => {
          const value = (row.doctor_name || "").trim();
          if (!value) return;
          names.add(value);
          if (!feesByDoctor[value]) {
            feesByDoctor[value] = {
              department: row.department ?? undefined,
              consultation_fee: row.consultation_fee ?? null,
              review_fee: row.review_fee ?? null,
            };
          }
        });

      const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));
      setDoctorSuggestions(sortedNames);
      setDoctorFeeMap(feesByDoctor);
      return { sortedNames, feesByDoctor };
    } catch {
      setDoctorSuggestions([]);
      setDoctorFeeMap({});
      return { sortedNames: [], feesByDoctor: {} };
    }
  };

  const loadRegistrationOps = async () => {
    try {
      const patientId = selectedPatient?.patient_id || "";
      const suffix = patientId ? `?patient_id=${encodeURIComponent(patientId)}` : "";
      const [consentData, insuranceData] = await Promise.all([
        apiFetch<{ consents?: ConsentRecord[] }>(`/api/registration/consents${suffix}`),
        apiFetch<{ verifications?: InsuranceRecord[] }>(`/api/registration/insurance${suffix}`),
      ]);
      setConsents(consentData.consents || []);
      setInsuranceChecks(insuranceData.verifications || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load registration records.");
    }
  };

  useEffect(() => {
    void loadAppointments(queueDate);
    void loadDepartmentOptions();
    void loadDoctorSuggestions();
    void loadRegistrationOps();
  }, [queueDate]);

  const filteredDoctorSuggestions = useMemo(() => {
    return doctorSuggestions;
  }, [doctorSuggestions]);

  useEffect(() => {
    let isMounted = true;
    const fetchDocs = async () => {
      // If no department is selected, load all doctors so user can select a doctor first
      const result = await loadDoctorSuggestions(appointmentForm.department || undefined);
      if (!isMounted) return;
      
      // Only apply auto-selection logic if a department is actually selected
      if (!appointmentForm.department) {
        return;
      }
      setAppointmentForm((prev) => {
        // If the previously selected doctor is still valid, keep it.
        if (prev.doctor_name && result.sortedNames.includes(prev.doctor_name)) {
          return prev;
        }
        // If there's exactly 1 active doctor, auto-select it.
        if (result.sortedNames.length === 1) {
          const doc = result.sortedNames[0];
          return {
            ...prev,
            doctor_name: doc,
            consultation_fee: String(
              resolveAppointmentFee(doc, prev.appointment_kind, selectedAppointmentPatient?.last_consultation_date, prev.appointment_date || queueDate)
            ),
          };
        }
        // Otherwise, clear it so the user must select.
        return {
          ...prev,
          doctor_name: "",
          consultation_fee: String(
            resolveAppointmentFee("", prev.appointment_kind, selectedAppointmentPatient?.last_consultation_date, prev.appointment_date || queueDate)
          ),
        };
      });
    };
    fetchDocs();
    return () => { isMounted = false; };
  }, [appointmentForm.department, queueDate]);

  const calculateDaysDifference = (d1?: string | null, d2?: string | null) => {
    if (!d1 || !d2) return null;
    try {
      const date1 = new Date(d1);
      const date2 = new Date(d2);
      if (isNaN(date1.getTime()) || isNaN(date2.getTime())) return null;
      const utc1 = Date.UTC(date1.getFullYear(), date1.getMonth(), date1.getDate());
      const utc2 = Date.UTC(date2.getFullYear(), date2.getMonth(), date2.getDate());
      return Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24));
    } catch {
      return null;
    }
  };

  const resolveAppointmentFee = (doctorName: string, appointmentKind: string, lastConsultationDate?: string | null, currentDate?: string) => {
    if (selectedAppointmentPatient?.eligible_for_free_followup) {
      return 0; // Free follow-up within 7 days, independent of doctor change
    }

    const selectedDoctor = doctorName.trim();
    const selectedDoctorFees = selectedDoctor ? doctorFeeMap[selectedDoctor] : undefined;
    
    let baseFee = Number(appointmentForm.consultation_fee) || 0;
    if (selectedDoctorFees) {
      if (appointmentKind === "follow_up" || appointmentKind === "review") {
        baseFee = selectedDoctorFees.review_fee ?? selectedDoctorFees.consultation_fee ?? 0;
      } else {
        baseFee = selectedDoctorFees.consultation_fee ?? selectedDoctorFees.review_fee ?? 0;
      }
    }
    
    return baseFee;
  };

  useEffect(() => {
    let isMounted = true;
    const fetchLatestFee = async () => {
      const doctorName = String(appointmentForm.doctor_name || "").trim();
      if (!doctorName) return;
      if (selectedAppointmentPatient?.eligible_for_free_followup) {
        setAppointmentForm((prev) => ({ ...prev, consultation_fee: "0" }));
        return;
      }
      try {
        const data = await apiFetch<{ schedules?: { consultation_fee?: number | null; review_fee?: number | null }[] }>(`/api/op/doctor-schedules?doctor_name=${encodeURIComponent(doctorName)}`);
        if (!isMounted) return;
        const schedule = data.schedules?.[0];
        if (schedule) {
          const kind = String(appointmentForm.appointment_kind || "").trim().toLowerCase();
          let fee: number | undefined = undefined;
          if (kind === "follow_up" || kind === "review") {
            fee = schedule.review_fee ?? schedule.consultation_fee ?? undefined;
          } else {
            fee = schedule.consultation_fee ?? schedule.review_fee ?? undefined;
          }
          if (fee !== undefined) {
             setAppointmentForm((prev) => ({ ...prev, consultation_fee: String(fee) }));
          }
        }
      } catch {
        // ignore
      }
    };
    fetchLatestFee();
    return () => { isMounted = false; };
  }, [appointmentForm.doctor_name, appointmentForm.appointment_kind, selectedAppointmentPatient?.eligible_for_free_followup]);

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
        setNotice({ type: "warning", message: "Razorpay is not configured. Add keys in backend .env." });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  useEffect(() => {
    const defaultPatientName = patientFullName(selectedPatient);
    setAppointmentForm((prev) => ({
      ...prev,
      patient_id: selectedPatient?.patient_id || "",
      patient_name: defaultPatientName || prev.patient_name,
      patient_type: selectedPatient ? (selectedPatient.has_appointments ? "existing" : "new") : prev.patient_type,
    }));
    setConsentForm((prev) => ({
      ...prev,
      patient_id: selectedPatient?.patient_id || "",
      patient_name: defaultPatientName || prev.patient_name,
      age: selectedPatient?.age ? String(selectedPatient.age) : prev.age,
      gender: normalizeConsentGender(selectedPatient?.gender) || prev.gender,
      mobile: selectedPatient?.phone || prev.mobile,
      mobile_country_code: selectedPatient?.phone ? cleanCountryCode(selectedPatient.phone_country_code) : prev.mobile_country_code,
      signed_by: defaultPatientName || prev.signed_by,
      relation_to_patient: defaultPatientName ? "Self" : prev.relation_to_patient,
      patient_signature: defaultPatientName || prev.patient_signature,
    }));
    setInsuranceForm((prev) => ({
      ...prev,
      patient_id: selectedPatient?.patient_id || "",
      patient_name: defaultPatientName || prev.patient_name,
    }));
    if (selectedPatient) {
      setSelectedAppointmentPatient(selectedPatient);
      setSelectedConsentPatient(selectedPatient);
      setSelectedInsurancePatient(selectedPatient);
    }
  }, [selectedPatient]);

  const selectedPatientDetails = selectedAppointmentPatient || selectedPatient;

  const handlePatientSearch = async () => {
    const query = patientSearch.trim();
    if (!query) {
      setNotice({ type: "warning", message: "Enter Patient ID, mobile number, Aadhaar number, or patient name." });
      return;
    }
    setPatientSearchLoading(true);
    try {
      setPatientResults([]);
      const data = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(query)}`);
      let results = data.patients || [];
      if (!results.length && /^\d{3,4}$/.test(query)) {
        const allData = await apiFetch<{ patients?: Patient[] }>("/api/patients");
        results = (allData.patients || []).filter((patient) => String(patient.patient_id || "").slice(-4) === query);
      }
      const seenPatients = new Set<string>();
      results = results.filter((patient) => {
        const key = patient.patient_id || patient.phone || (patient as any).aadhaar_number || patientFullName(patient);
        if (!key || seenPatients.has(key)) return false;
        seenPatients.add(key);
        return true;
      });
      setPatientResults(results);
      const normalizedQuery = query.toLowerCase();
      const exactPatient = results.find((patient) => {
        const patientId = String(patient.patient_id || "").toLowerCase();
        const last4 = patientId.slice(-4);
        const phone = String(patient.phone || "");
        return patientId === normalizedQuery || last4 === normalizedQuery || phone === query;
      });
      const autoSelectPatient = exactPatient || (results.length === 1 ? results[0] : null);
      if (autoSelectPatient && mode === "consent") {
        handleSelectConsentPatient(autoSelectPatient);
      } else if (autoSelectPatient && mode === "insurance") {
        handleSelectInsurancePatient(autoSelectPatient);
      } else if (autoSelectPatient) {
        handleSelectAppointmentPatient(autoSelectPatient);
      } else if (results.length > 0) {
        // If results exist but no auto-select, we shouldn't show the warning.
      } else {
        setNotice({ type: "warning", message: "No matching patient found. You can continue as a new patient." });
      }
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to search patients.");
    } finally {
      setPatientSearchLoading(false);
    }
  };

  const handleSelectAppointmentPatient = (patient: Patient) => {
    const fullName = patientFullName(patient) || patient.name || "";
    const isExisting = !!patient.has_appointments;
    setSelectedAppointmentPatient(patient);
    setAppointmentForm((prev) => {
      let nextDepartment = prev.department;
      let nextDoctor = prev.doctor_name;
      let nextKind = prev.appointment_kind;
      
      if (patient.eligible_for_free_followup) {
        nextKind = "follow_up";
        if (patient.last_department) nextDepartment = patient.last_department;
        if (patient.last_doctor) nextDoctor = patient.last_doctor;
      }
      
      const resolvedFee = nextDoctor
        ? resolveAppointmentFee(nextDoctor, nextKind, patient.last_consultation_date, prev.appointment_date || queueDate)
        : (patient.consultation_fee || "");
        
      return {
        ...prev,
        patient_id: patient.patient_id || "",
        patient_name: fullName,
        patient_type: isExisting ? "existing" : "new",
        appointment_kind: nextKind,
        department: nextDepartment,
        doctor_name: nextDoctor,
        chief_complaint: "",
        bp: "",
        temperature: "",
        pulse: "",
        spo2: "",
        weight: patient.weight ? String(patient.weight) : prev.weight,
        height: patient.height ? String(patient.height) : prev.height,
        consultation_fee: String(resolvedFee),
      };
    });
    // Clear BP split fields so old values don't linger
    setBpSys("");
    setBpDia("");
    setNotice({ type: "success", message: `${fullName || patient.patient_id} selected for appointment.` });
  };

  const handleClearAppointmentPatient = () => {
    setSelectedAppointmentPatient(null);
    setPatientResults([]);
    setPatientSearch("");
    setAppointmentForm((prev) => ({
      ...prev,
      patient_id: "",
      patient_name: "",
      patient_type: "new",
    }));
  };

  const appointmentStats = useMemo(() => {
    const waiting = appointments.filter((item) => item.status === "scheduled" || item.status === "checked_in").length;
    const inConsultation = appointments.filter((item) => item.status === "in_consultation").length;
    const completed = appointments.filter((item) => item.status === "completed").length;
    return { waiting, inConsultation, completed };
  }, [appointments]);

  const patientAppointmentHistory = useMemo(() => {
    const patientId = appointmentForm.patient_id.trim();
    const patientName = appointmentForm.patient_name.trim().toLowerCase();
    if (!patientId && !patientName) return [];
    return appointments
      .filter((item) => (patientId && item.patient_id === patientId) || (patientName && item.patient_name.toLowerCase() === patientName))
      .slice(0, 5);
  }, [appointments, appointmentForm.patient_id, appointmentForm.patient_name]);

  const buildAppointmentNotes = () => {
    const parts = [
      appointmentForm.chief_complaint.trim() ? `Chief Complaint: ${appointmentForm.chief_complaint.trim()}` : "",
      appointmentForm.bp.trim() ? `BP: ${appointmentForm.bp.trim()}` : "",
      appointmentForm.temperature.trim() ? `Temp: ${appointmentForm.temperature.trim()}` : "",
      appointmentForm.pulse.trim() ? `Pulse: ${appointmentForm.pulse.trim()}` : "",
      appointmentForm.spo2.trim() ? `SPO2: ${appointmentForm.spo2.trim()}` : "",
      appointmentForm.weight.trim() ? `Weight: ${appointmentForm.weight.trim()} kg` : "",
      appointmentForm.height.trim() ? `Height: ${appointmentForm.height.trim()} cm` : "",
      appointmentForm.notes.trim(),
    ].filter(Boolean);
    return parts.join(" | ");
  };

  const handleAddDepartment = async () => {
    const departmentName = departmentInput.trim();
    if (!departmentName) {
      setNotice({ type: "warning", message: "Department name is required." });
      return;
    }
    setSavingDepartment(true);
    try {
      const data = await apiFetch<{ department_id: number; department_name?: string; already_exists?: boolean }>("/api/registration/departments", {
        method: "POST",
        body: JSON.stringify({ department_name: departmentName }),
      });
      const savedName = data.department_name || departmentName;
      setDepartmentInput("");
      setDepartments((current) => {
        const exists = current.some((department) => (department.department_name || "").trim().toLowerCase() === savedName.trim().toLowerCase());
        return exists ? current : [...current, { id: data.department_id, department_name: savedName }].sort((a, b) => String(a.department_name || "").localeCompare(String(b.department_name || "")));
      });
      setAppointmentForm((prev) => ({ ...prev, department: savedName }));
      await loadDepartmentOptions();
      if (data.already_exists) {
        setNotice({ type: "warning", message: `Department ${data.department_name || departmentName} already exists.` });
      } else {
        setNotice({ type: "success", message: `Department ${departmentName} added.` });
      }
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to add department.");
    } finally {
      setSavingDepartment(false);
    }
  };

  const handleCreateAppointment = async () => {
    const patientName = appointmentForm.patient_name.trim() || patientFullName(selectedPatient);
    if (!patientName || !appointmentForm.appointment_date) {
      setNotice({ type: "warning", message: "Patient name and appointment date/time are required." });
      return;
    }
    if (!appointmentForm.doctor_name.trim()) {
      setNotice({ type: "warning", message: "Please select a doctor for the appointment." });
      return;
    }
    if (!paymentConfirmed) {
      setNotice({ type: "warning", message: "Please verify and confirm that the consultation fee has been paid by checking the 'Verify Fee Paid' checkbox." });
      return;
    }
    if (!appointmentForm.payment_mode) {
      setNotice({ type: "warning", message: "Please select a payment mode." });
      return;
    }
    const doctorName = appointmentForm.doctor_name.trim();
    const consultationFee = resolveAppointmentFee(doctorName, appointmentForm.appointment_kind, selectedAppointmentPatient?.last_consultation_date, appointmentForm.appointment_date || queueDate);
    if (consultationFee < 0) {
      setNotice({ type: "warning", message: "Consultation fee is mandatory and cannot be negative." });
      return;
    }
    setSavingAppointment(true);
    try {
      const data = await apiFetch<{ token_no: number }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          patient_id: appointmentForm.patient_id.trim() || selectedPatient?.patient_id || undefined,
          patient_name: patientName,
          visit_type: "OP",
          department: appointmentForm.department.trim() || undefined,
          doctor_name: appointmentForm.doctor_name.trim() || undefined,
          appointment_date: appointmentForm.appointment_date,
          appointment_kind: appointmentForm.appointment_kind || "new", fee_kind: selectedAppointmentPatient?.eligible_for_free_followup ? "free_followup" : undefined,
          notes: buildAppointmentNotes() || undefined,
          consultation_fee: consultationFee,
          payment_mode: appointmentForm.payment_mode || "cash",
          operator_name: appointmentForm.operator_name.trim() || undefined,
        }),
      });
      setPaymentConfirmed(false);
      setAppointmentForm((prev) => ({
        ...DEFAULT_APPOINTMENT_FORM,
        patient_type: prev.patient_type,
        visit_type: prev.visit_type,
        appointment_kind: prev.appointment_kind,
      }));
      setPatientSearch("");
      setPatientResults([]);
      setSelectedAppointmentPatient(null);
      setBpSys("");
      setBpDia("");
      
      // Return focus to first relevant input (patient search)
      setTimeout(() => {
        const searchInput = document.getElementById("patient-search-input-desk");
        if (searchInput) searchInput.focus();
      }, 50);

      await loadAppointments();
      const newToken = {
        token_no: data.token_no,
        patient_id: appointmentForm.patient_id.trim() || selectedPatient?.patient_id || undefined,
        patient_name: patientName,
        visit_type: "OP",
        department: appointmentForm.department.trim() || undefined,
        doctor_name: appointmentForm.doctor_name.trim() || undefined,
        appointment_date: appointmentForm.appointment_date,
        appointment_kind: appointmentForm.appointment_kind || "new", fee_kind: selectedAppointmentPatient?.eligible_for_free_followup ? "free_followup" : undefined,
        notes: buildAppointmentNotes() || undefined,
        consultation_fee: consultationFee,
        operator_name: appointmentForm.operator_name.trim() || undefined,
      };
      setLastGeneratedToken(newToken);
      printRegistrationToken(newToken, setNotice);
      await loadDoctorSuggestions();
      setNotice({ type: "success", message: `Appointment scheduled. Token #${data.token_no}. Added to OP queue.` });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to schedule appointment.");
    } finally {
      setSavingAppointment(false);
    }
  };

  const handleCreateAppointmentWithRazorpay = async () => {
    if (!(await ensureRazorpayConfigured())) {
      return;
    }
    const patientName = appointmentForm.patient_name.trim() || patientFullName(selectedPatient);
    if (!patientName || !appointmentForm.appointment_date) {
      setNotice({ type: "warning", message: "Patient name and appointment date/time are required." });
      return;
    }
    const consultationFee = resolveAppointmentFee(appointmentForm.doctor_name.trim(), appointmentForm.appointment_kind);
    if (consultationFee <= 0) {
      setNotice({ type: "warning", message: "Consultation fee must be greater than zero for Razorpay payment." });
      return;
    }

    const appointmentPayload = {
      patient_id: appointmentForm.patient_id.trim() || selectedPatient?.patient_id || undefined,
      patient_name: patientName,
      visit_type: "OP",
      department: appointmentForm.department.trim() || undefined,
      doctor_name: appointmentForm.doctor_name.trim() || undefined,
      appointment_date: appointmentForm.appointment_date,
      appointment_kind: appointmentForm.appointment_kind || "new", fee_kind: selectedAppointmentPatient?.eligible_for_free_followup ? "free_followup" : undefined,
      notes: buildAppointmentNotes() || undefined,
      consultation_fee: consultationFee,
      payment_mode: appointmentForm.payment_mode || "cash",
      operator_name: appointmentForm.operator_name.trim() || undefined,
    };

    setSavingAppointment(true);
    try {
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
        name: "HospAI Registration Desk",
        description: "Appointment Booking",
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

      const verification = await apiFetch<{ token_no: number }>("/api/appointments/razorpay/verify", {
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

      setAppointmentForm((prev) => ({
        ...DEFAULT_APPOINTMENT_FORM,
        patient_type: prev.patient_type,
        visit_type: prev.visit_type,
        appointment_kind: prev.appointment_kind,
      }));
      setPatientSearch("");
      setPatientResults([]);
      setSelectedAppointmentPatient(null);
      setBpSys("");
      setBpDia("");
      setPaymentConfirmed(false);

      setTimeout(() => {
        const searchInput = document.getElementById("patient-search-input-desk");
        if (searchInput) searchInput.focus();
      }, 50);

      await loadAppointments();
      const newToken = { ...appointmentPayload, token_no: verification.token_no };
      setLastGeneratedToken(newToken);
      printRegistrationToken(newToken, setNotice);
      await loadDoctorSuggestions();
      setNotice({ type: "success", message: `Appointment scheduled with Razorpay. Token #${verification.token_no}. Added to OP queue.` });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to schedule appointment via Razorpay.");
    } finally {
      setSavingAppointment(false);
    }
  };

  const updateAppointmentStatus = async (appointmentId: number, status: string) => {
    try {
      await apiFetch(`/api/appointments/${appointmentId}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      await loadAppointments();
      setNotice({ type: "success", message: `Token status updated to ${status.replace("_", " ")}.` });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update appointment status.");
    }
  };

  const handleSaveConsent = async () => {
    const patientName = consentForm.patient_name.trim() || patientFullName(selectedPatient);
    if (!patientName || !consentForm.signed_by.trim()) {
      setNotice({ type: "warning", message: "Patient name and signer are required for consent." });
      return;
    }
    const consentNotes = {
      age: consentForm.age.trim(),
      gender: consentForm.gender.trim(),
      mobile: consentForm.mobile.trim(),
      mobile_country_code: consentForm.mobile_country_code,
      doctor_name: consentForm.doctor_name.trim(),
      attender_mobile: consentForm.attender_mobile.trim(),
      attender_country_code: consentForm.attender_country_code,
      patient_signature: consentForm.patient_signature.trim(),
      attender_signature: consentForm.attender_signature.trim(),
      doctor_signature: consentForm.doctor_signature.trim(),
      document_reference: consentForm.document_reference.trim(),
      notes: consentForm.notes.trim(),
    };
    setSavingConsent(true);
    try {
      await apiFetch("/api/registration/consents", {
        method: "POST",
        body: JSON.stringify({
          patient_id: consentForm.patient_id.trim() || selectedPatient?.patient_id || undefined,
          patient_name: patientName,
          consent_type: consentForm.consent_type,
          signed_by: consentForm.signed_by.trim(),
          relation_to_patient: consentForm.relation_to_patient.trim() || undefined,
          status: consentForm.status,
          notes: JSON.stringify(consentNotes),
        }),
      });
      setConsentForm({
        ...DEFAULT_CONSENT_FORM,
        patient_id: selectedPatient?.patient_id || "",
        patient_name: patientName,
        signed_by: patientName,
        relation_to_patient: "Self",
        patient_signature: patientName,
      });
      await loadRegistrationOps();
      setNotice({ type: "success", message: "Digital consent recorded." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save consent.");
    } finally {
      setSavingConsent(false);
    }
  };

  const handleSaveInsuranceVerification = async () => {
    const patientName = insuranceForm.patient_name.trim() || patientFullName(selectedPatient);
    if (!patientName || !insuranceForm.insurer_name.trim()) {
      setNotice({ type: "warning", message: "Patient name and insurer are required for insurance verification." });
      return;
    }
    setSavingInsurance(true);
    try {
      await apiFetch("/api/registration/insurance", {
        method: "POST",
        body: JSON.stringify({
          patient_id: insuranceForm.patient_id.trim() || selectedPatient?.patient_id || undefined,
          patient_name: patientName,
          insurer_name: insuranceForm.insurer_name.trim(),
          policy_number: insuranceForm.policy_number.trim() || undefined,
          member_id: insuranceForm.member_id.trim() || undefined,
          verification_status: insuranceForm.verification_status,
          coverage_notes: insuranceForm.coverage_notes.trim() || undefined,
        }),
      });
      setInsuranceForm({
        ...DEFAULT_INSURANCE_FORM,
        patient_id: selectedPatient?.patient_id || "",
        patient_name: patientName,
      });
      await loadRegistrationOps();
      setNotice({ type: "success", message: "Insurance verification saved." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save insurance verification.");
    } finally {
      setSavingInsurance(false);
    }
  };


  const handleSelectConsentPatient = (patient: Patient) => {
    const fullName = patientFullName(patient) || patient.name || "";
    const latestVisit = appointments
      .filter((item) => item.patient_id === patient.patient_id || item.patient_name.toLowerCase() === fullName.toLowerCase())
      .sort((a, b) => new Date(b.appointment_date || "").getTime() - new Date(a.appointment_date || "").getTime())[0];
    setSelectedConsentPatient(patient);
    setConsentForm((prev) => ({
      ...prev,
      patient_id: patient.patient_id || "",
      patient_name: fullName,
      age: patient.age ? String(patient.age) : "",
      gender: normalizeConsentGender(patient.gender),
      mobile: patient.phone || "",
      mobile_country_code: cleanCountryCode(patient.phone_country_code),
      doctor_name: latestVisit?.doctor_name || prev.doctor_name,
      signed_by: fullName,
      relation_to_patient: "Self",
      attender_mobile: patient.family_mobile || patient.phone || "",
      attender_country_code: cleanCountryCode(patient.family_mobile ? patient.family_country_code : patient.phone_country_code),
      patient_signature: fullName,
      notes: latestVisit?.department ? `Latest visit department: ${latestVisit.department}` : prev.notes,
    }));
    setNotice({ type: "success", message: `${fullName || patient.patient_id} selected for consent.` });
  };



  const handleSelectInsurancePatient = (patient: Patient) => {
    const fullName = patientFullName(patient) || patient.name || "";
    setSelectedInsurancePatient(patient);
    setInsuranceForm((prev) => ({
      ...prev,
      patient_id: patient.patient_id || "",
      patient_name: fullName,
    }));
    setNotice({ type: "success", message: `${fullName || patient.patient_id} selected for insurance verification.` });
  };

  const parseConsentNotes = (notes?: string) => {
    if (!notes) return null;
    try {
      return JSON.parse(notes) as { doctor_name?: string; document_reference?: string; mobile?: string; mobile_country_code?: string };
    } catch {
      return { document_reference: notes };
    }
  };

  const uniqueInsuranceChecks = useMemo(() => {
    const seen = new Set<string>();
    return insuranceChecks.filter((check) => {
      const key = [
        (check as any).patient_id || "",
        check.patient_name || "",
        (check as any).policy_number || "",
        (check as any).claim_id || "",
        check.insurer_name || "",
      ].join("|").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [insuranceChecks]);

  const appointmentInQueue = useMemo(
    () => appointments.filter((item) => ["scheduled", "checked_in", "in_consultation"].includes(item.status)),
    [appointments]
  );

  const appointmentOutQueue = useMemo(
    () => appointments.filter((item) => ["checked_in", "in_consultation", "completed", "cancelled"].includes(item.status)),
    [appointments]
  );

  if (mode === "consent") {
    return (
      <section className="module-page">
        <div className="module-panel-head">
          <h3>Consent Desk</h3>
          <p className="muted">Capture patient consent, attender details, signatures, and consent history.</p>
        </div>
        <div className="panel registration-desk-panel">
          <div className="appointment-search-card">
            <div>
              <h4>Patient Lookup</h4>
              <p className="muted">Search by UHID, mobile number, Aadhaar number, or patient name.</p>
            </div>
            <div className="appointment-search-row">
              <Input
                value={patientSearch}
                onChange={(event) => setPatientSearch(normalizeSearchQuery(event.target.value, "+91"))}
                placeholder="UHID / Mobile / Aadhaar / Name"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handlePatientSearch();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={() => void handlePatientSearch()} disabled={patientSearchLoading}>
                {patientSearchLoading ? "Searching..." : "Search Patient"}
              </Button>
            </div>
            {patientResults.length > 0 && (
              <div className="patient-result-list">
                {patientResults.slice(0, 5).map((patient) => (
                  <button key={patient.patient_id} type="button" onClick={() => handleSelectConsentPatient(patient)}>
                    <strong>{patientFullName(patient) || patient.name} ({patient.patient_id})</strong>
                    <span>{patient.patient_id} · {patient.phone || "No mobile"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid-form patient-grid-form">
            <Label>
              UHID / Patient ID
              <Input value={consentForm.patient_id} onChange={(event) => setConsentForm((prev) => ({ ...prev, patient_id: event.target.value }))} placeholder="Auto-filled or manual" />
            </Label>
            <Label>
              Patient Name
              <Input value={consentForm.patient_name} onChange={(event) => setConsentForm((prev) => ({ ...prev, patient_name: event.target.value }))} placeholder="Patient name" />
            </Label>
            <Label>
              Age
              <Input value={consentForm.age} onChange={(event) => setConsentForm((prev) => ({ ...prev, age: event.target.value }))} placeholder="Age" />
            </Label>
            <Label>
              Gender
              <Select value={consentForm.gender} onChange={(event) => setConsentForm((prev) => ({ ...prev, gender: event.target.value }))}>
                <option value="">Select</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </Select>
            </Label>
            <Label>
              Mobile
              <PhoneInput countryCode={consentForm.mobile_country_code} value={consentForm.mobile} placeholder="Patient mobile"
                onChange={({ countryCode, value }) => setConsentForm((prev) => ({ ...prev, mobile_country_code: countryCode, mobile: value }))} />
            </Label>
            <Label>
              Consent Type
              <Select value={consentForm.consent_type} onChange={(event) => setConsentForm((prev) => ({ ...prev, consent_type: event.target.value }))}>
                {CONSENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Label>
            <Label>
              Doctor / Consultant
              <Input list="doctor-suggestions" value={consentForm.doctor_name} onChange={(event) => setConsentForm((prev) => ({ ...prev, doctor_name: event.target.value }))} placeholder="Doctor name" />
            </Label>
            <Label>
              Signed By
              <Input value={consentForm.signed_by} onChange={(event) => setConsentForm((prev) => ({ ...prev, signed_by: event.target.value }))} placeholder="Patient / Attender / Guardian" />
            </Label>
            <Label>
              Relationship
              <Input value={consentForm.relation_to_patient} onChange={(event) => setConsentForm((prev) => ({ ...prev, relation_to_patient: event.target.value }))} placeholder="Self / Spouse / Parent" />
            </Label>
            <Label>
              Attender Mobile
              <PhoneInput countryCode={consentForm.attender_country_code} value={consentForm.attender_mobile} placeholder="Optional"
                onChange={({ countryCode, value }) => setConsentForm((prev) => ({ ...prev, attender_country_code: countryCode, attender_mobile: value }))} />
            </Label>
            <Label>
              Consent Status
              <Select value={consentForm.status} onChange={(event) => setConsentForm((prev) => ({ ...prev, status: event.target.value }))}>
                {CONSENT_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
              </Select>
            </Label>
            <Label>
              Supporting Document Reference
              <Input value={consentForm.document_reference} onChange={(event) => setConsentForm((prev) => ({ ...prev, document_reference: event.target.value }))} placeholder="Aadhaar / insurance / consent PDF filename" />
            </Label>
            <Label>
              Patient Signature Name
              <Input value={consentForm.patient_signature} onChange={(event) => setConsentForm((prev) => ({ ...prev, patient_signature: event.target.value }))} placeholder="Typed signature" />
            </Label>
            <Label>
              Attender Signature Name
              <Input value={consentForm.attender_signature} onChange={(event) => setConsentForm((prev) => ({ ...prev, attender_signature: event.target.value }))} placeholder="Typed signature" />
            </Label>
            <Label>
              Doctor Signature Name
              <Input value={consentForm.doctor_signature} onChange={(event) => setConsentForm((prev) => ({ ...prev, doctor_signature: event.target.value }))} placeholder="Typed signature" />
            </Label>
            <Label className="span-2">
              Notes / Consent Summary
              <Textarea value={consentForm.notes} onChange={(event) => setConsentForm((prev) => ({ ...prev, notes: event.target.value }))} placeholder="Procedure explained, risks discussed, patient questions answered..." />
            </Label>
          </div>
          <datalist id="doctor-suggestions">
            {doctorSuggestions.map((name) => <option key={name} value={name} />)}
          </datalist>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => void handleSaveConsent()} disabled={savingConsent}>
              {savingConsent ? "Saving Consent..." : "Save Consent"}
            </Button>
            <Button variant="ghost" type="button" onClick={() => printConsentDocument(consentForm, setNotice)}>Print Consent</Button>
            <Button
              type="button"
              style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
              onClick={() => shareConsentWhatsApp(consentForm, setNotice)}
            >
              💬 WhatsApp
            </Button>
          </div>

          <div className="appointment-history-card">
            <h4>Consent History</h4>
            {consents.length === 0 ? <p className="muted">No consent records yet.</p> : (
              <div className="consent-history-list">
                {consents.slice(0, 10).map((consent) => {
                  const parsedNotes = parseConsentNotes(consent.notes);
                  return (
                    <div key={consent.id} className="consent-history-item">
                      <strong>{consent.patient_name}</strong>
                      <span>{CONSENT_TYPE_OPTIONS.find((item) => item.value === consent.consent_type)?.label || consent.consent_type}</span>
                      <span>Signed by: {consent.signed_by}</span>
                      <span>Status: {consent.status || "signed"}</span>
                      <span>Date: {formatDateTime(consent.signed_at)}</span>
                      {parsedNotes?.doctor_name && <span>Doctor: {parsedNotes.doctor_name}</span>}
                      {parsedNotes?.mobile && <span>Mobile: {formatPhone(parsedNotes.mobile_country_code, parsedNotes.mobile)}</span>}
                      {parsedNotes?.document_reference && <span>Document: {parsedNotes.document_reference}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (mode === "insurance") {
    return (
      <section className="module-page">
        <div className="module-panel-head">
          <h3>Insurance Desk</h3>
          <p className="muted">Verify policy details, TPA status, documents, and claim readiness.</p>
        </div>
        <div className="panel registration-desk-panel">
          <div className="appointment-search-card">
            <div><h4>Patient Lookup</h4><p className="muted">Search by UHID, mobile number, Aadhaar number, or patient name.</p></div>
            <div className="appointment-search-row">
              <Input
                value={patientSearch}
                onChange={(event) => setPatientSearch(normalizeSearchQuery(event.target.value, "+91"))}
                placeholder="UHID / Mobile / Aadhaar / Name"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handlePatientSearch();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={() => void handlePatientSearch()} disabled={patientSearchLoading}>{patientSearchLoading ? "Searching..." : "Search Patient"}</Button>
            </div>
            {patientResults.length > 0 && (
              <div className="patient-result-list">
                {patientResults.slice(0, 5).map((patient) => (
                  <button key={patient.patient_id} type="button" onClick={() => handleSelectInsurancePatient(patient)}>
                    <strong>{patientFullName(patient) || patient.name} ({patient.patient_id})</strong><span>{patient.patient_id} · {patient.phone || "No mobile"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid-form">
            <Label>
              UHID / Patient ID
              <Input value={insuranceForm.patient_id} onChange={(event) => setInsuranceForm((prev) => ({ ...prev, patient_id: event.target.value }))} placeholder="Auto-filled or manual" />
            </Label>
            <Label>
              Patient Name
              <Input
                value={insuranceForm.patient_name}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, patient_name: event.target.value }))}
                placeholder="Patient name"
              />
            </Label>
            <Label>
              Insurer
              <Input
                value={insuranceForm.insurer_name}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, insurer_name: event.target.value }))}
                placeholder="Insurance provider"
              />
            </Label>
            <Label>
              Policy Number
              <Input
                value={insuranceForm.policy_number}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, policy_number: event.target.value }))}
                placeholder="Policy no."
              />
            </Label>
            <Label>
              Member ID
              <Input
                value={insuranceForm.member_id}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, member_id: event.target.value }))}
                placeholder="Member ID"
              />
            </Label>
            <Label>
              TPA Name
              <Input value={(insuranceForm as any).tpa_name || ""} onChange={(event) => setInsuranceForm((prev) => ({ ...prev, tpa_name: event.target.value } as any))} placeholder="Medi Assist / FHPL / Heritage" />
            </Label>
            <Label>
              Pre-Authorization No
              <Input value={(insuranceForm as any).preauth_no || ""} onChange={(event) => setInsuranceForm((prev) => ({ ...prev, preauth_no: event.target.value } as any))} placeholder="Pre-auth reference" />
            </Label>
            <Label>
              Approved Amount
              <Input type="number" value={(insuranceForm as any).approved_amount || ""} onChange={(event) => setInsuranceForm((prev) => ({ ...prev, approved_amount: event.target.value } as any))} placeholder="0" />
            </Label>
            <Label>
              Document Reference
              <Input value={(insuranceForm as any).document_reference || ""} onChange={(event) => setInsuranceForm((prev) => ({ ...prev, document_reference: event.target.value } as any))} placeholder="Policy card / TPA letter filename" />
            </Label>
            <Label>
              Status
              <Select
                value={insuranceForm.verification_status}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, verification_status: event.target.value }))}
              >
                <option value="pending">Pending</option>
                <option value="verified">Verified</option>
                <option value="rejected">Rejected</option>
              </Select>
            </Label>
            <Label className="span-2">
              Coverage Notes
              <Textarea
                value={insuranceForm.coverage_notes}
                onChange={(event) => setInsuranceForm((prev) => ({ ...prev, coverage_notes: event.target.value }))}
                rows={2}
              />
            </Label>
          </div>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => void handleSaveInsuranceVerification()} disabled={savingInsurance}>
              {savingInsurance ? "Saving Verification..." : "Save Verification"}
            </Button>
            <Button variant="ghost" type="button" onClick={() => printInsuranceDocument(insuranceForm as typeof DEFAULT_INSURANCE_FORM & Record<string, string>, setNotice)}>Print Insurance</Button>
            <Button
              type="button"
              style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
              onClick={() => shareInsuranceWhatsApp(insuranceForm as typeof DEFAULT_INSURANCE_FORM & Record<string, string>, setNotice)}
            >
              💬 WhatsApp
            </Button>
          </div>
          {uniqueInsuranceChecks.slice(0, 10).map((check) => (
            <p key={check.id} className="muted">
              {check.patient_name} · {check.insurer_name} · {check.verification_status}
            </p>
          ))}
        </div>
      </section>
    );
  }

  const queue = mode === "appointment-in" ? appointmentInQueue : appointmentOutQueue;

  return (
    <section className="module-page">

      {mode === "appointment-in" ? (
        <>
          <div className="panel registration-desk-panel">
            <h4>Patient Search & Appointment Intake</h4>
            <div className="module-inline-actions">
              <Input
                id="patient-search-input-desk"
                value={patientSearch}
                onChange={(event) => setPatientSearch(normalizeSearchQuery(event.target.value, "+91"))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handlePatientSearch();
                }}
                placeholder="Search by Patient ID / Mobile / Aadhaar / Name"
                aria-label="Search patient"
              />
              <Button type="button" onClick={() => void handlePatientSearch()} disabled={patientSearchLoading}>
                {patientSearchLoading ? "Searching..." : "Search Patient"}
              </Button>
              <Button type="button" variant="ghost" onClick={handleClearAppointmentPatient}>
                New Patient
              </Button>
            </div>

            {selectedPatientDetails ? (
              <div className="module-mobile-card" style={{ marginTop: 12 }}>
                <h4>{patientFullName(selectedPatientDetails) || selectedPatientDetails.patient_id} ({selectedPatientDetails.patient_id})</h4>
                <p><strong>Patient ID:</strong> {selectedPatientDetails.patient_id}</p>
                <p><strong>Age / Gender:</strong> {selectedPatientDetails.age || "-"} / {selectedPatientDetails.gender || "-"}</p>
                <p><strong>Mobile:</strong> {selectedPatientDetails.phone || "-"}</p>
                <p><strong>Address:</strong> {selectedPatientDetails.address || "-"}</p>
              </div>
            ) : null}

            {patientResults.length > 0 ? (
              <div className="module-mobile-list" style={{ display: "grid", marginTop: 12 }}>
                {patientResults.slice(0, 5).map((patient) => (
                  <article className="module-mobile-card" key={patient.patient_id}>
                    <h4>{patientFullName(patient) || patient.patient_id} ({patient.patient_id})</h4>
                    <p><strong>ID:</strong> {patient.patient_id}</p>
                    <p><strong>Mobile:</strong> {patient.phone || "-"}</p>
                    <p><strong>Age/Gender:</strong> {patient.age || "-"} / {patient.gender || "-"}</p>
                    <div className="module-card-actions">
                      <Button type="button" size="sm" onClick={() => handleSelectAppointmentPatient(patient)}>
                        Select Patient
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </div>

          <div className="panel registration-desk-panel">
            <h4>Queue Status</h4>
            <div className="dashboard-grid compact-grid">
              <div className="stat-card"><span>Waiting</span><strong>{appointmentStats.waiting}</strong></div>
              <div className="stat-card"><span>In Consultation</span><strong>{appointmentStats.inConsultation}</strong></div>
              <div className="stat-card"><span>Completed</span><strong>{appointmentStats.completed}</strong></div>
            </div>
          </div>

          <div className="panel registration-desk-panel">
            <h4>Schedule Appointment</h4>
            <div className="grid-form">
              <Label>
                Patient Type
                <Select
                  value={appointmentForm.patient_type}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, patient_type: event.target.value }))}
                >
                  <option value="new">New Patient</option>
                  <option value="existing">Existing Patient</option>
                </Select>
              </Label>
              <Label>
                Patient ID
                <Input
                  value={appointmentForm.patient_id}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, patient_id: event.target.value }))}
                  placeholder="Auto-filled for existing patient"
                />
              </Label>
              <Label>
                Patient Name
                <Input
                  value={appointmentForm.patient_name}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, patient_name: event.target.value }))}
                  placeholder="Walk-in or existing patient"
                />
              </Label>
              <Label>
                Operator Name
                <Input
                  value={appointmentForm.operator_name}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, operator_name: event.target.value }))}
                  placeholder="Staff / Receptionist name"
                />
              </Label>
              <Label>
                Appointment Date & Time
                <div className="appointment-time-with-period">
                  <Input
                    type="datetime-local"
                    value={appointmentForm.appointment_date}
                    onChange={(event) => {
                      setAppointmentForm((prev) => ({ ...prev, appointment_date: event.target.value }));
                      if ((event.nativeEvent as any).inputType === undefined) {
                        const input = event.target;
                        input.blur();
                        setTimeout(() => input.focus(), 10);
                      }
                    }}
                  />
                  <span
                    onClick={() => {
                      const newTime = toggleAmPm(appointmentForm.appointment_date);
                      if (newTime) setAppointmentForm((prev) => ({ ...prev, appointment_date: newTime }));
                    }}
                    style={{ cursor: "pointer", userSelect: "none" }}
                    title="Click to toggle AM/PM"
                  >
                    {getAmPmLabel(appointmentForm.appointment_date)}
                  </span>
                </div>
              </Label>
              <Label>
                Department
                <Select
                  value={appointmentForm.department}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAppointmentForm((prev) => {
                      return {
                        ...prev,
                        department: value,
                      };
                    });
                  }}
                >
                  <option value="">{departments.length ? "Select department" : "No Departments Available"}</option>
                  {departments.map((department) => {
                    const name = (department.department_name || "").trim();
                    if (!name) return null;
                    return <option key={department.id} value={name}>{name}</option>;
                  })}
                </Select>
              </Label>
              <Label>
                Doctor
                <Select
                  value={appointmentForm.doctor_name}
                  onChange={(event) => {
                    const doctor = event.target.value;
                    const schedule = doctorFeeMap[doctor.trim()];
                    setAppointmentForm((prev) => ({
                      ...prev,
                      doctor_name: doctor,
                      department: schedule?.department || prev.department,
                      consultation_fee: String(
                        resolveAppointmentFee(doctor, prev.appointment_kind, selectedAppointmentPatient?.last_consultation_date, prev.appointment_date || queueDate)
                      ),
                    }));
                  }}
                >
                  <option value="" disabled={filteredDoctorSuggestions.length > 0}>
                    {filteredDoctorSuggestions.length ? "Select doctor" : "No doctors available"}
                  </option>
                  {filteredDoctorSuggestions.map((doctor) => <option key={doctor} value={doctor}>{doctor}</option>)}
                </Select>
                {appointmentForm.appointment_date && filteredDoctorSuggestions.length === 0 && (
                  <span className="field-error" style={{ color: "#ef4444", fontSize: "11px", marginTop: "4px", display: "block", fontWeight: "500" }}>
                    No doctors available for the selected department.
                  </span>
                )}
              </Label>
              <Label>
                Visit Type
                <Select
                  value={appointmentForm.visit_type}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, visit_type: event.target.value }))}
                >
                  <option value="OP">OP</option>
                  <option value="Follow-up">Follow-up</option>
                  <option value="Emergency">Emergency</option>
                  <option value="Teleconsultation">Teleconsultation</option>
                </Select>
              </Label>
              <Label>
                Appointment Kind
                <Select
                  value={appointmentForm.appointment_kind}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, appointment_kind: event.target.value }))}
                >
                  <option value="new">New</option>
                  <option value="follow_up">Follow-up</option>
                  <option value="review">Review</option>
                </Select>
              </Label>
              {/* Previous Visit Info — read-only panel for existing patients */}
              {appointmentForm.patient_type === "existing" && selectedAppointmentPatient && (
                <div className="span-2" style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "8px", padding: "12px 16px", marginBottom: "4px" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.8rem", color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                    📋 Previous Visit Information
                    {selectedAppointmentPatient.last_consultation_date && (
                      <span style={{ fontWeight: 500, fontSize: "0.75rem", color: "#475569" }}> — Last: {selectedAppointmentPatient.last_consultation_date}</span>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px", fontSize: "0.82rem", color: "#334155" }}>
                    {selectedAppointmentPatient.bp && <span><strong>BP:</strong> {selectedAppointmentPatient.bp}</span>}
                    {selectedAppointmentPatient.temperature && <span><strong>Temp:</strong> {selectedAppointmentPatient.temperature}°F</span>}
                    {selectedAppointmentPatient.pulse && <span><strong>Pulse:</strong> {selectedAppointmentPatient.pulse} bpm</span>}
                    {selectedAppointmentPatient.spo2 && <span><strong>SpO2:</strong> {selectedAppointmentPatient.spo2}%</span>}
                    {selectedAppointmentPatient.weight && <span><strong>Weight:</strong> {selectedAppointmentPatient.weight} kg</span>}
                    {selectedAppointmentPatient.height && <span><strong>Height:</strong> {selectedAppointmentPatient.height} cm</span>}
                    {!selectedAppointmentPatient.bp && !selectedAppointmentPatient.temperature && !selectedAppointmentPatient.pulse && !selectedAppointmentPatient.spo2 && !selectedAppointmentPatient.weight && !selectedAppointmentPatient.height && (
                      <span style={{ color: "#94a3b8", fontStyle: "italic" }}>No previous vitals recorded.</span>
                    )}
                  </div>
                </div>
              )}
              {appointmentForm.patient_type === "existing" && (
                <div className="span-2" style={{ fontWeight: 700, fontSize: "0.8rem", color: "#0f766e", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "2px solid #99f6e4", paddingBottom: "6px", marginBottom: "2px" }}>
                  Follow-Up — Clinical Information
                </div>
              )}
              <Label className="span-2">
                Chief Complaint / Reason for Visit
                <Textarea
                  value={appointmentForm.chief_complaint}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, chief_complaint: event.target.value }))}
                  rows={2}
                  placeholder="Fever since 3 days, body pains, headache..."
                />
              </Label>
              <Label>
                Blood Pressure
                <div className="bp-split-wrap">
                  <Input value={bpSys} onChange={(event) => { const v = filterInteger(event.target.value); setBpSys(v); setAppointmentForm((prev) => ({ ...prev, bp: `${v}/${bpDia}` })); }} placeholder="120" inputMode="numeric" />
                  <span className="bp-separator">/</span>
                  <Input value={bpDia} onChange={(event) => { const v = filterInteger(event.target.value); setBpDia(v); setAppointmentForm((prev) => ({ ...prev, bp: `${bpSys}/${v}` })); }} placeholder="80" inputMode="numeric" />
                </div>
              </Label>
              <Label>
                Temperature
                <div className="vital-input-wrap">
                  <Input value={appointmentForm.temperature} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, temperature: filterDecimal(event.target.value) }))} placeholder="98.6" inputMode="decimal" />
                  <span className="vital-unit-badge">°F</span>
                </div>
              </Label>
              <Label>
                Pulse
                <div className="vital-input-wrap">
                  <Input value={appointmentForm.pulse} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, pulse: filterInteger(event.target.value) }))} placeholder="72" inputMode="numeric" />
                  <span className="vital-unit-badge">bpm</span>
                </div>
              </Label>
              <Label>
                SpO2
                <div className="vital-input-wrap">
                  <Input value={appointmentForm.spo2} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, spo2: filterDecimal(event.target.value) }))} placeholder="98" inputMode="numeric" />
                  <span className="vital-unit-badge">%</span>
                </div>
              </Label>
              <Label>Weight (kg)<Input value={appointmentForm.weight} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, weight: filterDecimal(event.target.value) }))} /></Label>
              <Label>Height (cm)<Input value={appointmentForm.height} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, height: filterDecimal(event.target.value) }))} /></Label>
              <Label style={{ position: "relative", display: "block" }}>
                Consultation Fee
                <Input type="number" min="0" required value={appointmentForm.consultation_fee} onChange={(event) => setAppointmentForm((prev) => ({ ...prev, consultation_fee: filterDecimal(event.target.value) }))} placeholder="Enter consultation fee" readOnly={true} className="locked-fee-input" title="Consultation fee is locked from Doctor Scheduling." />
                {Number(appointmentForm.consultation_fee) === 0 && selectedAppointmentPatient?.last_consultation_date && (
                  <span style={{ position: "absolute", right: "10px", bottom: "10px", fontSize: "11px", color: "#16a34a", fontWeight: "600", pointerEvents: "none" }}>Free Follow-up</span>
                )}
              </Label>
              <Label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", marginTop: "24px" }}>
                <input
                  type="checkbox"
                  id="verify-fee-paid-desk"
                  checked={paymentConfirmed}
                  onChange={(e) => setPaymentConfirmed(e.target.checked)}
                  style={{ width: "18px", height: "18px", cursor: "pointer" }}
                />
                <span style={{ fontWeight: "600", cursor: "pointer" }}>Verify Fee Paid</span>
              </Label>
              <Label>
                Payment Mode
                <Select
                  value={appointmentForm.payment_mode}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, payment_mode: event.target.value }))}
                >
                  <option value="" disabled>Select Payment Mode</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank">Bank Transfer</option>
                  <option value="cash">Cash</option>
                </Select>
              </Label>
              <Label className="span-2">
                Additional Notes
                <Textarea
                  value={appointmentForm.notes}
                  onChange={(event) => setAppointmentForm((prev) => ({ ...prev, notes: event.target.value }))}
                  rows={2}
                />
              </Label>
            </div>
            <div className="form-actions">

              <Button variant="secondary" type="button" onClick={() => void handleCreateAppointment()} disabled={savingAppointment}>
                {savingAppointment ? "Scheduling..." : "Save Appointment & Generate Token"}
              </Button>
              <Button variant="primary" type="button" onClick={() => void handleCreateAppointmentWithRazorpay()} disabled={savingAppointment || !isRazorpayReady}>
                {savingAppointment ? "Processing..." : "Pay via Razorpay & Schedule"}
              </Button>
              <Button variant="ghost" type="button" onClick={() => printRegistrationToken(lastGeneratedToken, setNotice)} disabled={!lastGeneratedToken}>
                Print
              </Button>
              <Button
                type="button"
                style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
                onClick={() => shareRegistrationTokenWhatsApp(lastGeneratedToken, setNotice)}
                disabled={!lastGeneratedToken}
              >
                💬 WhatsApp
              </Button>
            </div>
            {!isRazorpayReady ? <p className="muted">Razorpay payments are disabled until backend keys are configured.</p> : null}
          </div>

          <div className="panel registration-desk-panel">
            <h4>Appointment History</h4>
            {patientAppointmentHistory.length === 0 ? <p className="muted">Select or enter a patient to view today's matching appointment history.</p> : null}
            {patientAppointmentHistory.map((item) => (
              <p key={item.id} className="muted">
                {formatDateTime(item.appointment_date)} · {item.doctor_name || "Doctor not assigned"} · {item.department || "Department not assigned"} · {item.status.replace("_", " ")}
              </p>
            ))}
          </div>
        </>
      ) : null}

      <div className="panel registration-desk-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
          <h4 style={{ margin: 0 }}>{mode === "appointment-in" ? "Appointment Queue (In)" : "Appointment Queue (Out)"}</h4>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "bold" }}>Queue Date:</span>
            <Input
              type="date"
              value={queueDate}
              onChange={(e) => setQueueDate(e.target.value)}
              style={{ width: "150px", padding: "4px 8px", fontSize: "13px" }}
            />
          </div>
        </div>
        {appointmentsLoading ? <p className="muted">Loading queue...</p> : null}
        {!appointmentsLoading && queue.length === 0 ? (
          <p className="muted">No appointments found for {queueDate === new Date().toLocaleDateString('en-CA') ? "today" : queueDate}.</p>
        ) : null}
        {!appointmentsLoading && queue.length > 0 ? (
          <div className="module-mobile-list" style={{ display: "grid" }}>
            {queue.map((appointment) => (
              <article className="module-mobile-card" key={appointment.id}>
                <h4>
                  Token #{appointment.token_no} · {appointment.patient_name}
                </h4>
                <p><strong>Visit:</strong> {appointment.visit_type}</p>
                <p><strong>Department:</strong> {appointment.department || "-"}</p>
                <p><strong>Doctor:</strong> {appointment.doctor_name || "-"}</p>
                <p><strong>Time:</strong> {formatDateTime(appointment.appointment_date)}</p>
                <p><strong>Status:</strong> {appointment.status.replace("_", " ")}</p>
                {appointment.notes ? <p><strong>Notes:</strong> {appointment.notes}</p> : null}
                <div className="module-card-actions">
                  {mode === "appointment-in" && appointment.status === "scheduled" ? (
                    <Button type="button" size="sm" onClick={() => void updateAppointmentStatus(appointment.id, "checked_in")}>
                      Check In
                    </Button>
                  ) : null}
                  {mode === "appointment-in" && appointment.status === "checked_in" ? (
                    <Button type="button" size="sm" onClick={() => void updateAppointmentStatus(appointment.id, "in_consultation")}>
                      Start Visit
                    </Button>
                  ) : null}
                  {mode === "appointment-out" && (appointment.status === "checked_in" || appointment.status === "in_consultation") ? (
                    <Button type="button" size="sm" variant="secondary" onClick={() => void updateAppointmentStatus(appointment.id, "completed")}>
                      Complete
                    </Button>
                  ) : null}
                  {(mode === "appointment-in" || mode === "appointment-out") && appointment.status !== "completed" && appointment.status !== "cancelled" ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void updateAppointmentStatus(appointment.id, "cancelled")}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
