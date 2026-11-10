import { useState, useMemo, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Notice, Patient, PatientForm } from "../types";
import { apiFetch, reportError } from "../lib/api";
import { printViaIframe } from "../lib/printViaIframe";
import { calculateAgeFromDob } from "../lib/format";
import { doctorsInDepartment, useDoctorDirectory } from "../lib/doctorDirectory";
import { Modal } from "../components/ui";
import { COUNTRY_CODE_RULES } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";

const COUNTRY_OPTIONS = Object.values(COUNTRY_CODE_RULES).map((r) => r.label);

/** Digits allowed for a mobile under the chosen country option ("UAE (+971)" -> 9). */
function primaryDigitLimit(countryOption: string): number {
  const code = countryOption.match(/\+\d+/)?.[0] || "+91";
  return (COUNTRY_CODE_RULES[code] || COUNTRY_CODE_RULES["+91"]).max;
}

type Props = {
  onCreate?: (
    payload: Record<string, unknown>,
    setForm: Dispatch<SetStateAction<PatientForm>>,
    setDuplicateInfo: Dispatch<SetStateAction<any>>,
    refreshPatientId: () => Promise<void>
  ) => Promise<{ patient_id: string; admission_id?: string } | null>;
  selectedPatient?: Patient | null;
  ocrLanguage?: string;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onDocumentSaved?: (patientId?: string) => Promise<void>;
  onNavigate?: (pageId: string) => void;
};

type RecentReg = {
  id: string;
  patientId: string;
  name: string;
  ageGender: string;
  phone: string;
  visitType: "OP" | "IP" | "ER";
  registeredAt: string;
  doctorName?: string;
  department?: string;
};

// Digit-count limiting (e.g. slice(0, 2)) still lets "99" through -- the
// pain scale is clinically defined as 0-10, so clamp the parsed number too.
const clampPainScore = (v: string): string => {
  const digits = v.replace(/\D/g, "").slice(0, 2);
  if (digits === "") return "";
  return String(Math.min(10, parseInt(digits, 10)));
};

export default function AddPatientPage({ setNotice, onNavigate, onCreate }: Props) {
  const [patientId, setPatientId] = useState<string | null>(null);
  const [nextUhid, setNextUhid] = useState<string>("");
  const [bookedAppointment, setBookedAppointment] = useState<{
    tokenNo: string | number;
    appointmentId?: number;
    doctor: string;
    department: string;
    fee: string | number;
    paymentMode: string;
    date: string;
  } | null>(null);
  const [bookingAppointment, setBookingAppointment] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState<any>(null);
  const [lastRegisteredPatient, setLastRegisteredPatient] = useState<{
    patientId: string;
    name: string;
    age: string;
    gender: string;
    phone: string;
    address: string;
    visitType: string;
    doctor?: string;
    department?: string;
    fee?: string | number;
    paymentMode?: string;
    tokenNo?: string | number;
  } | null>(null);

  // Existing Patient Search / Auto-fill state
  const [existingSearchQuery, setExistingSearchQuery] = useState("");
  const [existingSearchResults, setExistingSearchResults] = useState<Patient[]>([]);
  const [isSearchingExisting, setIsSearchingExisting] = useState(false);
  const [hasSearchedExisting, setHasSearchedExisting] = useState(false);
  const [existingPatient, setExistingPatient] = useState<Patient | null>(null);

  const handleSearchExistingPatients = async (queryOverride?: string) => {
    const q = (queryOverride !== undefined ? queryOverride : existingSearchQuery).trim();
    if (!q) {
      setExistingSearchResults([]);
      setHasSearchedExisting(false);
      return;
    }
    setIsSearchingExisting(true);
    try {
      const data = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(q)}`);
      const list = data.patients || [];
      setExistingSearchResults(list);
      setHasSearchedExisting(true);
      if (list.length === 0) {
        setNotice({ type: "info", message: `No registered patient found matching "${q}". You can proceed with new patient registration below.` });
      }
    } catch (err) {
      reportError(setNotice, err as any, "Patient search failed");
      setExistingSearchResults([]);
      setHasSearchedExisting(true);
    } finally {
      setIsSearchingExisting(false);
    }
  };

  const handleSelectExistingPatient = (patient: Patient) => {
    setExistingPatient(patient);
    setPatientId(patient.patient_id);
    setFirstName(patient.name || "");
    setLastName(patient.last_name || "");
    setDob(patient.dob || "");
    if (patient.dob) {
      setAge(calculateAgeFromDob(patient.dob));
    } else {
      setAge(patient.age ? String(patient.age) : "");
    }
    setGender(patient.gender || "");
    setMaritalStatus(patient.marital_status || "");
    setPrimaryPhone(patient.phone || "");
    setAltPhone(patient.family_mobile || "");
    setEmail(patient.email || "");
    setAddress(patient.address || "");
    setAllergies(patient.allergies || "");
    setNoAllergies(Boolean(patient.no_known_allergies));
    setDuplicateInfo(null);
    setHasSearchedExisting(false);
    setExistingSearchResults([]);
    setExistingSearchQuery("");
    setNotice({
      type: "success",
      message: `Existing patient ${patient.name} ${patient.last_name || ""} (${patient.patient_id}) selected. Details auto-filled! You can now choose a doctor to book appointment or proceed to IP admission.`,
    });
  };

  const handleClearExistingPatient = () => {
    setExistingPatient(null);
    setPatientId(null);
    resetPatientDetailsForm();
    setExistingSearchQuery("");
    setExistingSearchResults([]);
    setHasSearchedExisting(false);
    setDuplicateInfo(null);
    setBookedAppointment(null);
    void fetchNextUhid();
    setNotice({ type: "info", message: "Cleared existing patient. Switched to New Patient Registration." });
  };

  const fetchNextUhid = async () => {
    try {
      const data = await apiFetch<{ patient_id: string }>("/api/patients/next-id");
      if (data?.patient_id) {
        setNextUhid(data.patient_id);
      }
    } catch (err) {
      // A 401 means the session ended; App already routes to login, so don't log noise.
      if ((err as { status?: number })?.status !== 401) console.warn("Could not fetch next UHID:", err);
    }
  };

  // Personal information state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [maritalStatus, setMaritalStatus] = useState("");
  const [primaryCountryCode, setPrimaryCountryCode] = useState("India (+91)");
  const [primaryPhone, setPrimaryPhone] = useState("");
  const [altCountryCode, setAltCountryCode] = useState("India (+91)");
  const [altPhone, setAltPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [insuranceProvider, setInsuranceProvider] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [insuranceProviders, setInsuranceProviders] = useState<{ id: number; name: string }[]>([]);
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderContact, setNewProviderContact] = useState("");
  const [newProviderPhone, setNewProviderPhone] = useState("");
  const [newProviderPhoneCode, setNewProviderPhoneCode] = useState("+91");
  const [savingProvider, setSavingProvider] = useState(false);
  const [noAllergies, setNoAllergies] = useState(false);
  const [allergies, setAllergies] = useState("");
  const [prebookingRefId, setPrebookingRefId] = useState<number | null>(null);

  // Visit Type: 'OP' | 'IP' | 'Emergency'
  const [visitType, setVisitType] = useState<"OP" | "IP" | "Emergency">("OP");

  // OP Appointment & Doctor Consultation fields
  // Departments and doctors come only from the Doctor Scheduling module.
  const { departments, doctors: doctorList, loading: directoryLoading } = useDoctorDirectory();
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [consultationFee, setConsultationFee] = useState<string | number>(0);
  const [appointmentType, setAppointmentType] = useState<"Consultation" | "Review" | "Follow-up">("Consultation");
  const [paymentMode, setPaymentMode] = useState<"Cash" | "UPI" | "Card" | "Waived">("Cash");
  const [appointmentSlot, setAppointmentSlot] = useState("Immediate Live Queue (Walk-in)");


  // Emergency fields
  const [emergencyTriage, setEmergencyTriage] = useState<"Red (Critical)" | "Yellow (Urgent)" | "Green (Non-urgent)">("Yellow (Urgent)");
  const [emergencyAttendant, setEmergencyAttendant] = useState("");
  const [emergencyComplaint, setEmergencyComplaint] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [vitalsBp, setVitalsBp] = useState("");
  const [vitalsPulse, setVitalsPulse] = useState("");
  const [vitalsTemp, setVitalsTemp] = useState("");
  const [vitalsSpo2, setVitalsSpo2] = useState("");
  const [vitalsRespRate, setVitalsRespRate] = useState("");
  const [vitalsHeight, setVitalsHeight] = useState("");
  const [vitalsWeight, setVitalsWeight] = useState("");
  const [vitalsPainScore, setVitalsPainScore] = useState("");
  const [vitalsBloodSugar, setVitalsBloodSugar] = useState("");
  const [emergencyBp, setEmergencyBp] = useState("");
  const [emergencyPulse, setEmergencyPulse] = useState("");
  const [emergencyTemp, setEmergencyTemp] = useState("");
  const [emergencySpo2, setEmergencySpo2] = useState("");
  const [emergencyRespRate, setEmergencyRespRate] = useState("");
  const [emergencyPainScore, setEmergencyPainScore] = useState("");

  // Recent registrations list
  const [recentRegistrations, setRecentRegistrations] = useState<RecentReg[]>(() => {
    try {
      const saved = localStorage.getItem("hospai_recent_registrations");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    fetchNextUhid();
    void loadInsuranceProviders();

    // Check for pre-booked patient prefill data
    try {
      const raw = sessionStorage.getItem("hospai_prefill_prebooking");
      if (raw) {
        const item = JSON.parse(raw);
        if (item) {
          if (item.id) setPrebookingRefId(item.id);
          const rawName = String(item.patient_name || "").trim();
          if (rawName) {
            const parts = rawName.split(/\s+/);
            if (parts.length > 1) {
              setFirstName(parts[0]);
              setLastName(parts.slice(1).join(" "));
            } else {
              setFirstName(rawName);
            }
          }
          if (item.phone) {
            setPrimaryPhone(item.phone);
          }
          if (item.phone_country_code) {
            const matched = COUNTRY_OPTIONS.find((opt) => opt.includes(item.phone_country_code));
            if (matched) setPrimaryCountryCode(matched);
          }
          if (item.dob) {
            setDob(item.dob);
            setAge(calculateAgeFromDob(item.dob));
          } else if (item.age) {
            setAge(String(item.age));
          }
          if (item.email) {
            setEmail(item.email);
          }
          if (item.reason) {
            setSymptoms(item.reason);
          }
          if (item.department) {
            setSelectedDepartment(item.department);
          }
          if (item.doctor_name) {
            setSelectedDoctor(item.doctor_name);
          }
          setNotice({
            type: "info",
            message: `Pre-booked details for "${rawName}" auto-filled! Complete registration below to generate official UHID.`,
          });
        }
      }
    } catch (e) {
      console.warn("Could not parse pre-booking prefill data:", e);
    }
  }, []);

  const loadInsuranceProviders = async () => {
    try {
      const data = await apiFetch<{ providers?: { id: number; name: string }[] }>("/api/insurance-providers");
      setInsuranceProviders(data.providers || []);
    } catch {
      // Non-fatal -- the provider dropdown just stays empty and staff can
      // still add one.
    }
  };

  const handleAddProvider = async () => {
    if (!newProviderName.trim()) {
      setNotice({ type: "warning", message: "Provider name is required." });
      return;
    }
    setSavingProvider(true);
    try {
      const res = await apiFetch<{ provider: { id: number; name: string } }>("/api/insurance-providers", {
        method: "POST",
        body: JSON.stringify({
          name: newProviderName.trim(),
          contact_person: newProviderContact.trim() || undefined,
          contact_phone: newProviderPhone.trim() || undefined,
          contact_phone_country_code: newProviderPhone.trim() ? newProviderPhoneCode : undefined,
        }),
      });
      setInsuranceProviders((prev) => [...prev, res.provider].sort((a, b) => a.name.localeCompare(b.name)));
      setInsuranceProvider(res.provider.name);
      setShowAddProviderModal(false);
      setNewProviderName("");
      setNewProviderContact("");
      setNewProviderPhone("");
      setNotice({ type: "success", message: `"${res.provider.name}" added and selected.` });
    } catch (err) {
      reportError(setNotice, err as any, "Could not add insurance provider.");
    } finally {
      setSavingProvider(false);
    }
  };

  // Filter available doctors strictly by selected department
  const filteredDoctors = useMemo(() => doctorsInDepartment(doctorList, selectedDepartment), [doctorList, selectedDepartment]);

  // When department changes, reset doctor selection so user explicitly chooses
  const handleDepartmentChange = (dept: string) => {
    setSelectedDepartment(dept);
    setSelectedDoctor("");
    setConsultationFee(0);
  };

  // When doctor changes, update fee
  const handleDoctorChange = (docName: string) => {
    setSelectedDoctor(docName);
    if (!docName) {
      setConsultationFee(0);
      return;
    }
    const doc = doctorList.find((d) => d.doctor_name === docName);
    if (doc) {
      setConsultationFee(appointmentType === "Review" ? doc.review_fee : doc.consultation_fee);
    }
  };

  // When appointment type changes, adjust fee if review
  const handleAppointmentTypeChange = (type: "Consultation" | "Review" | "Follow-up") => {
    setAppointmentType(type);
    const doc = doctorList.find((d) => d.doctor_name === selectedDoctor);
    if (doc) {
      setConsultationFee(type === "Review" ? doc.review_fee : doc.consultation_fee);
    }
  };

  const getTodayIso = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const handleDobChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value;
    if (val) {
      const parts = val.split("-");
      if (parts[0] && parts[0].length > 4) {
        parts[0] = parts[0].slice(0, 4);
        val = parts.join("-");
      }
      const todayIso = getTodayIso();
      if (val > todayIso) {
        val = todayIso;
        setNotice({ type: "error", message: "Date of Birth cannot be in the future." });
      }
    }
    setDob(val);
    if (val) {
      const calculated = calculateAgeFromDob(val);
      setAge(calculated);
    } else {
      setAge("");
    }
  };

  const handleDobBlur = () => {
    if (dob) {
      const todayIso = getTodayIso();
      if (dob > todayIso) {
        setDob(todayIso);
        const calc = calculateAgeFromDob(todayIso);
        setAge(calc);
        setNotice({ type: "error", message: "Date of Birth cannot be in the future." });
        return;
      }
      const parts = dob.split("-");
      if (parts[0] && parts[0].length > 4) {
        const fixed = `${parts[0].slice(0, 4)}-${parts[1] || "01"}-${parts[2] || "01"}`;
        setDob(fixed);
        const calc = calculateAgeFromDob(fixed);
        setAge(calc);
      }
    }
  };

  const resetPatientDetailsForm = () => {
    setFirstName("");
    setLastName("");
    setDob("");
    setAge("");
    setGender("");
    setMaritalStatus("");
    setPrimaryPhone("");
    setAltPhone("");
    setEmail("");
    setAddress("");
    setInsuranceProvider("");
    setPolicyNumber("");
    setNoAllergies(false);
    setAllergies("");
    setSymptoms("");
    setVitalsBp("");
    setVitalsPulse("");
    setVitalsTemp("");
    setVitalsSpo2("");
    setVitalsRespRate("");
    setVitalsHeight("");
    setVitalsWeight("");
    setVitalsPainScore("");
    setVitalsBloodSugar("");
    setEmergencyComplaint("");
    setEmergencyAttendant("");
    setEmergencyBp("");
    setEmergencyPulse("");
    setEmergencyTemp("");
    setEmergencySpo2("");
    setEmergencyRespRate("");
    setEmergencyPainScore("");
    setPatientId(null);
  };

  const handleRegisterPatient = async (): Promise<string | null> => {
    if (patientId) {
      setNotice({
        type: "info",
        message: `Patient is already registered with UHID: ${patientId}. You can now book the appointment in Step 3 below.`,
      });
      return patientId;
    }

    if (!firstName.trim()) {
      setNotice({ type: "warning", message: "Patient name is required." });
      return null;
    }
    if (dob.trim()) {
      const dobParts = dob.trim().split("-");
      const birthYear = parseInt(dobParts[0], 10);
      const currentYear = new Date().getFullYear();
      if (!birthYear || dobParts[0].length !== 4 || birthYear < 1900 || birthYear > currentYear) {
        setNotice({ type: "warning", message: "Please enter a valid 4-digit birth year between 1900 and present." });
        return null;
      }
    }
    const cleanPrimaryPhone = primaryPhone.replace(/\D/g, "");
    const primaryCodeMatch = primaryCountryCode.match(/\+\d+/)?.[0] || "+91";
    if (!cleanPrimaryPhone) {
      setNotice({ type: "warning", message: "Phone number is required." });
      return null;
    }
    const primaryRule = COUNTRY_CODE_RULES[primaryCodeMatch] || COUNTRY_CODE_RULES["+91"];
    if (cleanPrimaryPhone.length !== primaryRule.max) {
      setNotice({ type: "warning", message: `${primaryRule.label} mobile number must be exactly ${primaryRule.max} digits.` });
      return null;
    }
    if (primaryCodeMatch === "+91" && !/^[6-9]\d{9}$/.test(cleanPrimaryPhone)) {
      setNotice({ type: "warning", message: "India (+91) primary mobile number must start with 6, 7, 8, or 9." });
      return null;
    }

    const cleanAltPhone = altPhone.trim() ? altPhone.replace(/\D/g, "") : "";
    const altCodeMatch = altCountryCode.match(/\+\d+/)?.[0] || "+91";
    if (cleanAltPhone) {
      const altRule = COUNTRY_CODE_RULES[altCodeMatch] || COUNTRY_CODE_RULES["+91"];
      if (cleanAltPhone.length !== altRule.max) {
        setNotice({ type: "warning", message: `${altRule.label} alternate mobile must be exactly ${altRule.max} digits (or leave it blank).` });
        return null;
      }
      if (altCodeMatch === "+91" && !/^[6-9]\d{9}$/.test(cleanAltPhone)) {
        setNotice({ type: "warning", message: "India (+91) alternate mobile number must start with 6, 7, 8, or 9 (or leave it blank)." });
        return null;
      }
    }

    let fName = firstName.trim();
    let lName = lastName.trim();
    if (!lName && fName.includes(" ")) {
      const parts = fName.split(/\s+/);
      fName = parts[0];
      lName = parts.slice(1).join(" ");
    }
    const fullName = `${fName} ${lName}`.trim() || fName;
    const ageGender = `${age || "-"} / ${gender || "Not specified"}`;
    setRegistering(true);

    try {
      let createdPatientId = "";
      const payload: Record<string, unknown> = {
        name: fName,
        last_name: lName,
        dob: dob || undefined,
        age: age ? parseInt(String(age), 10) : undefined,
        gender: gender || undefined,
        marital_status: maritalStatus || undefined,
        phone: primaryPhone.trim(),
        phone_country_code: primaryCodeMatch,
        primary_country_code: primaryCodeMatch,
        family_mobile: altPhone.trim() || undefined,
        family_country_code: altCodeMatch,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        allergies: noAllergies ? "" : allergies.trim(),
        no_known_allergies: noAllergies,
        symptoms: (visitType === "OP" || visitType === "IP") ? (symptoms.trim() || undefined) : undefined,
      };

      if (onCreate) {
        const result = await onCreate(payload, () => {}, setDuplicateInfo, async () => {});
        if (!result) return null;
        createdPatientId = result.patient_id;
      } else {
        const res = await apiFetch<{ patient_id: string }>("/api/patients", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        createdPatientId = res.patient_id;
      }

      setPatientId(createdPatientId);

      if (prebookingRefId) {
        try {
          await apiFetch(`/api/pre-bookings/${prebookingRefId}/convert`, {
            method: "PUT",
            body: JSON.stringify({ patient_id: createdPatientId }),
          });
          sessionStorage.removeItem("hospai_prefill_prebooking");
          setPrebookingRefId(null);
        } catch (linkErr) {
          console.warn("Could not link pre-booking:", linkErr);
        }
      }

      const regSummary = {
        patientId: createdPatientId,
        name: fullName,
        age: age || "-",
        gender: gender || "-",
        phone: primaryPhone.trim(),
        address: address.trim(),
        visitType: visitType === "Emergency" ? "ER" : visitType,
        doctor: undefined,
        department: undefined,
        fee: undefined,
        paymentMode,
      };
      setLastRegisteredPatient(regSummary);

      // Record in local recents list
      const newPatientRecord: RecentReg = {
        id: `reg-${Date.now()}`,
        patientId: createdPatientId,
        name: fullName,
        ageGender,
        phone: `${primaryCountryCode.includes("+91") ? "+91" : ""} ${primaryPhone.trim()}`,
        visitType: visitType === "Emergency" ? "ER" : visitType,
        registeredAt: "Just now",
        doctorName: undefined,
        department: undefined,
      };
      const updatedRecents = [newPatientRecord, ...recentRegistrations.slice(0, 9)];
      setRecentRegistrations(updatedRecents);
      try {
        localStorage.setItem("hospai_recent_registrations", JSON.stringify(updatedRecents));
      } catch {
        // ignore
      }

      if (visitType === "OP" || visitType === "IP") {
        const hasVitals = vitalsBp || vitalsPulse || vitalsTemp || vitalsSpo2 || vitalsRespRate || vitalsHeight || vitalsWeight || vitalsPainScore || vitalsBloodSugar;
        if (hasVitals) {
          try {
            await apiFetch(`/api/patients/${createdPatientId}/vitals`, {
              method: "POST",
              body: JSON.stringify({
                bp: vitalsBp || undefined,
                pulse: vitalsPulse || undefined,
                temperature: vitalsTemp || undefined,
                spo2: vitalsSpo2 || undefined,
                respiratory_rate: vitalsRespRate || undefined,
                height: vitalsHeight || undefined,
                weight: vitalsWeight || undefined,
                pain_score: vitalsPainScore || undefined,
                blood_sugar: vitalsBloodSugar || undefined,
              }),
            });
          } catch {
            // Vitals capture failing shouldn't block registration from completing.
          }
        }
      }

      // FLOW 1: OP
      if (visitType === "OP") {
        setNotice({
          type: "success",
          message: `Patient ${fullName} registered with UHID: ${createdPatientId}! You can now select a doctor and book an appointment in Step 3 below.`,
        });
        return createdPatientId;
      }

      // FLOW 2: IP
      if (visitType === "IP") {
        setNotice({
          type: "success",
          message: `Inpatient ${fullName} registered with UHID: ${createdPatientId}! Proceed to the IP Admission module to allocate a bed and issue the admission number.`,
        });
        return createdPatientId;
      }

      // FLOW 3: Emergency
      if (visitType === "Emergency") {
        let appointmentId: number | undefined;
        try {
          const apptRes = await apiFetch<{ appointment_id?: number }>("/api/appointments", {
            method: "POST",
            body: JSON.stringify({
              patient_id: createdPatientId,
              patient_name: fullName,
              phone: primaryPhone.trim(),
              department: "Emergency / Trauma",
              doctor_name: "Emergency Duty Medical Officer",
              consultation_fee: 0,
              visit_type: "emergency",
              appointment_date: new Date().toLocaleDateString("en-CA"), // local date; toISOString() is UTC (yesterday before 5:30 AM IST)
              payment_mode: "pending",
              status: "in-consultation",
              notes: `[EMERGENCY - ${emergencyTriage}] Attendant: ${emergencyAttendant || "N/A"}. Issue: ${emergencyComplaint || "Immediate triage required"}`,
            }),
          });
          appointmentId = apptRes?.appointment_id;
        } catch {
          // ignore
        }

        let encounterId: number | undefined;
        try {
          const encRes = await apiFetch<{ encounter_id?: number }>(`/api/patients/${createdPatientId}/encounters`, {
            method: "POST",
            body: JSON.stringify({
              encounter_type: "EMERGENCY",
              appointment_id: appointmentId,
              chief_complaint: emergencyComplaint || "Immediate triage required",
              triage_priority: emergencyTriage,
              attendant_name: emergencyAttendant || undefined,
              attending_doctor: "Emergency Duty Medical Officer",
            }),
          });
          encounterId = encRes?.encounter_id;
        } catch (err) {
          reportError(setNotice, err as any, "Emergency encounter could not be recorded.");
        }

        if (encounterId && (emergencyBp || emergencyPulse || emergencyTemp || emergencySpo2 || emergencyRespRate || emergencyPainScore)) {
          try {
            await apiFetch(`/api/patients/${createdPatientId}/vitals`, {
              method: "POST",
              body: JSON.stringify({
                bp: emergencyBp || undefined,
                pulse: emergencyPulse || undefined,
                temperature: emergencyTemp || undefined,
                spo2: emergencySpo2 || undefined,
                respiratory_rate: emergencyRespRate || undefined,
                pain_score: emergencyPainScore || undefined,
                encounter_id: encounterId,
              }),
            });
          } catch {
            // Vitals capture failing shouldn't block emergency registration from completing.
          }
        }

        setNotice({
          type: "success",
          message: `EMERGENCY: Patient ${fullName} (${createdPatientId}) registered [${emergencyTriage}]. Form cleared for next patient. Opening Emergency worklist.`,
        });
        resetPatientDetailsForm();
        void fetchNextUhid();

        setTimeout(() => {
          if (onNavigate) onNavigate("emergency-worklist");
        }, 900);
        return createdPatientId;
      }

      return createdPatientId;
    } catch (error: any) {
      reportError(setNotice, error, "Failed to complete registration.");
      return null;
    } finally {
      setRegistering(false);
    }
  };

  // ==========================================
  // OP FLOW: Explicit Appointment Booking
  // After patient is registered, this books the appointment & creates Live Queue Token.
  // Stays on this page without redirecting!
  // ==========================================
  const handleBookAppointment = async () => {
    let currentId = patientId;
    let currentName = `${firstName.trim()} ${lastName.trim()}`.trim();
    let currentPhone = primaryPhone.trim();
    let currentAge = age;
    let currentGender = gender;
    let currentAddress = address;

    if (!currentId) {
      currentId = await handleRegisterPatient();
      if (!currentId) return;
      if (lastRegisteredPatient) {
        currentName = lastRegisteredPatient.name;
        currentPhone = lastRegisteredPatient.phone;
        currentAge = lastRegisteredPatient.age;
        currentGender = lastRegisteredPatient.gender;
        currentAddress = lastRegisteredPatient.address;
      }
    } else {
      if (lastRegisteredPatient) {
        currentName = lastRegisteredPatient.name;
        currentPhone = lastRegisteredPatient.phone;
        currentAge = lastRegisteredPatient.age;
        currentGender = lastRegisteredPatient.gender;
        currentAddress = lastRegisteredPatient.address;
      } else if (existingPatient) {
        currentName = `${existingPatient.name || ""} ${existingPatient.last_name || ""}`.trim() || currentName;
        currentPhone = existingPatient.phone || currentPhone;
        currentAge = existingPatient.age ? String(existingPatient.age) : currentAge;
        currentGender = existingPatient.gender || currentGender;
        currentAddress = existingPatient.address || currentAddress;
      }
    }

    if (!selectedDepartment) {
      setNotice({
        type: "warning",
        message: "Please select a department.",
      });
      return;
    }

    if (!selectedDoctor) {
      setNotice({
        type: "warning",
        message: `Please select an available consulting doctor for ${selectedDepartment}.`,
      });
      return;
    }

    setBookingAppointment(true);

    try {
      const apptPayload = {
        patient_id: currentId,
        patient_name: currentName,
        phone: currentPhone,
        department: selectedDepartment,
        doctor_name: selectedDoctor,
        consultation_fee: Number(consultationFee) || 500,
        visit_type: visitType === "IP" ? "ip" : "op",
        appointment_date: new Date().toLocaleDateString("en-CA"), // local date; toISOString() is UTC (yesterday before 5:30 AM IST)
        payment_mode: paymentMode.toLowerCase(),
        status: "waiting",
        notes: visitType === "IP"
          ? "Pre-admission consultation booked at registration desk."
          : `${appointmentType} booked at registration desk.`,
      };

      const apptRes = await apiFetch<{ appointment_id?: number; token_no?: number | string }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify(apptPayload),
      });

      const tokenNo = apptRes?.token_no || "Live";

      setBookedAppointment({
        tokenNo,
        appointmentId: apptRes?.appointment_id,
        doctor: selectedDoctor,
        department: selectedDepartment,
        fee: consultationFee,
        paymentMode,
        date: new Date().toLocaleDateString("en-GB"),
      });

      setLastRegisteredPatient((prev) => ({
        ...(prev || {
          patientId: currentId!,
          name: currentName,
          phone: currentPhone,
          age: currentAge,
          gender: currentGender,
          address: currentAddress,
          visitType,
        }),
        tokenNo,
        doctor: selectedDoctor,
        department: selectedDepartment,
        fee: consultationFee,
        paymentMode,
      }));

      setNotice({
        type: "success",
        message: visitType === "IP"
          ? `Appointment booked for ${currentName} with ${selectedDoctor}. Live Token #${tokenNo} generated. Form cleared for next patient.`
          : `Appointment booked for ${currentName} with ${selectedDoctor}! Live Queue Token #${tokenNo} created. Patient added to Queue Management. Form cleared for next patient.`,
      });

      // Update recent registrations with the booked doctor and department
      setRecentRegistrations((prev) =>
        prev.map((r) =>
          r.patientId === currentId
            ? { ...r, doctorName: selectedDoctor, department: selectedDepartment }
            : r
        )
      );

      // Clear the patient details from registration so that next patient register can be done easily
      resetPatientDetailsForm();
      setPatientId("");
      setExistingPatient(null);
      setSelectedDoctor("");
      setConsultationFee(0);
      void fetchNextUhid();
    } catch (err: any) {
      reportError(setNotice, err, "Failed to book appointment.");
    } finally {
      setBookingAppointment(false);
    }
  };

  const handleClear = () => {
    setExistingPatient(null);
    resetPatientDetailsForm();
    setPatientId("");
    setVisitType("OP");
    setSelectedDepartment("");
    setSelectedDoctor("");
    setConsultationFee(0);
    setAppointmentType("Consultation");
    setPaymentMode("Cash");
    setBookedAppointment(null);
    setLastRegisteredPatient(null);
    setDuplicateInfo(null);
    setExistingSearchQuery("");
    setExistingSearchResults([]);
    setHasSearchedExisting(false);
    setNotice({ type: "info", message: "Registration form cleared." });
    void fetchNextUhid();
  };

  const handlePrintSlip = () => {
    const target = lastRegisteredPatient || (patientId ? {
      patientId,
      name: `${firstName.trim()} ${lastName.trim()}`.trim(),
      age,
      gender,
      phone: primaryPhone,
      address,
      visitType,
      doctor: selectedDoctor,
      department: selectedDepartment,
      fee: consultationFee,
      paymentMode,
    } : null);

    if (!target?.patientId) {
      setNotice({ type: "warning", message: "Please register a patient first before printing the slip." });
      return;
    }
    const tokenPart = bookedAppointment?.tokenNo || target.tokenNo;
    const slipHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 20px auto; padding: 24px; border: 2px solid #00828a; border-radius: 8px;">
        <div style="text-align: center; border-bottom: 2px solid #00828a; padding-bottom: 12px; margin-bottom: 16px;">
          <h2 style="margin: 0; color: #16324a;">HospAI</h2>
          <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Patient Registration & Token Slip</div>
        </div>
        <div style="font-size: 13px; line-height: 1.8; color: #1e293b; margin-bottom: 16px;">
          <div style="background: #f0fdfa; border: 1px solid #ccfbf1; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <strong>UHID:</strong> <span style="font-size: 16px; font-weight: 800; color: #00828a; font-family: monospace;">${target.patientId}</span>
          </div>
          ${tokenPart ? `
          <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <strong>Live Queue Token:</strong> <span style="font-size: 18px; font-weight: 900; color: #2563eb;">#${tokenPart}</span>
          </div>
          ` : ""}
          <div><strong>Date:</strong> ${new Date().toLocaleDateString("en-GB")}</div>
          <div><strong>Name:</strong> ${target.name}</div>
          <div><strong>Age / Gender:</strong> ${target.age || "-"} / ${target.gender || "-"}</div>
          <div><strong>Mobile:</strong> ${target.phone || "-"}</div>
          <div><strong>Address:</strong> ${target.address || "-"}</div>
          <div><strong>Visit Type:</strong> <span style="color: #00828a; font-weight: 700;">${target.visitType}</span></div>
          ${target.visitType === "OP" || target.visitType === "IP" ? `
            <div><strong>Department:</strong> ${target.department || selectedDepartment}</div>
            <div><strong>Consulting Doctor:</strong> ${target.doctor || selectedDoctor}</div>
            <div><strong>Consultation Fee:</strong> ₹ ${target.fee ?? consultationFee} (${target.paymentMode || paymentMode})</div>
          ` : ""}
        </div>
        <div style="text-align: center; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px;">
          Please present this slip at the Consultation Desk or Admission Counter.
        </div>
      </div>
    `;
    printViaIframe(slipHtml);
  };

  const todayFormatted = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date()).replace(/\//g, "-");

  return (
    <div className="patient-registration-page" style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* Top Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", color: "#64748b", fontWeight: 500, marginBottom: "8px" }}>
        <span style={{ color: "#3b82f6", cursor: "pointer" }} onClick={() => window.history.back()}>
          HospAI
        </span>
        <span style={{ color: "#94a3b8" }}>/</span>
        <span style={{ color: "#0f172a", fontWeight: 600 }}>Patient Registration</span>
      </div>

      {/* Main Page Title Row with Date Pill (No doctor badge) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "22px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "27px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.02em" }}>
            Patient Registration
          </h1>
          <p style={{ fontSize: "13.5px", color: "#64748b", margin: 0 }}>
            Register new patients and choose OP or IP flow.
          </p>
        </div>

        {/* Date chip exactly matching screenshot */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "8px 14px",
            fontSize: "13px",
            fontWeight: 600,
            color: "#1e293b",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <span style={{ fontSize: "15px" }}>📅</span>
          <span>{todayFormatted}</span>
          <span style={{ fontSize: "10px", color: "#64748b", marginLeft: "2px" }}>▾</span>
        </div>
      </div>

      {duplicateInfo && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "10px 16px", marginBottom: "18px", fontSize: "12.5px", color: "#92400e" }}>
          <span>⚠</span>
          <span>
            A matching patient already exists: <strong>{duplicateInfo.patient_id}</strong>
            {duplicateInfo.name ? ` (${duplicateInfo.name}${duplicateInfo.last_name ? ` ${duplicateInfo.last_name}` : ""})` : ""}.
            Please review existing records to avoid duplicates.
          </span>
        </div>
      )}

      {/* ======================================================== */}
      {/* 0. EXISTING PATIENT LOOKUP (AUTO-FILL & PREVENT DUPLICATES) */}
      {/* ======================================================== */}
      <div
        style={{
          background: existingPatient ? "#f0fdfa" : "#ffffff",
          border: existingPatient ? "1.5px solid #00828a" : "1px solid #cbd5e1",
          borderRadius: "12px",
          padding: "16px 20px",
          marginBottom: "18px",
          boxShadow: existingPatient ? "0 4px 12px rgba(0, 130, 138, 0.08)" : "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        {existingPatient ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "10px",
                  background: "#00828a",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: "1.2rem",
                }}
              >
                ✓
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>
                    Existing Registered Patient: {firstName} {lastName}
                  </span>
                  <span style={{ background: "#ccfbf1", color: "#0f766e", padding: "2px 8px", borderRadius: "10px", fontSize: "11.5px", fontWeight: 700 }}>
                    UHID: {patientId}
                  </span>
                  <span style={{ background: "#e0f2fe", color: "#0369a1", padding: "2px 8px", borderRadius: "10px", fontSize: "11.5px", fontWeight: 600 }}>
                    Mobile: +91 {primaryPhone}
                  </span>
                  <span style={{ background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "10px", fontSize: "11.5px", fontWeight: 600 }}>
                    {age ? `${age} yrs` : ""} · {gender}
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "#059669", marginTop: "3px", fontWeight: 600 }}>
                  ✓ Demographics auto-filled. Select visit type and doctor below to book appointment or admit without duplicate registration.
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {visitType === "IP" && onNavigate && (
                <button
                  type="button"
                  style={{
                    padding: "7px 14px",
                    fontSize: "12.5px",
                    fontWeight: 700,
                    borderRadius: "6px",
                    background: "#2563eb",
                    color: "#ffffff",
                    border: "none",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(37,99,235,0.2)",
                  }}
                  onClick={() => {
                    localStorage.setItem("selected_admission_patient", patientId!);
                    onNavigate("ip-admission");
                  }}
                >
                  Direct IP Admission & Bed Allotment ➔
                </button>
              )}
              <button
                type="button"
                style={{
                  padding: "7px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  background: "#fff1f2",
                  color: "#be123c",
                  border: "1px solid #fecdd3",
                  cursor: "pointer",
                }}
                onClick={handleClearExistingPatient}
              >
                ✕ Clear / Register New Patient
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "8px" }}>
              <div>
                <span style={{ fontSize: "13.5px", fontWeight: 800, color: "#0f172a" }}>
                  🔍 Returning Patient? Search & Quick Auto-Fill
                </span>
                <span style={{ fontSize: "12px", color: "#64748b", marginLeft: "8px" }}>
                  (If patient visited earlier for OP or IP, search here to prevent duplicate registration)
                </span>
              </div>
              <span style={{ fontSize: "11.5px", color: "#00828a", fontWeight: 600, background: "#f0fdfa", padding: "2px 8px", borderRadius: "6px" }}>
                Auto-fills demographics & preserves UHID
              </span>
            </div>

            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <input
                  type="text"
                  value={existingSearchQuery}
                  onChange={(e) => {
                    setExistingSearchQuery(e.target.value);
                    if (!e.target.value.trim()) {
                      setExistingSearchResults([]);
                      setHasSearchedExisting(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSearchExistingPatients();
                    }
                  }}
                  placeholder="Enter Patient Name, UHID (e.g. PAT-2026...), or Mobile Number..."
                  className="pharmacy-rx-search-input"
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    fontSize: "13px",
                    boxSizing: "border-box",
                  }}
                />
                {existingSearchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setExistingSearchQuery("");
                      setExistingSearchResults([]);
                      setHasSearchedExisting(false);
                    }}
                    style={{
                      position: "absolute",
                      right: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "#e2e8f0",
                      border: "none",
                      borderRadius: "50%",
                      width: "20px",
                      height: "20px",
                      fontSize: "11px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleSearchExistingPatients()}
                disabled={isSearchingExisting || !existingSearchQuery.trim()}
                style={{
                  height: "40px",
                  padding: "0 20px",
                  borderRadius: "8px",
                  background: "#00828a",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "13px",
                  border: "none",
                  cursor: isSearchingExisting || !existingSearchQuery.trim() ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  whiteSpace: "nowrap",
                }}
              >
                {isSearchingExisting ? "Searching…" : "Search Patient"}
              </button>
            </div>

            {/* Results Dropdown / List */}
            {hasSearchedExisting && (
              <div style={{ marginTop: "10px" }}>
                {existingSearchResults.length === 0 ? (
                  <div style={{ padding: "10px 14px", background: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1", fontSize: "12.5px", color: "#64748b" }}>
                    No existing patient found matching &ldquo;{existingSearchQuery}&rdquo;. You can fill out the form below to register as a new patient.
                  </div>
                ) : (
                  <div style={{ background: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1", maxHeight: "240px", overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                    <div style={{ padding: "6px 12px", background: "#f1f5f9", fontSize: "11px", fontWeight: 700, color: "#475569", textTransform: "uppercase" }}>
                      Select patient to auto-fill details ({existingSearchResults.length} found):
                    </div>
                    {existingSearchResults.map((p) => {
                      const pName = [p.name, p.middle_name, p.last_name].filter(Boolean).join(" ");
                      return (
                        <div
                          key={p.patient_id}
                          onClick={() => handleSelectExistingPatient(p)}
                          style={{
                            padding: "9px 14px",
                            borderBottom: "1px solid #f1f5f9",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            cursor: "pointer",
                            transition: "background 0.15s ease",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdfa")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
                        >
                          <div>
                            <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                              {pName}
                            </div>
                            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                              UHID: <span style={{ fontWeight: 700, color: "#00828a" }}>{p.patient_id}</span> · Mobile: {p.phone || "No phone"} · {p.age ? `${p.age}y` : ""} {p.gender || ""} · {p.address || "No address"}
                            </div>
                          </div>
                          <button
                            type="button"
                            style={{
                              padding: "4px 12px",
                              fontSize: "12px",
                              fontWeight: 700,
                              background: "#00828a",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                            }}
                          >
                            Select & Auto-fill →
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* TOP UHID BANNER: Shows UHID prominently while registering */}
      {/* ======================================================== */}
      <div
        style={{
          background: patientId
            ? "linear-gradient(135deg, #00828a 0%, #00565c 100%)"
            : "linear-gradient(135deg, #f0fdfa 0%, #e6f7f6 100%)",
          border: patientId ? "1px solid #00565c" : "2px dashed #00828a",
          borderRadius: "12px",
          padding: "16px 24px",
          marginBottom: "22px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
          boxShadow: patientId
            ? "0 4px 14px rgba(0, 130, 138, 0.22)"
            : "0 2px 6px rgba(0, 130, 138, 0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "10px",
              background: patientId ? "rgba(255,255,255,0.2)" : "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "24px",
              boxShadow: patientId ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
              color: patientId ? "#ffffff" : "#00828a",
            }}
          >
            🪪
          </div>
          <div>
            <div
              style={{
                fontSize: "11.5px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontWeight: 800,
                color: patientId ? "#a7f3d0" : "#00828a",
                marginBottom: "2px",
              }}
            >
              {patientId ? "Registered Patient UHID" : "Patient Unique Hospital ID (UHID)"}
            </div>
            <div
              style={{
                fontSize: "24px",
                fontWeight: 900,
                letterSpacing: "0.04em",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: patientId ? "#ffffff" : "#0f172a",
              }}
            >
              {patientId || nextUhid || "Generating UHID…"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {patientId ? (
            <div style={{ textAlign: "right" }}>
              <span
                style={{
                  background: "#10b981",
                  color: "#ffffff",
                  padding: "5px 14px",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  fontWeight: 800,
                  letterSpacing: "0.03em",
                }}
              >
                ✓ REGISTERED PATIENT
              </span>
              <div style={{ fontSize: "12.5px", color: "#e2e8f0", marginTop: "4px", fontWeight: 600 }}>
                {firstName} {lastName} {primaryPhone ? `• +91 ${primaryPhone}` : ""}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "right" }}>
              <span
                style={{
                  background: "#ccfbf1",
                  color: "#0f766e",
                  padding: "5px 14px",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  fontWeight: 700,
                }}
              >
                Auto-assigned on Register
              </span>
              <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "4px" }}>
                Next prospective UHID for this registration
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ======================================================== */}
      {/* SECTION 1: Select Visit Type (Exact 3 cards horizontal) */}
      {/* ======================================================== */}
      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginBottom: "12px" }}>
          1. Select Visit Type
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
          {/* Outpatient (OP) */}
          <div
            onClick={() => setVisitType("OP")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderRadius: "10px",
              border: visitType === "OP" ? "2px solid #00828a" : "1px solid #e2e8f0",
              background: visitType === "OP" ? "#f0fdf4" : "#ffffff",
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: visitType === "OP" ? "0 2px 6px rgba(0,130,138,0.08)" : "0 1px 2px rgba(0,0,0,0.03)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "50%",
                  background: "#e6f7f6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#00828a",
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
                  <path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4" />
                  <circle cx="20" cy="10" r="2" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: "14.5px", fontWeight: 700, color: "#0f172a" }}>Outpatient (OP)</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  Consultation, checkup, diagnostics (same day)
                </div>
              </div>
            </div>
            <div
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                border: visitType === "OP" ? "6px solid #00828a" : "2px solid #cbd5e1",
                background: "#ffffff",
                flexShrink: 0,
              }}
            />
          </div>

          {/* Inpatient (IP) */}
          <div
            onClick={() => setVisitType("IP")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderRadius: "10px",
              border: visitType === "IP" ? "2px solid #2563eb" : "1px solid #e2e8f0",
              background: visitType === "IP" ? "#eff6ff" : "#ffffff",
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: visitType === "IP" ? "0 2px 6px rgba(37,99,235,0.08)" : "0 1px 2px rgba(0,0,0,0.03)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "50%",
                  background: "#eff6ff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#2563eb",
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: "14.5px", fontWeight: 700, color: "#0f172a" }}>Inpatient (IP)</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  Register patient. Bed allocation &amp; admission number in IP Admission module
                </div>
              </div>
            </div>
            <div
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                border: visitType === "IP" ? "6px solid #2563eb" : "2px solid #cbd5e1",
                background: "#ffffff",
                flexShrink: 0,
              }}
            />
          </div>

          {/* Emergency */}
          <div
            onClick={() => setVisitType("Emergency")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderRadius: "10px",
              border: visitType === "Emergency" ? "2px solid #ef4444" : "1px solid #e2e8f0",
              background: visitType === "Emergency" ? "#fef2f2" : "#ffffff",
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: visitType === "Emergency" ? "0 2px 6px rgba(239,68,68,0.08)" : "0 1px 2px rgba(0,0,0,0.03)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "50%",
                  background: "#fee2e2",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ef4444",
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: "14.5px", fontWeight: 700, color: "#dc2626" }}>Emergency</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  Emergency care and immediate treatment
                </div>
              </div>
            </div>
            <div
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                border: visitType === "Emergency" ? "6px solid #ef4444" : "2px solid #cbd5e1",
                background: "#ffffff",
                flexShrink: 0,
              }}
            />
          </div>
        </div>
      </div>

      {/* ======================================================== */}
      {/* SECTION 2: 2. Patient Details (Exact Card) */}
      {/* ======================================================== */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "24px 28px",
          marginBottom: "24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "22px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ color: "#2563eb", display: "flex", alignItems: "center" }}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
              </svg>
            </span>
            <div>
              <h2 style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", margin: 0 }}>2. Patient Details</h2>
              <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
                Enter patient information to create a new patient record.
              </p>
            </div>
          </div>
          <div style={{ fontSize: "11.5px", color: "#64748b" }}>
            Fields marked with <span style={{ color: "#ef4444", fontWeight: 700 }}>*</span> are mandatory
          </div>
        </div>

        {prebookingRefId && (
          <div
            style={{
              marginBottom: "20px",
              padding: "12px 18px",
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: "8px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "13px",
              color: "#166534",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>📋</span>
              <span>
                <strong>Pre-booking Loaded (#{prebookingRefId}):</strong> Details have been auto-filled. Complete registration to generate the official UHID.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPrebookingRefId(null);
                sessionStorage.removeItem("hospai_prefill_prebooking");
                resetPatientDetailsForm();
                setNotice({ type: "info", message: "Pre-booking prefill cleared." });
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "#166534",
                textDecoration: "underline",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              Clear prefill
            </button>
          </div>
        )}

        {lastRegisteredPatient && (
          <div
            style={{
              marginBottom: "20px",
              padding: "14px 18px",
              background: "#ecfdf5",
              border: "1px solid #a7f3d0",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: "#10b981",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: "bold",
                  flexShrink: 0,
                }}
              >
                ✓
              </div>
              <div>
                <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#065f46" }}>
                  Patient Registered Successfully! UHID: <span style={{ fontFamily: "monospace", fontSize: "14px" }}>{lastRegisteredPatient.patientId || (lastRegisteredPatient as any).uhid}</span>
                </div>
                <div style={{ fontSize: "12px", color: "#047857", marginTop: "2px" }}>
                  {lastRegisteredPatient.name} • {lastRegisteredPatient.doctor ? `Consultation booked with ${lastRegisteredPatient.doctor} (Token #${lastRegisteredPatient.tokenNo || "-"}). Desk is cleared for next patient.` : "Patient registered. Select a doctor below to book consultation, or start next registration."}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={handlePrintSlip}
                style={{
                  padding: "6px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  color: "#065f46",
                  background: "#ffffff",
                  border: "1px solid #6ee7b7",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                🖨️ Print Slip
              </button>
              <button
                type="button"
                onClick={() => setLastRegisteredPatient(null)}
                style={{
                  padding: "6px 10px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#6b7280",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Row 1: Patient Name *, Last Name (optional), Date of Birth (optional) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Patient Name <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value.replace(/[^a-zA-Z\s]/g, ""))}
              placeholder="Enter patient name"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Last Name (optional)
            </label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value.replace(/[^a-zA-Z\s]/g, ""))}
              placeholder="Enter last name (optional)"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Date of Birth (optional)
            </label>
            <input
              type="date"
              value={dob}
              onChange={handleDobChange}
              onBlur={handleDobBlur}
              max={new Date().toISOString().split("T")[0]}
              min="1900-01-01"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>

        {/* Row 2: Age (optional), Gender (optional) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Age {dob ? "(Auto-calculated from DOB)" : "(optional)"}
            </label>
            <input
              type="text"
              value={age}
              readOnly={!!dob}
              onChange={(e) => {
                if (!dob) {
                  setAge(e.target.value.replace(/\D/g, "").slice(0, 3));
                }
              }}
              tabIndex={dob ? -1 : 0}
              placeholder={dob ? "Auto-calculated from DOB" : "Enter age or select DOB"}
              className="pharmacy-rx-search-input"
              style={{
                height: "42px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                background: dob ? "#f1f5f9" : "#ffffff",
                color: "#1e293b",
                fontWeight: 600,
                width: "100%",
                boxSizing: "border-box",
                cursor: dob ? "not-allowed" : "text",
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Gender (optional)
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            >
              <option value="">Select gender (optional)</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        {/* Row 3: Phone Number *, Alternate Mobile (optional) with country prefix */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Phone Number <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <select
                value={primaryCountryCode}
                onChange={(e) => {
                  setPrimaryCountryCode(e.target.value);
                  // A number that is too long for the newly chosen country is trimmed to its length.
                  setPrimaryPhone((p) => p.slice(0, primaryDigitLimit(e.target.value)));
                }}
                style={{ width: "135px", height: "42px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#f8fafc", padding: "0 8px", fontSize: "12.5px", fontWeight: 500, color: "#334155" }}
              >
                {COUNTRY_OPTIONS.map((label) => <option key={label} value={label}>{label}</option>)}
              </select>
              <input
                type="tel"
                value={primaryPhone}
                onChange={(e) => setPrimaryPhone(e.target.value.replace(/\D/g, "").slice(0, primaryDigitLimit(primaryCountryCode)))}
                placeholder={`${primaryDigitLimit(primaryCountryCode)}-digit mobile`}
                maxLength={primaryDigitLimit(primaryCountryCode)}
                inputMode="numeric"
                pattern="[0-9]*"
                className="pharmacy-rx-search-input"
                style={{ flex: 1, height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", boxSizing: "border-box" }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Alternate Mobile (optional)
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <select
                value={altCountryCode}
                onChange={(e) => {
                  setAltCountryCode(e.target.value);
                  setAltPhone((p) => p.slice(0, primaryDigitLimit(e.target.value)));
                }}
                style={{ width: "135px", height: "42px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#f8fafc", padding: "0 8px", fontSize: "12.5px", fontWeight: 500, color: "#334155" }}
              >
                {COUNTRY_OPTIONS.map((label) => <option key={label} value={label}>{label}</option>)}
              </select>
              <input
                type="tel"
                value={altPhone}
                onChange={(e) => setAltPhone(e.target.value.replace(/\D/g, "").slice(0, primaryDigitLimit(altCountryCode)))}
                placeholder="Alternate mobile"
                maxLength={primaryDigitLimit(altCountryCode)}
                inputMode="numeric"
                pattern="[0-9]*"
                className="pharmacy-rx-search-input"
                style={{ flex: 1, height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", boxSizing: "border-box" }}
              />
            </div>
          </div>
        </div>

        {/* Row 4: Email (optional), Address / Area (optional) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginBottom: "18px" }}>
          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Email (optional)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter email address"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Address / Area (optional)
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter address (optional)"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>

        {/* Row 5: Insurance Provider, Policy Number */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginBottom: "22px" }}>
          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Insurance Provider (optional)
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <select
                value={insuranceProvider}
                onChange={(e) => setInsuranceProvider(e.target.value)}
                className="pharmacy-rx-search-input"
                style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
              >
                <option value="">Select insurance provider</option>
                {insuranceProviders.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowAddProviderModal(true)}
                title="Add a new insurance provider"
                style={{
                  height: "42px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: "1.5px solid #00828a",
                  background: "#f0fdfa",
                  color: "#00828a",
                  fontWeight: 700,
                  fontSize: "13px",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                + Add New
              </button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
              Insurance Policy Number
            </label>
            <input
              type="text"
              value={policyNumber}
              onChange={(e) => setPolicyNumber(e.target.value)}
              placeholder="Enter policy number"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>

      </div>

      {/* ======================================================== */}
      {/* SECTION 3: Visit Specific Section (OP / IP / Emergency) */}
      {/* ======================================================== */}

      {(visitType === "OP" || visitType === "IP") && (
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px 28px", marginBottom: "24px" }}>
          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
            Symptoms / Chief Complaint
          </label>
          <textarea
            value={symptoms}
            onChange={(e) => setSymptoms(e.target.value)}
            placeholder="Describe the patient's presenting symptoms / reason for visit"
            rows={3}
            className="pharmacy-rx-search-input"
            style={{ padding: "10px 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", marginBottom: "18px" }}
          />

          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "8px" }}>
            Vitals (optional)
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
            {[
              { label: "BP", value: vitalsBp, set: (v: string) => setVitalsBp(v.replace(/[^0-9/]/g, "").slice(0, 7)), placeholder: "120/80" },
              { label: "Pulse (bpm)", value: vitalsPulse, set: (v: string) => setVitalsPulse(v.replace(/\D/g, "").slice(0, 3)), placeholder: "72" },
              { label: "Temp (°F)", value: vitalsTemp, set: (v: string) => setVitalsTemp(v.replace(/[^0-9.]/g, "").slice(0, 5)), placeholder: "98.6" },
              { label: "SpO2 (%)", value: vitalsSpo2, set: (v: string) => setVitalsSpo2(v.replace(/\D/g, "").slice(0, 3)), placeholder: "98" },
              { label: "Resp. Rate", value: vitalsRespRate, set: (v: string) => setVitalsRespRate(v.replace(/\D/g, "").slice(0, 3)), placeholder: "/min" },
              { label: "Height (cm)", value: vitalsHeight, set: (v: string) => setVitalsHeight(v.replace(/[^0-9.]/g, "").slice(0, 5)), placeholder: "170" },
              { label: "Weight (kg)", value: vitalsWeight, set: (v: string) => setVitalsWeight(v.replace(/[^0-9.]/g, "").slice(0, 5)), placeholder: "65" },
              { label: "Pain (0-10)", value: vitalsPainScore, set: (v: string) => setVitalsPainScore(clampPainScore(v)), placeholder: "0-10" },
              { label: "Blood Glucose", value: vitalsBloodSugar, set: (v: string) => setVitalsBloodSugar(v.replace(/\D/g, "").slice(0, 4)), placeholder: "mg/dL" },
            ].map((f) => (
              <div key={f.label}>
                <label style={{ fontSize: "11px", color: "#64748b", display: "block", marginBottom: "4px" }}>{f.label}</label>
                <input
                  type="text"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  placeholder={f.placeholder}
                  className="pharmacy-rx-search-input"
                  style={{ height: "38px", padding: "0 10px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box", fontSize: "13px" }}
                />
              </div>
            ))}
          </div>

          {/* Bottom Actions -- placed after Symptoms/Vitals so the submit
              buttons come after the clinical fields, not before them. */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px", borderTop: "1px solid #f1f5f9", paddingTop: "18px", marginTop: "18px" }}>
            {patientId && (
              <span style={{ fontSize: "13px", color: "#0f766e", fontWeight: 700, marginRight: "auto" }}>
                ✓ Patient registered with UHID: <strong>{patientId}</strong>. Proceed below to Step 3 to book appointment.
              </span>
            )}
            <button
              type="button"
              className="pharmacy-btn-teal"
              style={{
                padding: "10px 24px",
                fontSize: "14px",
                fontWeight: 700,
                borderRadius: "8px",
                background: patientId ? "#10b981" : "#00828a",
                color: "#ffffff",
                border: "none",
                cursor: registering ? "not-allowed" : "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
              disabled={registering}
              onClick={() => void handleRegisterPatient()}
            >
              {registering ? "Registering…" : patientId ? `✓ Patient Registered (${patientId})` : "Register Patient"}
            </button>
            {patientId && (
              <button
                type="button"
                style={{
                  padding: "10px 18px",
                  fontSize: "13.5px",
                  fontWeight: 600,
                  borderRadius: "8px",
                  background: "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => {
                  resetPatientDetailsForm();
                  setPatientId("");
                  setSelectedDoctor("");
                  setNotice({ type: "info", message: "Form cleared for next patient registration." });
                  void fetchNextUhid();
                }}
              >
                + Register Next Patient
              </button>
            )}
            <button
              type="button"
              style={{
                padding: "10px 20px",
                fontSize: "13.5px",
                fontWeight: 600,
                borderRadius: "8px",
                background: "#e2e8f0",
                color: "#334155",
                border: "none",
                cursor: "pointer",
              }}
              onClick={handleClear}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* FLOW A: Outpatient (OP) -> Doctor Consultation & Queue Appointment */}
      {visitType === "OP" && (
        <div
          id="section-3-consultation"
          style={{
            background: "#ffffff",
            border: "2px solid #00828a",
            borderRadius: "12px",
            padding: "24px 28px",
            marginBottom: "24px",
            boxShadow: "0 2px 8px rgba(0,130,138,0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ width: "36px", height: "36px", borderRadius: "8px", background: "#f0fdfa", color: "#00828a", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
                  <path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4" />
                  <circle cx="20" cy="10" r="2" />
                </svg>
              </span>
              <div>
                <h3 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
                  3. OP Appointment &amp; Doctor Consultation
                </h3>
                <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
                  Select doctor, department, and consultation fee to book appointment and add patient to Queue Management.
                </p>
              </div>
            </div>

            <span style={{ background: "#ccfbf1", color: "#0f766e", fontSize: "12px", fontWeight: 800, padding: "4px 12px", borderRadius: "9999px" }}>
              Queue Management on Booking
            </span>
          </div>

          {bookedAppointment ? (
            /* Confirmed Appointment Card - Stays on page per user request */
            <div
              style={{
                background: "#f0fdf4",
                border: "2px solid #16a34a",
                borderRadius: "12px",
                padding: "24px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "56px",
                  height: "56px",
                  borderRadius: "50%",
                  background: "#dcfce7",
                  color: "#16a34a",
                  fontSize: "28px",
                  marginBottom: "12px",
                }}
              >
                ✓
              </div>
              <h3 style={{ fontSize: "20px", fontWeight: 800, color: "#14532d", margin: "0 0 6px" }}>
                Appointment Confirmed &amp; Patient Queued!
              </h3>
              <div style={{ fontSize: "14px", color: "#166534", marginBottom: "16px" }}>
                <>Patient has been added to Queue Management for <strong>{bookedAppointment.doctor}</strong> ({bookedAppointment.department}).</>
              </div>

              {/* Token Badge */}
              <div
                style={{
                  display: "inline-block",
                  background: "#ffffff",
                  border: "2px dashed #16a34a",
                  borderRadius: "10px",
                  padding: "14px 32px",
                  marginBottom: "18px",
                }}
              >
                <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.06em" }}>
                  Live Queue Token Number
                </div>
                <div style={{ fontSize: "34px", fontWeight: 900, color: "#15803d", letterSpacing: "1px" }}>
                  #{bookedAppointment.tokenNo}
                </div>
                <div style={{ fontSize: "12.5px", color: "#475569", fontWeight: 600, marginTop: "2px" }}>
                  UHID: {patientId} • Fee: ₹{bookedAppointment.fee} ({bookedAppointment.paymentMode})
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", justifyContent: "center", gap: "12px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="pharmacy-btn-teal"
                  style={{
                    padding: "10px 22px",
                    fontSize: "14px",
                    fontWeight: 700,
                    borderRadius: "8px",
                    background: "#00828a",
                    color: "#ffffff",
                    border: "none",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                  onClick={handlePrintSlip}
                >
                  🖨 Print Token & Slip
                </button>

                <button
                  type="button"
                  style={{
                    padding: "10px 20px",
                    fontSize: "14px",
                    fontWeight: 700,
                    borderRadius: "8px",
                    background: "#2563eb",
                    color: "#ffffff",
                    border: "none",
                    cursor: "pointer",
                  }}
                  onClick={handleClear}
                >
                  + Register Next Patient
                </button>

                {onNavigate && (
                  <button
                    type="button"
                    style={{
                      padding: "10px 18px",
                      fontSize: "13.5px",
                      fontWeight: 600,
                      borderRadius: "8px",
                      background: "#ffffff",
                      color: "#334155",
                      border: "1px solid #cbd5e1",
                      cursor: "pointer",
                    }}
                    onClick={() => onNavigate("op-queue-management")}
                  >
                    View in Queue Management ➔
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Booking Form Fields */
            <>
              {/* Row 1: Department *, Consulting Doctor *, Consultation Fee (₹) * */}
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1.3fr 0.9fr", gap: "18px", marginBottom: "18px" }}>
                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Department <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <select
                    value={selectedDepartment}
                    onChange={(e) => handleDepartmentChange(e.target.value)}
                    style={{
                      height: "42px",
                      padding: "0 12px",
                      borderRadius: "8px",
                      border: "1px solid #cbd5e1",
                      width: "100%",
                      boxSizing: "border-box",
                      fontWeight: 600,
                      color: !selectedDepartment ? "#94a3b8" : "#0f172a",
                      background: "#ffffff",
                    }}
                  >
                    <option value="">
                      {directoryLoading ? "Loading departments..." : departments.length === 0 ? "No departments -- add them in Doctor Scheduling" : "Select department"}
                    </option>
                    {departments.map((dept) => (
                      <option key={dept} value={dept}>
                        {dept}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Consulting Doctor <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <select
                    value={selectedDoctor}
                    onChange={(e) => handleDoctorChange(e.target.value)}
                    disabled={!selectedDepartment}
                    style={{
                      height: "42px",
                      padding: "0 12px",
                      borderRadius: "8px",
                      border: selectedDepartment && filteredDoctors.length === 0 ? "1px solid #f87171" : "1px solid #cbd5e1",
                      width: "100%",
                      boxSizing: "border-box",
                      fontWeight: 600,
                      color: !selectedDoctor ? "#94a3b8" : "#0f172a",
                      background: "#ffffff",
                    }}
                  >
                    {!selectedDepartment ? (
                      <option value="">Select doctor</option>
                    ) : filteredDoctors.length === 0 ? (
                      <option value="">No doctors available in {selectedDepartment}</option>
                    ) : (
                      <>
                        <option value="">Select doctor</option>
                        {filteredDoctors.map((doc) => (
                          <option key={doc.doctor_name} value={doc.doctor_name}>
                            {doc.doctor_name} ({doc.department}) — ₹{doc.consultation_fee}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Consultation Fee (₹) <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
                    <span
                      style={{
                        height: "42px",
                        padding: "0 14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "#f1f5f9",
                        border: "1px solid #cbd5e1",
                        borderRight: "none",
                        borderRadius: "8px 0 0 8px",
                        fontSize: "14px",
                        fontWeight: 800,
                        color: "#475569",
                        userSelect: "none",
                      }}
                    >
                      ₹
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={consultationFee}
                      onChange={(e) => setConsultationFee(e.target.value)}
                      placeholder="0"
                      style={{
                        height: "42px",
                        padding: "0 12px",
                        borderRadius: "0 8px 8px 0",
                        border: "1px solid #cbd5e1",
                        fontWeight: 700,
                        fontSize: "14px",
                        color: "#00828a",
                        width: "100%",
                        boxSizing: "border-box",
                        outline: "none",
                        background: "#ffffff",
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Row 2: Consultation Type, Payment Mode, Appointment Slot */}
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1.2fr", gap: "18px", marginBottom: "20px" }}>
                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Consultation Type
                  </label>
                  <select
                    value={appointmentType}
                    onChange={(e) => handleAppointmentTypeChange(e.target.value as any)}
                    className="pharmacy-rx-search-input"
                    style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="Consultation">New Consultation (Full Fee)</option>
                    <option value="Review">Follow-up / Review Visit</option>
                    <option value="Follow-up">Report Evaluation</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Payment Mode
                  </label>
                  <select
                    value={paymentMode}
                    onChange={(e) => setPaymentMode(e.target.value as any)}
                    className="pharmacy-rx-search-input"
                    style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="Cash">Cash Counter</option>
                    <option value="UPI">UPI / QR Code</option>
                    <option value="Card">Debit / Credit Card</option>
                    <option value="Waived">Exempt / Waived</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                    Consultation Slot
                  </label>
                  <input
                    type="text"
                    value={appointmentSlot}
                    readOnly
                    className="pharmacy-rx-search-input"
                    style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#f8fafc", color: "#334155", fontWeight: 600, width: "100%", boxSizing: "border-box" }}
                  />
                </div>
              </div>

              {/* Queue routing banner */}
              <div
                style={{
                  background: selectedDoctor ? "#f0fdfa" : "#fffbeb",
                  border: selectedDoctor ? "1px solid #99f6e4" : "1px solid #fde68a",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "20px",
                }}
              >
                <span style={{ color: selectedDoctor ? "#0f766e" : "#b45309", fontSize: "16px" }}>
                  {selectedDoctor ? "✓" : "⚠"}
                </span>
                <span style={{ fontSize: "13px", color: selectedDoctor ? "#115e59" : "#92400e", fontWeight: 500 }}>
                  {selectedDoctor ? (
                    <>
                      Booking appointment assigns <strong>{selectedDoctor}</strong> ({selectedDepartment}), records ₹{consultationFee} fee, generates a <strong>Live Queue Token</strong>, and places patient into <strong>Queue Management</strong>.
                    </>
                  ) : !selectedDepartment ? (
                    <>Please select a department and consulting doctor to book the consultation appointment.</>
                  ) : filteredDoctors.length === 0 ? (
                    <>
                      No doctor currently available in <strong>{selectedDepartment}</strong>. Please select another department or configure a doctor schedule.
                    </>
                  ) : (
                    <>
                      Please select a consulting doctor from <strong>{selectedDepartment}</strong>.
                    </>
                  )}
                </span>
              </div>

              {/* Bottom Action Buttons for OP */}
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px" }}>
                <button
                  type="button"
                  className="pharmacy-btn-teal"
                  style={{
                    padding: "12px 28px",
                    fontSize: "14px",
                    fontWeight: 800,
                    borderRadius: "8px",
                    background: "#00828a",
                    color: "#ffffff",
                    border: "none",
                    cursor: (bookingAppointment || registering) ? "not-allowed" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                  }}
                  disabled={bookingAppointment || registering}
                  onClick={() => void handleBookAppointment()}
                >
                  {bookingAppointment ? "Booking Appointment…" : "Book Appointment & Add to Queue ➔"}
                </button>
                <button
                  type="button"
                  className="btn-clear-outlined"
                  style={{ padding: "10px 18px", fontSize: "13px", fontWeight: 700, borderRadius: "8px" }}
                  onClick={handlePrintSlip}
                >
                  Print Slip
                </button>
                <button
                  type="button"
                  style={{ padding: "10px 18px", fontSize: "13px", fontWeight: 600, borderRadius: "8px", background: "#e2e8f0", color: "#334155", border: "none", cursor: "pointer" }}
                  onClick={handleClear}
                >
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* FLOW B: Inpatient (IP) -> Proceed to IP Admission module for Admission No & Bed Allotment */}
      {visitType === "IP" && (
        <div
          id="section-3-ip-admission-flow"
          style={{
            background: "#ffffff",
            border: "2px solid #2563eb",
            borderRadius: "12px",
            padding: "24px 28px",
            marginBottom: "24px",
            boxShadow: "0 2px 8px rgba(37,99,235,0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <span style={{ width: "44px", height: "44px", borderRadius: "10px", background: "#eff6ff", color: "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
                </svg>
              </span>
              <div>
                <h3 style={{ fontSize: "16.5px", fontWeight: 800, color: "#1e3a8a", margin: 0 }}>
                  3. Inpatient (IP) Admission Flow
                </h3>
                <p style={{ fontSize: "13px", color: "#64748b", margin: "3px 0 0 0", maxWidth: "680px" }}>
                  {patientId
                    ? `Patient is registered with UHID: ${patientId}. Proceed to the IP Admission module to record doctor orders, generate an Admission Number, and allocate a bed.`
                    : "Register the patient in Step 2 above. Once registered with a UHID, proceed to the IP Admission module to complete bed allocation and generate the Admission Number."}
                </p>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              {patientId && onNavigate && (
                <button
                  type="button"
                  style={{
                    padding: "11px 22px",
                    fontSize: "13.5px",
                    fontWeight: 700,
                    borderRadius: "8px",
                    background: "#2563eb",
                    color: "#ffffff",
                    border: "none",
                    cursor: "pointer",
                    boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                  onClick={() => {
                    localStorage.setItem("selected_admission_patient", patientId);
                    onNavigate("ip-admission");
                  }}
                >
                  <span>Go to IP Admission Module</span>
                  <span>➔</span>
                </button>
              )}

              <button
                type="button"
                style={{
                  padding: "10px 18px",
                  fontSize: "13px",
                  fontWeight: 600,
                  borderRadius: "8px",
                  background: "#f1f5f9",
                  color: "#475569",
                  border: "1px solid #cbd5e1",
                  cursor: "pointer",
                }}
                onClick={handleClear}
              >
                Clear Form
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FLOW C: Emergency -> Triage & Immediate Resuscitation */}
      {visitType === "Emergency" && (
        <div
          style={{
            background: "#ffffff",
            border: "2px solid #ef4444",
            borderRadius: "12px",
            padding: "24px 28px",
            marginBottom: "24px",
            boxShadow: "0 2px 8px rgba(239,68,68,0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ width: "36px", height: "36px", borderRadius: "8px", background: "#fef2f2", color: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </span>
              <div>
                <h3 style={{ fontSize: "16px", fontWeight: 800, color: "#991b1b", margin: 0 }}>
                  3. Emergency Triage & Immediate Care
                </h3>
                <p style={{ fontSize: "12px", color: "#64748b", margin: "2px 0 0 0" }}>
                  Instant emergency triage for urgent medical attention without consultation queue delays.
                </p>
              </div>
            </div>

            <span style={{ background: "#fee2e2", color: "#991b1b", fontSize: "12px", fontWeight: 800, padding: "4px 12px", borderRadius: "9999px" }}>
              Priority 1: Emergency 🚨
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "18px", marginBottom: "18px" }}>
            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#991b1b", display: "block", marginBottom: "6px" }}>
                Triage Level <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <select
                value={emergencyTriage}
                onChange={(e) => setEmergencyTriage(e.target.value as any)}
                className="pharmacy-rx-search-input"
                style={{ height: "42px", padding: "0 12px", borderRadius: "8px", border: "1px solid #fca5a5", width: "100%", boxSizing: "border-box", fontWeight: 700 }}
              >
                <option value="Red (Critical)">🔴 Red — Resuscitation (Immediate Life Threat)</option>
                <option value="Yellow (Urgent)">🟡 Yellow — Urgent (Severe pain, High fever)</option>
                <option value="Green (Non-urgent)">🟢 Green — Non-urgent (Minor trauma, stable)</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
                Attendant / Emergency Contact
              </label>
              <input
                type="text"
                value={emergencyAttendant}
                onChange={(e) => setEmergencyAttendant(e.target.value.replace(/[^a-zA-Z\s]/g, ""))}
                placeholder="Relative / Attendant name"
                className="pharmacy-rx-search-input"
                style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
              Chief Complaint / Trauma Reason
            </label>
            <input
              type="text"
              value={emergencyComplaint}
              onChange={(e) => setEmergencyComplaint(e.target.value)}
              placeholder="e.g. Chest pain, Road traffic accident, Breathing distress"
              className="pharmacy-rx-search-input"
              style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
            />
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "block", marginBottom: "6px" }}>
              Triage Vitals
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "10px" }}>
              {[
                { label: "BP", value: emergencyBp, set: (v: string) => setEmergencyBp(v.replace(/[^0-9/]/g, "").slice(0, 7)), placeholder: "120/80" },
                { label: "Pulse", value: emergencyPulse, set: (v: string) => setEmergencyPulse(v.replace(/\D/g, "").slice(0, 3)), placeholder: "bpm" },
                { label: "Temp (°F)", value: emergencyTemp, set: (v: string) => setEmergencyTemp(v.replace(/[^0-9.]/g, "").slice(0, 5)), placeholder: "98.6" },
                { label: "SpO2 (%)", value: emergencySpo2, set: (v: string) => setEmergencySpo2(v.replace(/\D/g, "").slice(0, 3)), placeholder: "98" },
                { label: "Resp. Rate", value: emergencyRespRate, set: (v: string) => setEmergencyRespRate(v.replace(/\D/g, "").slice(0, 3)), placeholder: "/min" },
                { label: "Pain (0-10)", value: emergencyPainScore, set: (v: string) => setEmergencyPainScore(clampPainScore(v)), placeholder: "0-10" },
              ].map((f) => (
                <div key={f.label}>
                  <label style={{ fontSize: "11px", color: "#64748b", display: "block", marginBottom: "4px" }}>{f.label}</label>
                  <input
                    type="text"
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                    placeholder={f.placeholder}
                    className="pharmacy-rx-search-input"
                    style={{ height: "38px", padding: "0 10px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box", fontSize: "13px" }}
                  />
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "12px 16px", display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
            <span style={{ color: "#dc2626", fontSize: "16px" }}>🚨</span>
            <span style={{ fontSize: "13px", color: "#991b1b", fontWeight: 600 }}>
              Emergency patient will bypass standard billing checks and be rushed to the Emergency Consultation Room immediately.
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              style={{
                padding: "12px 28px",
                fontSize: "14px",
                fontWeight: 800,
                borderRadius: "8px",
                background: "#dc2626",
                color: "#ffffff",
                border: "none",
                cursor: registering ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
              }}
              disabled={registering}
              onClick={() => void handleRegisterPatient()}
            >
              {registering ? "Processing…" : "Register Emergency Patient 🚨"}
            </button>
            <button
              type="button"
              className="btn-clear-outlined"
              style={{ padding: "10px 18px", fontSize: "13px", fontWeight: 700, borderRadius: "8px" }}
              onClick={handlePrintSlip}
            >
              Print Slip
            </button>
            <button
              type="button"
              style={{ padding: "10px 18px", fontSize: "13px", fontWeight: 600, borderRadius: "8px", background: "#e2e8f0", color: "#334155", border: "none", cursor: "pointer" }}
              onClick={handleClear}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* SECTION 4: Recent Registrations Table */}
      {/* ======================================================== */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "20px 24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ color: "#00828a" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>Recent Registrations</h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>Recently registered patients in this session for quick access.</p>
            </div>
          </div>

          <button
            type="button"
            className="btn-clear-outlined"
            style={{ padding: "6px 14px", fontSize: "12.5px", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}
            onClick={() => onNavigate && onNavigate("patients")}
          >
            View All Patients →
          </button>
        </div>

        {recentRegistrations.length === 0 ? (
          <div style={{ textAlign: "center", padding: "18px", color: "#94a3b8", fontSize: "13px" }}>
            No recent registrations in this session yet. Newly registered patients will appear here.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px", marginTop: "14px" }}>
            {recentRegistrations.slice(0, 3).map((r) => (
              <div
                key={r.id}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: "13.5px", color: "#0f172a" }}>{r.name}</div>
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                    {r.patientId} • {r.ageGender}
                  </div>
                  {r.doctorName && (
                    <div style={{ fontSize: "11px", color: "#00828a", fontWeight: 600, marginTop: "2px" }}>
                      {r.doctorName}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "3px 10px",
                    borderRadius: "4px",
                    background: r.visitType === "IP" ? "#eff6ff" : r.visitType === "ER" ? "#fee2e2" : "#f0fdf4",
                    color: r.visitType === "IP" ? "#1d4ed8" : r.visitType === "ER" ? "#991b1b" : "#0f766e",
                  }}
                >
                  {r.visitType}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddProviderModal && (
        <Modal
          open={showAddProviderModal}
          onClose={() => setShowAddProviderModal(false)}
          title="Add New Insurance Provider"
          description="This provider is saved to the list and will be selectable for every future patient."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: "360px" }}>
            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
                Provider Name <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                value={newProviderName}
                onChange={(e) => setNewProviderName(e.target.value)}
                placeholder="e.g. Bajaj Allianz"
                style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
                Contact Person (optional)
              </label>
              <input
                type="text"
                value={newProviderContact}
                onChange={(e) => setNewProviderContact(e.target.value)}
                placeholder="TPA / relationship manager name"
                style={{ height: "42px", padding: "0 14px", borderRadius: "8px", border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "6px" }}>
                Contact Phone (optional)
              </label>
              <PhoneInput
                landline
                countryCode={newProviderPhoneCode}
                value={newProviderPhone}
                placeholder="Support / claims contact number"
                onChange={({ countryCode, value }) => { setNewProviderPhoneCode(countryCode); setNewProviderPhone(value); }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "6px" }}>
              <button
                type="button"
                onClick={() => setShowAddProviderModal(false)}
                style={{ padding: "10px 18px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingProvider}
                onClick={() => void handleAddProvider()}
                style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: "#00828a", color: "#ffffff", fontWeight: 700, cursor: savingProvider ? "not-allowed" : "pointer" }}
              >
                {savingProvider ? "Saving..." : "Save Provider"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
