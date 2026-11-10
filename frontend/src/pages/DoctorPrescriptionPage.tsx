import React, { useState, useEffect, useMemo, useRef } from "react";
import { cleanCountryCode, splitStoredPhone, toWhatsAppNumber } from "../lib/phone";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError, getHospitalCode } from "../lib/api";
import { API_BASE } from "../lib/constants";
import type { Notice } from "../types";
import BrandLogo from "../components/BrandLogo";
import { HOSPAI_PRINT_FOOTER_CSS } from "../lib/printViaIframe";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onOpenPatient?: (patientId: string) => void;
  onNavigate?: (pageId: string) => void;
  /** Doctor-linked login: prescriptions are always signed as this doctor (the API enforces it). */
  scopedDoctor?: string | null;
};

export type QueueItem = {
  id: string;
  token: string;
  name: string;
  uhid: string;
  ageGender: string;
  doctor: string;
  department: string;
  appointmentTime: string;
  status: "Waiting" | "In Consultation" | "Completed";
  visitType: string;
  phone?: string;
  appointmentId?: number;
  consultationFee?: number | string;
  paymentMode?: string;
  symptoms?: string;
  notes?: string;
  appointmentDate?: string;
};

export type MedicineItem = {
  id: string;
  medicine_name: string;
  dosage: string;
  frequency: string;
  is_custom?: boolean;
  freq_m?: string;
  freq_a?: string;
  freq_n?: string;
  duration: string;
  instructions: string;
};

type SavedMedicine = { medicine_name: string; dosage: string; frequency: string; duration: string; instructions: string };

type RxSuggestions = {
  source: "doctor" | "all" | null;
  prescription_count: number;
  medicines: (SavedMedicine & { count: number })[];
  lab_tests: { name: string; count: number }[];
};

/** Editor row for a medicine read from OCR or past prescriptions */
function toMedicineItem(m: SavedMedicine, id: string): MedicineItem {
  return {
    id,
    medicine_name: m.medicine_name,
    dosage: m.dosage || "",
    frequency: m.frequency || "",
    duration: m.duration || "",
    instructions: m.instructions || "",
  };
}

type OcrPrescriptionFields = {
  patient_name: string;
  patient_age: string;
  patient_gender: string;
  symptoms: string;
  diagnosis: string;
  vitals: { bp: string; pulse: string; temperature: string; weight: string; spo2: string };
  labs: { fbs: string; ppbs: string; hba1c: string; total_cholesterol: string; ldl: string; tgl: string; vitamin_d: string };
  medicines: { medicine_name: string; dosage: string; frequency: string; duration: string; instructions: string }[];
  lab_tests: string;
  advice: string;
  follow_up_date: string;
};

const COMMON_DRUGS = [
  { name: "Paracetamol 650mg (Dolo)", dosage: "650 mg", freq: "1-1-1", duration: "3 Days", inst: "After Food" },
  { name: "Amoxicillin + Clavulanate 625mg (Augmentin)", dosage: "625 mg", freq: "1-0-1", duration: "5 Days", inst: "After Food" },
  { name: "Pantoprazole 40mg (Pan 40)", dosage: "40 mg", freq: "1-0-0", duration: "7 Days", inst: "Before Food (Empty Stomach)" },
  { name: "Azithromycin 500mg (Azee)", dosage: "500 mg", freq: "1-0-0", duration: "3 Days", inst: "After Food" },
  { name: "Cetirizine 10mg (Cetzine)", dosage: "10 mg", freq: "0-0-1", duration: "5 Days", inst: "At Bedtime" },
  { name: "Metformin 500mg (Glycomet)", dosage: "500 mg", freq: "1-0-1", duration: "30 Days", inst: "After Food" },
  { name: "Telmisartan 40mg (Telma 40)", dosage: "40 mg", freq: "1-0-0", duration: "30 Days", inst: "Morning After Food" },
  { name: "Atorvastatin 10mg (Atorva)", dosage: "10 mg", freq: "0-0-1", duration: "30 Days", inst: "At Bedtime" },
  { name: "Ibuprofen 400mg (Brufen)", dosage: "400 mg", freq: "1-0-1", duration: "3 Days", inst: "After Food" },
  { name: "Cough Syrup (Ascoril LS)", dosage: "10 ml", freq: "1-1-1", duration: "5 Days", inst: "After Food" },
  { name: "Multivitamin (Becadexamin)", dosage: "1 Cap", freq: "1-0-0", duration: "15 Days", inst: "After Food" },
  { name: "Rabeprazole + Domperidone (Rablet-D)", dosage: "20mg/30mg", freq: "1-0-0", duration: "10 Days", inst: "Before Food" },
];

const WhatsAppIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.031 2C6.504 2 2 6.504 2 12.031c0 1.954.563 3.778 1.536 5.32L2 22l4.821-1.503a10.007 10.007 0 0 0 5.21 1.534h.005c5.526 0 10.03-4.504 10.03-10.031A10.02 10.02 0 0 0 12.031 2zm0 18.272a8.23 8.23 0 0 1-4.214-1.157l-.302-.18-2.862.893.908-2.793-.197-.313A8.216 8.216 0 0 1 3.784 12.03c0-4.549 3.7-8.249 8.249-8.249 4.547 0 8.246 3.7 8.246 8.25 0 4.548-3.7 8.241-8.248 8.241zm4.52-6.177c-.248-.124-1.465-.723-1.692-.806-.228-.083-.393-.124-.559.124-.166.248-.642.806-.786.971-.145.166-.29.186-.538.062-.248-.124-1.049-.387-1.997-1.233-.738-.658-1.237-1.472-1.382-1.72-.145-.248-.016-.382.108-.506.112-.111.248-.29.373-.435.124-.145.166-.248.248-.414.083-.166.042-.311-.02-.435-.063-.124-.559-1.348-.766-1.846-.201-.485-.406-.419-.559-.427l-.476-.008c-.166 0-.435.062-.663.311-.228.248-.87 1.056-.87 2.574s1.099 2.984 1.253 3.191c.155.207 2.164 3.305 5.244 4.634.733.317 1.305.506 1.751.648.736.234 1.406.201 1.936.122.591-.088 1.815-.742 2.072-1.458.257-.716.257-1.33.18-1.458-.076-.124-.241-.186-.489-.31z" />
  </svg>
);

const COMMON_DIAGNOSES = [
  "Viral Fever / Pyrexia",
  "Upper Respiratory Tract Infection (URTI)",
  "Acute Bronchitis",
  "Acute Gastritis / Acid Peptic Disease",
  "Essential Hypertension",
  "Type 2 Diabetes Mellitus",
  "Gastroenteritis / Acute Diarrhea",
  "Urinary Tract Infection (UTI)",
  "Allergic Rhinitis / Sinusitis",
  "Migraine / Tension Headache",
  "Lumbar Spondylosis / Low Back Ache",
  "General Bodyache & Malaise",
];

const COMMON_LAB_TESTS = [
  "Complete Blood Count (CBC)",
  "Lipid Profile",
  "Liver Function Test (LFT)",
  "Kidney Function Test (KFT)",
  "Urine Routine & Microscopic",
  "Fasting Blood Sugar (FBS)",
  "Post Prandial Blood Sugar (PPBS)",
  "HbA1c (Glycated Hemoglobin)",
  "Thyroid Profile (T3, T4, TSH)",
  "Serum Creatinine & Urea",
  "Chest X-Ray PA View",
  "12-Lead ECG",
  "Ultrasound Whole Abdomen",
];

const DEFAULT_FREQUENCIES: string[] = [
  "1-0-1",
  "1-0-0",
  "0-0-1",
  "1-1-1",
  "0-1-0",
  "1-0-1-0",
  "1-1-1-1",
  "SOS",
  "Stat",
  "OD",
  "BD",
  "TDS",
  "QID",
  "Alternate Days",
  "Weekly Once",
];

const FREQUENCIES_STORAGE_KEY = "hospai_prescription_frequencies";

function getStoredFrequencies(): string[] {
  try {
    const raw = localStorage.getItem(FREQUENCIES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // fallback
  }
  return DEFAULT_FREQUENCIES;
}

interface FrequencyComboboxProps {
  value: string;
  onChange: (val: string) => void;
  options: string[];
  onAddOption: (opt: string) => void;
  onDeleteOption: (opt: string) => void;
  onResetDefaults?: () => void;
  placeholder?: string;
}

const FrequencyCombobox: React.FC<FrequencyComboboxProps> = ({
  value,
  onChange,
  options,
  onAddOption,
  onDeleteOption,
  onResetDefaults,
  placeholder = "e.g. 1-0-1 / SOS",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [newOption, setNewOption] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleAddNew = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newOption.trim();
    if (!trimmed) return;
    onAddOption(trimmed);
    onChange(trimmed);
    setNewOption("");
  };

  const hasCustomTypedValue = value && value.trim() && !options.includes(value.trim());

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
        <input
          type="text"
          className="table-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          style={{
            paddingRight: "26px",
            fontWeight: 600,
            fontSize: "12.5px",
            height: "32px",
            borderRadius: "4px",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          title="Toggle frequency dropdown menu"
          aria-label="Toggle frequency dropdown menu"
          style={{
            position: "absolute",
            right: "4px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            padding: "4px 6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "3px",
            fontSize: "10px",
          }}
        >
          {isOpen ? "▲" : "▼"}
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            width: "235px",
            background: "#ffffff",
            border: "1.5px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 10px 25px -5px rgba(15, 23, 42, 0.2), 0 8px 10px -6px rgba(15, 23, 42, 0.1)",
            zIndex: 1000,
            padding: "6px",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "4px 6px 6px",
              borderBottom: "1px solid #f1f5f9",
              fontSize: "11px",
              fontWeight: 700,
              color: "#334155",
            }}
          >
            <span>Frequencies ({options.length})</span>
            {onResetDefaults && (
              <button
                type="button"
                onClick={onResetDefaults}
                style={{
                  background: "none",
                  border: "none",
                  color: "#0284c7",
                  fontSize: "10.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
                title="Restore default frequencies"
              >
                Reset Defaults
              </button>
            )}
          </div>

          {/* Quick-add current typed text if not yet in options */}
          {hasCustomTypedValue && (
            <div style={{ padding: "4px 2px", borderBottom: "1px solid #f1f5f9" }}>
              <button
                type="button"
                onClick={() => {
                  onAddOption(value.trim());
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "#f0fdf4",
                  border: "1px dashed #86efac",
                  borderRadius: "5px",
                  padding: "4px 8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#166534",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                title={`Add "${value.trim()}" to saved frequency list`}
              >
                <span>+ Save &quot;{value.trim()}&quot; to list</span>
                <span style={{ fontSize: "12px" }}>↵</span>
              </button>
            </div>
          )}

          {/* Scrollable list of options with delete icon */}
          <div
            style={{
              maxHeight: "160px",
              overflowY: "auto",
              margin: "4px 0",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {options.length === 0 ? (
              <div style={{ padding: "10px", fontSize: "11px", color: "#94a3b8", textAlign: "center" }}>
                No options in list. Add below!
              </div>
            ) : (
              options.map((opt) => {
                const isSelected = opt === value;
                return (
                  <div
                    key={opt}
                    onClick={() => {
                      onChange(opt);
                      setIsOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "5px 8px",
                      borderRadius: "5px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: isSelected ? 700 : 500,
                      background: isSelected ? "#e0f2fe" : "#ffffff",
                      color: isSelected ? "#0369a1" : "#1e293b",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#f8fafc";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#ffffff";
                    }}
                  >
                    <span>{opt}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteOption(opt);
                      }}
                      title={`Remove "${opt}" from dropdown list`}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#94a3b8",
                        cursor: "pointer",
                        fontSize: "13px",
                        lineHeight: 1,
                        padding: "2px 5px",
                        borderRadius: "3px",
                        fontWeight: 700,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                        (e.currentTarget as HTMLButtonElement).style.background = "#fee2e2";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#94a3b8";
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Manage: Add new option input form */}
          <div
            style={{
              paddingTop: "6px",
              borderTop: "1px solid #f1f5f9",
            }}
          >
            <form
              onSubmit={handleAddNew}
              style={{
                display: "flex",
                gap: "4px",
                alignItems: "center",
              }}
            >
              <input
                type="text"
                placeholder="New option (e.g. 2-0-2)..."
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  fontSize: "11px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => handleAddNew()}
                disabled={!newOption.trim()}
                style={{
                  background: newOption.trim() ? "#0284c7" : "#e2e8f0",
                  color: newOption.trim() ? "#ffffff" : "#94a3b8",
                  border: "none",
                  borderRadius: "4px",
                  padding: "4px 8px",
                  fontSize: "11px",
                  fontWeight: 700,
                  cursor: newOption.trim() ? "pointer" : "default",
                  whiteSpace: "nowrap",
                }}
              >
                + Add
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default function DoctorPrescriptionPage({ setNotice, onOpenPatient, onNavigate, scopedDoctor }: Props) {
  // Today's date
  const [selectedDate, setSelectedDate] = useState(() => new Date().toLocaleDateString("en-CA"));

  // Queue state
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [queueStatusFilter, setQueueStatusFilter] = useState<"ALL" | "Waiting" | "In Consultation" | "Completed">("ALL");
  const [queueSearch, setQueueSearch] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState("All Departments");
  const [selectedDoctor, setSelectedDoctor] = useState("All Doctors");
  const [departmentsList, setDepartmentsList] = useState<string[]>([]);
  const [doctorsList, setDoctorsList] = useState<string[]>([]);
  const [isQueueCollapsed, setIsQueueCollapsed] = useState(false);

  // Active Patient Prescription State
  const [activeQueueItem, setActiveQueueItem] = useState<QueueItem | null>(null);
  const [patientUhid, setPatientUhid] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [patientGender, setPatientGender] = useState("Male");
  const [patientPhone, setPatientPhone] = useState("");
  const [patientPhoneCode, setPatientPhoneCode] = useState("+91");
  const [doctorName, setDoctorNameState] = useState(scopedDoctor || "Dr. Rajesh Sharma, MD");
  const setDoctorName = (name: string) => setDoctorNameState(scopedDoctor || name);
  const [department, setDepartment] = useState("General Medicine");
  const [appointmentId, setAppointmentId] = useState<number | null>(null);
  const [appointmentToken, setAppointmentToken] = useState("");
  const [visitType, setVisitType] = useState("OP Consultation");

  // Clinical Details
  const [symptoms, setSymptoms] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [vitalsBp, setVitalsBp] = useState("");
  const [vitalsPulse, setVitalsPulse] = useState("");
  const [vitalsTemp, setVitalsTemp] = useState("");
  const [vitalsWeight, setVitalsWeight] = useState("");
  const [vitalsSpo2, setVitalsSpo2] = useState("");
  const [loadingVitals, setLoadingVitals] = useState(false);
  const [latestVitalsRecord, setLatestVitalsRecord] = useState<{
    id?: number;
    bp?: string | null;
    pulse?: number | string | null;
    temperature?: number | string | null;
    weight?: number | string | null;
    height?: number | string | null;
    spo2?: number | string | null;
    recorded_at?: string;
  } | null>(null);
  const [vitalsSourceUhid, setVitalsSourceUhid] = useState<string>("");

  // Lab Results / Parameters Box
  const [labFbs, setLabFbs] = useState("");
  const [labPpbs, setLabPpbs] = useState("");
  const [labHba1c, setLabHba1c] = useState("");
  const [labTchol, setLabTchol] = useState("");
  const [labLdl, setLabLdl] = useState("");
  const [labTgl, setLabTgl] = useState("");
  const [labVitd, setLabVitd] = useState("");

  // Manageable frequency dropdown options (persisted across sessions)
  const [frequencyOptions, setFrequencyOptions] = useState<string[]>(getStoredFrequencies);

  const handleAddFrequencyOption = (newOpt: string) => {
    const trimmed = newOpt.trim();
    if (!trimmed) return;
    if (frequencyOptions.includes(trimmed)) return;
    const updated = [...frequencyOptions, trimmed];
    setFrequencyOptions(updated);
    try {
      localStorage.setItem(FREQUENCIES_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // ignore
    }
  };

  const handleDeleteFrequencyOption = (optToDelete: string) => {
    const updated = frequencyOptions.filter((opt) => opt !== optToDelete);
    setFrequencyOptions(updated);
    try {
      localStorage.setItem(FREQUENCIES_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // ignore
    }
  };

  const handleResetFrequencyOptions = () => {
    setFrequencyOptions(DEFAULT_FREQUENCIES);
    try {
      localStorage.setItem(FREQUENCIES_STORAGE_KEY, JSON.stringify(DEFAULT_FREQUENCIES));
    } catch {
      // ignore
    }
  };

  // Medicines List - Starts with clean empty fields without dummy data
  const [medicines, setMedicines] = useState<MedicineItem[]>([
    {
      id: "med-1",
      medicine_name: "",
      dosage: "",
      frequency: "",
      duration: "",
      instructions: "",
    },
  ]);

  // Lab Tests & Advice
  const [labTests, setLabTests] = useState("");
  const [advice, setAdvice] = useState("");
  const [followUpDate, setFollowUpDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return d.toLocaleDateString("en-CA");
  });
  const [sendToPharmacy, setSendToPharmacy] = useState(true);

  // Search registered patients manually & Directory
  const [patientSearchTerm, setPatientSearchTerm] = useState("");
  const [searchingPatient, setSearchingPatient] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [registeredPatients, setRegisteredPatients] = useState<any[]>([]);
  const [loadingRegisteredPatients, setLoadingRegisteredPatients] = useState(false);
  const [patientDirectoryModalOpen, setPatientDirectoryModalOpen] = useState(false);
  const [topViewMode, setTopViewMode] = useState<"queue" | "directory">("queue");
  const [uhidDropdownOpen, setUhidDropdownOpen] = useState(false);
  const [directorySearch, setDirectorySearch] = useState("");

  // Submitting / completing
  const [submitting, setSubmitting] = useState(false);

  // OCR auto-fill: upload a prescription image, Qwen OCR reads it, consultation fields are filled in.
  const [ocrScanning, setOcrScanning] = useState(false);
  const [ocrFileName, setOcrFileName] = useState("");
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState("");

  useEffect(() => () => {
    if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
  }, [ocrPreviewUrl]);

  const applyOcrPrescription = (f: OcrPrescriptionFields): string[] => {
    const filled: string[] = [];
    const put = (value: string, setter: (v: string) => void, label: string) => {
      if (value) {
        setter(value);
        filled.push(label);
      }
    };
    // Patient identity normally comes from the queue; only fill what is still blank.
    if (!patientName.trim()) put(f.patient_name, setPatientName, "Patient name");
    if (!patientAge.trim()) put(f.patient_age, setPatientAge, "Age");
    if (!patientUhid.trim()) put(f.patient_gender, setPatientGender, "Gender");
    put(f.symptoms, setSymptoms, "Symptoms");
    put(f.diagnosis, setDiagnosis, "Diagnosis");
    put(f.vitals.bp, setVitalsBp, "BP");
    put(f.vitals.pulse, setVitalsPulse, "Pulse");
    put(f.vitals.temperature, setVitalsTemp, "Temperature");
    put(f.vitals.weight, setVitalsWeight, "Weight");
    put(f.vitals.spo2, setVitalsSpo2, "SpO2");
    put(f.labs.fbs, setLabFbs, "FBS");
    put(f.labs.ppbs, setLabPpbs, "PPBS");
    put(f.labs.hba1c, setLabHba1c, "HbA1c");
    put(f.labs.total_cholesterol, setLabTchol, "T. Chol");
    put(f.labs.ldl, setLabLdl, "LDL");
    put(f.labs.tgl, setLabTgl, "TGL");
    put(f.labs.vitamin_d, setLabVitd, "Vit-D");
    put(f.lab_tests, setLabTests, "Lab tests");
    put(f.advice, setAdvice, "Advice");
    put(f.follow_up_date, setFollowUpDate, "Follow-up date");
    if (f.medicines.length) {
      const stamp = Date.now();
      const scanned: MedicineItem[] = f.medicines.map((m, i) => toMedicineItem(m, `med-ocr-${stamp}-${i}`));
      // Replace blank placeholder rows, keep any medicines the doctor already entered.
      setMedicines((prev) => [...prev.filter((m) => m.medicine_name.trim()), ...scanned]);
      filled.push(`${scanned.length} medicine${scanned.length > 1 ? "s" : ""}`);
    }
    return filled;
  };

  const handleOcrUpload = async (file: File | undefined) => {
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) {
      setNotice({ type: "warning", message: "Please upload an image file (JPG, PNG, WEBP, TIFF, BMP, GIF...)." });
      return;
    }
    setOcrFileName(file.name);
    setOcrPreviewUrl(URL.createObjectURL(file));
    setOcrScanning(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const baseUrl = (API_BASE || "").replace(/\/+$/, "").replace(/\/api$/, "");
      const response = await fetch(`${baseUrl}/api/ocr/prescription-fields`, {
        method: "POST",
        body,
        credentials: "include",
        headers: { "X-Hospital-Code": getHospitalCode() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(data?.detail || data?.error || "OCR failed."), { status: response.status });
      }
      const filled = applyOcrPrescription(data.fields as OcrPrescriptionFields);
      setNotice(
        filled.length
          ? { type: "success", message: `OCR filled: ${filled.join(", ")}. Please verify before saving the prescription.` }
          : { type: "warning", message: "No prescription details could be read from this image. Try a clearer photo." }
      );
    } catch (err) {
      reportError(setNotice, err as any, "OCR failed.");
    } finally {
      setOcrScanning(false);
    }
  };
  const printSheetRef = useRef<HTMLDivElement>(null);

  // Fetch live queue from backend
  const fetchLiveQueue = async () => {
    setLoadingQueue(true);
    try {
      const data = await apiFetch<{ appointments?: Array<any> }>(`/api/appointments?date=${selectedDate}`);
      const appointments = (data?.appointments || []).filter((a) => {
        const vt = String(a.visit_type || "").trim().toLowerCase();
        return vt !== "emergency" && vt !== "ip";
      });

      const depts = new Set<string>();
      const docs = new Set<string>();

      const mapped: QueueItem[] = appointments.map((a) => {
        const ag = [a.age, a.gender].filter(Boolean).join(" / ");
        const rawStatus = String(a.status || "").trim().toLowerCase();
        const status: "Waiting" | "In Consultation" | "Completed" =
          ["in_consultation", "in consultation", "consulting"].includes(rawStatus)
            ? "In Consultation"
            : ["completed", "done", "consulted", "finished"].includes(rawStatus)
            ? "Completed"
            : "Waiting";

        if (a.department) depts.add(String(a.department).trim());
        if (a.doctor_name) docs.add(String(a.doctor_name).trim());

        const timeStr =
          a.appointment_time ||
          (a.appointment_date ? new Date(a.appointment_date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-");

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
          visitType: a.visit_type || "OP Consultation",
          phone: a.phone || a.mobile || "",
          appointmentId: a.id,
          consultationFee: a.consultation_fee ?? a.fee,
          paymentMode: a.payment_mode,
          symptoms: a.symptoms || a.chief_complaint || "",
          notes: a.notes,
          appointmentDate: a.appointment_date,
        };
      });

      setQueue(mapped);
      setDepartmentsList(Array.from(depts).filter(Boolean).sort());
      setDoctorsList(Array.from(docs).filter(Boolean).sort());

      // If active patient exists, update their status reference from the freshly fetched appointments
      if (activeQueueItem) {
        const updatedActive = mapped.find((item) => item.appointmentId === activeQueueItem.appointmentId);
        if (updatedActive) {
          setActiveQueueItem(updatedActive);
        }
      }
    } catch (err) {
      // keep existing queue
    } finally {
      setLoadingQueue(false);
    }
  };

  useEffect(() => {
    void fetchLiveQueue();
  }, [selectedDate]);

  // Also pre-fetch common inventory medicines if available
  const [pharmacyMeds, setPharmacyMeds] = useState<{ medicine_name?: string; brand_name?: string }[]>([]);
  useEffect(() => {
    apiFetch<{ medicines?: any[] }>("/api/pharmacy/medicines")
      .then((res) => {
        if (res?.medicines && Array.isArray(res.medicines)) {
          setPharmacyMeds(res.medicines);
        }
      })
      .catch(() => {});
  }, []);

  // Medicines / tests usually prescribed for this diagnosis, from saved prescriptions (the doctor's own first).
  const [rxSuggestions, setRxSuggestions] = useState<RxSuggestions | null>(null);
  useEffect(() => {
    const term = diagnosis.trim();
    if (term.length < 3) {
      setRxSuggestions(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ diagnosis: term });
      if (doctorName.trim()) params.set("doctor_name", doctorName.trim());
      apiFetch<RxSuggestions>(`/api/prescriptions/suggestions?${params.toString()}`)
        .then((res) => { if (!cancelled) setRxSuggestions(res); })
        .catch(() => { if (!cancelled) setRxSuggestions(null); });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [diagnosis, doctorName]);

  const suggestedMedicines = useMemo(() => {
    const present = new Set(medicines.map((m) => m.medicine_name.trim().toLowerCase()).filter(Boolean));
    return (rxSuggestions?.medicines || []).filter((m) => !present.has(m.medicine_name.trim().toLowerCase()));
  }, [rxSuggestions, medicines]);

  const suggestedLabTests = useMemo(() => {
    const present = new Set(labTests.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
    return (rxSuggestions?.lab_tests || []).filter((t) => !present.has(t.name.trim().toLowerCase()));
  }, [rxSuggestions, labTests]);

  const handleAddSuggestedMedicines = (list: SavedMedicine[]) => {
    const stamp = Date.now();
    // Replace blank placeholder rows, keep any medicines the doctor already entered.
    setMedicines((prev) => [
      ...prev.filter((m) => m.medicine_name.trim()),
      ...list.map((m, i) => toMedicineItem(m, `med-sug-${stamp}-${i}`)),
    ]);
    setNotice({ type: "success", message: `Added ${list.length === 1 ? list[0].medicine_name : `${list.length} medicines`}. Review dosage before saving.` });
  };

  // Fetch all registered patients from hospital database for UHID selection
  const fetchAllRegisteredPatients = async () => {
    setLoadingRegisteredPatients(true);
    try {
      const res = await apiFetch<{ patients?: any[] }>("/api/patients");
      if (res?.patients && Array.isArray(res.patients)) {
        setRegisteredPatients(res.patients);
      }
    } catch {
      // non-fatal
    } finally {
      setLoadingRegisteredPatients(false);
    }
  };

  useEffect(() => {
    void fetchAllRegisteredPatients();
  }, []);

  const getPatientFullName = (p: any) => {
    if (!p) return "";
    const parts = [p.name, p.middle_name, p.last_name].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
    return p.full_name || p.patient_name || p.name || "Registered Patient";
  };

  // Filtered queue items
  const filteredQueue = useMemo(() => {
    const qTerm = queueSearch.trim().toLowerCase();
    const docTerm = selectedDoctor.trim().toLowerCase();
    const deptTerm = selectedDepartment.trim().toLowerCase();

    return queue.filter((item) => {
      // Status filter
      if (queueStatusFilter !== "ALL" && item.status !== queueStatusFilter) {
        return false;
      }
      // Department filter
      if (selectedDepartment !== "All Departments" && item.department.toLowerCase() !== deptTerm) {
        return false;
      }
      // Doctor filter
      if (selectedDoctor !== "All Doctors" && item.doctor.toLowerCase() !== docTerm) {
        return false;
      }
      // Search term (name, token, uhid, phone)
      if (qTerm) {
        const matchName = item.name.toLowerCase().includes(qTerm);
        const matchToken = item.token.toLowerCase().includes(qTerm);
        const matchUhid = item.uhid.toLowerCase().includes(qTerm);
        const matchPhone = (item.phone || "").toLowerCase().includes(qTerm);
        if (!matchName && !matchToken && !matchUhid && !matchPhone) {
          return false;
        }
      }
      return true;
    });
  }, [queue, queueStatusFilter, selectedDepartment, selectedDoctor, queueSearch]);

  // Counts
  const queueCounts = useMemo(() => {
    const waiting = queue.filter((i) => i.status === "Waiting").length;
    const inConsultation = queue.filter((i) => i.status === "In Consultation").length;
    const completed = queue.filter((i) => i.status === "Completed").length;
    return {
      all: queue.length,
      waiting,
      inConsultation,
      completed,
    };
  }, [queue]);

  // Registered patients matching queue search term
  const matchingRegisteredForQueue = useMemo(() => {
    if (!queueSearch.trim()) return [];
    const q = queueSearch.trim().toLowerCase();
    return registeredPatients.filter((p) => {
      const pid = (p.patient_id || p.id || "").toLowerCase();
      const name = getPatientFullName(p).toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      return pid.includes(q) || name.includes(q) || phone.includes(q);
    }).slice(0, 8);
  }, [queueSearch, registeredPatients]);

  // Registered patients displayed in top directory view
  const displayedRegistered = useMemo(() => {
    if (!queueSearch.trim()) return registeredPatients;
    const q = queueSearch.trim().toLowerCase();
    return registeredPatients.filter((p) => {
      const pid = (p.patient_id || p.id || "").toLowerCase();
      const name = getPatientFullName(p).toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      return pid.includes(q) || name.includes(q) || phone.includes(q);
    });
  }, [queueSearch, registeredPatients]);

  // Matching registered patients for live UHID input autocomplete
  const matchingUhidPatients = useMemo(() => {
    if (!patientUhid.trim()) return [];
    const q = patientUhid.trim().toLowerCase();
    return registeredPatients.filter((p) => {
      const pid = (p.patient_id || p.id || "").toLowerCase();
      const name = getPatientFullName(p).toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      return pid.includes(q) || name.includes(q) || phone.includes(q);
    }).slice(0, 6);
  }, [patientUhid, registeredPatients]);

  // Filtered patients for Directory Modal
  const modalFilteredPatients = useMemo(() => {
    if (!directorySearch.trim()) return registeredPatients;
    const q = directorySearch.trim().toLowerCase();
    return registeredPatients.filter((p) => {
      const pid = (p.patient_id || p.id || "").toLowerCase();
      const name = getPatientFullName(p).toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      return pid.includes(q) || name.includes(q) || phone.includes(q);
    });
  }, [directorySearch, registeredPatients]);

  // Auto-fill vitals from latest recorded patient vitals
  const loadPatientLatestVitals = async (uhid: string, fallbackPatient?: any, forceNotification = false) => {
    if (!uhid || !uhid.trim()) {
      if (forceNotification) {
        setNotice({ type: "warning", message: "Please select a patient or enter a valid UHID first." });
      }
      return;
    }
    const cleanUhid = uhid.trim();
    setLoadingVitals(true);
    try {
      const res = await apiFetch<{ vitals?: any[] }>(`/api/patients/${encodeURIComponent(cleanUhid)}/vitals`);
      const vitalsList = res?.vitals && Array.isArray(res.vitals) ? res.vitals : [];

      if (vitalsList.length > 0) {
        // Sort newest first by recorded_at descending
        const sorted = [...vitalsList].sort((a, b) => {
          const tA = a.recorded_at ? new Date(a.recorded_at).getTime() : 0;
          const tB = b.recorded_at ? new Date(b.recorded_at).getTime() : 0;
          return (tB || b.id || 0) - (tA || a.id || 0);
        });
        const latest = sorted[0];
        setLatestVitalsRecord(latest);
        setVitalsSourceUhid(cleanUhid);

        if (latest.bp) {
          setVitalsBp(String(latest.bp).trim());
        }
        if (latest.pulse !== null && latest.pulse !== undefined && String(latest.pulse).trim() !== "") {
          const pStr = String(latest.pulse).trim();
          setVitalsPulse(pStr.toLowerCase().includes("bpm") ? pStr : `${pStr} bpm`);
        }
        if (latest.temperature !== null && latest.temperature !== undefined && String(latest.temperature).trim() !== "") {
          const tStr = String(latest.temperature).trim();
          setVitalsTemp(tStr.includes("°") ? tStr : `${tStr} °F`);
        }
        if (latest.weight !== null && latest.weight !== undefined && String(latest.weight).trim() !== "") {
          const wStr = String(latest.weight).trim();
          setVitalsWeight(wStr.toLowerCase().includes("kg") ? wStr : `${wStr} kg`);
        } else if (fallbackPatient?.weight) {
          const wStr = String(fallbackPatient.weight).trim();
          setVitalsWeight(wStr.toLowerCase().includes("kg") ? wStr : `${wStr} kg`);
        }
        if (latest.spo2 !== null && latest.spo2 !== undefined && String(latest.spo2).trim() !== "") {
          const sStr = String(latest.spo2).trim();
          setVitalsSpo2(sStr.includes("%") ? sStr : `${sStr}%`);
        }

        if (forceNotification) {
          setNotice({
            type: "success",
            message: `Latest vitals auto-filled for ${cleanUhid}: BP: ${latest.bp || "-"}, Pulse: ${latest.pulse || "-"}, Temp: ${latest.temperature || "-"}, Wt: ${latest.weight || "-"}, SpO2: ${latest.spo2 || "-"}.`,
          });
        }
      } else {
        // No vitals record in patient_vitals. Try master record weight
        if (fallbackPatient?.weight) {
          const wStr = String(fallbackPatient.weight).trim();
          setVitalsWeight(wStr.toLowerCase().includes("kg") ? wStr : `${wStr} kg`);
        }
        setLatestVitalsRecord(null);
        setVitalsSourceUhid(cleanUhid);
        if (forceNotification) {
          setNotice({
            type: "info",
            message: `No clinical vitals recorded yet for patient ${cleanUhid}. You can enter them manually.`,
          });
        }
      }
    } catch (err) {
      console.warn("Could not load vitals:", err);
      if (forceNotification) {
        setNotice({
          type: "warning",
          message: `Unable to fetch vitals for ${cleanUhid}. Please check connection or enter manually.`,
        });
      }
    } finally {
      setLoadingVitals(false);
    }
  };

  // Auto-fetch latest vitals whenever patientUhid changes
  useEffect(() => {
    const uhid = patientUhid.trim();
    if (!uhid) {
      setLatestVitalsRecord(null);
      setVitalsSourceUhid("");
      return;
    }
    if (uhid === vitalsSourceUhid) return;

    // Fetch vitals if exact registered patient match, starts with PAT-, or has length >= 4
    const isExact = registeredPatients.some((p) => (p.patient_id || "").toLowerCase() === uhid.toLowerCase());
    if (isExact || uhid.toUpperCase().startsWith("PAT-") || uhid.length >= 4) {
      const timer = setTimeout(() => {
        const matched = registeredPatients.find((p) => (p.patient_id || "").toLowerCase() === uhid.toLowerCase());
        void loadPatientLatestVitals(uhid, matched);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [patientUhid, vitalsSourceUhid, registeredPatients]);

  // Select patient from queue
  const handleSelectPatient = async (patient: QueueItem) => {
    setActiveQueueItem(patient);
    setAppointmentId(patient.appointmentId || null);
    setAppointmentToken(patient.token);
    setPatientUhid(patient.uhid);
    setPatientName(patient.name);
    setPatientPhone(patient.phone || "");
    setPatientPhoneCode(cleanCountryCode((patient as { phone_country_code?: string | null }).phone_country_code));
    setVisitType(patient.visitType || "OP Consultation");

    if (patient.doctor && patient.doctor !== "-") {
      setDoctorName(patient.doctor);
    }
    if (patient.department && patient.department !== "-") {
      setDepartment(patient.department);
    }

    // Parse age and gender if available
    if (patient.ageGender) {
      const parts = patient.ageGender.split("/").map((p) => p.trim());
      if (parts[0]) setPatientAge(parts[0]);
      if (parts[1]) setPatientGender(parts[1]);
    }

    // Symptoms
    if (patient.symptoms) {
      setSymptoms(patient.symptoms);
    }

    // If patient is in 'Waiting' status, mark them as 'In Consultation' in queue & backend
    if (patient.status === "Waiting" && patient.appointmentId) {
      try {
        await apiFetch(`/api/appointments/${patient.appointmentId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "in_consultation" }),
        });
        // Update local queue status
        setQueue((prev) =>
          prev.map((item) =>
            item.appointmentId === patient.appointmentId ? { ...item, status: "In Consultation" } : item
          )
        );
        setActiveQueueItem((prev) => (prev ? { ...prev, status: "In Consultation" } : prev));
      } catch {
        // silent
      }
    }

    // Try to load any previous prescription for this patient
    if (patient.uhid) {
      try {
        const res = await apiFetch<{ prescriptions?: any[] }>(`/api/prescriptions?patient_id=${encodeURIComponent(patient.uhid)}`);
        if (res?.prescriptions && res.prescriptions.length > 0) {
          const latest = res.prescriptions[0];
          if (latest.diagnosis && !diagnosis) setDiagnosis(latest.diagnosis);
          if (latest.lab_tests && !labTests) setLabTests(latest.lab_tests);
          if (latest.advice) setAdvice(latest.advice);
        }
      } catch {
        // non-blocking
      }

      // Auto-fill vitals with latest records taken
      void loadPatientLatestVitals(patient.uhid, patient);
    }

    setNotice({
      type: "info",
      message: `Selected Token #${patient.token}: ${patient.name} (${patient.uhid || "UHID Pending"}). Ready for consultation.`,
    });
  };

  // Select next waiting patient in queue
  const handleNextPatient = () => {
    const nextWaiting = queue.find((i) => i.status === "Waiting");
    if (nextWaiting) {
      void handleSelectPatient(nextWaiting);
    } else {
      const nextInConsultation = queue.find((i) => i.status === "In Consultation" && i.id !== activeQueueItem?.id);
      if (nextInConsultation) {
        void handleSelectPatient(nextInConsultation);
      } else {
        setNotice({ type: "info", message: "No more waiting patients in today's OPD queue." });
      }
    }
  };

  // Medicine management
  const handleAddMedicine = () => {
    const newMed: MedicineItem = {
      id: `med-${Date.now()}`,
      medicine_name: "",
      dosage: "",
      frequency: "",
      duration: "",
      instructions: "",
    };
    setMedicines([...medicines, newMed]);
  };

  const handleQuickAddMedicine = (drug: (typeof COMMON_DRUGS)[0]) => {
    const newMed: MedicineItem = {
      id: `med-${Date.now()}`,
      medicine_name: drug.name,
      dosage: drug.dosage,
      frequency: drug.freq,
      duration: drug.duration,
      instructions: drug.inst,
    };
    setMedicines([...medicines, newMed]);
    setNotice({ type: "success", message: `Added ${drug.name} to prescription.` });
  };

  const handleRemoveMedicine = (id: string) => {
    setMedicines(medicines.filter((m) => m.id !== id));
  };

  const handleUpdateMedicine = (id: string, field: keyof MedicineItem, val: string) => {
    setMedicines(medicines.map((m) => (m.id === id ? { ...m, [field]: val } : m)));
  };

  // Quick follow-up days
  const handleSetFollowUpDays = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setFollowUpDate(d.toLocaleDateString("en-CA"));
  };

  // Complete Consultation handler
  const handleCompleteConsultation = async (andPrint: boolean = false) => {
    if (!patientUhid.trim() && !patientName.trim()) {
      setNotice({ type: "warning", message: "Please select a patient from the Queue or enter patient details." });
      return;
    }

    if (!patientUhid.trim()) {
      setNotice({ type: "warning", message: "A valid Patient UHID is required to file this clinical prescription." });
      return;
    }

    setSubmitting(true);

    try {
      // 1. Save prescription via POST /api/prescriptions
      const prescPayload = {
        patient_id: patientUhid.trim(),
        appointment_id: appointmentId,
        doctor_name: doctorName.trim(),
        department: department.trim(),
        diagnosis: diagnosis.trim(),
        lab_tests: labTests.trim(),
        advice: advice.trim(),
        follow_up_date: followUpDate || null,
        lab_fbs: labFbs || null,
        lab_ppbs: labPpbs || null,
        lab_hba1c: labHba1c || null,
        lab_tchol: labTchol || null,
        lab_ldl: labLdl || null,
        lab_tgl: labTgl || null,
        lab_vitd: labVitd || null,
        medicines: medicines.filter((m) => m.medicine_name.trim()),
        send_to_pharmacy: sendToPharmacy,
        complete_consultation: true,
      };

      const saved = await apiFetch<{ ip_order?: { indent_no: string; items: number } | null }>("/api/prescriptions", {
        method: "POST",
        body: JSON.stringify(prescPayload),
      });

      // Save/update vitals to patient_vitals if vitals were provided/updated
      if (patientUhid.trim() && (vitalsBp || vitalsPulse || vitalsTemp || vitalsWeight || vitalsSpo2)) {
        try {
          await apiFetch(`/api/patients/${encodeURIComponent(patientUhid.trim())}/vitals`, {
            method: "POST",
            body: JSON.stringify({
              bp: vitalsBp.trim() || undefined,
              pulse: vitalsPulse ? parseInt(vitalsPulse.replace(/[^0-9]/g, ""), 10) || undefined : undefined,
              temperature: vitalsTemp ? parseFloat(vitalsTemp.replace(/[^0-9.]/g, "")) || undefined : undefined,
              weight: vitalsWeight ? parseFloat(vitalsWeight.replace(/[^0-9.]/g, "")) || undefined : undefined,
              spo2: vitalsSpo2 ? parseFloat(vitalsSpo2.replace(/[^0-9.]/g, "")) || undefined : undefined,
            }),
          });
        } catch {
          // non-fatal
        }
      }

      // 2. Explicitly update appointment status to 'completed' in appointments table
      if (appointmentId) {
        try {
          await apiFetch(`/api/appointments/${appointmentId}`, {
            method: "PUT",
            body: JSON.stringify({ status: "completed" }),
          });
        } catch {
          // non-fatal if clinical.py already updated status
        }
      }

      // 3. Update local Queue state to reflect Completed immediately
      const completedToken = appointmentToken || (activeQueueItem ? activeQueueItem.token : "");
      const completedName = patientName;

      setQueue((prevQueue) => {
        const updated = prevQueue.map((item) => {
          if (
            (appointmentId && item.appointmentId === appointmentId) ||
            (item.uhid && item.uhid === patientUhid)
          ) {
            return { ...item, status: "Completed" as const };
          }
          return item;
        });

        // Also update local storage for queue sync with Queue Management page
        try {
          localStorage.setItem("hospai_op_queue_v2", JSON.stringify(updated));
        } catch {
          // silent
        }
        return updated;
      });

      if (activeQueueItem) {
        setActiveQueueItem({ ...activeQueueItem, status: "Completed" });
      }

      // 4. Success Toast Notification
      setNotice({
        type: "success",
        message: saved?.ip_order
          ? `Prescription saved for admitted patient ${completedName}. ${saved.ip_order.items} medicine(s) sent to Pharmacy > IP Dispense as medication order ${saved.ip_order.indent_no}.`
          : `Consultation completed for Token #${completedToken || "1"} (${completedName})! Prescription generated and status successfully reflected under Queue Management.`,
      });

      // 5. If print was requested, open print dialog
      if (andPrint) {
        setTimeout(() => {
          window.print();
        }, 300);
      }
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Failed to complete consultation.");
    } finally {
      setSubmitting(false);
    }
  };

  // Save Draft (without completing consultation)
  const handleSaveDraft = async () => {
    if (!patientUhid.trim()) {
      setNotice({ type: "warning", message: "Patient UHID is required to save prescription." });
      return;
    }

    setSubmitting(true);
    try {
      const prescPayload = {
        patient_id: patientUhid.trim(),
        appointment_id: appointmentId,
        doctor_name: doctorName.trim(),
        department: department.trim(),
        diagnosis: diagnosis.trim(),
        lab_tests: labTests.trim(),
        advice: advice.trim(),
        follow_up_date: followUpDate || null,
        medicines: medicines.filter((m) => m.medicine_name.trim()),
        send_to_pharmacy: sendToPharmacy,
        complete_consultation: false,
      };

      await apiFetch("/api/prescriptions", {
        method: "POST",
        body: JSON.stringify(prescPayload),
      });

      setNotice({
        type: "success",
        message: `Prescription draft saved successfully for ${patientName}.`,
      });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Failed to save prescription draft.");
    } finally {
      setSubmitting(false);
    }
  };

  // Share digital prescription via WhatsApp
  const handleShareWhatsAppPrescription = () => {
    if (!patientName.trim()) {
      setNotice({ type: "warning", message: "Please select a patient first to share the prescription." });
      return;
    }
    const medsList = medicines
      .filter((m) => m.medicine_name.trim())
      .map((m, idx) => `${idx + 1}. *${m.medicine_name}* (${m.dosage || "-"}) — ${m.frequency || "-"} for ${m.duration || "-"} (${m.instructions || "-"})`)
      .join("\n");

    const text = [
      `🏥 *HospAI Hospital — Digital Prescription*`,
      `----------------------------------------`,
      `👤 *Patient:* ${patientName} (${patientUhid || "OPD"})`,
      patientAge || patientGender ? `ℹ️ *Age/Gender:* ${patientAge ? `${patientAge}y` : ""} ${patientGender || ""}` : "",
      `👨‍⚕️ *Consultant:* ${doctorName} (${department})`,
      `📅 *Date:* ${new Date().toLocaleDateString("en-IN")}`,
      diagnosis ? `🩺 *Diagnosis:* ${diagnosis}` : "",
      symptoms ? `🤒 *Symptoms:* ${symptoms}` : "",
      (vitalsBp || vitalsPulse || vitalsTemp || vitalsWeight || vitalsSpo2)
        ? `📊 *Vitals:* ${[
            vitalsBp ? `BP ${vitalsBp}` : "",
            vitalsPulse ? `Pulse ${vitalsPulse}` : "",
            vitalsTemp ? `Temp ${vitalsTemp}` : "",
            vitalsWeight ? `Wt ${vitalsWeight}` : "",
            vitalsSpo2 ? `SpO2 ${vitalsSpo2}` : "",
          ].filter(Boolean).join(", ")}`
        : "",
      medsList ? `\n💊 *Prescribed Medicines:*\n${medsList}` : "",
      labTests ? `\n🔬 *Advised Lab Tests:* ${labTests}` : "",
      advice ? `\n💡 *Doctor's Advice:* ${advice}` : "",
      followUpDate ? `\n🗓️ *Follow-up Date:* ${followUpDate}` : "",
      `----------------------------------------`,
      `Wishing you good health & a speedy recovery! Valid electronic prescription.`,
    ].filter(Boolean).join("\n");

    const stored = splitStoredPhone(patientPhone, patientPhoneCode);
    const countryCoded = toWhatsAppNumber(stored.countryCode, stored.value);
    const url = countryCoded
      ? `https://wa.me/${countryCoded}?text=${encodeURIComponent(text)}`
      : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
    setNotice({
      type: "success",
      message: `WhatsApp launched with digital prescription for ${patientName}!`,
    });
  };

  // Live search registered patients as user types
  const handleLiveSearchRegistered = (term: string) => {
    setPatientSearchTerm(term);
    const q = term.trim().toLowerCase();
    if (!q) {
      setSearchResults([]);
      return;
    }
    // Instant client-side match from registeredPatients cache
    const localMatches = registeredPatients.filter((p) => {
      const uhid = (p.patient_id || p.id || "").toLowerCase();
      const name = getPatientFullName(p).toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      return uhid.includes(q) || name.includes(q) || phone.includes(q);
    });
    setSearchResults(localMatches);

    // Also debounced server query if local cache is empty or incomplete
    if (localMatches.length === 0) {
      void apiFetch<{ patients?: any[] }>(`/api/patients?q=${encodeURIComponent(q)}`)
        .then((res) => {
          if (res?.patients && Array.isArray(res.patients)) {
            setSearchResults(res.patients);
          }
        })
        .catch(() => {});
    }
  };

  // Search registered patients for walk-ins
  const handleSearchRegisteredPatients = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!patientSearchTerm.trim()) {
      setSearchResults([]);
      return;
    }

    setSearchingPatient(true);
    try {
      const res = await apiFetch<{ patients?: any[] }>(`/api/patients?q=${encodeURIComponent(patientSearchTerm.trim())}`);
      const patients = res?.patients || [];
      setSearchResults(patients);
      if (patients.length === 0) {
        setNotice({ type: "info", message: `No registered patients found matching "${patientSearchTerm}".` });
      }
    } catch {
      const q = patientSearchTerm.trim().toLowerCase();
      const localMatches = registeredPatients.filter((p) => {
        const uhid = (p.patient_id || p.id || "").toLowerCase();
        const name = getPatientFullName(p).toLowerCase();
        const phone = (p.phone || "").toLowerCase();
        return uhid.includes(q) || name.includes(q) || phone.includes(q);
      });
      setSearchResults(localMatches);
    } finally {
      setSearchingPatient(false);
    }
  };

  const handlePickSearchedPatient = async (p: any) => {
    const uhid = p.patient_id || p.id || "";
    const fullName = getPatientFullName(p);
    setPatientUhid(uhid);
    setPatientName(fullName);
    setPatientAge(p.age ? String(p.age) : "");
    setPatientGender(p.gender || "Male");
    setPatientPhone(p.phone || "");
    setPatientPhoneCode(cleanCountryCode(p.phone_country_code));
    setVisitType(p.latest_visit_type || "OP Consultation");
    setAppointmentId(null);
    setAppointmentToken("Walk-in / Registered");
    setActiveQueueItem(null);
    setSearchResults([]);
    setPatientSearchTerm("");
    setPatientDirectoryModalOpen(false);
    setUhidDropdownOpen(false);

    if (p.latest_doctor_name && p.latest_doctor_name !== "-") {
      setDoctorName(p.latest_doctor_name);
    }
    if (p.latest_department && p.latest_department !== "-") {
      setDepartment(p.latest_department);
    }

    // Try to load any previous prescription for this patient
    if (uhid) {
      try {
        const res = await apiFetch<{ prescriptions?: any[] }>(`/api/prescriptions?patient_id=${encodeURIComponent(uhid)}`);
        if (res?.prescriptions && res.prescriptions.length > 0) {
          const latest = res.prescriptions[0];
          if (latest.diagnosis && !diagnosis) setDiagnosis(latest.diagnosis);
          if (latest.lab_tests && !labTests) setLabTests(latest.lab_tests);
          if (latest.advice && !advice) setAdvice(latest.advice);
        }
      } catch {
        // non-blocking
      }

      // Auto-fill vitals with latest records taken
      void loadPatientLatestVitals(uhid, p);
    }

    setNotice({
      type: "success",
      message: `Loaded registered patient: ${fullName} (${uhid}). Ready for consultation.`,
    });
  };

  return (
    <div className="doctor-rx-page-root">
      {/* Print Styles for clean A4 paper output */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .doctor-rx-sheet, .doctor-rx-sheet * {
            visibility: visible;
          }
          .doctor-rx-sheet {
            position: absolute;
            left: 0;
            top: 0;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 24px !important;
            box-shadow: none !important;
            border: none !important;
          }
          .doctor-rx-top-header,
          .doctor-rx-queue-section,
          .doctor-rx-layout-split > :first-child,
          .doctor-rx-actions-row,
          .doctor-rx-preview-header,
          .doctor-rx-sub-header {
            display: none !important;
          }
          ${HOSPAI_PRINT_FOOTER_CSS}
        }
      `}</style>

      {/* Top Header */}
      <div className="doctor-rx-top-header">
        <div>
          <h1 className="doctor-rx-main-title">Doctor Prescription & Consultation</h1>
          <p className="doctor-rx-subtitle">
            OPD Live Consultation Workstation • Issue Branded Prescriptions & Complete Queued Visits
          </p>
        </div>

        <div className="doctor-rx-doctor-pill-group">
          {onNavigate && (
            <button
              type="button"
              className="rx-outline-btn"
              onClick={() => onNavigate("op-queue-management")}
              title="Navigate to Queue Management module"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span>View Queue Management</span>
            </button>
          )}

          <div className="doctor-rx-profile-pill" title="Active Consulting Doctor">
            <div className="doctor-rx-profile-avatar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0284c7" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <div>
              <div className="doctor-rx-profile-name">{doctorName}</div>
              <div className="doctor-rx-profile-dept">{department}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Breadcrumb Navigation & Stepper */}
      <div className="doctor-rx-sub-header">
        <div className="doctor-rx-breadcrumbs">
          <span>OP Management</span> &gt; <span>OPD Queue</span> &gt;{" "}
          <span>Doctor Prescription {appointmentToken ? `(#Token ${appointmentToken})` : ""}</span>
        </div>

        <div className="doctor-rx-stepper">
          <div className={`doctor-rx-step ${activeQueueItem ? "completed" : "active"}`}>
            <span className="doctor-rx-step-circle">①</span>
            <span>Select Queued Patient</span>
          </div>
          <span className="doctor-rx-step-line"></span>
          <div className={`doctor-rx-step ${activeQueueItem && diagnosis ? "completed" : activeQueueItem ? "active" : ""}`}>
            <span className="doctor-rx-step-circle">②</span>
            <span>Clinical Diagnosis & Rx</span>
          </div>
          <span className="doctor-rx-step-line"></span>
          <div className={`doctor-rx-step ${activeQueueItem?.status === "Completed" ? "completed" : ""}`}>
            <span className="doctor-rx-step-circle">③</span>
            <span>Complete Consultation</span>
          </div>
        </div>
      </div>

      {/* =========================================================================
          PATIENT QUEUE WORKLIST SECTION (PROMINENT OPD QUEUE DISPLAY)
          ========================================================================= */}
      <div
        className="doctor-rx-card"
        style={{
          marginBottom: "20px",
          background: "#ffffff",
          border: "1px solid #bae6fd",
          borderRadius: "12px",
          boxShadow: "0 2px 8px rgba(2, 132, 199, 0.06)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: isQueueCollapsed ? "0" : "12px",
            borderBottom: isQueueCollapsed ? "none" : "1.5px solid #f0f4f8",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                background: "#e0f2fe",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0284c7",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
                <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
              </svg>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "2px" }}>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 800, color: "#102a43", letterSpacing: "-0.01em" }}>
                  {topViewMode === "queue" ? `OPD Patient Queue (${selectedDate})` : `All Registered Patients Directory (${registeredPatients.length})`}
                </h3>
                <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "2px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                  <button
                    type="button"
                    onClick={() => setTopViewMode("queue")}
                    style={{
                      padding: "3px 10px",
                      borderRadius: "4px",
                      fontSize: "11.5px",
                      fontWeight: topViewMode === "queue" ? 700 : 500,
                      cursor: "pointer",
                      border: "none",
                      background: topViewMode === "queue" ? "#0284c7" : "transparent",
                      color: topViewMode === "queue" ? "#ffffff" : "#475569",
                      transition: "all 0.15s ease",
                    }}
                  >
                    Today's OPD Queue ({queue.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTopViewMode("directory")}
                    style={{
                      padding: "3px 10px",
                      borderRadius: "4px",
                      fontSize: "11.5px",
                      fontWeight: topViewMode === "directory" ? 700 : 500,
                      cursor: "pointer",
                      border: "none",
                      background: topViewMode === "directory" ? "#0284c7" : "transparent",
                      color: topViewMode === "directory" ? "#ffffff" : "#475569",
                      transition: "all 0.15s ease",
                    }}
                  >
                    All Registered Patients (UHID) ({registeredPatients.length})
                  </button>
                </div>
              </div>
              <span style={{ fontSize: "12px", color: "#627d98" }}>
                {topViewMode === "queue"
                  ? "Patients waiting or consulting today. Click any card to load their prescription."
                  : "Complete directory of registered hospital patients. Choose any patient by UHID to prescribe directly."}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {/* Status counts badges */}
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                onClick={() => setQueueStatusFilter("Waiting")}
                style={{
                  background: queueStatusFilter === "Waiting" ? "#fef3c7" : "#f8fafc",
                  color: queueStatusFilter === "Waiting" ? "#b45309" : "#64748b",
                  border: queueStatusFilter === "Waiting" ? "1.5px solid #f59e0b" : "1px solid #e2e8f0",
                  borderRadius: "20px",
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#f59e0b" }}></span>
                Waiting: <strong>{queueCounts.waiting}</strong>
              </button>

              <button
                type="button"
                onClick={() => setQueueStatusFilter("In Consultation")}
                style={{
                  background: queueStatusFilter === "In Consultation" ? "#e0f2fe" : "#f8fafc",
                  color: queueStatusFilter === "In Consultation" ? "#0369a1" : "#64748b",
                  border: queueStatusFilter === "In Consultation" ? "1.5px solid #0284c7" : "1px solid #e2e8f0",
                  borderRadius: "20px",
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#0284c7" }}></span>
                In Consultation: <strong>{queueCounts.inConsultation}</strong>
              </button>

              <button
                type="button"
                onClick={() => setQueueStatusFilter("Completed")}
                style={{
                  background: queueStatusFilter === "Completed" ? "#dcfce7" : "#f8fafc",
                  color: queueStatusFilter === "Completed" ? "#15803d" : "#64748b",
                  border: queueStatusFilter === "Completed" ? "1.5px solid #16a34a" : "1px solid #e2e8f0",
                  borderRadius: "20px",
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#16a34a" }}></span>
                Completed: <strong>{queueCounts.completed}</strong>
              </button>

              <button
                type="button"
                onClick={() => setQueueStatusFilter("ALL")}
                style={{
                  background: queueStatusFilter === "ALL" ? "#f1f5f9" : "#ffffff",
                  color: "#334155",
                  border: queueStatusFilter === "ALL" ? "1.5px solid #94a3b8" : "1px solid #e2e8f0",
                  borderRadius: "20px",
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                All: <strong>{queueCounts.all}</strong>
              </button>
            </div>

            {/* Quick Next Patient CTA */}
            <button
              type="button"
              onClick={handleNextPatient}
              style={{
                background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "6px 14px",
                fontSize: "12.5px",
                fontWeight: 700,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>Next Patient</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>

            {/* Refresh Queue */}
            <button
              type="button"
              onClick={fetchLiveQueue}
              disabled={loadingQueue}
              title="Refresh Queue"
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "6px 10px",
                fontSize: "12px",
                cursor: "pointer",
                color: "#475569",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ animation: loadingQueue ? "spin 1s linear infinite" : "none" }}
              >
                <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>

            {/* Collapse toggle */}
            <button
              type="button"
              onClick={() => setIsQueueCollapsed(!isQueueCollapsed)}
              style={{
                background: "transparent",
                border: "none",
                fontSize: "12px",
                color: "#64748b",
                cursor: "pointer",
                padding: "4px",
              }}
            >
              {isQueueCollapsed ? "Show Queue ▼" : "Hide Queue ▲"}
            </button>
          </div>
        </div>

        {/* Queue filter controls & cards */}
        {!isQueueCollapsed && (
          <div style={{ paddingTop: "12px" }}>
            <div
              style={{
                display: "flex",
                gap: "10px",
                marginBottom: "12px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div style={{ position: "relative", flex: "1", minWidth: "180px" }}>
                <input
                  type="text"
                  placeholder="Search queue by token, patient name or UHID..."
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "7px 10px 7px 30px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12.5px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="2"
                  style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)" }}
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>

              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#334155",
                }}
              />

              {departmentsList.length > 0 && (
                <select
                  value={selectedDepartment}
                  onChange={(e) => setSelectedDepartment(e.target.value)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    color: "#334155",
                    background: "#ffffff",
                  }}
                >
                  <option value="All Departments">All Departments</option>
                  {departmentsList.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}

              {doctorsList.length > 0 && (
                <select
                  value={selectedDoctor}
                  onChange={(e) => setSelectedDoctor(e.target.value)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    color: "#334155",
                    background: "#ffffff",
                  }}
                >
                  <option value="All Doctors">All Doctors</option>
                  {doctorsList.map((doc) => (
                    <option key={doc} value={doc}>
                      {doc}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Queue Cards or Registered Patients Directory */}
            {topViewMode === "directory" ? (
              loadingRegisteredPatients ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                  Loading registered patients directory...
                </div>
              ) : displayedRegistered.length === 0 ? (
                <div
                  style={{
                    padding: "24px",
                    textAlign: "center",
                    background: "#f8fafc",
                    borderRadius: "8px",
                    border: "1px dashed #cbd5e1",
                    color: "#64748b",
                    fontSize: "13px",
                  }}
                >
                  No registered patients found matching "{queueSearch}".
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                      Showing {displayedRegistered.length} registered patient{displayedRegistered.length === 1 ? "" : "s"} with UHID:
                    </span>
                    <button
                      type="button"
                      onClick={() => setPatientDirectoryModalOpen(true)}
                      style={{
                        background: "#0284c7",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "5px",
                        padding: "4px 10px",
                        fontSize: "11.5px",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Open Full Directory Table ↗
                    </button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                      gap: "12px",
                      maxHeight: "310px",
                      overflowY: "auto",
                      padding: "2px",
                    }}
                  >
                    {displayedRegistered.map((p) => {
                      const uhid = p.patient_id || p.id || "";
                      const fullName = getPatientFullName(p);
                      const isSelected = patientUhid === uhid;

                      return (
                        <div
                          key={uhid}
                          onClick={() => handlePickSearchedPatient(p)}
                          style={{
                            padding: "12px 14px",
                            borderRadius: "8px",
                            border: isSelected ? "2px solid #0284c7" : "1px solid #e2e8f0",
                            background: isSelected ? "#f0f9ff" : "#ffffff",
                            cursor: "pointer",
                            boxShadow: isSelected ? "0 2px 8px rgba(2, 132, 199, 0.15)" : "0 1px 3px rgba(0, 0, 0, 0.03)",
                            transition: "all 0.15s ease",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span
                              style={{
                                background: "#e0f2fe",
                                color: "#0369a1",
                                fontSize: "11px",
                                fontWeight: 800,
                                padding: "2px 7px",
                                borderRadius: "4px",
                                border: "1px solid #bae6fd",
                              }}
                            >
                              {uhid}
                            </span>
                            <span style={{ fontSize: "11px", color: "#64748b" }}>
                              {p.gender || "Patient"} {p.age ? `• ${p.age}y` : ""}
                            </span>
                          </div>

                          <div style={{ fontWeight: 800, fontSize: "14px", color: "#102a43" }}>
                            {fullName}
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11.5px", color: "#627d98" }}>
                            <span>Ph: {p.phone || "—"}</span>
                            <span style={{ color: "#0284c7", fontWeight: 700 }}>Prescribe →</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            ) : loadingQueue ? (
              <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                Loading live appointments queue...
              </div>
            ) : filteredQueue.length === 0 ? (
              <div>
                {queueSearch.trim() && matchingRegisteredForQueue.length > 0 ? (
                  <div
                    style={{
                      padding: "16px",
                      background: "#f0f9ff",
                      borderRadius: "8px",
                      border: "1.5px solid #7dd3fc",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "6px" }}>
                      <div>
                        <strong style={{ fontSize: "13px", color: "#0369a1" }}>
                          No appointments in today's queue for "{queueSearch}", but found {matchingRegisteredForQueue.length} registered patient(s) with matching UHID / Name:
                        </strong>
                        <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                          Click any registered patient below to load their medical details and prescribe.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTopViewMode("directory")}
                        style={{
                          background: "#0284c7",
                          color: "#ffffff",
                          border: "none",
                          borderRadius: "4px",
                          padding: "4px 10px",
                          fontSize: "11.5px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Browse All Registered Patients →
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "10px" }}>
                      {matchingRegisteredForQueue.map((p) => {
                        const uhid = p.patient_id || p.id || "";
                        const fullName = getPatientFullName(p);
                        return (
                          <div
                            key={uhid}
                            onClick={() => handlePickSearchedPatient(p)}
                            style={{
                              background: "#ffffff",
                              padding: "10px 12px",
                              borderRadius: "6px",
                              border: "1px solid #bae6fd",
                              cursor: "pointer",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                            }}
                          >
                            <div>
                              <span style={{ fontSize: "11px", fontWeight: 800, color: "#0284c7", background: "#e0f2fe", padding: "2px 6px", borderRadius: "4px" }}>
                                {uhid}
                              </span>
                              <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginTop: "3px" }}>
                                {fullName}
                              </div>
                              <div style={{ fontSize: "11.5px", color: "#64748b" }}>
                                {p.age ? `${p.age}y` : ""} {p.gender || ""} • {p.phone || ""}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePickSearchedPatient(p);
                              }}
                              style={{
                                background: "#16a34a",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "5px",
                                padding: "6px 12px",
                                fontSize: "11.5px",
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              Prescribe →
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "24px",
                      textAlign: "center",
                      background: "#f8fafc",
                      borderRadius: "8px",
                      border: "1px dashed #cbd5e1",
                      color: "#64748b",
                      fontSize: "13px",
                    }}
                  >
                    No patients found in queue for this selection. New appointments registered via Patient Registration will appear here automatically.
                    <div style={{ marginTop: "10px" }}>
                      <button
                        type="button"
                        onClick={() => setTopViewMode("directory")}
                        style={{
                          background: "#e0f2fe",
                          color: "#0369a1",
                          border: "1px solid #bae6fd",
                          borderRadius: "6px",
                          padding: "6px 14px",
                          fontSize: "12px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        👥 Choose from All Registered Patients (UHID) ({registeredPatients.length})
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: "12px",
                  maxHeight: "310px",
                  overflowY: "auto",
                  padding: "2px",
                }}
              >
                {filteredQueue.map((item) => {
                  const isSelected = activeQueueItem?.id === item.id || (appointmentId && item.appointmentId === appointmentId);
                  const isWaiting = item.status === "Waiting";
                  const isInConsultation = item.status === "In Consultation";
                  const isCompleted = item.status === "Completed";

                  return (
                    <div
                      key={item.id}
                      onClick={() => handleSelectPatient(item)}
                      style={{
                        padding: "12px 14px",
                        borderRadius: "8px",
                        border: isSelected ? "2px solid #0284c7" : "1px solid #e2e8f0",
                        background: isSelected ? "#f0f9ff" : isCompleted ? "#fbfdfc" : "#ffffff",
                        cursor: "pointer",
                        boxShadow: isSelected ? "0 2px 8px rgba(2, 132, 199, 0.15)" : "0 1px 3px rgba(0, 0, 0, 0.03)",
                        transition: "all 0.15s ease",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span
                            style={{
                              background: "#0f172a",
                              color: "#ffffff",
                              fontSize: "11px",
                              fontWeight: 800,
                              padding: "2px 7px",
                              borderRadius: "4px",
                              letterSpacing: "0.02em",
                            }}
                          >
                            Token #{item.token}
                          </span>
                          <span style={{ fontSize: "11.5px", color: "#64748b", fontWeight: 600 }}>
                            {item.appointmentTime}
                          </span>
                        </div>

                        {/* Status badge */}
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            padding: "2px 8px",
                            borderRadius: "12px",
                            background: isCompleted ? "#dcfce7" : isInConsultation ? "#e0f2fe" : "#fef3c7",
                            color: isCompleted ? "#15803d" : isInConsultation ? "#0369a1" : "#b45309",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          {isCompleted && "✓ "}
                          {isInConsultation && "● "}
                          {item.status}
                        </span>
                      </div>

                      <div style={{ fontWeight: 800, fontSize: "14px", color: "#102a43", lineHeight: 1.2 }}>
                        {item.name}
                      </div>

                      <div style={{ fontSize: "11.5px", color: "#64748b", display: "flex", gap: "8px" }}>
                        <span>UHID: <strong>{item.uhid || "Pending"}</strong></span>
                        {item.ageGender && <span>• {item.ageGender}</span>}
                      </div>

                      <div style={{ fontSize: "11px", color: "#475569" }}>
                        <span>{item.department}</span> {item.doctor && item.doctor !== "-" ? `• ${item.doctor}` : ""}
                      </div>

                      {item.symptoms && (
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#b45309",
                            background: "#fffbeb",
                            padding: "3px 6px",
                            borderRadius: "4px",
                            border: "1px dashed #fde68a",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={item.symptoms}
                        >
                          Chief Complaint: {item.symptoms}
                        </div>
                      )}

                      <div style={{ marginTop: "4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "10.5px", color: "#94a3b8" }}>{item.visitType}</span>
                        <span
                          style={{
                            fontSize: "11.5px",
                            fontWeight: 700,
                            color: isSelected ? "#0284c7" : "#0369a1",
                          }}
                        >
                          {isSelected ? "Currently Selected ✓" : isCompleted ? "View Prescribed" : "Select & Prescribe →"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* =========================================================================
          MAIN 2-COLUMN SPLIT SCREEN: LEFT = PRESCRIPTION FORM, RIGHT = LIVE A4 PREVIEW
          ========================================================================= */}
      <div className="doctor-rx-layout-split">
        {/* LEFT COLUMN: Clinical Inputs & Prescription Form */}
        <div>
          {/* Active Patient Identity Card */}
          <div className="doctor-rx-card" style={{ marginBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span
                  style={{
                    background: appointmentToken ? "#0284c7" : "#64748b",
                    color: "#ffffff",
                    fontWeight: 800,
                    fontSize: "13px",
                    padding: "4px 10px",
                    borderRadius: "6px",
                  }}
                >
                  {appointmentToken ? `Token #${appointmentToken}` : "Patient"}
                </span>
                <h3 className="doctor-rx-card-title" style={{ margin: 0 }}>
                  {patientName || "Select a Patient from Queue"}
                </h3>
              </div>

              {activeQueueItem && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Status:</span>
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      padding: "3px 10px",
                      borderRadius: "14px",
                      background:
                        activeQueueItem.status === "Completed"
                          ? "#dcfce7"
                          : activeQueueItem.status === "In Consultation"
                          ? "#e0f2fe"
                          : "#fef3c7",
                      color:
                        activeQueueItem.status === "Completed"
                          ? "#15803d"
                          : activeQueueItem.status === "In Consultation"
                          ? "#0369a1"
                          : "#b45309",
                    }}
                  >
                    {activeQueueItem.status}
                  </span>
                </div>
              )}
            </div>

            {/* Quick manual search for walk-in patients */}
            <form onSubmit={handleSearchRegisteredPatients} style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: 1, minWidth: "240px" }}>
                <input
                  type="text"
                  placeholder="Type registered UHID (e.g. 0001, PAT-2026...), Name or Phone..."
                  value={patientSearchTerm}
                  onChange={(e) => handleLiveSearchRegistered(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1.5px solid #94a3b8",
                    fontSize: "12.5px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={searchingPatient}
                style={{
                  background: "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  padding: "0 14px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {searchingPatient ? "Searching..." : "Search"}
              </button>
              <button
                type="button"
                onClick={() => setPatientDirectoryModalOpen(true)}
                style={{
                  background: "#f0fdf4",
                  color: "#166534",
                  border: "1.5px solid #86efac",
                  borderRadius: "6px",
                  padding: "6px 14px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>👥 Choose from Registered Patients ({registeredPatients.length})</span>
              </button>
            </form>

            {searchResults.length > 0 && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1.5px solid #0284c7",
                  borderRadius: "8px",
                  padding: "8px",
                  marginBottom: "14px",
                  maxHeight: "180px",
                  overflowY: "auto",
                  boxShadow: "0 4px 12px rgba(2, 132, 199, 0.08)",
                }}
              >
                <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#0369a1", marginBottom: "6px", display: "flex", justifyContent: "space-between" }}>
                  <span>Matching Registered Patients:</span>
                  <span style={{ fontSize: "10.5px", color: "#64748b" }}>Click to load into prescription</span>
                </div>
                {searchResults.map((p) => {
                  const uhid = p.patient_id || p.id || "";
                  const fullName = getPatientFullName(p);
                  return (
                    <div
                      key={uhid}
                      onClick={() => handlePickSearchedPatient(p)}
                      style={{
                        padding: "7px 10px",
                        borderRadius: "5px",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "12px",
                        borderBottom: "1px solid #e2e8f0",
                        background: "#ffffff",
                        marginBottom: "4px",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#e0f2fe")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
                    >
                      <div>
                        <span style={{ background: "#e0f2fe", color: "#0369a1", fontWeight: 800, fontSize: "11px", padding: "1px 6px", borderRadius: "3px", marginRight: "6px" }}>
                          {uhid}
                        </span>
                        <strong>{fullName}</strong>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span style={{ color: "#64748b", fontSize: "11px" }}>
                          {p.age ? `${p.age}y` : ""} {p.gender || ""} • Ph: {p.phone || "—"}
                        </span>
                        <span style={{ background: "#16a34a", color: "#ffffff", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>
                          Select →
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Patient Meta Fields */}
            <div className="doctor-rx-grid-3">
              <div className="doctor-rx-field" style={{ position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <label style={{ margin: 0 }}>
                    Patient UHID <span className="req">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setPatientDirectoryModalOpen(true)}
                    style={{
                      background: "#e0f2fe",
                      color: "#0369a1",
                      border: "1px solid #bae6fd",
                      borderRadius: "4px",
                      padding: "1px 6px",
                      fontSize: "10.5px",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Select UHID 🔍
                  </button>
                </div>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={patientUhid}
                  onFocus={() => setUhidDropdownOpen(true)}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPatientUhid(val);
                    setUhidDropdownOpen(true);
                    const exact = registeredPatients.find((p) => (p.patient_id || "").toLowerCase() === val.trim().toLowerCase());
                    if (exact) {
                      void handlePickSearchedPatient(exact);
                    }
                  }}
                  placeholder="e.g. 0001 or PAT-2026..."
                  autoComplete="off"
                />
                {/* Autocomplete dropdown for UHID */}
                {uhidDropdownOpen && patientUhid.trim().length > 0 && matchingUhidPatients.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      zIndex: 50,
                      background: "#ffffff",
                      border: "1.5px solid #0284c7",
                      borderRadius: "6px",
                      boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
                      maxHeight: "180px",
                      overflowY: "auto",
                      marginTop: "2px",
                    }}
                  >
                    {matchingUhidPatients.map((p) => {
                      const uhid = p.patient_id || p.id || "";
                      const fullName = getPatientFullName(p);
                      return (
                        <div
                          key={uhid}
                          onClick={() => {
                            void handlePickSearchedPatient(p);
                          }}
                          style={{
                            padding: "8px 10px",
                            cursor: "pointer",
                            borderBottom: "1px solid #f1f5f9",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "12px",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#e0f2fe")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
                        >
                          <div>
                            <strong style={{ color: "#0284c7" }}>{uhid}</strong> — {fullName}
                          </div>
                          <div style={{ color: "#64748b", fontSize: "11px" }}>
                            {p.age ? `${p.age}y` : ""} {p.gender || ""} • {p.phone || ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="doctor-rx-field">
                <label>
                  Patient Name <span className="req">*</span>
                </label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="Patient Full Name"
                />
              </div>

              <div className="doctor-rx-field">
                <label>Age & Gender</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    type="text"
                    className="doctor-rx-input"
                    style={{ width: "60px" }}
                    value={patientAge}
                    onChange={(e) => setPatientAge(e.target.value)}
                    placeholder="Age"
                  />
                  <select
                    className="doctor-rx-select"
                    style={{ flex: 1 }}
                    value={patientGender}
                    onChange={(e) => setPatientGender(e.target.value)}
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="doctor-rx-field">
                <label>Consulting Doctor</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={doctorName}
                  onChange={(e) => setDoctorName(e.target.value)}
                  readOnly={!!scopedDoctor}
                />
              </div>

              <div className="doctor-rx-field">
                <label>Department / Specialty</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </div>

              <div className="doctor-rx-field">
                <label>Visit Type / Fee</label>
                <input
                  type="text"
                  className="doctor-rx-input readonly-input"
                  readOnly
                  value={`${visitType} ${activeQueueItem?.consultationFee ? `(₹${activeQueueItem.consultationFee})` : ""}`}
                />
              </div>
            </div>
          </div>

          {/* OCR Upload Card: scan a prescription image to auto-fill the consultation */}
          <div
            className="doctor-rx-card"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!ocrScanning) void handleOcrUpload(e.dataTransfer.files?.[0]);
            }}
            style={{
              marginBottom: "16px",
              border: "1.5px dashed #94a3b8",
              background: "#f8fafc",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "14px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
              {ocrPreviewUrl ? (
                <img src={ocrPreviewUrl} alt={ocrFileName} style={{ width: "56px", height: "40px", objectFit: "cover", borderRadius: "6px", border: "1px solid #cbd5e1" }} />
              ) : (
                <span style={{ fontSize: "22px" }}>📄</span>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#102a43" }}>Scan Prescription to Auto-fill</div>
                <div style={{ fontSize: "12px", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ocrScanning
                    ? `Reading ${ocrFileName} with OCR…`
                    : ocrFileName
                      ? `Last scanned: ${ocrFileName}`
                      : "Upload or drop a prescription / case sheet image (any image format) to fill symptoms, diagnosis, vitals, medicines and advice"}
                </div>
              </div>
            </div>
            <label
              style={{
                height: "34px",
                padding: "0 16px",
                borderRadius: "8px",
                background: ocrScanning ? "#94a3b8" : "#0284c7",
                color: "#ffffff",
                fontWeight: 700,
                fontSize: "13px",
                display: "inline-flex",
                alignItems: "center",
                cursor: ocrScanning ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {ocrScanning ? "Scanning…" : "⬆ Upload Image"}
              <input
                type="file"
                accept="image/*,.tif,.tiff,.bmp,.webp,.gif"
                disabled={ocrScanning}
                style={{ display: "none" }}
                onChange={(e) => {
                  void handleOcrUpload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {/* Clinical Assessment & Diagnosis Card */}
          <div className="doctor-rx-card" style={{ marginBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <h3 className="doctor-rx-card-title" style={{ margin: 0 }}>Clinical Assessment & Vitals</h3>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {loadingVitals ? (
                  <span style={{ fontSize: "11px", color: "#0284c7", fontWeight: 600 }}>
                    ⚡ Fetching latest vitals...
                  </span>
                ) : latestVitalsRecord ? (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#166534",
                      background: "#dcfce7",
                      border: "1px solid #bbf7d0",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                    title={latestVitalsRecord.recorded_at ? `Recorded on ${new Date(latestVitalsRecord.recorded_at).toLocaleString()}` : "Latest recorded vitals"}
                  >
                    <span style={{ color: "#16a34a" }}>●</span> Auto-Filled with Latest Records {latestVitalsRecord.recorded_at ? `(${new Date(latestVitalsRecord.recorded_at).toLocaleDateString()})` : ""}
                  </span>
                ) : null}

                <button
                  type="button"
                  onClick={() => void loadPatientLatestVitals(patientUhid, null, true)}
                  disabled={!patientUhid.trim() || loadingVitals}
                  style={{
                    background: "#f0fdf4",
                    color: "#166534",
                    border: "1px solid #86efac",
                    borderRadius: "6px",
                    padding: "3px 10px",
                    fontSize: "11px",
                    fontWeight: 700,
                    cursor: !patientUhid.trim() || loadingVitals ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    transition: "all 0.15s ease",
                  }}
                  title="Fetch and auto-fill latest vitals taken for this patient"
                >
                  <span>↻</span> Auto-Fill Latest Vitals
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
              <div className="doctor-rx-field">
                <label>Chief Complaints / Symptoms</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={symptoms}
                  onChange={(e) => setSymptoms(e.target.value)}
                  placeholder="e.g. High fever for 3 days, bodyache, persistent dry cough..."
                />
              </div>

              <div className="doctor-rx-field">
                <label>
                  Provisional / Final Diagnosis <span className="req">*</span>
                </label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="e.g. Viral Fever / Acute Bronchitis"
                />
              </div>
            </div>

            {/* Quick Diagnosis Suggestions */}
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "6px" }}>
                Quick Diagnosis Presets (Click to set):
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {COMMON_DIAGNOSES.slice(0, 8).map((diag) => (
                  <button
                    key={diag}
                    type="button"
                    onClick={() => setDiagnosis(diag)}
                    style={{
                      background: diagnosis === diag ? "#0284c7" : "#f1f5f9",
                      color: diagnosis === diag ? "#ffffff" : "#334155",
                      border: "1px solid #cbd5e1",
                      borderRadius: "14px",
                      padding: "3px 10px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: "pointer",
                      transition: "all 0.1s ease",
                    }}
                  >
                    + {diag}
                  </button>
                ))}
              </div>
            </div>

            {/* Vitals row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" }}>
              <div className="doctor-rx-field">
                <label style={{ fontSize: "11px" }}>Blood Pressure</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  style={{ fontSize: "12px", padding: "6px 8px" }}
                  value={vitalsBp}
                  onChange={(e) => setVitalsBp(e.target.value)}
                  placeholder="e.g. 120/80"
                />
              </div>
              <div className="doctor-rx-field">
                <label style={{ fontSize: "11px" }}>Pulse Rate</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  style={{ fontSize: "12px", padding: "6px 8px" }}
                  value={vitalsPulse}
                  onChange={(e) => setVitalsPulse(e.target.value)}
                  placeholder="e.g. 72 bpm"
                />
              </div>
              <div className="doctor-rx-field">
                <label style={{ fontSize: "11px" }}>Temperature</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  style={{ fontSize: "12px", padding: "6px 8px" }}
                  value={vitalsTemp}
                  onChange={(e) => setVitalsTemp(e.target.value)}
                  placeholder="e.g. 98.6 °F"
                />
              </div>
              <div className="doctor-rx-field">
                <label style={{ fontSize: "11px" }}>Body Weight</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  style={{ fontSize: "12px", padding: "6px 8px" }}
                  value={vitalsWeight}
                  onChange={(e) => setVitalsWeight(e.target.value)}
                  placeholder="e.g. 68 kg"
                />
              </div>
              <div className="doctor-rx-field">
                <label style={{ fontSize: "11px" }}>SpO2 (%)</label>
                <input
                  type="text"
                  className="doctor-rx-input"
                  style={{ fontSize: "12px", padding: "6px 8px" }}
                  value={vitalsSpo2}
                  onChange={(e) => setVitalsSpo2(e.target.value)}
                  placeholder="e.g. 99%"
                />
              </div>
            </div>

            {/* Optional Lab Parameters Box (.doctor-rx-lab-box) */}
            <div className="doctor-rx-lab-box">
              <div className="doctor-rx-lab-header">
                <span className="doctor-rx-lab-title">Recent Lab Parameters (Optional Reference)</span>
                <button
                  type="button"
                  className="doctor-rx-lab-link"
                  onClick={() => {
                    setLabFbs("98");
                    setLabPpbs("134");
                    setLabHba1c("5.8");
                    setLabTchol("182");
                    setLabLdl("110");
                    setLabTgl("145");
                    setLabVitd("32");
                  }}
                >
                  Fill Normal Defaults
                </button>
              </div>

              <div className="doctor-rx-lab-grid">
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">FBS (mg/dL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labFbs}
                    onChange={(e) => setLabFbs(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">PPBS (mg/dL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labPpbs}
                    onChange={(e) => setLabPpbs(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">HbA1c (%)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labHba1c}
                    onChange={(e) => setLabHba1c(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">T. Chol (mg/dL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labTchol}
                    onChange={(e) => setLabTchol(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">LDL (mg/dL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labLdl}
                    onChange={(e) => setLabLdl(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">TGL (mg/dL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labTgl}
                    onChange={(e) => setLabTgl(e.target.value)}
                    placeholder="—"
                  />
                </div>
                <div className="doctor-rx-lab-item">
                  <span className="lab-label">Vit-D (ng/mL)</span>
                  <input
                    type="text"
                    className="lab-input"
                    value={labVitd}
                    onChange={(e) => setLabVitd(e.target.value)}
                    placeholder="—"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Prescription Medicines (Rx) Card */}
          <div className="doctor-rx-card" style={{ marginBottom: "16px" }}>
            <div className="doctor-rx-meds-header">
              <div>
                <h3 className="meds-title" style={{ margin: 0 }}>
                  Prescribed Medicines (℞)
                </h3>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  Add medicine names, dosage, frequency, duration and timing instructions.
                </span>
              </div>

              <div className="meds-controls">
                <button type="button" className="add-med-btn" onClick={handleAddMedicine}>
                  + Add Medicine
                </button>
              </div>
            </div>

            {/* Quick add chips */}
            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "5px" }}>
                Common OPD Drugs Quick-Add:
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {COMMON_DRUGS.slice(0, 6).map((drug) => (
                  <button
                    key={drug.name}
                    type="button"
                    onClick={() => handleQuickAddMedicine(drug)}
                    style={{
                      background: "#f0fdf4",
                      color: "#166534",
                      border: "1px solid #bbf7d0",
                      borderRadius: "12px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    + {drug.name.split(" ")[0]}
                  </button>
                ))}
              </div>
            </div>

            {suggestedMedicines.length > 0 && rxSuggestions && (
              <div style={{ marginBottom: "12px", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: "8px", padding: "8px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#5b21b6" }}>
                    ✨ Usually prescribed for "{diagnosis.trim()}" (from {rxSuggestions.source === "doctor" ? "your" : "all doctors'"} last{" "}
                    {rxSuggestions.prescription_count} prescription{rxSuggestions.prescription_count === 1 ? "" : "s"}):
                  </span>
                  {suggestedMedicines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleAddSuggestedMedicines(suggestedMedicines)}
                      style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: "10px", padding: "2px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                    >
                      + Add all
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {suggestedMedicines.map((m) => (
                    <button
                      key={m.medicine_name}
                      type="button"
                      title={`Used in ${m.count} of ${rxSuggestions.prescription_count} prescriptions`}
                      onClick={() => handleAddSuggestedMedicines([m])}
                      style={{ background: "#ffffff", color: "#5b21b6", border: "1px solid #c4b5fd", borderRadius: "12px", padding: "2px 8px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
                    >
                      + {m.medicine_name}
                      {(m.frequency || m.duration) && (
                        <span style={{ fontWeight: 400, color: "#6d28d9" }}> · {[m.frequency, m.duration].filter(Boolean).join(" · ")}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Medicines Table */}
            <div className="doctor-rx-table-wrap">
              <table className="doctor-rx-table">
                <thead>
                  <tr>
                    <th style={{ width: "35px" }}>#</th>
                    <th style={{ minWidth: "160px" }}>Medicine Name</th>
                    <th style={{ width: "95px" }}>Dosage</th>
                    <th style={{ width: "170px" }}>Frequency</th>
                    <th style={{ width: "100px" }}>Duration</th>
                    <th style={{ minWidth: "130px" }}>Instructions</th>
                    <th style={{ width: "40px", textAlign: "center" }}>Del</th>
                  </tr>
                </thead>
                <tbody>
                  {medicines.map((med, index) => (
                    <tr key={med.id}>
                      <td style={{ textAlign: "center", fontWeight: 700, color: "#64748b" }}>{index + 1}</td>
                      <td>
                        <input
                          type="text"
                          className="table-input"
                          placeholder="Medicine name..."
                          value={med.medicine_name}
                          onChange={(e) => handleUpdateMedicine(med.id, "medicine_name", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="table-input"
                          placeholder="Dosage"
                          value={med.dosage}
                          onChange={(e) => handleUpdateMedicine(med.id, "dosage", e.target.value)}
                        />
                      </td>
                      <td style={{ position: "relative" }}>
                        <FrequencyCombobox
                          value={med.frequency}
                          onChange={(val) => handleUpdateMedicine(med.id, "frequency", val)}
                          options={frequencyOptions}
                          onAddOption={handleAddFrequencyOption}
                          onDeleteOption={handleDeleteFrequencyOption}
                          onResetDefaults={handleResetFrequencyOptions}
                        />
                      </td>
                      <td>
                        <select
                          className="duration-select"
                          value={med.duration}
                          onChange={(e) => handleUpdateMedicine(med.id, "duration", e.target.value)}
                        >
                          <option value="">Select duration...</option>
                          <option value="3 Days">3 Days</option>
                          <option value="5 Days">5 Days</option>
                          <option value="7 Days">7 Days</option>
                          <option value="10 Days">10 Days</option>
                          <option value="14 Days">14 Days</option>
                          <option value="1 Month">1 Month</option>
                          <option value="Continuous">Continuous</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          className="table-input"
                          placeholder="Instructions (e.g. After Food)"
                          value={med.instructions}
                          onChange={(e) => handleUpdateMedicine(med.id, "instructions", e.target.value)}
                        />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <button
                          type="button"
                          className="trash-btn"
                          onClick={() => handleRemoveMedicine(med.id)}
                          title="Remove Medicine"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Lab Investigations & Advice Card */}
          <div className="doctor-rx-card" style={{ marginBottom: "16px" }}>
            <h3 className="doctor-rx-card-title">Lab Investigations & Clinical Advice</h3>

            <div className="doctor-rx-field" style={{ marginBottom: "12px" }}>
              <label>Recommended Lab & Diagnostic Tests</label>
              <input
                type="text"
                className="doctor-rx-input"
                placeholder="e.g. CBC, Lipid Profile, LFT, Urine R/M, Chest X-Ray..."
                value={labTests}
                onChange={(e) => setLabTests(e.target.value)}
              />
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "5px" }}>
                {COMMON_LAB_TESTS.slice(0, 5).map((test) => (
                  <button
                    key={test}
                    type="button"
                    onClick={() => {
                      const cur = labTests ? `${labTests}, ${test}` : test;
                      setLabTests(cur);
                    }}
                    style={{
                      background: "#f1f5f9",
                      color: "#475569",
                      border: "1px solid #cbd5e1",
                      borderRadius: "10px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      cursor: "pointer",
                    }}
                  >
                    + {test}
                  </button>
                ))}
              </div>
              {suggestedLabTests.length > 0 && (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginTop: "6px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#5b21b6" }}>✨ Usually advised for this diagnosis:</span>
                  {suggestedLabTests.map((t) => (
                    <button
                      key={t.name}
                      type="button"
                      title={`Advised in ${t.count} of ${rxSuggestions?.prescription_count ?? 0} prescriptions`}
                      onClick={() => setLabTests((cur) => (cur.trim() ? `${cur.trim().replace(/,\s*$/, "")}, ${t.name}` : t.name))}
                      style={{ background: "#f5f3ff", color: "#5b21b6", border: "1px solid #c4b5fd", borderRadius: "10px", padding: "2px 8px", fontSize: "11px", cursor: "pointer" }}
                    >
                      + {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="doctor-rx-field" style={{ marginBottom: "12px" }}>
              <label>Doctor Advice & Dietary Guidelines</label>
              <textarea
                className="doctor-rx-textarea"
                rows={3}
                value={advice}
                onChange={(e) => setAdvice(e.target.value)}
                placeholder="Dietary instructions, precautions, lifestyle advice..."
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "12px", alignItems: "center" }}>
              <div className="doctor-rx-field">
                <label>Follow-up Date</label>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <input
                    type="date"
                    className="doctor-rx-input"
                    value={followUpDate}
                    onChange={(e) => setFollowUpDate(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button
                      type="button"
                      onClick={() => handleSetFollowUpDays(3)}
                      style={{
                        padding: "5px 8px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        background: "#f8fafc",
                        cursor: "pointer",
                      }}
                    >
                      +3d
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetFollowUpDays(7)}
                      style={{
                        padding: "5px 8px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        background: "#f8fafc",
                        cursor: "pointer",
                      }}
                    >
                      +7d
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetFollowUpDays(15)}
                      style={{
                        padding: "5px 8px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        background: "#f8fafc",
                        cursor: "pointer",
                      }}
                    >
                      +15d
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: "16px" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#0369a1",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sendToPharmacy}
                    onChange={(e) => setSendToPharmacy(e.target.checked)}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  <span>Send electronic Rx to Pharmacy OP Dispense</span>
                </label>
              </div>
            </div>
          </div>

          {/* Action Row */}
          <div className="doctor-rx-actions-row">
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              {/* PRIMARY ACTION: Complete Consultation */}
              <button
                type="button"
                className="rx-send-btn"
                disabled={submitting}
                onClick={() => handleCompleteConsultation(false)}
                style={{
                  background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)",
                  boxShadow: "0 2px 8px rgba(22, 163, 74, 0.3)",
                  fontSize: "14px",
                  padding: "10px 22px",
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>{submitting ? "Saving & Completing..." : "Complete Consultation"}</span>
              </button>

              {/* Complete & Print */}
              <button
                type="button"
                className="rx-outline-btn"
                disabled={submitting}
                onClick={() => handleCompleteConsultation(true)}
                title="Complete consultation and print prescription"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                <span>Complete & Print</span>
              </button>

              {/* Share via WhatsApp */}
              <button
                type="button"
                className="rx-outline-btn"
                style={{
                  background: "#25D366",
                  borderColor: "#25D366",
                  color: "#ffffff",
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
                onClick={handleShareWhatsAppPrescription}
                title="Share electronic prescription to patient via WhatsApp"
              >
                <WhatsAppIcon size={16} />
                <span>Share via WhatsApp</span>
              </button>

              {/* Save Draft */}
              <button
                type="button"
                className="rx-outline-btn"
                disabled={submitting}
                onClick={handleSaveDraft}
                title="Save prescription draft without completing"
              >
                <span>Save Draft</span>
              </button>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="rx-outline-btn"
                onClick={() => {
                  setMedicines([]);
                  setDiagnosis("");
                  setSymptoms("");
                  setLabTests("");
                  setActiveQueueItem(null);
                  setPatientUhid("");
                  setPatientName("");
                  setAppointmentId(null);
                  setAppointmentToken("");
                }}
              >
                Clear Form
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Live Branded A4 Prescription Sheet */}
        <div className="doctor-rx-preview-column">
          <div className="doctor-rx-preview-header">
            <div>
              <h2 className="preview-title">Live Prescription Sheet</h2>
              <span style={{ fontSize: "12px", color: "#627d98" }}>
                Branded A4 format • Official HospAI HMS Medical Record
              </span>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="refresh-preview-btn"
                style={{
                  background: "#25D366",
                  borderColor: "#25D366",
                  color: "#ffffff",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontWeight: 600,
                }}
                onClick={handleShareWhatsAppPrescription}
                title="Send digital prescription summary to patient via WhatsApp"
              >
                <WhatsAppIcon size={14} />
                <span>WhatsApp</span>
              </button>
              <button
                type="button"
                className="refresh-preview-btn"
                onClick={() => window.print()}
                title="Print official prescription document"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                <span>Print Document</span>
              </button>
            </div>
          </div>

          {/* The A4 Prescription Document */}
          <div className="doctor-rx-sheet" ref={printSheetRef}>
            {/* Sheet Header */}
            <div className="rx-sheet-header">
              <div className="rx-sheet-logo-group">
                <BrandLogo className="brand-logo-img" />
                <div className="rx-sheet-title-col">
                  <div className="rx-sheet-brand-name">
                    Hosp<span className="brand-red">AI</span>
                  </div>
                  <div className="rx-sheet-brand-sub">MULTISPECIALITY HOSPITAL & RESEARCH CENTRE</div>
                </div>
              </div>
            </div>

            <div className="rx-sheet-divider"></div>

            {/* Patient & Doctor Meta Grid */}
            <div className="rx-sheet-meta-grid">
              <div className="meta-item">
                <span className="meta-lbl">Patient Name</span>
                <span className="meta-sep">:</span>
                <span className="meta-val" style={{ fontWeight: 800, color: "#102a43" }}>
                  {patientName || "—"}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Date & Time</span>
                <span className="meta-sep">:</span>
                <span className="meta-val">
                  {selectedDate} • {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">UHID</span>
                <span className="meta-sep">:</span>
                <span className="meta-val" style={{ fontWeight: 700 }}>
                  {patientUhid || "—"}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Token / Queue</span>
                <span className="meta-sep">:</span>
                <span className="meta-val">
                  {appointmentToken ? `#Token ${appointmentToken}` : "OPD Walk-in"}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Age / Gender</span>
                <span className="meta-sep">:</span>
                <span className="meta-val">
                  {patientAge ? `${patientAge} Years` : "—"} / {patientGender}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Doctor</span>
                <span className="meta-sep">:</span>
                <span className="meta-val" style={{ fontWeight: 700, color: "#0369a1" }}>
                  {doctorName}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Department</span>
                <span className="meta-sep">:</span>
                <span className="meta-val">{department}</span>
              </div>
              <div className="meta-item">
                <span className="meta-lbl">Diagnosis</span>
                <span className="meta-sep">:</span>
                <span className="meta-val" style={{ fontWeight: 700 }}>
                  {diagnosis || "Under Evaluation"}
                </span>
              </div>
            </div>

            <div style={{ height: "1px", background: "#e2e8f0", margin: "6px 0 10px" }}></div>

            {/* Vitals summary if recorded */}
            {(vitalsBp || vitalsPulse || vitalsTemp || vitalsWeight || vitalsSpo2) ? (
              <div
                style={{
                  fontSize: "11px",
                  color: "#475569",
                  background: "#f8fafc",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  display: "flex",
                  gap: "16px",
                  marginBottom: "8px",
                }}
              >
                {vitalsBp && <span><strong>BP:</strong> {vitalsBp}</span>}
                {vitalsPulse && <span><strong>Pulse:</strong> {vitalsPulse}</span>}
                {vitalsTemp && <span><strong>Temp:</strong> {vitalsTemp}</span>}
                {vitalsWeight && <span><strong>Wt:</strong> {vitalsWeight}</span>}
                {vitalsSpo2 && <span><strong>SpO2:</strong> {vitalsSpo2}</span>}
              </div>
            ) : null}

            {/* Rx Symbol */}
            <div className="rx-sheet-symbol">℞</div>

            {/* Medicines Box */}
            <div className="rx-sheet-meds-box">
              <table className="rx-sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: "30px", textAlign: "center" }}>#</th>
                    <th style={{ textAlign: "left" }}>Medicine / Formulation</th>
                    <th style={{ width: "85px" }}>Dosage</th>
                    <th style={{ width: "110px" }}>Frequency</th>
                    <th style={{ width: "80px" }}>Duration</th>
                    <th style={{ textAlign: "left" }}>Instructions</th>
                  </tr>
                </thead>
                <tbody>
                  {medicines.filter((m) => m.medicine_name.trim()).length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", padding: "16px", color: "#94a3b8" }}>
                        No medicines added yet.
                      </td>
                    </tr>
                  ) : (
                    medicines
                      .filter((m) => m.medicine_name.trim())
                      .map((med, idx) => (
                        <tr key={med.id}>
                          <td style={{ textAlign: "center", fontWeight: 700 }}>{idx + 1}</td>
                          <td style={{ fontWeight: 700 }}>{med.medicine_name}</td>
                          <td>{med.dosage}</td>
                          <td>{med.frequency}</td>
                          <td>{med.duration}</td>
                          <td style={{ fontStyle: "italic", color: "#475569" }}>{med.instructions}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Lab Investigations */}
            {labTests && (
              <div style={{ margin: "8px 0", fontSize: "11.5px" }}>
                <strong style={{ color: "#102a43" }}>Investigations Advised:</strong>{" "}
                <span style={{ color: "#334e68" }}>{labTests}</span>
              </div>
            )}

            {/* Clinical Advice */}
            {advice.trim() ? (
              <div className="rx-sheet-advice">
                <div className="advice-title">Doctor's Advice & Guidelines:</div>
                <ul className="advice-list">
                  {advice.split("\n").filter(Boolean).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Follow-up date */}
            {followUpDate && (
              <div style={{ marginTop: "10px", fontSize: "11.5px", fontWeight: 700, color: "#0369a1" }}>
                Review / Follow-up Visit on: {followUpDate} (or earlier SOS)
              </div>
            )}

            {/* Doctor Details Block */}
            <div className="rx-sheet-signature-block">
              <div className="sig-name">{doctorName}</div>
              <div className="sig-dept">{department}</div>
              <div className="sig-reg">Reg. No: TSMC-48291 • HospAI HMS</div>
            </div>

            {/* Footer */}
            <div className="rx-sheet-footer">
              This is a computer generated electronic prescription. Valid across HospAI Pharmacy and Diagnostic Labs.
            </div>
          </div>
        </div>
      </div>

      {/* Registered Patients Master Directory Modal */}
      {patientDirectoryModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.65)",
            backdropFilter: "blur(4px)",
            zIndex: 99999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
          onClick={() => setPatientDirectoryModalOpen(false)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              width: "100%",
              maxWidth: "860px",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1.5px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#f8fafc",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "8px",
                    background: "#e0f2fe",
                    color: "#0284c7",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                    fontSize: "16px",
                  }}
                >
                  👥
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 800, color: "#102a43" }}>
                    Choose Registered Patient (UHID Master Directory)
                  </h3>
                  <span style={{ fontSize: "12px", color: "#627d98" }}>
                    Click any patient to load their details into the prescription form.
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setPatientDirectoryModalOpen(false)}
                style={{
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  width: "32px",
                  height: "32px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: "#475569",
                  fontWeight: 800,
                  fontSize: "14px",
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Search & Filter */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #f1f5f9", display: "flex", gap: "12px", alignItems: "center", background: "#ffffff" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <input
                  type="text"
                  placeholder="Search by UHID (e.g. 0001, PAT-2026...), Patient Name, or Mobile Number..."
                  value={directorySearch}
                  onChange={(e) => setDirectorySearch(e.target.value)}
                  autoFocus
                  style={{
                    width: "100%",
                    padding: "9px 12px 9px 34px",
                    borderRadius: "6px",
                    border: "1.5px solid #0284c7",
                    fontSize: "13px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="2.2"
                  style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)" }}
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>

              <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 600, whiteSpace: "nowrap" }}>
                {modalFilteredPatients.length} of {registeredPatients.length} Patients
              </span>
            </div>

            {/* Modal Table Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
              {modalFilteredPatients.length === 0 ? (
                <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
                  <div style={{ fontSize: "28px", marginBottom: "8px" }}>🔍</div>
                  <div style={{ fontWeight: 700, fontSize: "14px", color: "#334155" }}>
                    No registered patients found matching "{directorySearch}"
                  </div>
                  <div style={{ fontSize: "12px", marginTop: "4px" }}>
                    Try searching with another UHID number, full name, or phone.
                  </div>
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", marginTop: "8px" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e2e8f0", color: "#475569", textAlign: "left" }}>
                      <th style={{ padding: "10px 8px", width: "160px" }}>Patient UHID</th>
                      <th style={{ padding: "10px 8px" }}>Full Name</th>
                      <th style={{ padding: "10px 8px", width: "110px" }}>Age / Gender</th>
                      <th style={{ padding: "10px 8px", width: "120px" }}>Mobile</th>
                      <th style={{ padding: "10px 8px", width: "120px" }}>Department</th>
                      <th style={{ padding: "10px 8px", textAlign: "right", width: "120px" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalFilteredPatients.map((p) => {
                      const uhid = p.patient_id || p.id || "";
                      const fullName = getPatientFullName(p);
                      const isCurrent = patientUhid === uhid;

                      return (
                        <tr
                          key={uhid}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: isCurrent ? "#f0f9ff" : "transparent",
                            transition: "background 0.1s ease",
                          }}
                          onMouseEnter={(e) => {
                            if (!isCurrent) e.currentTarget.style.background = "#f8fafc";
                          }}
                          onMouseLeave={(e) => {
                            if (!isCurrent) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <td style={{ padding: "10px 8px" }}>
                            <span
                              style={{
                                background: "#e0f2fe",
                                color: "#0369a1",
                                fontWeight: 800,
                                fontSize: "11.5px",
                                padding: "2px 7px",
                                borderRadius: "4px",
                                border: "1px solid #bae6fd",
                              }}
                            >
                              {uhid}
                            </span>
                          </td>
                          <td style={{ padding: "10px 8px", fontWeight: 700, color: "#102a43" }}>
                            {fullName}
                          </td>
                          <td style={{ padding: "10px 8px", color: "#475569" }}>
                            {p.age ? `${p.age} y` : "—"} / {p.gender || "—"}
                          </td>
                          <td style={{ padding: "10px 8px", color: "#475569", fontWeight: 600 }}>
                            {p.phone || "—"}
                          </td>
                          <td style={{ padding: "10px 8px", color: "#64748b" }}>
                            {p.latest_department || "General"}
                          </td>
                          <td style={{ padding: "10px 8px", textAlign: "right" }}>
                            <button
                              type="button"
                              onClick={() => void handlePickSearchedPatient(p)}
                              style={{
                                background: isCurrent ? "#0284c7" : "#16a34a",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "5px",
                                padding: "6px 14px",
                                fontSize: "11.5px",
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              {isCurrent ? "Selected ✓" : "Select Patient →"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#f8fafc",
              }}
            >
              <span style={{ fontSize: "11.5px", color: "#64748b" }}>
                Tip: You can also search by typing the last digits of UHID (e.g. <code>0001</code>) to find patients instantly.
              </span>
              <button
                type="button"
                onClick={() => setPatientDirectoryModalOpen(false)}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "6px 16px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  color: "#334155",
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
