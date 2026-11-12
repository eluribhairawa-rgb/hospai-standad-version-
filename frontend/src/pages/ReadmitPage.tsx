import { cleanCountryCode, formatPhone, normalizeSearchQuery, validateMobileByCountry } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import DocumentUploadDropzone from "../components/DocumentUploadDropzone";
import MarkdownReport from "../components/MarkdownReport";
import { Button, Checkbox, Input, Label, Select, Table, TableCell, TableHead, TableRow, Textarea } from "../components/ui";
import { API_BASE, DOC_TYPES, SUPPORTED_DOCUMENT_ACCEPT, SUPPORTED_DOCUMENT_EXTENSIONS, isSupportedDocumentFile } from "../lib/constants";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTimeIST, getISTDateTimeKey, getTimestamp, stripUploadTimestampPrefix, filterInteger, filterDecimal } from "../lib/format";
import { printViaIframe } from "../lib/printViaIframe";
import { PRINT_BRAND_HEADER_DATA_URI, PRINT_WATERMARK_DATA_URI } from "../lib/printBrand";
import type { DocumentItem, Notice, Patient } from "../types";

type ProfileUpdates = {
  age: number | string;
  weight: number | string;
  height: number | string;
  bpSys: string;
  bpDia: string;
  temperature: string;
  pulse: string;
  spo2: string;
  phone: string;
  phone_country_code: string;
  symptoms: string;
  gender: string;
  pregnant: boolean;
};

type Props = {
  onSelect: (patient: Patient) => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onReadmitComplete?: (patientId?: string) => Promise<void>;
  ocrLanguage: string;
  onNavigate?: (pageId: string) => void;
};

type DoctorSchedule = {
  doctor_name?: string | null;
  department?: string | null;
  consultation_fee?: number | null;
  review_fee?: number | null;
  status?: string | null;
};

type OcrResultMap = Record<string, { text?: string; file?: File }>;

const IMAGE_NAME_PATTERN = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i;
const ACTIVE_READMIT_STATUSES = new Set(["In Queue", "In Consultation"]);
const FOLLOW_UP_PAYMENT_MODES = ["Cash", "UPI", "Card"];

type QueueStatusLabel = "Waiting" | "In Consultation" | "Completed";
type QueueEntry = { status: QueueStatusLabel; time: string; doctor: string; department: string; token: string };
type StatusFilter = "All" | QueueStatusLabel | "Not in Queue";

const STATUS_FILTERS: StatusFilter[] = ["All", "Waiting", "In Consultation", "Completed", "Not in Queue"];
const STATUS_PRIORITY: Record<QueueStatusLabel, number> = { "In Consultation": 3, Waiting: 2, Completed: 1 };
const STATUS_BADGE_STYLE: Record<QueueStatusLabel | "Not in Queue", { bg: string; fg: string; border: string }> = {
  Waiting: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" },
  "In Consultation": { bg: "#dbeafe", fg: "#1e40af", border: "#93c5fd" },
  Completed: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
  "Not in Queue": { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
};
const QUEUE_REFRESH_MS = 15000;

// Mirrors the status mapping used by OP Queue Management so both pages agree.
function mapQueueStatus(raw: unknown): QueueStatusLabel {
  const status = String(raw || "").trim().toLowerCase();
  if (["in_consultation", "in consultation", "consulting"].includes(status)) return "In Consultation";
  if (["completed", "done", "consulted", "finished"].includes(status)) return "Completed";
  return "Waiting";
}

function getStoredReadmitQueue() {
  try {
    const storedQueue = JSON.parse(localStorage.getItem("hospai_op_queue") || "[]");
    return Array.isArray(storedQueue) ? storedQueue : [];
  } catch {
    return [];
  }
}

function getActiveReadmitEntry(patientId?: string) {
  // Client-side duplicate check removed; rely on backend deterministic validation.
  return null;
}

function OriginalDocumentPreview({ file }: { file?: File }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!file || !url) {
    return <p className="muted">No source document available.</p>;
  }

  const mime = (file.type || "").toLowerCase();
  const isPdf = mime === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = mime.startsWith("image/") || IMAGE_NAME_PATTERN.test(file.name);

  if (isImage) {
    return <img className="ocr-source-image" src={url} alt={file.name} />;
  }

  if (isPdf) {
    return <iframe className="ocr-source-pdf" src={url} title={`Preview ${file.name}`} />;
  }

  return (
    <a className="link" href={url} target="_blank" rel="noreferrer">
      Open original document
    </a>
  );
}

/** "11 Nov, 11:46 PM" for the patient's most recent appointment, or "" when there is none. */
function lastVisitLabel(patient: Patient): string {
  const raw = patient.latest_appointment_date;
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

export default function ReadmitPage({ onSelect, setNotice, onReadmitComplete, ocrLanguage, onNavigate }: Props) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [activePatient, setActivePatient] = useState<Patient | null>(null);
  const [notes, setNotes] = useState("");
  const [profileUpdates, setProfileUpdates] = useState<ProfileUpdates>({
    age: "",
    weight: "",
    height: "",
    bpSys: "",
    bpDia: "",
    temperature: "",
    pulse: "",
    spo2: "",
    phone: "",
    phone_country_code: "+91",
    symptoms: "",
    gender: "",
    pregnant: false,
  });
  const [doctorName, setDoctorName] = useState("");
  const [doctorDepartment, setDoctorDepartment] = useState("");
  const [reviewFee, setReviewFee] = useState("");
  const [paymentMode, setPaymentMode] = useState("");
  const [readmitValidationErrors, setReadmitValidationErrors] = useState<Record<string, string>>({});
  const [doctorSchedules, setDoctorSchedules] = useState<DoctorSchedule[]>([]);
  const [docFiles, setDocFiles] = useState<Record<string, File>>({});
  const [ocrResults, setOcrResults] = useState<OcrResultMap>({});
  const [ocrStatus, setOcrStatus] = useState<Record<string, string>>({});
  const [previousDocuments, setPreviousDocuments] = useState<DocumentItem[]>([]);
  const [previousDocumentsLoading, setPreviousDocumentsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [queueByUhid, setQueueByUhid] = useState<Record<string, QueueEntry>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  // Today's OP queue keyed by UHID, from the same endpoint OP Queue Management reads.
  const loadTodayQueue = async (background = false) => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const data = await apiFetch<{ appointments?: Array<any> }>(`/api/appointments?date=${today}`, { background: background === true });
      const next: Record<string, QueueEntry> = {};
      (data.appointments || []).forEach((a) => {
        const visitType = String(a.visit_type || "").trim().toLowerCase();
        if (visitType === "emergency" || visitType === "ip") return;
        const uhid = String(a.patient_id || "").trim();
        if (!uhid) return;
        const status = mapQueueStatus(a.status);
        const existing = next[uhid];
        if (existing && STATUS_PRIORITY[existing.status] >= STATUS_PRIORITY[status]) return;
        next[uhid] = {
          status,
          // Same derivation as OP Queue Management: the appointments table stores the
          // time inside appointment_date, there is no separate time column.
          time: a.appointment_time || (a.appointment_date ? new Date(a.appointment_date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"),
          doctor: a.doctor_name || "-",
          department: a.department || "",
          token: String(a.token_no || a.id || ""),
        };
      });
      setQueueByUhid(next);
    } catch {
      // Keep the last known queue state rather than clearing it on a transient error.
    }
  };

  useEffect(() => {
    void loadTodayQueue();
    const timer = window.setInterval(() => void loadTodayQueue(true), QUEUE_REFRESH_MS);
    const onFocus = () => void loadTodayQueue();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const normalizeProfile = (patient: Patient): ProfileUpdates => {
    let sys = "";
    let dia = "";
    if (patient?.bp) {
      const parts = patient.bp.split("/");
      if (parts.length === 2) {
        sys = parts[0];
        dia = parts[1];
      }
    }
    return {
      age: patient?.age ?? "",
      weight: patient?.weight ?? "",
      height: patient?.height ?? "",
      bpSys: sys,
      bpDia: dia,
      temperature: patient?.temperature ?? "",
      pulse: patient?.pulse ?? "",
      spo2: patient?.spo2 ?? "",
      phone: patient?.phone || "",
      phone_country_code: cleanCountryCode(patient?.phone_country_code),
      symptoms: patient?.symptoms || "",
      gender: patient?.gender || "Female",
      pregnant: patient?.gender === "Female" && (patient?.pregnant === 1 || patient?.pregnant === true),
    };
  };

  useEffect(() => {
    const loadPatients = async () => {
      try {
        const data = await apiFetch<{ patients?: Patient[] }>("/api/patients");
        setPatients(data.patients || []);
      } catch (error) {
        reportError(setNotice, error as { message?: string; status?: number }, "Unable to load patients.");
      }
    };
    const loadDepartments = async () => {
      try {
        const data = await apiFetch<{ departments?: { department_name?: string }[] }>("/api/registration/departments");
        setDepartmentNames((data.departments || []).map(d => (d.department_name || "").trim()).filter(Boolean).sort((a,b)=>a.localeCompare(b)));
      } catch {
        setDepartmentNames([]);
      }
    };
    void loadPatients();
    void loadDepartments();
  }, [setNotice]);

  useEffect(() => {
    if (!doctorDepartment) {
      setDoctorSchedules([]);
      return;
    }
    let isMounted = true;
    const loadDoctorSchedules = async () => {
      try {
        const data = await apiFetch<{ schedules?: DoctorSchedule[] }>(`/api/op/doctor-schedules?department=${encodeURIComponent(doctorDepartment)}`);
        if (!isMounted) return;
        const schedules = (data.schedules || []).filter(s => {
          const status = String(s.status || 'available').trim().toLowerCase();
          return !['inactive', 'disabled', 'leave', 'full', 'unavailable', 'false', '0', 'cancelled'].includes(status);
        });
        setDoctorSchedules(schedules);

        const uniqueDocs = Array.from(new Map(schedules.map(s => [String(s.doctor_name || "").trim(), s])).values()).filter(s => String(s.doctor_name || "").trim());
        const docNames = uniqueDocs.map(s => String(s.doctor_name || "").trim());
        
        setDoctorName(prev => {
           let selectedDoc = "";
           if (prev && docNames.includes(prev)) {
             selectedDoc = prev;
           } else if (docNames.length === 1) {
             selectedDoc = docNames[0];
           }
           if (selectedDoc) {
             const match = uniqueDocs.find(s => String(s.doctor_name || "").trim() === selectedDoc);
             setReviewFee(String(match?.review_fee ?? match?.consultation_fee ?? ""));
           } else {
             setReviewFee("");
           }
           return selectedDoc;
        });
      } catch {
        if (isMounted) setDoctorSchedules([]);
      }
    };
    loadDoctorSchedules();
    return () => { isMounted = false; };
  }, [doctorDepartment]);

  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const queryDigits = normalizedQuery.replace(/\D/g, "");
  const results = normalizedQuery
    ? patients.filter((patient) => {
        const fullName = [patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
        const nameWithoutMiddle = [patient.name, patient.last_name].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
        const fields = [
          fullName,
          nameWithoutMiddle,
          patient.name,
          patient.middle_name,
          patient.last_name,
          patient.patient_id,
          patient.phone,
          patient.family_mobile,
          patient.emergency_contact,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase().replace(/\s+/g, " ").trim());
        const textHaystack = fields.join(" | ");
        const digitHaystack = fields.map((value) => value.replace(/\D/g, "")).join(" | ");
        return (
          textHaystack.includes(normalizedQuery) ||
          (queryTokens.length > 0 && queryTokens.every((token) => textHaystack.includes(token))) ||
          (queryDigits.length > 0 && digitHaystack.includes(queryDigits))
        );
      })
    : patients;

  const getRowStatus = (patient: Patient): QueueStatusLabel | "Not in Queue" =>
    queueByUhid[String(patient.patient_id || "").trim()]?.status || "Not in Queue";

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { All: results.length, Waiting: 0, "In Consultation": 0, Completed: 0, "Not in Queue": 0 };
    results.forEach((patient) => {
      counts[getRowStatus(patient)] += 1;
    });
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, queueByUhid]);

  const filteredResults = statusFilter === "All" ? results : results.filter((patient) => getRowStatus(patient) === statusFilter);

  const doctorNames = useMemo(() => {
    const unique = new Set<string>();
    doctorSchedules.forEach((schedule) => {
      const name = String(schedule.doctor_name || "").trim();
      if (name) unique.add(name);
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [doctorSchedules]);

  const [departmentNames, setDepartmentNames] = useState<string[]>([]);

  const getDoctorScheduleForName = (name: string) => {
    const normalized = String(name).trim().toLowerCase();
    return doctorSchedules.find((schedule) => String(schedule.doctor_name || "").trim().toLowerCase() === normalized);
  };

  const getDoctorsForDepartment = (department: string) => {
    const normalized = String(department).trim().toLowerCase();
    return doctorSchedules
      .filter((schedule) => String(schedule.department || "").trim().toLowerCase() === normalized)
      .map((schedule) => String(schedule.doctor_name || "").trim())
      .filter(Boolean);
  };

  const getReviewFeeForDoctor = (name: string) => {
    const schedule = getDoctorScheduleForName(name);
    if (!schedule) return undefined;
    return schedule.review_fee ?? schedule.consultation_fee ?? undefined;
  };

  const previousDocumentGroups = useMemo(() => {
    const sorted = [...previousDocuments].sort((a, b) => getTimestamp(b.created_at) - getTimestamp(a.created_at));
    const groups = new Map<string, { label: string; items: DocumentItem[] }>();
    sorted.forEach((doc) => {
      const key = getISTDateTimeKey(doc.created_at) || "unknown";
      const label = formatDateTimeIST(doc.created_at);
      if (!groups.has(key)) {
        groups.set(key, { label, items: [] });
      }
      groups.get(key)?.items.push(doc);
    });
    return Array.from(groups.entries()).map(([key, value]) => ({ key, ...value }));
  }, [previousDocuments]);

  const loadPreviousDocuments = async (patientId: string) => {
    setPreviousDocumentsLoading(true);
    try {
      const data = await apiFetch<{ documents?: DocumentItem[] }>(`/api/patients/${patientId}/documents`);
      setPreviousDocuments(data.documents || []);
    } catch {
      setPreviousDocuments([]);
      setNotice({ type: "warning", message: "Unable to load previous documents." });
    } finally {
      setPreviousDocumentsLoading(false);
    }
  };

  const handleSelect = async (patient: Patient) => {
    setActivePatient(patient);
    setNotes("");
    setDocFiles({});
    setOcrResults({});
    setOcrStatus({});
    setProfileUpdates(normalizeProfile(patient));
    setPaymentMode("");
    setReadmitValidationErrors({});
    // Fetch full patient details and auto-fill previous consultation details
    try {
      const [patientData, lastConsultation] = await Promise.all([
        apiFetch<{ patient?: Patient & { consulting_doctor?: string, department?: string, last_department?: string, last_doctor?: string } }>(`/api/patients/${patient.patient_id}`),
        apiFetch<{ department?: string; doctor_name?: string } | null>(`/api/patients/${patient.patient_id}/last-consultation`).catch(() => null)
      ]);
      
      if (patientData.patient) {
        setActivePatient(patientData.patient);
        setProfileUpdates(normalizeProfile(patientData.patient));
      }

      if (lastConsultation) {
        if (lastConsultation.department) {
          setDoctorDepartment(lastConsultation.department);
        }
        if (lastConsultation.doctor_name) {
          setDoctorName(lastConsultation.doctor_name);
        }
      }
    } catch (error) {
      setNotice({ type: "warning", message: "Loaded limited patient details for readmission edit." });
    }

    setPreviousDocuments([]);
    onSelect(patient);
    
    void loadPreviousDocuments(patient.patient_id);
  };

  const handleFileSelect = (docType: string) => (file: File | null) => {
    if (!file) {
      setDocFiles((prev) => {
        const next = { ...prev };
        delete next[docType];
        return next;
      });
      setOcrResults((prev) => {
        if (!prev[docType]) return prev;
        const next = { ...prev };
        delete next[docType];
        return next;
      });
      setOcrStatus((prev) => ({ ...prev, [docType]: "" }));
      return;
    }

    if (!isSupportedDocumentFile(file)) {
      setOcrStatus((prev) => ({ ...prev, [docType]: "Unsupported file type. Use PDF, JPG, PNG, WEBP, TIFF, BMP, GIF, HEIC, or HEIF." }));
      setDocFiles((prev) => {
        const next = { ...prev };
        delete next[docType];
        return next;
      });
      return;
    }
    setOcrStatus((prev) => ({ ...prev, [docType]: "" }));
    setDocFiles((prev) => ({ ...prev, [docType]: file }));
  };

  const handleOCR = async (docType: string) => {
    const file = docFiles[docType];
    if (!file) return;
    setOcrStatus((prev) => ({ ...prev, [docType]: "Processing OCR..." }));
    const body = new FormData();
    body.append("file", file);
    body.append("language", ocrLanguage);
    body.append("doc_type", docType);

    try {
      const response = await fetch(`${API_BASE}/api/ocr`, { method: "POST", body, credentials: "include" });
      const data = await response.json();
      setOcrResults((prev) => ({
        ...prev,
        [docType]: { text: data.text || "", file },
      }));
      setOcrStatus((prev) => ({ ...prev, [docType]: "OCR complete. Text will be saved with readmission." }));
    } catch {
      setOcrStatus((prev) => ({ ...prev, [docType]: "OCR failed." }));
    }
  };

  const handleOcrTextChange = (docType: string) => (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setOcrResults((prev) => ({
      ...prev,
      [docType]: { ...prev[docType], text: value },
    }));
  };

  const clearOcrEntry = (docType: string) => {
    setOcrResults((prev) => {
      const next = { ...prev };
      delete next[docType];
      return next;
    });
  };

  const handleProfileChange = (field: keyof ProfileUpdates) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    let value: string | boolean = field === "pregnant" ? (event.target as HTMLInputElement).checked : event.target.value;
    setProfileUpdates((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "gender" && event.target.value !== "Female") {
        next.pregnant = false;
      }
      return next;
    });
  };

  const printConfirmation = () => {
    if (!activePatient) return;
    
    const now = new Date();
    const printDate = now.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
    const printTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });



    const safeText = (t: unknown) => String(t ?? "-").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const patientName = [activePatient.name, activePatient.middle_name, activePatient.last_name].filter(Boolean).join(" ").trim() || activePatient.patient_id || "-";
    const patientId = activePatient.patient_id || "-";
    const age = profileUpdates.age || activePatient.age || "-";
    const gender = profileUpdates.gender || activePatient.gender || "-";
    const doctor = doctorName || "Doctor not assigned";
    const mobile = (profileUpdates.phone ? formatPhone(profileUpdates.phone_country_code, profileUpdates.phone) : "")
      || formatPhone(activePatient.phone_country_code, activePatient.phone) || activePatient.family_mobile || "-";
    const fee = Number(reviewFee || 0).toFixed(2);
    const operatorName = "name";
    const visitTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Re-visit Confirmation</title>
          <style>
            @page { size: A4 portrait; margin: 4mm 5mm 5mm; }
            * { box-sizing: border-box; }
            html { margin: 0; background: transparent; color: #000; font-family: Arial, Helvetica, sans-serif; }
            body { margin: 0; font-size: 8.5pt; background: transparent; line-height: 1.5; }
            .report { width: 100%; position: relative; z-index: 1; min-height: 265mm; display: flex; flex-direction: column; }
            
            /* Header */
            .header-container { display: grid; grid-template-columns: 100mm 1fr; align-items: start; margin-bottom: 2mm; margin-top: 5mm; }
            .brand-wrap { display: flex; align-items: center; gap: 4mm; }
            .brand-logo { width: auto; height: 24mm; object-fit: contain; }
            .thick-line { border-top: 1.2mm solid #000; margin: 1.5mm 0 2mm 0; }
            
            /* Title Section */
            .title-section { display: grid; grid-template-columns: 1fr 60mm; align-items: start; margin-bottom: 2mm; }
            .title-left h1 { font-size: 13pt; font-weight: 800; margin: 0 0 1mm; text-transform: uppercase; }
            .title-left p { font-size: 9.5pt; font-weight: normal; color: #111; margin: 0; }
            .meta-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
            .meta-table td { padding: 0.3mm 0; border: none !important; }
            .meta-table td:nth-child(1) { width: 25mm; }
            .meta-table td:nth-child(2) { width: 5mm; text-align: center; }
            .thin-line { border-top: 0.3mm solid #000; margin-top: 0; margin-bottom: 6mm; }
            
            .info-table { width: 100%; font-size: 9pt; margin-bottom: 12mm; border-collapse: collapse; }
            .info-table td { padding: 3mm 0; border: none !important; }
            .info-table td.label { width: 25mm; font-size: 9pt; font-weight: bold; }
            .info-table td.colon { width: 6mm; text-align: center; font-weight: bold; }
            .info-table td.val { width: 35mm; }
            
            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 25mm; border: 1px solid #000; }
            .items-table th { background-color: #0080D7; font-weight: bold; font-size: 9.5pt; color: #ffffff; padding: 3mm 4mm; border: 1px solid #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .items-table td { padding: 5mm 4mm; font-size: 9.5pt; border: 1px solid #000; }
            
            .totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 25mm; padding-right: 4mm; }
            .totals-table { width: 65mm; font-size: 9.5pt; border-collapse: collapse; }
            .totals-table td { padding: 3.5mm 0; border: none !important; }
            
            .operator { font-size: 9.5pt; margin-bottom: 5mm; padding-left: 4mm; margin-top: auto; padding-bottom: 15mm; }
            
            
            .hospai-shared-watermark {
              position: fixed;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              width: 145mm;
              max-width: 70%;
              opacity: 0.65;
              z-index: -1;
              pointer-events: none;
              display: block !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          </style>
        </head>
        <body>
          <main class="report" data-hospai-shared-print-shell>
            <img class="hospai-shared-watermark" src="${PRINT_WATERMARK_DATA_URI}" alt="HospAI Watermark" />
            
            <header>
              <div class="header-container">
                <div class="brand-wrap">
                  <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI Logo" />
                </div>
              </div>
              <div class="thick-line"></div>
            </header>

            <table class="info-table">
              <tr>
                <td class="label">Patient Name</td><td class="colon">:</td><td class="val">${safeText(patientName)}</td>
                <td class="label">Patient ID</td><td class="colon">:</td><td class="val">${safeText(patientId)}</td>
                <td class="label" style="width: 15mm;">Visit Date</td><td class="colon">:</td><td class="val" style="width: auto;">${safeText(printDate)}</td>
              </tr>
              <tr>
                <td class="label">Age</td><td class="colon">:</td><td class="val">${safeText(age)}</td>
                <td class="label">Doctor</td><td class="colon">:</td><td class="val">${safeText(doctor)}</td>
                <td class="label" style="width: 15mm;">Visit Time</td><td class="colon">:</td><td class="val" style="width: auto;">${safeText(visitTime)}</td>
              </tr>
              <tr>
                <td class="label">Gender</td><td class="colon">:</td><td class="val">${safeText(gender)}</td>
                <td class="label">Mobile Number</td><td class="colon">:</td><td class="val">${safeText(mobile)}</td>
                <td class="label" style="width: 15mm;">Visit Type</td><td class="colon">:</td><td class="val" style="width: auto;">Re-visit</td>
              </tr>
            </table>
            
            <table class="items-table">
              <thead>
                <tr>
                  <th style="text-align: center; width: 12%;">S.No.</th>
                  <th style="text-align: left; width: 48%;">Description</th>
                  <th style="text-align: center; width: 20%;">Qty</th>
                  <th style="text-align: right; width: 20%;">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="text-align: center;">1</td>
                  <td>Review Fee</td>
                  <td style="text-align: center;">1</td>
                  <td style="text-align: right;">${safeText(fee)}</td>
                </tr>
              </tbody>
            </table>
            
            <div class="totals-wrap">
              <table class="totals-table">
                <tr>
                  <td style="text-align: left;">Total Amount</td>
                  <td style="text-align: center; width: 10mm;">:</td>
                  <td style="text-align: right; font-weight: bold;">${safeText(fee)}</td>
                </tr>
                <tr>
                  <td style="text-align: left;">Amount Paid</td>
                  <td style="text-align: center; width: 10mm;">:</td>
                  <td style="text-align: right; font-weight: bold;">${safeText(fee)}</td>
                </tr>
              </table>
            </div>
            
            <div class="operator">
              <p style="margin: 0 0 10mm 0;">Operator: ${safeText(operatorName)}</p>
              <p style="margin: 0; font-weight: bold; letter-spacing: 2px;">........................................</p>
            </div>
            
          </main>
        </body>
      </html>`;
      
    printViaIframe(html);
  };

  const handleReadmit = async () => {
    if (!activePatient) return;
    const activeQueueEntry = getActiveReadmitEntry(activePatient.patient_id);
    if (activeQueueEntry) {
      setNotice({
        type: "warning",
        message: `${activePatient.patient_id} is already in OP Queue Management (${activeQueueEntry.status}). Complete the previous OP before re-visitting again.`,
      });
      return;
    }
    setSubmitting(true);
    const validationErrors: Record<string, string> = {};
    const feeValue = String(reviewFee).trim();
    if (!feeValue || Number.isNaN(Number(feeValue)) || Number(Number(feeValue)) <= 0) {
      validationErrors.reviewFee = "Review Fee is required and must be a positive number.";
    }
    if (!paymentMode.trim()) {
      validationErrors.paymentMode = "Payment Mode is required.";
    }
    const phoneError = profileUpdates.phone ? validateMobileByCountry(profileUpdates.phone, profileUpdates.phone_country_code, false) : null;
    if (phoneError) validationErrors.phone = phoneError;
    if (Object.keys(validationErrors).length > 0) {
      setReadmitValidationErrors(validationErrors);
      setNotice({ type: "warning", message: "Please fill the required follow-up details before saving." });
      setSubmitting(false);
      return;
    }
    setReadmitValidationErrors({});

    try {
      const numberOrNull = (value: number | string) => {
        if (value === "" || value === null || value === undefined) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      await apiFetch(`/api/patients/${activePatient.patient_id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...activePatient,
          age: numberOrNull(profileUpdates.age),
          phone: profileUpdates.phone,
          phone_country_code: profileUpdates.phone_country_code,
          gender: profileUpdates.gender,
          pregnant: profileUpdates.pregnant,
        }),
      });
      const additionalNotes = [
        "[Re-visit Details]",
        profileUpdates.bpSys && profileUpdates.bpDia ? `BP: ${profileUpdates.bpSys}/${profileUpdates.bpDia}` : "",
        profileUpdates.temperature ? `Temp: ${profileUpdates.temperature}` : "",
        profileUpdates.pulse ? `Pulse: ${profileUpdates.pulse}` : "",
        profileUpdates.spo2 ? `SpO2: ${profileUpdates.spo2}` : "",
        profileUpdates.height ? `Height: ${profileUpdates.height} cm` : "",
        profileUpdates.weight ? `Weight: ${profileUpdates.weight} kg` : "",
        profileUpdates.symptoms ? `Current Symptoms: ${profileUpdates.symptoms}` : "",
        doctorName ? `Doctor: ${doctorName}` : "",
        doctorDepartment ? `Department: ${doctorDepartment}` : "",
        `Review Fee: ${reviewFee}`,
        paymentMode ? `Payment Mode: ${paymentMode}` : ""
      ].filter(Boolean).join(" | ");
      const finalNotes = [additionalNotes, notes ? `[Admission Notes]\n${notes}` : ""].filter(Boolean).join("\n\n");
      // Local (IST) wall-clock time: toISOString() is UTC, which is still "yesterday"
      // before 5:30 AM IST (backend rejects past dates) and shifts the time by 5.5h.
      const now = new Date();
      const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);

      const data = await apiFetch<{ token_no: number; appointment_id: number }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          patient_id: activePatient.patient_id,
          patient_name: [activePatient.name, activePatient.middle_name, activePatient.last_name].filter(Boolean).join(" ").trim() || activePatient.patient_id || "Patient",
          visit_type: "OP",
          department: doctorDepartment || undefined,
          doctor_name: doctorName || undefined,
          appointment_date: localNow,
          appointment_kind: "follow_up",
          notes: finalNotes,
          consultation_fee: Number(reviewFee) || 0,
          payment_mode: paymentMode || "cash",
        }),
      });

      setNotice({
        type: "success",
        message: `Re-visit created. Patient added to OP Queue Management. Token: ${data.token_no}`,
      });
      setNotes("");
      setDocFiles({});
      setOcrResults({});
      setOcrStatus({});
      setPreviousDocuments([]);
      onSelect({ ...activePatient, ...profileUpdates, appointment_id: data.appointment_id });
      await onReadmitComplete?.(activePatient.patient_id);
      await loadTodayQueue();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to re-visit patient.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel">
      <h3>Re-visit Patient</h3>
      <div className="search-bar">
        <Input value={query} onChange={(event) => setQuery(normalizeSearchQuery(event.target.value, "+91"))} placeholder="Search by Name, UHID, or Mobile Number" />
      </div>
      <div className="list-meta">
        <p className="muted">
          {query.trim()
            ? `Showing ${filteredResults.length} search result${filteredResults.length === 1 ? "" : "s"}.`
            : `Showing ${filteredResults.length} patient${filteredResults.length === 1 ? "" : "s"}.`}
        </p>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", margin: "0 0 12px" }}>
        {STATUS_FILTERS.map((filter) => {
          const active = statusFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              style={{
                padding: "6px 12px",
                borderRadius: "999px",
                fontSize: "12.5px",
                fontWeight: 700,
                cursor: "pointer",
                border: active ? "1.5px solid #0f766e" : "1px solid #cbd5e1",
                background: active ? "#ccfbf1" : "#ffffff",
                color: active ? "#0f766e" : "#475569",
              }}
            >
              {filter === "Not in Queue" ? "Not in Today's Queue" : filter} ({statusCounts[filter]})
            </button>
          );
        })}
      </div>
      <div className="search-results">
        <Table className="readmit-results-table">
          <TableHead>
            <TableCell>Patient</TableCell>
            <TableCell>UHID</TableCell>
            <TableCell>Age</TableCell>
            <TableCell>Gender</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Queue Status</TableCell>
            <TableCell>Appt. Time / Last Visit</TableCell>
            <TableCell>Doctor</TableCell>
            <TableCell>Actions</TableCell>
          </TableHead>
          {filteredResults.length === 0 && <p className="muted" style={{ padding: "12px" }}>No patients match the selected filter.</p>}
          {filteredResults.map((patient) => {
            const queueEntry = queueByUhid[String(patient.patient_id || "").trim()];
            const rowStatus = queueEntry?.status || "Not in Queue";
            const badge = STATUS_BADGE_STYLE[rowStatus];
            const inQueue = Boolean(queueEntry);
            const expanded = !inQueue && activePatient?.patient_id === patient.patient_id;
            return (
              <Fragment key={patient.patient_id}>
                <TableRow 
                  className={`${expanded ? "active" : ""} cursor-pointer`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    // Patients already in today's queue are not re-admitted from here (no duplicate visits).
                    if (inQueue) return;
                    if (expanded) {
                      setActivePatient(null);
                      return;
                    }
                    void handleSelect(patient);
                  }}
                >
                  <TableCell>
                    {[patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ").trim() || patient.patient_id}
                  </TableCell>
                  <TableCell>{patient.patient_id}</TableCell>
                  <TableCell>{patient.age || "-"}</TableCell>
                  <TableCell>{patient.gender || "-"}</TableCell>
                  <TableCell>{patient.phone || "-"}</TableCell>
                  <TableCell>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "3px 10px",
                        borderRadius: "999px",
                        fontSize: "12px",
                        fontWeight: 700,
                        background: badge.bg,
                        color: badge.fg,
                        border: `1px solid ${badge.border}`,
                      }}
                    >
                      {rowStatus === "Not in Queue" ? "Not in Today's Queue" : rowStatus}
                    </span>
                  </TableCell>
                  {/* In today's queue: today's time and doctor. Otherwise: the patient's last visit, shown muted. */}
                  <TableCell>
                    {queueEntry ? (
                      queueEntry.time || "-"
                    ) : lastVisitLabel(patient) ? (
                      <span style={{ color: "#64748b" }} title="Last visit">{lastVisitLabel(patient)}</span>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell title={(queueEntry?.department || patient.latest_department) || undefined}>
                    {queueEntry ? (
                      queueEntry.doctor || "-"
                    ) : patient.latest_doctor_name && patient.latest_doctor_name !== "-" ? (
                      <span style={{ color: "#64748b" }} title="Doctor at last visit">{patient.latest_doctor_name}</span>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="row-actions">
                    {inQueue ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          onNavigate?.("op-queue-management");
                        }}
                      >
                        View Queue
                      </Button>
                    ) : (
                      <Button
                        variant={expanded ? "ghost" : "primary"}
                        size="sm"
                      >
                        {expanded ? "Hide" : "Follow-up/Re-visit"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
                {expanded && activePatient && (
                  <div className="table-row-expand">
                    <div className="readmit-form">
                      <h4>
                        Re-visiting: {activePatient.name} {activePatient.last_name} ({activePatient.patient_id})
                      </h4>
                      {onNavigate && (
                        <div style={{ background: "#eff6ff", border: "1.5px solid #93c5fd", borderRadius: "8px", padding: "10px 14px", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                          <div>
                            <strong style={{ color: "#1e40af", fontSize: "13px" }}>Admitting as Inpatient (IP)?</strong>
                            <p style={{ margin: "2px 0 0 0", color: "#3b82f6", fontSize: "12px" }}>
                              If {activePatient.name} requires bed allocation and inpatient admission, proceed directly to IP Admission.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            style={{ background: "#2563eb", borderColor: "#2563eb", fontWeight: 700 }}
                            onClick={() => {
                              localStorage.setItem("selected_admission_patient", activePatient.patient_id);
                              onNavigate("ip-admission");
                            }}
                          >
                            Proceed to IP Admission & Bed Allotment ➔
                          </Button>
                        </div>
                      )}
                      <Label>
                        Admission Notes
                        <Textarea className="readmit-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
                      </Label>
                      <h5>Update Patient Details</h5>
                      <div className="readmit-profile-grid">
                        <Label>
                          Age
                          <Input value={profileUpdates.age} readOnly className="locked-fee-input" title="Calculated age from patient record" />
                        </Label>
                        <Label>
                        Weight (kg)
                        <Input value={profileUpdates.weight} onChange={(e) => setProfileUpdates((prev) => ({ ...prev, weight: filterDecimal(e.target.value) }))} />
                      </Label>
                      <Label>
                        Height (cm)
                        <Input value={profileUpdates.height} onChange={(e) => setProfileUpdates((prev) => ({ ...prev, height: filterDecimal(e.target.value) }))} />
                      </Label>
                        <Label>
                          Blood Pressure
                        <div className="bp-split-wrap">
                          <Input value={profileUpdates.bpSys} onChange={(e) => { const v = filterInteger(e.target.value); setProfileUpdates((prev) => ({ ...prev, bpSys: v })); }} placeholder="120" inputMode="numeric" />
                          <span className="bp-separator">/</span>
                          <Input value={profileUpdates.bpDia} onChange={(e) => { const v = filterInteger(e.target.value); setProfileUpdates((prev) => ({ ...prev, bpDia: v })); }} placeholder="80" inputMode="numeric" />
                        </div>
                        </Label>
                      <Label>
                        Temperature
                        <div className="vital-input-wrap">
                          <Input value={profileUpdates.temperature} onChange={(e) => setProfileUpdates((prev) => ({ ...prev, temperature: filterDecimal(e.target.value) }))} placeholder="98.6" inputMode="decimal" />
                          <span className="vital-unit-badge">°F</span>
                        </div>
                      </Label>
                      <Label>
                        Pulse
                        <div className="vital-input-wrap">
                          <Input value={profileUpdates.pulse} onChange={(e) => setProfileUpdates((prev) => ({ ...prev, pulse: filterInteger(e.target.value) }))} placeholder="72" inputMode="numeric" />
                          <span className="vital-unit-badge">bpm</span>
                        </div>
                      </Label>
                      <Label>
                        SpO2
                        <div className="vital-input-wrap">
                          <Input value={profileUpdates.spo2} onChange={(e) => setProfileUpdates((prev) => ({ ...prev, spo2: filterDecimal(e.target.value) }))} placeholder="98" inputMode="numeric" />
                          <span className="vital-unit-badge">%</span>
                        </div>
                      </Label>
                        <Label>
                          Phone
                          <PhoneInput countryCode={profileUpdates.phone_country_code} value={profileUpdates.phone}
                            onChange={({ countryCode, value }) => setProfileUpdates((prev) => ({ ...prev, phone_country_code: countryCode, phone: value }))} />
                        </Label>
                      <Label>
                        Appointment Kind
                        <Input value="Follow-up / Re-Visit" readOnly className="locked-fee-input" title="Automatically set for Readmission" />
                      </Label>
                      <Label>
                        Doctor Department
                        <Select
                          value={doctorDepartment}
                          onChange={(event) => {
                            setDoctorDepartment(event.target.value);
                          }}
                          aria-label="Doctor department"
                        >
                          <option value="">{departmentNames.length ? "Select department" : "No Departments Available"}</option>
                          {departmentNames.map((department) => <option key={department} value={department}>{department}</option>)}
                        </Select>
                      </Label>
                                        <Label>
                        Doctor Name
                        <Select
                          value={doctorName}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDoctorName(value);
                            const match = getDoctorScheduleForName(value);
                            if (match) {
                              setReviewFee(String(match.review_fee ?? match.consultation_fee ?? ""));
                            } else {
                              setReviewFee("");
                            }
                          }}
                          aria-label="Doctor name"
                        >
                          <option value="" disabled={doctorNames.length > 0}>
                            {doctorNames.length ? "Select doctor" : "No doctors available"}
                          </option>
                          {doctorNames.map((name) => <option key={name} value={name}>{name}</option>)}
                        </Select>
                        {doctorDepartment && doctorNames.length === 0 && (
                          <span className="field-error" style={{ color: "#ef4444", fontSize: "11px", marginTop: "4px", display: "block", fontWeight: "500" }}>
                            No doctors available for the selected department.
                          </span>
                        )}
                      </Label>
                      <Label>
                        <span className="label-text">Review Fee <span className="required-marker">*</span></span>
                        <Input
                          type="number"
                          min={0}
                          value={reviewFee}
                          onChange={(event) => {
                            setReviewFee(event.target.value);
                            if (readmitValidationErrors.reviewFee) {
                              setReadmitValidationErrors((prev) => {
                                const next = { ...prev };
                                delete next.reviewFee;
                                return next;
                              });
                            }
                          }}
                          placeholder="0"
                          aria-label="Review fee"
                          readOnly={true}
                          className="locked-fee-input"
                          title="Review fee is dynamically fetched from Doctor Scheduling"
                        />
                        {readmitValidationErrors.reviewFee && <span className="field-error">{readmitValidationErrors.reviewFee}</span>}
                      </Label>
                      <Label>
                        <span className="label-text">Payment Mode <span className="required-marker">*</span></span>
                        <Select
                          value={paymentMode}
                          onChange={(event) => {
                            setPaymentMode(event.target.value);
                            if (readmitValidationErrors.paymentMode) {
                              setReadmitValidationErrors((prev) => {
                                const next = { ...prev };
                                delete next.paymentMode;
                                return next;
                              });
                            }
                          }}
                        >
                          <option value="">Select payment mode</option>
                          {FOLLOW_UP_PAYMENT_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {mode}
                            </option>
                          ))}
                        </Select>
                        {readmitValidationErrors.paymentMode && <span className="field-error">{readmitValidationErrors.paymentMode}</span>}
                      </Label>
                      <Label>
                        Gender
                        <Select value={profileUpdates.gender} onChange={handleProfileChange("gender")}>
                            <option>Male</option>
                            <option>Female</option>
                            <option>Other</option>
                          </Select>
                        </Label>
                        {profileUpdates.gender === "Female" && (
                          <Label className="checkbox">
                            <Checkbox checked={profileUpdates.pregnant} onChange={handleProfileChange("pregnant")} />
                            Pregnant
                          </Label>
                        )}
                        <Label className="span-2">
                          Current Symptoms
                          <Textarea value={profileUpdates.symptoms} onChange={handleProfileChange("symptoms")} rows={3} />
                        </Label>
                      </div>

                      <div className="queue-note">
                        {getActiveReadmitEntry(activePatient.patient_id) ? (
                          <>
                            This patient is already in <b>OP Queue Management</b>. Complete the active OP token before re-visitting again.
                          </>
                        ) : (
                          <>
                            After confirmation, this patient will be added directly to <b>OP Queue Management</b> with visit type <b>Re-visit</b>.
                          </>
                        )}
                      </div>

                      <div className="readmit-actions">
                        <Button variant="secondary" onClick={printConfirmation} disabled={!activePatient}>
                          Print Confirmation
                        </Button>
                        <Button variant="primary" onClick={() => void handleReadmit()} disabled={submitting || Boolean(getActiveReadmitEntry(activePatient.patient_id))}>
                          {submitting ? "Submitting..." : "Confirm Re-admission"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </Table>
      </div>
    </section>
  );
}
