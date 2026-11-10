import { useEffect, useMemo, useState } from "react";
import PhoneInput from "../components/PhoneInput";
import { splitStoredPhone, toWhatsAppNumber } from "../lib/phone";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../lib/api";
import { printViaIframe } from "../lib/printViaIframe";
import type { Notice, Patient } from "../types";
import { SurveyManagementPanel, SurveyReportsPanel, SurveyResponsesPanel, SurveyTemplatesPanel, WhatsAppTemplatesPanel } from "./patientReach/SurveyPanels";
import { WHATSAPP_CATEGORY_LABELS, renderTemplate, useWhatsAppTemplates } from "./patientReach/surveyCommon";
import type { SurveyContext, SurveySummary, WhatsAppCategory } from "./patientReach/surveyCommon";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  selectedPatient?: Patient | null;
  onSelectPatient?: (patient: Patient) => void;
  onNavigate?: (page: string) => void;
  /** Sidebar sub-pages of the module render one survey panel instead of the patient workspace. */
  view?: "workspace" | "survey-management" | "survey-templates" | "whatsapp-templates" | "survey-reports";
  canWriteSurveys?: boolean;
};

type EncounterOption = {
  key: string;
  encounter_type: "IP" | "OP" | "EMERGENCY";
  encounter_id: number;
  label: string;
  start: string | null;
  status: string;
};

type Records = {
  patient: Record<string, string | number>;
  encounter: {
    type: string;
    id: number;
    label: string;
    start: string | null;
    end: string | null;
    status: string;
    ward: string | null;
    bed_no: string | null;
    attending_doctor: string | null;
  } | null;
  vitals: Record<string, string | number>[];
  prescriptions: Record<string, unknown>[];
  doctor_rounds: Record<string, unknown>[];
  observation_notes: Record<string, unknown>[];
  inpatient_medications: Record<string, unknown>[];
  procedures: Record<string, unknown>[];
  surgeries: Record<string, unknown>[];
  nursing: Record<string, unknown>[];
  diagnostic_reports: { test: string; type: string; released_at: string; result: string }[];
  pharmacy_issued: string[];
  timeline: Record<string, string>[];
  billing: { categories?: { label: string; amount: number }[]; total_charges: number; payments_received: number; outstanding: number; status: string } | null;
  encounters?: { label: string; start: string | null; status: string }[];
};

type DischargeMedicine = {
  medicine: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
};

type Report = {
  summary: string;
  presenting_complaints: string;
  diagnosis: string;
  clinical_course: string;
  key_investigations: string;
  procedures: string;
  treatment_given: string;
  condition_at_discharge: string;
  discharge_medications: DischargeMedicine[];
  advice: string;
  follow_up: string;
};

type Certificate = {
  id: number;
  patient_id: string;
  certificate_type: string;
  title: string;
  body: string;
  admission_id?: number | null;
  issued_by?: string | null;
  created_at?: string;
};

type TabKey = "discharge" | "journey" | "whatsapp" | "survey" | "survey-management" | "survey-templates" | "notes";

type WhatsAppMessage = { id: number; recipient_name: string | null; phone: string | null; purpose: string; template_name: string | null; message: string; sent_by: string | null; sent_at: string };

const TEMPLATE_LABELS: Record<string, string> = {
  summary: "Discharge Summary",
  meds: "Medication & Care",
  followup: "Follow-up Reminder",
  quick: "Quick Update",
};

const TEMPLATE_PURPOSE: Record<string, WhatsAppCategory> = { summary: "DISCHARGE", meds: "DISCHARGE", followup: "FOLLOW_UP", quick: "GENERAL" };

const VIEW_TITLES: Record<string, { title: string; subtitle: string }> = {
  "survey-management": { title: "Survey Management", subtitle: "Queue patient feedback surveys, send them on WhatsApp and track replies" },
  "survey-templates": { title: "Survey Templates", subtitle: "Survey questions, answer options and report categories" },
  "whatsapp-templates": { title: "WhatsApp Templates", subtitle: "Reusable WhatsApp messages for surveys, reminders and follow-ups" },
  "survey-reports": { title: "Survey Reports", subtitle: "Detailed patient feedback reports, trends and exports" },
};

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";


// SVG Icons
const WhatsAppIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.031 2C6.5 2 2.016 6.484 2.016 12.016c0 1.947.558 3.766 1.528 5.305L2 22l4.828-1.508c1.488.887 3.223 1.391 5.074 1.391 5.531 0 10.016-4.484 10.016-10.016C21.918 6.484 17.562 2 12.031 2zm0 18.234c-1.637 0-3.176-.469-4.5-1.281l-.324-.199-3.098.969.988-3.023-.211-.336c-.926-1.445-1.422-3.137-1.422-4.883 0-4.664 3.797-8.461 8.461-8.461 4.664 0 8.461 3.797 8.461 8.461 0 4.664-3.797 8.461-8.461 8.461zm4.641-6.328c-.254-.129-1.508-.742-1.742-.828-.234-.086-.406-.129-.578.129-.172.254-.668.828-.816.996-.152.172-.301.191-.555.066-.254-.129-1.074-.395-2.043-1.258-.754-.672-1.266-1.504-1.414-1.758-.152-.254-.016-.391.109-.516.113-.113.254-.297.383-.445.129-.152.172-.254.254-.422.086-.172.043-.324-.023-.449-.066-.129-.578-1.391-.793-1.906-.211-.5-.422-.43-.578-.438-.152-.008-.324-.008-.496-.008-.172 0-.449.066-.684.32-.234.254-.895.875-.895 2.133s.918 2.473 1.047 2.645c.129.172 1.809 2.762 4.383 3.871.613.266 1.09.426 1.465.547.617.195 1.176.168 1.621.102.496-.074 1.508-.617 1.723-1.215.211-.598.211-1.113.148-1.215-.062-.102-.234-.168-.488-.297z" />
  </svg>
);

const SparkleIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
  </svg>
);

const RefreshIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
  </svg>
);

const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const PrinterIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
);

const CopyIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function PatientReachAiPage({ setNotice, selectedPatient: initialPatient, onSelectPatient, view = "workspace", canWriteSurveys = false }: Props) {
  // Patients directory state
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "ip" | "op" | "with_phone">("all");
  const [activePatient, setActivePatient] = useState<Patient | null>(initialPatient || null);

  // Discharge summary state
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [records, setRecords] = useState<Records | null>(null);
  const [encounters, setEncounters] = useState<EncounterOption[]>([]);
  const [selectedEncounterKey, setSelectedEncounterKey] = useState("");
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [generatedAt, setGeneratedAt] = useState("");

  // WhatsApp Dialog State
  const [whatsAppModalOpen, setWhatsAppModalOpen] = useState(false);
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientPhoneCode, setRecipientPhoneCode] = useState("+91");
  const [recipientName, setRecipientName] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<"summary" | "meds" | "followup" | "quick">("summary");
  const [savedTemplateId, setSavedTemplateId] = useState<number | null>(null);
  const { templates: savedWhatsAppTemplates, hospitalName } = useWhatsAppTemplates(setNotice, true);
  const [copied, setCopied] = useState(false);

  // Tabs, outreach history and notes
  const [activeTab, setActiveTab] = useState<TabKey>("discharge");
  const [waHistory, setWaHistory] = useState<WhatsAppMessage[]>([]);
  const [notesByPatient, setNotesByPatient] = useState<Record<string, string>>({});

  // Survey KPIs (header cards); surveyRefresh bumps after any survey change.
  const [surveySummary, setSurveySummary] = useState<SurveySummary | null>(null);
  const [surveyRefresh, setSurveyRefresh] = useState(0);
  const bumpSurveys = () => setSurveyRefresh((n) => n + 1);

  useEffect(() => {
    apiFetch<SurveySummary>("/api/reach/survey-summary")
      .then(setSurveySummary)
      .catch(() => setSurveySummary(null));
  }, [surveyRefresh]);

  const loadWhatsAppHistory = async (patientId: string) => {
    try {
      const res = await apiFetch<{ messages: WhatsAppMessage[] }>(`/api/reach/whatsapp-messages?patient_id=${encodeURIComponent(patientId)}`);
      setWaHistory(res.messages || []);
    } catch {
      setWaHistory([]);
    }
  };

  useEffect(() => {
    if (view === "workspace" && activePatient?.patient_id) void loadWhatsAppHistory(activePatient.patient_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePatient?.patient_id, view]);

  const activePatientName = activePatient
    ? [activePatient.name, activePatient.middle_name, activePatient.last_name].filter(Boolean).join(" ")
    : "";

  // Survey context: the visit currently selected in the workspace
  const surveyContext = useMemo<SurveyContext>(() => {
    const enc = encounters.find((e) => e.key === selectedEncounterKey);
    return {
      encounter_type: enc?.encounter_type || records?.encounter?.type || null,
      encounter_id: enc?.encounter_id ?? records?.encounter?.id ?? null,
      encounter_label: records?.encounter?.label || enc?.label || null,
      doctor_name: records?.encounter?.attending_doctor || activePatient?.latest_doctor_name || null,
      department: activePatient?.latest_department || null,
    };
  }, [encounters, selectedEncounterKey, records, activePatient]);

  // Load patient directory
  const fetchPatients = async (query = "") => {
    setLoadingPatients(true);
    try {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const res = await apiFetch<{ patients?: Patient[] }>(`/api/patients${qs}`);
      const list = res.patients || [];
      setPatients(list);
      // If we don't have an active patient yet, select the first one
      if (view === "workspace" && !activePatient && list.length > 0) {
        selectPatient(list[0]);
      }
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load patients.");
    } finally {
      setLoadingPatients(false);
    }
  };

  useEffect(() => {
    void fetchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When initialPatient prop changes from parent
  useEffect(() => {
    if (view === "workspace" && initialPatient?.patient_id && initialPatient.patient_id !== activePatient?.patient_id) {
      selectPatient(initialPatient);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPatient?.patient_id]);

  // Load discharge summary records & certificates for active patient
  const loadPatientSummaryData = async (patient: Patient, encounter?: EncounterOption) => {
    setLoadingRecords(true);
    setReport(null);
    try {
      const pid = patient.patient_id;
      const encQs = encounter ? `?encounter_type=${encounter.encounter_type}&encounter_id=${encounter.encounter_id}` : "";
      
      const [journeyRes, dischargeRes, certRes] = await Promise.all([
        apiFetch<{ encounters: EncounterOption[]; selected: EncounterOption | null }>(`/api/patients/${encodeURIComponent(pid)}/journey${encQs}`),
        apiFetch<{ records: Records }>(`/api/patients/${encodeURIComponent(pid)}/discharge-summary${encQs}`),
        apiFetch<{ certificates?: Certificate[] }>(`/api/patients/${encodeURIComponent(pid)}/certificates`).catch(() => ({ certificates: [] })),
      ]);

      setEncounters(journeyRes.encounters || []);
      setSelectedEncounterKey(journeyRes.selected?.key || "");
      setRecords(dischargeRes.records);
      setCertificates(certRes.certificates || []);
    } catch (err) {
      setRecords(null);
      setCertificates([]);
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load patient clinical records.");
    } finally {
      setLoadingRecords(false);
    }
  };

  const selectPatient = (patient: Patient) => {
    setActivePatient(patient);
    if (onSelectPatient) onSelectPatient(patient);
    void loadPatientSummaryData(patient);
  };

  // Switch encounter
  const handleEncounterChange = (encKey: string) => {
    setSelectedEncounterKey(encKey);
    const enc = encounters.find((x) => x.key === encKey);
    if (activePatient && enc) {
      void loadPatientSummaryData(activePatient, enc);
    }
  };

  // Generate AI Discharge Summary
  const handleGenerateAiSummary = async () => {
    if (!activePatient) return;
    setGeneratingAi(true);
    const selectedEnc = encounters.find((e) => e.key === selectedEncounterKey);
    try {
      const data = await apiFetch<{ records: Records; report: Report; generated_at: string }>(
        `/api/patients/${encodeURIComponent(activePatient.patient_id)}/discharge-summary/generate`,
        {
          method: "POST",
          body: JSON.stringify(
            selectedEnc ? { encounter_type: selectedEnc.encounter_type, encounter_id: selectedEnc.encounter_id } : {}
          ),
        }
      );
      setRecords(data.records);
      setReport(data.report);
      setGeneratedAt(data.generated_at);
      setNotice({ type: "success", message: "AI Discharge Summary generated successfully with Qwen!" });
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not generate AI discharge summary.");
    } finally {
      setGeneratingAi(false);
    }
  };

  // Synthesize existing summary from gathered records if AI hasn't run yet
  const existingDischargeSummaryText = useMemo(() => {
    if (report?.summary) return report.summary;
    if (!records) return "";

    const cert = certificates.find((c) => c.certificate_type === "discharge_summary" || c.certificate_type === "medical_certificate");
    if (cert?.body) return cert.body;

    // Synthesize structured summary from patient's real medical history
    const p = records.patient;
    const enc = records.encounter;
    const parts: string[] = [];

    const pName = [p.name, p.middle_name, p.last_name].filter(Boolean).join(" ") || "Patient";
    const pAgeGender = [p.age ? `${p.age}y` : "", p.gender].filter(Boolean).join(", ");
    
    parts.push(`${pName} (${pAgeGender || "Adult"}) was seen under ${enc?.attending_doctor ? `Dr. ${enc.attending_doctor}` : "the clinical team"} for ${enc?.label || "clinical consultation"}.`);

    if (p.symptoms) {
      parts.push(`Presenting complaints included ${p.symptoms}.`);
    }

    if (records.prescriptions.length > 0) {
      const latestRx = records.prescriptions[0] as { diagnosis?: string; advice?: string };
      if (latestRx.diagnosis) {
        parts.push(`Clinical diagnosis established: ${latestRx.diagnosis}.`);
      }
      if (latestRx.advice) {
        parts.push(`Management advice: ${latestRx.advice}.`);
      }
    }

    if (records.doctor_rounds.length > 0) {
      const latestRound = records.doctor_rounds[records.doctor_rounds.length - 1] as { clinical_findings?: string; assessment?: string };
      if (latestRound.assessment) {
        parts.push(`Clinical assessment: ${latestRound.assessment}.`);
      }
    }

    if (enc?.status) {
      parts.push(`Encounter status is marked as ${enc.status}. Patient is hemodynamically stable at the time of review.`);
    }

    return parts.join(" ");
  }, [report, records, certificates]);

  // Medications list from either AI report or gathered prescriptions
  const medicationsList = useMemo<DischargeMedicine[]>(() => {
    if (report?.discharge_medications && report.discharge_medications.length > 0) {
      return report.discharge_medications;
    }
    if (!records?.prescriptions) return [];

    const meds: DischargeMedicine[] = [];
    for (const rx of records.prescriptions as Array<{ medicines?: Array<{ medicine_name?: string; dosage?: string; frequency?: string; duration?: string; instructions?: string }> }>) {
      if (rx.medicines && Array.isArray(rx.medicines)) {
        for (const m of rx.medicines) {
          if (m.medicine_name) {
            meds.push({
              medicine: m.medicine_name,
              dosage: m.dosage || "As directed",
              frequency: m.frequency || "Once daily",
              duration: m.duration || "Course duration",
              instructions: m.instructions || "After food",
            });
          }
        }
      }
    }
    return meds;
  }, [report, records]);

  // Build WhatsApp Message Templates
  const buildTemplateMessage = (templateKey: "summary" | "meds" | "followup" | "quick"): string => {
    if (!activePatient) return "";
    const p = records?.patient || (activePatient as Record<string, any>);
    const enc = records?.encounter;
    const pName = [p.name, p.middle_name, p.last_name].filter(Boolean).join(" ") || activePatient.name;
    const uhid = activePatient.patient_id;
    const doctor = enc?.attending_doctor || (activePatient.latest_doctor_name || "Consultant Physician");
    const summaryText = existingDischargeSummaryText || "Patient received clinical care and is recovering well.";
    const adviceText = report?.advice || (records?.prescriptions?.[0] as any)?.advice || "Take prescribed medicines on time, maintain adequate hydration, and take adequate rest.";
    const followUpDate = report?.follow_up || (records?.prescriptions?.[0] as any)?.follow_up_date || "After 5 to 7 days or SOS";

    if (templateKey === "quick") {
      return [
        `*HospAI · Patient Care Update*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Dear *${pName}* (UHID: *${uhid}*),`,
        ``,
        `Your discharge summary and medical review have been finalized under *Dr. ${doctor}*.`,
        ``,
        `📋 *Summary:*`,
        `${summaryText}`,
        ``,
        `📞 *Hospital Helpline:* +91 9849237676`,
        `We wish you a fast and complete recovery!`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `*HospAI Hospital & Care Center*`,
      ].join("\n");
    }

    if (templateKey === "meds") {
      const medLines = medicationsList.length > 0
        ? medicationsList.map((m, i) => `${i + 1}. *${m.medicine}* - ${m.dosage} (${m.frequency}) · ${m.duration} [${m.instructions}]`).join("\n")
        : "• Continue maintenance regimen as advised by doctor.";

      return [
        `*HospAI · Discharge Medication & Care Instructions*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `👤 *Patient:* ${pName} | *UHID:* ${uhid}`,
        `👨‍⚕️ *Attending Doctor:* Dr. ${doctor}`,
        ``,
        `💊 *PRESCRIBED MEDICINES SCHEDULE:*`,
        `${medLines}`,
        ``,
        `⚠️ *IMPORTANT CARE ADVICE:*`,
        `${adviceText}`,
        ``,
        `🗓️ *Follow-Up:* ${followUpDate}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `*HospAI Hospital · Hyderabad* | Helpline: +91 9849237676`,
      ].join("\n");
    }

    if (templateKey === "followup") {
      return [
        `*HospAI · Follow-Up & Review Appointment Reminder*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Dear *${pName}* (UHID: *${uhid}*),`,
        ``,
        `This is a friendly reminder regarding your scheduled follow-up consultation with *Dr. ${doctor}*.`,
        ``,
        `📅 *Scheduled Follow-Up:* ${followUpDate}`,
        `📍 *Location:* HospAI Outpatient Department (OPD)`,
        ``,
        `🩺 *Instructions Before Visit:*`,
        `• Please carry this discharge summary and your medication strip.`,
        `• Complete any pending lab tests prior to consultation.`,
        `• If you experience any high fever, acute pain, or breathlessness, visit our Emergency immediately.`,
        ``,
        `📞 24/7 Emergency & Appointment Booking: +91 9849237676`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `*HospAI Hospital*`,
      ].join("\n");
    }

    // Default: Comprehensive Clinical Discharge Summary
    const medSection = medicationsList.length > 0
      ? "\n💊 *Discharge Medications:*\n" + medicationsList.slice(0, 5).map((m) => `• *${m.medicine}* (${m.dosage}) - ${m.frequency} [${m.instructions}]`).join("\n")
      : "";

    return [
      `*HospAI Hospital · Patient Discharge Summary*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 *Patient:* ${pName} (${uhid})`,
      `📅 *Date:* ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
      `👨‍⚕️ *Consultant:* Dr. ${doctor}`,
      enc?.label ? `🏥 *Encounter:* ${enc.label}` : "",
      ``,
      `📋 *CLINICAL SUMMARY:*`,
      `${summaryText}`,
      medSection,
      ``,
      `📝 *Care Advice & Follow-Up:*`,
      `• ${adviceText}`,
      `• Next Review: ${followUpDate}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🏥 HospAI Multi-Speciality Hospital · Domalguda, Hyderabad`,
      `📞 Emergency / Helpline: +91 9849237676`,
    ].filter(Boolean).join("\n");
  };

  // Open WhatsApp dialog
  const handleOpenWhatsAppDialog = () => {
    if (!activePatient) return;
    const usePrimary = !!activePatient.phone;
    const stored = splitStoredPhone(
      usePrimary ? activePatient.phone : activePatient.family_mobile,
      usePrimary ? activePatient.phone_country_code : activePatient.family_country_code,
    );
    setRecipientPhone(stored.value);
    setRecipientPhoneCode(stored.countryCode);
    setRecipientName([activePatient.name, activePatient.last_name].filter(Boolean).join(" "));
    setSavedTemplateId(null);
    const initialMsg = buildTemplateMessage(selectedTemplate);
    setWhatsAppMessage(initialMsg);
    setCopied(false);
    setWhatsAppModalOpen(true);
  };

  // Change WhatsApp template
  const handleTemplateSwitch = (tmpl: "summary" | "meds" | "followup" | "quick") => {
    setSelectedTemplate(tmpl);
    setSavedTemplateId(null);
    const msg = buildTemplateMessage(tmpl);
    setWhatsAppMessage(msg);
  };

  // Saved templates from WhatsApp Templates, filled with this patient's details
  const handleSavedTemplateSwitch = (templateId: number) => {
    const tpl = savedWhatsAppTemplates.find((t) => t.id === templateId);
    if (!tpl || !activePatient) return;
    setSavedTemplateId(templateId);
    setWhatsAppMessage(renderTemplate(tpl.body, {
      patient_name: activePatientName || activePatient.name,
      uhid: activePatient.patient_id,
      doctor_name: records?.encounter?.attending_doctor || activePatient.latest_doctor_name,
      department: activePatient.latest_department,
      visit: records?.encounter?.label,
      hospital_name: hospitalName,
    }));
  };

  // Launch WhatsApp link
  const handleSendWhatsApp = () => {
    const cleaned = toWhatsAppNumber(recipientPhoneCode, recipientPhone);
    const encoded = encodeURIComponent(whatsAppMessage);
    const url = cleaned
      ? `https://wa.me/${cleaned}?text=${encoded}`
      : `https://api.whatsapp.com/send?text=${encoded}`;

    window.open(url, "_blank", "noopener,noreferrer");
    if (activePatient) {
      const saved = savedWhatsAppTemplates.find((t) => t.id === savedTemplateId);
      const patientId = activePatient.patient_id;
      apiFetch("/api/reach/whatsapp-messages", {
        method: "POST",
        body: JSON.stringify({
          patient_id: patientId,
          recipient_name: recipientName,
          phone: recipientPhone,
          purpose: saved ? saved.category : TEMPLATE_PURPOSE[selectedTemplate],
          template_name: saved ? saved.name : TEMPLATE_LABELS[selectedTemplate],
          message: whatsAppMessage,
        }),
      })
        .then(() => loadWhatsAppHistory(patientId))
        .catch(() => setNotice({ type: "warning", message: "WhatsApp opened, but the message could not be saved to WhatsApp History." }));
    }
    setNotice({
      type: "success",
      message: `WhatsApp launched for ${recipientName || "patient"}. Message is ready to send.`,
    });
    setWhatsAppModalOpen(false);
  };

  // Copy message to clipboard
  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(whatsAppMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
      setNotice({ type: "success", message: "WhatsApp message copied to clipboard!" });
    } catch {
      setNotice({ type: "warning", message: "Failed to copy message. Please copy manually." });
    }
  };

  // Print Discharge Summary
  const handlePrintSummary = () => {
    if (!activePatient || !records) return;
    const p = records.patient;
    const enc = records.encounter;
    const pName = [p.name, p.middle_name, p.last_name].filter(Boolean).join(" ");
    const medsRows = medicationsList.length > 0
      ? `<table style="width:100%; border-collapse:collapse; margin-top:8px; font-size:12px;">
          <thead>
            <tr style="background:#f1f5f9; text-align:left;">
              <th style="padding:6px; border:1px solid #cbd5e1;">Medicine</th>
              <th style="padding:6px; border:1px solid #cbd5e1;">Dosage</th>
              <th style="padding:6px; border:1px solid #cbd5e1;">Frequency</th>
              <th style="padding:6px; border:1px solid #cbd5e1;">Duration</th>
              <th style="padding:6px; border:1px solid #cbd5e1;">Instructions</th>
            </tr>
          </thead>
          <tbody>
            ${medicationsList
              .map(
                (m) =>
                  `<tr>
                    <td style="padding:6px; border:1px solid #cbd5e1; font-weight:bold;">${esc(m.medicine)}</td>
                    <td style="padding:6px; border:1px solid #cbd5e1;">${esc(m.dosage)}</td>
                    <td style="padding:6px; border:1px solid #cbd5e1;">${esc(m.frequency)}</td>
                    <td style="padding:6px; border:1px solid #cbd5e1;">${esc(m.duration)}</td>
                    <td style="padding:6px; border:1px solid #cbd5e1;">${esc(m.instructions)}</td>
                  </tr>`
              )
              .join("")}
          </tbody>
        </table>`
      : `<p style="font-size:12px; color:#64748b;">No specific discharge medications recorded.</p>`;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Discharge Summary - ${esc(pName)}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1e293b; font-size: 13px; line-height: 1.6; padding: 24px; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #00828a; padding-bottom: 12px; margin-bottom: 16px; }
        .logo-title { font-size: 22px; font-weight: 800; color: #00828a; margin: 0; }
        .badge { background: #e0f2fe; color: #0369a1; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; font-size: 12.5px; }
        h2 { font-size: 14px; text-transform: uppercase; color: #00828a; letter-spacing: 0.04em; margin: 16px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
        .summary-box { background: #f0fdfa; border-left: 4px solid #00828a; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 14px; font-size: 13px; }
        .sign { margin-top: 48px; display: flex; justify-content: space-between; font-size: 12px; color: #475569; }
      </style>
      </head><body>
      <div class="header">
        <div>
          <div class="logo-title">HospAI Hospital</div>
          <div style="font-size:12px; color:#64748b;">Patient Care & Discharge Summary</div>
        </div>
        <div style="text-align:right;">
          <div class="badge">DISCHARGE REPORT</div>
          <div style="font-size:11.5px; color:#64748b; margin-top:4px;">Date: ${esc(new Date().toLocaleDateString("en-IN"))}</div>
        </div>
      </div>

      <div class="info-grid">
        <div><strong>Patient Name:</strong> ${esc(pName)}</div>
        <div><strong>UHID:</strong> ${esc(p.patient_id)}</div>
        <div><strong>Age / Gender:</strong> ${esc(p.age || "—")} / ${esc(p.gender || "—")}</div>
        <div><strong>Blood Group:</strong> ${esc(p.blood_group || "—")}</div>
        <div><strong>Attending Doctor:</strong> ${esc(enc?.attending_doctor || "Consultant Physician")}</div>
        <div><strong>Phone:</strong> ${esc(p.phone || "—")}</div>
        <div><strong>Visit / Encounter:</strong> ${esc(enc?.label || "General Care")}</div>
        <div><strong>Allergies:</strong> ${esc(p.allergies || "None recorded")}</div>
      </div>

      <h2>Clinical Summary</h2>
      <div class="summary-box">${esc(existingDischargeSummaryText)}</div>

      <h2>Discharge Medications</h2>
      ${medsRows}

      <h2>Care Advice & Follow-Up</h2>
      <p><strong>Advice:</strong> ${esc(report?.advice || (records?.prescriptions?.[0] as any)?.advice || "Follow general rest and hygiene precautions.")}</p>
      <p><strong>Follow-Up:</strong> ${esc(report?.follow_up || (records?.prescriptions?.[0] as any)?.follow_up_date || "After 5 to 7 days or SOS")}</p>

      <div class="sign">
        <div>Generated via HospAI Patient Reach AI · Official Medical Record</div>
        <div>Authorized Signatory / Consultant: ____________________</div>
      </div>
      </body></html>`;

    printViaIframe(html);
  };

  // Filtered patients list
  const filteredPatients = useMemo(() => {
    return patients.filter((p) => {
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.last_name || "").toLowerCase().includes(q) ||
        (p.patient_id || "").toLowerCase().includes(q) ||
        (p.phone || "").toLowerCase().includes(q) ||
        (p.latest_doctor_name || "").toLowerCase().includes(q) ||
        (p.latest_department || "").toLowerCase().includes(q);

      if (!matchQuery) return false;

      if (filterType === "ip") return !!p.is_inpatient;
      if (filterType === "op") return !p.is_inpatient;
      if (filterType === "with_phone") return !!(p.phone || p.family_mobile);

      return true;
    });
  }, [patients, searchQuery, filterType]);

  return (
    <div style={{ padding: "20px 28px 48px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* Module Header */}
      <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "14px" }}>
        <div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#ecfdf5", color: "#059669", padding: "4px 10px", borderRadius: "16px", fontSize: "12px", fontWeight: 700, marginBottom: "8px", border: "1px solid #a7f3d0" }}>
            <SparkleIcon size={14} /> AI Patient Engagement & Outreach
          </div>
          <h1 style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", margin: "0 0 6px 0", letterSpacing: "-0.025em" }}>
            {VIEW_TITLES[view]?.title || "Patient Reach AI"}
          </h1>
          <p style={{ fontSize: "14px", color: "#64748b", margin: 0, maxWidth: "720px" }}>
            {VIEW_TITLES[view]?.subtitle || "Patient outreach, discharge summaries and feedback management"}
          </p>
        </div>

        {/* Global Action Chips */}
        {view === "workspace" && (
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void fetchPatients(searchQuery)}
            disabled={loadingPatients}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              height: "38px",
              padding: "0 14px",
              borderRadius: "8px",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              fontSize: "13px",
              fontWeight: 600,
              color: "#334155",
              cursor: loadingPatients ? "not-allowed" : "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <RefreshIcon size={14} />
            {loadingPatients ? "Refreshing…" : "Refresh Patients"}
          </button>
        </div>
        )}
      </div>

      {/* KPI Summary Row (survey figures from /api/reach/survey-summary) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        {[
          { label: "Total Responses", value: String(surveySummary?.total ?? "—"), trend: surveySummary?.trend.total_pct, bg: "#ecfdf5", border: "#d1fae5", iconBg: "#d1fae5", color: "#059669", icon: "💬" },
          { label: "Pending Responses", value: String(surveySummary?.pending ?? "—"), trend: surveySummary?.trend.pending_pct, bg: "#fffbeb", border: "#fde68a", iconBg: "#fde68a", color: "#d97706", icon: "🕒" },
          { label: "Completed Surveys", value: String(surveySummary?.completed ?? "—"), trend: surveySummary?.trend.completed_pct, bg: "#eff6ff", border: "#dbeafe", iconBg: "#dbeafe", color: "#2563eb", icon: "✔" },
          { label: "Average Rating", value: surveySummary?.avg_rating != null ? surveySummary.avg_rating.toFixed(1) : "—", suffix: " / 5", delta: surveySummary?.trend.avg_rating_delta, bg: "#faf5ff", border: "#e9d5ff", iconBg: "#e9d5ff", color: "#7c3aed", icon: "★" },
        ].map((k) => {
          const change = "delta" in k ? k.delta : k.trend;
          const changeText = change == null ? null : "delta" in k ? `${Math.abs(change).toFixed(1)}` : `${Math.abs(change)}%`;
          return (
            <div key={k.label} style={{ display: "flex", alignItems: "center", gap: "16px", background: k.bg, border: `1px solid ${k.border}`, borderRadius: "14px", padding: "18px 22px" }}>
              <div style={{ width: "56px", height: "56px", borderRadius: "50%", background: k.iconBg, color: k.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px", flexShrink: 0 }}>{k.icon}</div>
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#475569" }}>{k.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
                  <div style={{ fontSize: "30px", fontWeight: 800, color: "#0f172a", lineHeight: 1.2 }}>
                    {k.value}
                    {"suffix" in k && k.suffix && <span style={{ fontSize: "17px", fontWeight: 700, color: "#475569" }}>{k.suffix}</span>}
                  </div>
                  {changeText && (
                    <div style={{ fontSize: "11.5px", lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 700, color: change! >= 0 ? "#059669" : "#dc2626" }}>{change! >= 0 ? "↑" : "↓"} {changeText}</div>
                      <div style={{ color: "#64748b" }}>from last month</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {view === "survey-management" && (
        <SurveyManagementPanel setNotice={setNotice} canWrite={canWriteSurveys} patients={patients} refreshKey={surveyRefresh} onChanged={bumpSurveys} />
      )}
      {view === "survey-templates" && <SurveyTemplatesPanel setNotice={setNotice} canWrite={canWriteSurveys} />}
      {view === "whatsapp-templates" && <WhatsAppTemplatesPanel setNotice={setNotice} canWrite={canWriteSurveys} />}
      {view === "survey-reports" && <SurveyReportsPanel setNotice={setNotice} />}

      {/* Main Grid: Split Layout */}
      {view === "workspace" && (
      <div style={{ display: "grid", gridTemplateColumns: "360px minmax(0, 1fr)", gap: "22px", alignItems: "start" }}>
        {/* Left Column: All Existing Patients Directory */}
        <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", display: "flex", flexDirection: "column", height: "calc(100vh - 170px)", minHeight: "560px" }}>
          {/* Search & Filters */}
          <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #f1f5f9" }}>
            <div style={{ position: "relative", marginBottom: "10px" }}>
              <span style={{ position: "absolute", left: "12px", top: "11px", color: "#94a3b8" }}>
                <SearchIcon size={16} />
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search UHID, name, mobile, doctor…"
                style={{
                  width: "100%",
                  height: "38px",
                  paddingLeft: "36px",
                  paddingRight: "12px",
                  boxSizing: "border-box",
                  borderRadius: "8px",
                  border: "1.5px solid #cbd5e1",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
            </div>

            {/* Filter Pills */}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {[
                { key: "all", label: `All (${patients.length})` },
                { key: "ip", label: "Inpatients" },
                { key: "op", label: "Outpatients" },
                { key: "with_phone", label: "With Mobile" },
              ].map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilterType(f.key as any)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: "14px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    border: filterType === f.key ? "1.5px solid #00828a" : "1px solid #e2e8f0",
                    background: filterType === f.key ? "#f0fdfa" : "#f8fafc",
                    color: filterType === f.key ? "#0f766e" : "#64748b",
                    cursor: "pointer",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Patient Directory List */}
          <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
            {loadingPatients ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                Loading patients directory…
              </div>
            ) : filteredPatients.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                No patients match the search criteria.
              </div>
            ) : (
              filteredPatients.map((patient) => {
                const isSelected = activePatient?.patient_id === patient.patient_id;
                const pName = [patient.name, patient.last_name].filter(Boolean).join(" ");
                const hasMobile = Boolean(patient.phone || patient.family_mobile);

                return (
                  <div
                    key={patient.patient_id}
                    onClick={() => selectPatient(patient)}
                    style={{
                      padding: "12px 14px",
                      borderRadius: "10px",
                      marginBottom: "6px",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      border: isSelected ? "1.5px solid #00828a" : "1px solid #f1f5f9",
                      background: isSelected ? "#f0fdfa" : "#ffffff",
                      boxShadow: isSelected ? "0 2px 8px rgba(0,130,138,0.12)" : "none",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: isSelected ? "#0f766e" : "#1e293b" }}>
                        {pName}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: "6px",
                          background: patient.is_inpatient ? "#e0f2fe" : "#f1f5f9",
                          color: patient.is_inpatient ? "#0369a1" : "#475569",
                        }}
                      >
                        {patient.is_inpatient ? "IPD" : "OPD"}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "#64748b" }}>
                      <span style={{ fontWeight: 600, color: "#00828a" }}>{patient.patient_id}</span>
                      <span>·</span>
                      <span>{patient.age ? `${patient.age}y` : ""} {patient.gender || ""}</span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "6px", fontSize: "11.5px", color: "#64748b" }}>
                      <span>{patient.phone ? `📱 ${patient.phone}` : "No phone"}</span>
                      {hasMobile && (
                        <span style={{ color: "#25D366", display: "inline-flex", alignItems: "center", gap: "3px", fontWeight: 600 }}>
                          <WhatsAppIcon size={13} /> Reachable
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div style={{ padding: "10px 14px", borderTop: "1px solid #f1f5f9", fontSize: "11.5px", color: "#94a3b8", textAlign: "center" }}>
            Showing {filteredPatients.length} of {patients.length} patients
          </div>
        </div>

        {/* Right Column: Patient Reach AI Workspace & Discharge Summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          {!activePatient ? (
            <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "64px 24px", textAlign: "center", color: "#64748b" }}>
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>📋</div>
              <h3 style={{ fontSize: "18px", fontWeight: 700, color: "#1e293b", margin: "0 0 6px" }}>Select a Patient</h3>
              <p style={{ fontSize: "13.5px", margin: 0 }}>Click on any patient in the left directory to inspect their discharge summary and launch WhatsApp outreach.</p>
            </div>
          ) : (
            <>
              {/* Patient Banner Card */}
              <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "18px 22px", boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "14px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <h2 style={{ fontSize: "21px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
                        {activePatientName}
                      </h2>
                      <span style={{ background: "#ccfbf1", color: "#0f766e", padding: "3px 9px", borderRadius: "8px", fontSize: "12px", fontWeight: 700 }}>
                        {activePatient.patient_id}
                      </span>
                      <span style={{ background: activePatient.is_inpatient ? "#dbeafe" : "#f1f5f9", color: activePatient.is_inpatient ? "#1e40af" : "#475569", padding: "3px 8px", borderRadius: "8px", fontSize: "11.5px", fontWeight: 700 }}>
                        {activePatient.is_inpatient ? "Inpatient (IP)" : "Outpatient (OP)"}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "8px", fontSize: "13px", color: "#475569" }}>
                      <span><strong>Age/Gender:</strong> {activePatient.age || "—"} yrs / {activePatient.gender || "—"}</span>
                      <span><strong>Mobile:</strong> {activePatient.phone || activePatient.family_mobile || "Not recorded"}</span>
                      {records?.encounter && (
                        <span><strong>Attending Doctor:</strong> Dr. {records.encounter.attending_doctor || "Physician"}</span>
                      )}
                      {records?.encounter?.ward && (
                        <span><strong>Ward/Bed:</strong> {records.encounter.ward} / {records.encounter.bed_no || "—"}</span>
                      )}
                    </div>
                  </div>

                  {/* Top Action Buttons (WhatsApp & Print) */}
                  <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={handleOpenWhatsAppDialog}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        height: "40px",
                        padding: "0 18px",
                        borderRadius: "10px",
                        background: "#25D366",
                        color: "#ffffff",
                        fontWeight: 700,
                        fontSize: "13.5px",
                        border: "none",
                        cursor: "pointer",
                        boxShadow: "0 3px 10px rgba(37,211,102,0.35)",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <WhatsAppIcon size={19} />
                      WhatsApp Outreach
                    </button>

                    <button
                      type="button"
                      onClick={handlePrintSummary}
                      disabled={!records}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        height: "40px",
                        padding: "0 14px",
                        borderRadius: "10px",
                        background: "#ffffff",
                        color: "#334155",
                        fontWeight: 600,
                        fontSize: "13px",
                        border: "1.5px solid #cbd5e1",
                        cursor: records ? "pointer" : "not-allowed",
                      }}
                    >
                      <PrinterIcon size={15} />
                      Print
                    </button>
                  </div>
                </div>

                {/* Encounter switcher if patient has multiple visits */}
                {encounters.length > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #f1f5f9" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#64748b" }}>Select Visit / Encounter:</span>
                    <select
                      value={selectedEncounterKey}
                      onChange={(e) => handleEncounterChange(e.target.value)}
                      style={{
                        height: "34px",
                        borderRadius: "8px",
                        border: "1.5px solid #cbd5e1",
                        padding: "0 10px",
                        fontSize: "12.5px",
                        background: "#f8fafc",
                        color: "#1e293b",
                      }}
                    >
                      {encounters.map((e) => (
                        <option key={e.key} value={e.key}>
                          {e.label} · {fmtDate(e.start)} · {e.status}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: "28px", borderBottom: "1px solid #e2e8f0", padding: "0 6px", background: "#ffffff", borderRadius: "14px 14px 0 0", overflowX: "auto" }}>
                {([
                  ["discharge", "Discharge Summary"],
                  ["journey", "Patient Journey"],
                  ["whatsapp", "WhatsApp History"],
                  ["survey", "Survey Responses"],
                  ["survey-management", "Survey Management"],
                  ["survey-templates", "Survey Templates"],
                  ["notes", "Notes"],
                ] as [TabKey, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveTab(key)}
                    style={{
                      padding: "14px 4px",
                      background: "none",
                      border: "none",
                      borderBottom: activeTab === key ? "2px solid #00828a" : "2px solid transparent",
                      marginBottom: "-1px",
                      fontSize: "13.5px",
                      fontWeight: activeTab === key ? 700 : 500,
                      color: activeTab === key ? "#0f766e" : "#64748b",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {activeTab === "journey" && (
                <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "20px 24px" }}>
                  <h3 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", margin: "0 0 12px" }}>Patient Journey</h3>
                  {loadingRecords ? (
                    <div style={{ color: "#94a3b8", fontSize: "13px" }}>Loading…</div>
                  ) : records?.timeline && records.timeline.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {records.timeline.map((t, i) => (
                        <div key={i} style={{ display: "flex", gap: "12px", fontSize: "13px" }}>
                          <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#00828a", marginTop: "5px", flexShrink: 0 }} />
                          <div>
                            <div style={{ fontWeight: 700, color: "#1e293b" }}>{t.title || t.label || t.event || t.type || "Event"}</div>
                            <div style={{ color: "#64748b", fontSize: "12px" }}>
                              {[t.at || t.time || t.date, t.detail || t.description].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: "#94a3b8", fontSize: "13px" }}>No journey events recorded for this visit.</div>
                  )}
                </div>
              )}

              {activeTab === "whatsapp" && (
                <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "20px 24px" }}>
                  <h3 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", margin: "0 0 2px" }}>WhatsApp History</h3>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 14px" }}>WhatsApp messages opened for this patient from Patient Reach AI (discharge outreach and surveys).</p>
                  {waHistory.length === 0 ? (
                    <div style={{ color: "#94a3b8", fontSize: "13px" }}>No WhatsApp messages sent yet.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {waHistory.map((l) => (
                        <div key={l.id} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "10px 14px", fontSize: "12.5px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontWeight: 700, color: "#1e293b" }}>
                            <span>
                              {l.template_name || WHATSAPP_CATEGORY_LABELS[l.purpose as WhatsAppCategory] || "Message"} → {l.recipient_name || activePatientName}{l.phone ? ` (${l.phone})` : ""}
                            </span>
                            <span style={{ color: "#94a3b8", fontWeight: 500, fontSize: "11.5px", whiteSpace: "nowrap" }}>{fmtDateTime(l.sent_at)}{l.sent_by ? ` · ${l.sent_by}` : ""}</span>
                          </div>
                          <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontFamily: "inherit", color: "#475569", fontSize: "12px" }}>{l.message}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "survey" && (
                <SurveyResponsesPanel setNotice={setNotice} canWrite={canWriteSurveys} patients={patients} activePatient={activePatient}
                  context={surveyContext} refreshKey={surveyRefresh} onChanged={bumpSurveys} />
              )}

              {activeTab === "survey-management" && (
                <SurveyManagementPanel setNotice={setNotice} canWrite={canWriteSurveys} patients={patients} activePatient={activePatient}
                  context={surveyContext} refreshKey={surveyRefresh} onChanged={bumpSurveys} />
              )}

              {activeTab === "survey-templates" && <SurveyTemplatesPanel setNotice={setNotice} canWrite={canWriteSurveys} />}

              {activeTab === "notes" && activePatient && (
                <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "20px 24px" }}>
                  <h3 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", margin: "0 0 2px" }}>Notes</h3>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 12px" }}>Outreach notes for {activePatientName} (kept in this session only).</p>
                  <textarea
                    value={notesByPatient[activePatient.patient_id] || ""}
                    onChange={(e) => setNotesByPatient((prev) => ({ ...prev, [activePatient.patient_id]: e.target.value }))}
                    placeholder="Add a note about calls, feedback or follow-ups…"
                    rows={8}
                    style={{ width: "100%", boxSizing: "border-box", borderRadius: "8px", border: "1.5px solid #cbd5e1", padding: "10px 12px", fontSize: "13px", fontFamily: "inherit", resize: "vertical" }}
                  />
                </div>
              )}

              {/* Discharge Summary Main Panel */}
              {activeTab === "discharge" && (
              <div style={{ background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "20px 24px", boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
                  <div>
                    <h3 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a", margin: "0 0 2px" }}>
                      Discharge Summary
                    </h3>
                    <p style={{ fontSize: "12.5px", color: "#64748b", margin: 0 }}>
                      Compiled from patient encounters, prescriptions, vitals, lab reports, and doctor rounds.
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => void handleGenerateAiSummary()}
                      disabled={generatingAi || loadingRecords}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        height: "36px",
                        padding: "0 14px",
                        borderRadius: "8px",
                        background: "#00828a",
                        color: "#ffffff",
                        fontWeight: 700,
                        fontSize: "12.5px",
                        border: "none",
                        cursor: generatingAi || loadingRecords ? "not-allowed" : "pointer",
                      }}
                    >
                      <SparkleIcon size={14} />
                      {generatingAi ? "Generating with Qwen AI…" : report ? "Regenerate AI Summary" : "Generate AI Summary"}
                    </button>
                  </div>
                </div>

                {loadingRecords ? (
                  <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8", fontSize: "13.5px" }}>
                    Loading patient clinical records…
                  </div>
                ) : (
                  <>
                    {/* Summary Narrative Banner */}
                    <div style={{ background: "#f0fdfa", border: "1.5px solid #99f6e4", borderLeft: "5px solid #00828a", borderRadius: "10px", padding: "14px 18px", marginBottom: "20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "#0f766e" }}>
                          Clinical Discharge Summary Narrative
                        </span>
                        {generatedAt && (
                          <span style={{ fontSize: "11px", color: "#0d9488", fontWeight: 600 }}>
                            AI Generated on {new Date(generatedAt).toLocaleString("en-IN")}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: "13.5px", lineHeight: "1.65", color: "#134e4a", margin: 0 }}>
                        {existingDischargeSummaryText || "No recorded discharge summary narrative yet. Click 'Generate AI Summary' to synthesize one from clinical records."}
                      </p>
                    </div>

                    {/* Structured Clinical Sections */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "20px" }}>
                      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 16px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", marginBottom: "4px" }}>
                          Presenting Complaints & History
                        </div>
                        <div style={{ fontSize: "13px", color: "#334155" }}>
                          {report?.presenting_complaints || records?.patient?.symptoms || records?.patient?.medical_history || "Routine hospital admission/consultation."}
                        </div>
                      </div>

                      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 16px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", marginBottom: "4px" }}>
                          Diagnosis
                        </div>
                        <div style={{ fontSize: "13px", color: "#334155", fontWeight: 600 }}>
                          {report?.diagnosis || (records?.prescriptions?.[0] as any)?.diagnosis || "Clinical evaluation completed."}
                        </div>
                      </div>

                      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 16px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", marginBottom: "4px" }}>
                          Treatment & Clinical Course
                        </div>
                        <div style={{ fontSize: "13px", color: "#334155" }}>
                          {report?.clinical_course || report?.treatment_given || (records?.doctor_rounds?.[0] as any)?.assessment || "Administered standard clinical therapy and monitored in ward."}
                        </div>
                      </div>

                      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "14px 16px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#00828a", textTransform: "uppercase", marginBottom: "4px" }}>
                          Condition at Discharge & Advice
                        </div>
                        <div style={{ fontSize: "13px", color: "#334155" }}>
                          {report?.condition_at_discharge ? `${report.condition_at_discharge}. ` : "Hemodynamically stable. "}
                          {report?.advice || (records?.prescriptions?.[0] as any)?.advice || "Follow medication schedule and maintain adequate rest."}
                        </div>
                      </div>
                    </div>

                    {/* Discharge Medications Table */}
                    <div style={{ marginBottom: "20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <div style={{ fontSize: "13.5px", fontWeight: 800, color: "#0f172a" }}>
                          Discharge Medications ({medicationsList.length})
                        </div>
                      </div>

                      {medicationsList.length > 0 ? (
                        <div style={{ border: "1px solid #e2e8f0", borderRadius: "10px", overflow: "hidden" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
                            <thead>
                              <tr style={{ background: "#f8fafc", textAlign: "left", color: "#475569" }}>
                                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>Medicine</th>
                                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>Dosage</th>
                                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>Frequency</th>
                                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>Duration</th>
                                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>Instructions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {medicationsList.map((m, idx) => (
                                <tr key={idx} style={{ borderBottom: idx < medicationsList.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                                  <td style={{ padding: "8px 12px", fontWeight: 700, color: "#1e293b" }}>{m.medicine}</td>
                                  <td style={{ padding: "8px 12px", color: "#334155" }}>{m.dosage}</td>
                                  <td style={{ padding: "8px 12px", color: "#334155" }}>{m.frequency}</td>
                                  <td style={{ padding: "8px 12px", color: "#334155" }}>{m.duration}</td>
                                  <td style={{ padding: "8px 12px", color: "#00828a", fontWeight: 600 }}>{m.instructions}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div style={{ padding: "14px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "12.5px", color: "#94a3b8" }}>
                          No specific discharge medications found in latest prescriptions.
                        </div>
                      )}
                    </div>

                    {/* Vitals & Investigations Bar */}
                    {records?.vitals && records.vitals.length > 0 && (
                      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 16px", marginBottom: "16px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "6px" }}>
                          Latest Discharge Vitals Snapshot
                        </div>
                        <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", fontSize: "12.5px" }}>
                          {records.vitals[records.vitals.length - 1].bp && (
                            <span><strong>BP:</strong> {records.vitals[records.vitals.length - 1].bp} mmHg</span>
                          )}
                          {records.vitals[records.vitals.length - 1].pulse && (
                            <span><strong>Pulse:</strong> {records.vitals[records.vitals.length - 1].pulse} bpm</span>
                          )}
                          {records.vitals[records.vitals.length - 1].spo2 && (
                            <span><strong>SpO2:</strong> {records.vitals[records.vitals.length - 1].spo2}%</span>
                          )}
                          {records.vitals[records.vitals.length - 1].temperature && (
                            <span><strong>Temp:</strong> {records.vitals[records.vitals.length - 1].temperature} °F</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Bills for this visit */}
                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 16px", marginBottom: "16px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>Bills for this Visit</span>
                        {records?.billing && <span style={{ fontSize: "11.5px", fontWeight: 700, color: records.billing.status === "Settled" ? "#15803d" : "#b45309" }}>{records.billing.status}</span>}
                      </div>
                      {records?.billing && records.billing.total_charges > 0 ? (
                        <>
                          {(records.billing.categories || []).filter((c) => c.amount).map((c) => (
                            <div key={c.label} style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", padding: "2px 0" }}>
                              <span>{c.label}</span><span>₹{Number(c.amount).toLocaleString("en-IN")}</span>
                            </div>
                          ))}
                          <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", fontSize: "12.5px", marginTop: "6px", paddingTop: "6px", borderTop: "1px solid #e2e8f0" }}>
                            <span><strong>Total:</strong> ₹{records.billing.total_charges.toLocaleString("en-IN")}</span>
                            <span><strong>Paid:</strong> ₹{records.billing.payments_received.toLocaleString("en-IN")}</span>
                            <span><strong>Outstanding:</strong> ₹{records.billing.outstanding.toLocaleString("en-IN")}</span>
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No bills recorded for this visit.</div>
                      )}
                    </div>

                    {/* Existing Saved Certificates (if any) */}
                    {certificates.length > 0 && (
                      <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #f1f5f9" }}>
                        <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#64748b", marginBottom: "8px" }}>
                          Saved Hospital Certificates & Past Summaries ({certificates.length})
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {certificates.map((cert) => (
                            <div key={cert.id} style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 14px", fontSize: "12.5px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontWeight: 700, color: "#1e293b" }}>{cert.title}</span>
                                <span style={{ color: "#94a3b8", fontSize: "11px" }}>{cert.created_at ? fmtDate(cert.created_at) : ""}</span>
                              </div>
                              <p style={{ margin: "4px 0 0", color: "#475569", fontSize: "12px" }}>{cert.body}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              )}
            </>
          )}
        </div>
      </div>
      )}

      {/* WhatsApp Outreach Modal */}
      {whatsAppModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(15, 23, 42, 0.6)",
            backdropFilter: "blur(4px)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              width: "100%",
              maxWidth: "1040px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              maxHeight: "90vh",
            }}
          >
            {/* Modal Header */}
            <div style={{ background: "#25D366", color: "#ffffff", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <WhatsAppIcon size={24} />
                <div>
                  <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 800 }}>Send WhatsApp Care Summary</h3>
                  <p style={{ margin: "2px 0 0", fontSize: "12px", opacity: 0.9 }}>
                    Communicate directly with {recipientName || "patient"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setWhatsAppModalOpen(false)}
                style={{ background: "transparent", border: "none", color: "#ffffff", fontSize: "20px", fontWeight: "bold", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ display: "flex", flex: 1, minHeight: 0, overflowY: "auto", flexWrap: "wrap" }}>
              {/* Left column: recipient, templates, actions */}
              <div style={{ flex: "1 1 380px", minWidth: 0, padding: "20px", display: "flex", flexDirection: "column", background: "#ffffff" }}>
              {/* Recipient Details */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "4px" }}>
                    Recipient Phone Number
                  </label>
                  <PhoneInput
                    countryCode={recipientPhoneCode}
                    value={recipientPhone}
                    placeholder="Mobile number, or leave blank"
                    onChange={({ countryCode, value }) => { setRecipientPhoneCode(countryCode); setRecipientPhone(value); }}
                  />
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                    Pick the country, then the mobile number (leave blank to choose a contact in WhatsApp)
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "4px" }}>
                    Recipient Name
                  </label>
                  <input
                    type="text"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    style={{
                      width: "100%",
                      height: "38px",
                      padding: "0 10px",
                      boxSizing: "border-box",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      fontSize: "13px",
                    }}
                  />
                </div>
              </div>

              {/* Template Selector */}
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "6px" }}>
                  Select Message Template
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {[
                    { key: "summary", label: "📋 Full Discharge Summary", desc: "Complete clinical overview & advice" },
                    { key: "meds", label: "💊 Medication & Care Plan", desc: "Medicine timings & home care" },
                    { key: "followup", label: "🗓️ Follow-Up Reminder", desc: "Review schedule & doctor details" },
                    { key: "quick", label: "⚡ Quick Outreach Update", desc: "Short friendly notice" },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => handleTemplateSwitch(t.key as any)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "8px",
                        textAlign: "left",
                        border: !savedTemplateId && selectedTemplate === t.key ? "1.5px solid #25D366" : "1px solid #e2e8f0",
                        background: !savedTemplateId && selectedTemplate === t.key ? "#f0fdf4" : "#f8fafc",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: "12.5px", fontWeight: 700, color: selectedTemplate === t.key ? "#15803d" : "#1e293b" }}>
                        {t.label}
                      </div>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>{t.desc}</div>
                    </button>
                  ))}
                </div>
                {savedWhatsAppTemplates.length > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "6px" }}>
                      Saved WhatsApp Templates
                    </label>
                    <select
                      value={savedTemplateId ?? ""}
                      onChange={(e) => (e.target.value ? handleSavedTemplateSwitch(Number(e.target.value)) : handleTemplateSwitch(selectedTemplate))}
                      style={{ width: "100%", height: "38px", padding: "0 10px", borderRadius: "8px", border: savedTemplateId ? "1.5px solid #25D366" : "1.5px solid #cbd5e1", fontSize: "13px", background: "#fff" }}
                    >
                      <option value="">— Use a discharge template above —</option>
                      {savedWhatsAppTemplates.filter((t) => t.category !== "SURVEY" && t.category !== "REMINDER").map((t) => (
                        <option key={t.id} value={t.id}>{t.name} · {WHATSAPP_CATEGORY_LABELS[t.category]}</option>
                      ))}
                    </select>
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                      Manage these under WhatsApp Templates. To send a feedback survey, use Survey Management so the reply can be tracked.
                    </div>
                  </div>
                )}
              </div>

            <div style={{ marginTop: "auto", paddingTop: "14px", borderTop: "1px solid #e2e8f0", display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "space-between", alignItems: "center" }}>
              <button
                type="button"
                onClick={handleCopyMessage}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  height: "38px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  background: "#ffffff",
                  border: "1.5px solid #cbd5e1",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#334155",
                  cursor: "pointer",
                }}
              >
                {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                {copied ? "Copied!" : "Copy Text"}
              </button>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setWhatsAppModalOpen(false)}
                  style={{
                    height: "38px",
                    padding: "0 16px",
                    borderRadius: "8px",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#475569",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSendWhatsApp}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    height: "38px",
                    padding: "0 20px",
                    borderRadius: "8px",
                    background: "#25D366",
                    color: "#ffffff",
                    fontSize: "13.5px",
                    fontWeight: 700,
                    border: "none",
                    cursor: "pointer",
                    boxShadow: "0 2px 6px rgba(37,211,102,0.4)",
                  }}
                >
                  <WhatsAppIcon size={17} />
                  Open in WhatsApp
                </button>
              </div>
            </div>
              </div>

              {/* Right column: editable message */}
              <div style={{ flex: "1.3 1 440px", minWidth: 0, padding: "20px", display: "flex", flexDirection: "column", background: "#f8fafc", borderLeft: "1px solid #e2e8f0" }}>
              {/* Live Message Preview & Editor */}
              <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>
                    WhatsApp Message Text (Editable)
                  </label>
                  <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                    {whatsAppMessage.length} characters
                  </span>
                </div>
                <textarea
                  value={whatsAppMessage}
                  onChange={(e) => setWhatsAppMessage(e.target.value)}
                  rows={18}
                  style={{
                    flex: 1,
                    minHeight: "380px",
                    width: "100%",
                    boxSizing: "border-box",
                    borderRadius: "8px",
                    border: "1.5px solid #cbd5e1",
                    padding: "10px 12px",
                    fontSize: "12.5px",
                    lineHeight: "1.5",
                    fontFamily: "monospace",
                    background: "#ffffff",
                    resize: "vertical",
                  }}
                />
              </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
