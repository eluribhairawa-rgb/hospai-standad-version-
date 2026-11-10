import { normalizeSearchQuery, validateMobileByCountry } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import MarkdownReport from "../components/MarkdownReport";
import DocumentUploadDropzone from "../components/DocumentUploadDropzone";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Input, Select, Table, TableCell, TableHead, TableRow, Tabs, TabsContent, TabsTrigger, Textarea } from "../components/ui";
import { API_BASE, SUPPORTED_DOCUMENT_ACCEPT, SUPPORTED_DOCUMENT_EXTENSIONS } from "../lib/constants";
import { apiFetch, reportError } from "../lib/api";
import { calculateAgeFromDob, formatDate, formatDateTimeIST, getISTDateTimeKey, getTimestamp, stripUploadTimestampPrefix } from "../lib/format";
import { printViaIframe } from "../lib/printViaIframe";
import { exportPDF, downloadPDF, patientFilename } from "../lib/exportService";
import { PRINT_BRAND_HEADER_DATA_URI, PRINT_WATERMARK_DATA_URI } from "../lib/printBrand";
import type { Admission, BedAllocation, Certificate, DocumentItem, Encounter, MedicationSchedule, Notice, ObservationNote, Patient, PatientMovement, PatientVital } from "../types";

type Props = {
  patients: Patient[];
  onSelect: (patient: Patient | null) => void;
  onDelete: (patientId: string) => Promise<void>;
  onPatientUpdated: (patientId?: string) => Promise<void>;
  onExportCsv: (query?: string) => Promise<void>;
  selectedPatient: Patient | null;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  canEdit: boolean;
  canDelete: boolean;
  canReadBilling: boolean;
  canReadLab: boolean;
  ocrLanguage: string;
  languages: Record<string, string>;
  refreshToken: number;
  onNavigate?: (pageId: string) => void;
};

const IMAGE_NAME_PATTERN = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i;
type DeleteTarget = { patientId: string; label: string };
type DeleteDocumentTarget = { id: number; label: string };
type PatientInvoice = {
  id: number;
  invoice_no?: string;
  module?: string;
  total_amount?: number;
  paid_amount?: number;
  due_amount?: number;
  payment_status?: string;
  created_at?: string;
};
type PatientDiagnostic = {
  id: number;
  invoice_no?: string;
  test_name?: string;
  amount?: number;
  paid_amount?: number;
  due_amount?: number;
  status?: string;
  created_at?: string;
};

function SavedDocumentPreview({ doc }: { doc: DocumentItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setError("");
    setUrl(null);

    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/documents/${doc.id}/file`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("preview unavailable");
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) setError("Original file preview unavailable.");
      }
    };
    void load();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id]);

  if (error) return <p className="muted">{error}</p>;
  if (!url) return <p className="muted">Loading file preview...</p>;

  const mime = (doc.mime_type || "").toLowerCase();
  const name = (doc.file_name || doc.file_path || "").toLowerCase();
  const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
  const isImage = mime.startsWith("image/") || IMAGE_NAME_PATTERN.test(name);

  if (isImage) return <img className="ocr-source-image" src={url} alt={doc.file_name || "Document"} />;
  if (isPdf) return <iframe className="ocr-source-pdf" src={url} title={`Document ${doc.id}`} />;

  return (
    <a className="link" href={url} target="_blank" rel="noreferrer">
      Open document
    </a>
  );
}

export default function PatientsPage({
  patients,
  onSelect,
  onDelete,
  onPatientUpdated,
  onExportCsv,
  selectedPatient,
  setNotice,
  canEdit,
  canDelete,
  canReadBilling,
  canReadLab,
  ocrLanguage,
  languages,
  refreshToken,
  onNavigate,
}: Props) {
  const handlePrintLatestCertificate = async (patientId: string) => {
    try {
      const data = await apiFetch<{ certificates?: Certificate[] }>(`/api/patients/${patientId}/certificates`);
      const certificate = data.certificates?.[0];
      if (!certificate) {
        setNotice({ type: "warning", message: "No certificates found for this patient." });
        return;
      }
      const safeText = (value: unknown) => String(value ?? "-")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

      const title = safeText(certificate.title || "Certificate");
      const printDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
      const printTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });

      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    @page { size: A4 portrait; margin: 4mm 5mm 5mm; }
    * { box-sizing: border-box; }
    html { margin: 0; background: transparent; color: #000; font-family: Arial, Helvetica, sans-serif; }
    body { margin: 0; font-size: 9pt; background: transparent; line-height: 1.5; }
    .receipt-wrap { width: 100%; min-height: 265mm; display: flex; flex-direction: column; position: relative; z-index: 1; padding-left: 5mm; padding-right: 5mm;}
    
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
    
    /* Header */
    .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2mm; margin-top: 5mm; width: 100%; }
    .brand-logo { width: auto; height: 24mm; object-fit: contain; }
    .thick-line { border-top: 1.2mm solid #000; margin: 1.5mm 0 6mm 0; }
    
    .cert-header { display: flex; justify-content: space-between; margin-bottom: 6mm; align-items: flex-start; }
    .cert-title-area h2 { margin: 0; font-size: 16pt; text-transform: uppercase; font-weight: 800; color: #111; }
    .cert-title-area p { margin: 1mm 0 0; font-size: 9.5pt; color: #333; }
    
    .cert-meta-table { font-size: 8.5pt; border-collapse: collapse; }
    .cert-meta-table td { padding: 1.5mm 0; border: none !important; }
    .cert-meta-table td.label { width: 22mm; font-weight: normal; }
    .cert-meta-table td.colon { width: 4mm; text-align: center; font-weight: bold; }
    .cert-meta-table td.val { font-weight: bold; text-align: right; }
    
    .cert-body-wrap { margin-top: 6mm; font-size: 10.5pt; line-height: 1.6; }
    .cert-body-wrap h3 { font-size: 16pt; margin: 0 0 4mm 0; text-transform: uppercase; font-weight: 800; color: #111; }
    .cert-body-meta { margin-bottom: 8mm; line-height: 1.8; }
    .cert-body-text { white-space: pre-wrap; margin-top: 4mm; }
    
  </style>
</head>
<body>
  <div class="receipt-wrap" data-hospai-shared-print-shell>
    <img class="hospai-shared-watermark" src="${PRINT_WATERMARK_DATA_URI}" alt="HospAI Watermark" />
    
    <header class="header-container">
      <div>
        <img class="brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI Logo" />
      </div>
    </header>
    
    <div class="thick-line"></div>
    
    <div class="cert-header">
      <div class="cert-title-area">
        <h2>${title}</h2>
        <p>HospAI | Pharmacy | Diagnostic</p>
      </div>
      <table class="cert-meta-table">
        <tr>
          <td class="label">Print Date</td><td class="colon">:</td><td class="val">${printDate}</td>
        </tr>
        <tr>
          <td class="label">Generated By</td><td class="colon">:</td><td class="val">HospAI System</td>
        </tr>
        <tr>
          <td class="label">Generated Time</td><td class="colon">:</td><td class="val">${printTime}</td>
        </tr>
      </table>
    </div>
    
    <div class="cert-body-wrap">
      <h3>${title}</h3>
      <div class="cert-body-meta">
        Type: ${safeText(String(certificate.certificate_type || "").replace(/_/g, " "))}<br/>
        Issued by: ${safeText(certificate.issued_by || "HospAI")}<br/>
        Created at: ${safeText(certificate.created_at ? formatDateTimeIST(certificate.created_at) : new Date().toLocaleString("en-IN"))}
      </div>
      <div class="cert-body-text">${safeText(certificate.body)}</div>
    </div>
    
  </div>
</body>
</html>`;
      printViaIframe(html);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load patient certificates.");
    }
  };
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletingPatient, setDeletingPatient] = useState(false);
  const [query, setQuery] = useState("");
  const [visitStatus, setVisitStatus] = useState<"all" | "ip" | "op">("all");
  const [results, setResults] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeQuery, setActiveQuery] = useState("");
  const latestQueryRef = useRef("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = async (term: string, status: "all" | "ip" | "op") => {
    const trimmed = term.trim();
    const requestKey = `${trimmed}|${status}`;
    if (!trimmed && status === "all") {
      latestQueryRef.current = "";
      setResults([]);
      setSearched(false);
      setActiveQuery("");
      setLoading(false);
      return;
    }

    latestQueryRef.current = requestKey;
    setActiveQuery(trimmed);
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      if (status !== "all") params.set("visit_status", status);
      const data = await apiFetch<{ patients?: Patient[] }>(`/api/patients?${params.toString()}`);
      if (latestQueryRef.current !== requestKey) return;
      setResults(data.patients || []);
    } catch (error) {
      if (latestQueryRef.current !== requestKey) return;
      setResults([]);
      reportError(setNotice, error as { message?: string; status?: number }, "Search failed.");
    } finally {
      if (latestQueryRef.current === requestKey) {
        setLoading(false);
      }
    }
  };

  const handleSearch = async () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    await runSearch(query, visitStatus);
  };

  useEffect(() => {
    const term = query.trim();
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    if (!term) {
      void runSearch("", visitStatus);
      return;
    }
    searchTimeoutRef.current = setTimeout(() => {
      void runSearch(term, visitStatus);
    }, 300);
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
    };
  }, [query, visitStatus]);

  const handleClearSearch = () => {
    setQuery("");
    setVisitStatus("all");
    setResults([]);
    setSearched(false);
    setActiveQuery("");
    setLoading(false);
    latestQueryRef.current = "";
  };

  const trimmedQuery = query.trim();
  const filterActive = Boolean(trimmedQuery) || visitStatus !== "all";
  const baseList = filterActive ? (searched ? results : []) : patients;

  const isPatientExpanded = (p: Patient) => {
    if (!selectedPatient?.patient_id || !p.patient_id) return false;
    return selectedPatient.patient_id.trim().toLowerCase() === p.patient_id.trim().toLowerCase();
  };

  const displayPatients = useMemo(() => {
    if (!selectedPatient?.patient_id) return baseList;
    const selId = selectedPatient.patient_id.trim().toLowerCase();
    const exists = baseList.some((p) => (p.patient_id || "").trim().toLowerCase() === selId);
    if (!exists) {
      const fromAll = patients.find((p) => (p.patient_id || "").trim().toLowerCase() === selId);
      return [fromAll || selectedPatient, ...baseList];
    }
    return baseList;
  }, [baseList, selectedPatient, patients]);

  useEffect(() => {
    if (!selectedPatient?.patient_id) return;
    const cleanId = selectedPatient.patient_id.trim().toLowerCase();
    if (query.trim() || visitStatus !== "all") {
      setQuery("");
      setVisitStatus("all");
    }
    const timer = setTimeout(() => {
      const el = document.getElementById(`patient-row-${selectedPatient.patient_id}`) ||
                 document.querySelector(`[data-patient-id="${cleanId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [selectedPatient?.patient_id]);
  // handleExportPatientsPdf has been replaced by PdfExportDropdown logic

  const handleConfirmDeletePatient = async () => {
    if (!deleteTarget) return;
    setDeletingPatient(true);
    try {
      await onDelete(deleteTarget.patientId);
      setDeleteTarget(null);
    } finally {
      setDeletingPatient(false);
    }
  };

  return (
    <section className="patient-page">
      <div className="patient-header panel">
        <div>
          <h3>Patients</h3>
          <p className="muted">Search, review, and manage patient records.</p>
        </div>
        <div className="patient-toolbar">
          <div className="visit-status-toggle" role="group" aria-label="Filter by inpatient or outpatient">
            {(["all", "ip", "op"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`visit-status-toggle-btn${visitStatus === option ? " active" : ""}`}
                onClick={() => setVisitStatus(option)}
                aria-pressed={visitStatus === option}
              >
                {option === "all" ? "All" : option === "ip" ? "Inpatient" : "Outpatient"}
              </button>
            ))}
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(normalizeSearchQuery(event.target.value, "+91"))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSearch();
              }
            }}
            placeholder="Search name or phone..."
            style={{ minWidth: "220px" }}
          />
          <Button variant="primary" onClick={() => void handleSearch()}>
            Search
          </Button>
          <Button variant="secondary" onClick={handleClearSearch}>
            Clear
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="list-meta">
          <p className="muted">
            {query.trim()
              ? `Showing ${displayPatients.length} search result${displayPatients.length === 1 ? "" : "s"}.`
              : `Showing ${displayPatients.length} patient${displayPatients.length === 1 ? "" : "s"}.`}
          </p>
          {loading && <Badge>Searching</Badge>}
        </div>

        <Table className="patient-list-table">
          <TableHead>
            <TableCell>UHID</TableCell>
            <TableCell>Patient</TableCell>
            <TableCell>Age</TableCell>
            <TableCell>Gender</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Created</TableCell>
            <TableCell>Actions</TableCell>
          </TableHead>
          {displayPatients.map((patient) => {
            const expanded = isPatientExpanded(patient);
            const createdAt = patient.created_at ? formatDate(patient.created_at) : "-";
            return (
              <Fragment key={patient.patient_id}>
                <TableRow
                  id={`patient-row-${patient.patient_id}`}
                  data-patient-id={(patient.patient_id || "").trim().toLowerCase()}
                  className={`${expanded ? "active" : ""} patient-row-clickable`}
                  onClick={() => onSelect(expanded ? null : patient)}
                  style={{ cursor: "pointer" }}
                  title={expanded ? "Click row to collapse details" : "Click row to open patient details"}
                >
                  <TableCell>{patient.patient_id}</TableCell>
                  <TableCell>
                    {[patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ") || "-"}
                  </TableCell>
                  <TableCell>{patient.age || "-"}</TableCell>
                  <TableCell>{patient.gender || "-"}</TableCell>
                  <TableCell>{patient.phone || "-"}</TableCell>
                  <TableCell>{createdAt}</TableCell>
                  <TableCell className="row-actions">
                    <Button
                      variant={expanded ? "secondary" : "ghost"}
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(expanded ? null : patient);
                      }}
                      style={
                        expanded
                          ? { fontWeight: 700 }
                          : { fontWeight: 700, color: "#00828a", border: "1px solid #ccfbf1", background: "#f0fdfa" }
                      }
                    >
                      {expanded ? "Hide" : "View"}
                    </Button>
                  </TableCell>
                </TableRow>
                {expanded && (
                  <div className="table-row-expand">
                    <PatientDetail
                      patientRef={patient}
                      setNotice={setNotice}
                      canEdit={canEdit}
                      canReadBilling={canReadBilling}
                      canReadLab={canReadLab}
                      ocrLanguage={ocrLanguage}
                      languages={languages}
                      canDelete={canDelete}
                      onRequestDelete={(fullPatient) =>
                        setDeleteTarget({
                          patientId: fullPatient.patient_id,
                          label: `${fullPatient.name} ${fullPatient.last_name || ""}`.trim() || fullPatient.patient_id,
                        })
                      }
                      onPatientUpdated={onPatientUpdated}
                      refreshToken={refreshToken}
                      onNavigate={onNavigate}
                    />
                  </div>
                )}
              </Fragment>
            );
          })}
        </Table>

        <div className="module-mobile-list patient-list-mobile" aria-label="Patient list cards">
          {displayPatients.map((patient) => {
            const expanded = isPatientExpanded(patient);
            return (
              <article
                className={`module-mobile-card ${expanded ? "active" : ""}`}
                key={`mobile-${patient.patient_id}`}
                data-patient-id={(patient.patient_id || "").trim().toLowerCase()}
                onClick={() => onSelect(expanded ? null : patient)}
                style={{ cursor: "pointer" }}
              >
                <h4>{[patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ") || "-"}</h4>
                <p><strong>UHID:</strong> {patient.patient_id}</p>
                <p><strong>Age:</strong> {patient.age || "-"}</p>
                <p><strong>Gender:</strong> {patient.gender || "-"}</p>
                <p><strong>Phone:</strong> {patient.phone || "-"}</p>
                <p><strong>Created:</strong> {formatDateTimeIST(patient.created_at)}</p>
                <div className="module-card-actions">
                  <Button
                    type="button"
                    variant={expanded ? "secondary" : "ghost"}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(expanded ? null : patient);
                    }}
                    style={
                      expanded
                        ? { fontWeight: 700 }
                        : { fontWeight: 700, color: "#00828a", border: "1px solid #ccfbf1", background: "#f0fdfa" }
                    }
                  >
                    {expanded ? "Hide" : "View"}
                  </Button>
                </div>
                {expanded && (
                  <div className="table-row-expand" style={{ marginTop: "1rem" }}>
                    <PatientDetail
                      patientRef={patient}
                      setNotice={setNotice}
                      canEdit={canEdit}
                      canReadBilling={canReadBilling}
                      canReadLab={canReadLab}
                      ocrLanguage={ocrLanguage}
                      languages={languages}
                      canDelete={canDelete}
                      onRequestDelete={(fullPatient) =>
                        setDeleteTarget({
                          patientId: fullPatient.patient_id,
                          label: `${fullPatient.name} ${fullPatient.last_name || ""}`.trim() || fullPatient.patient_id,
                        })
                      }
                      onPatientUpdated={onPatientUpdated}
                      refreshToken={refreshToken}
                      onNavigate={onNavigate}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {!loading && searched && displayPatients.length === 0 && <p className="muted">No patients found.</p>}
        {!loading && !searched && displayPatients.length === 0 && <p className="muted">No patients registered yet.</p>}
      </div>
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDeletePatient}
        loading={deletingPatient}
        title="Delete patient record?"
        description={
          deleteTarget
            ? `This will permanently remove ${deleteTarget.label}. This action cannot be undone.`
            : "This action cannot be undone."
        }
        confirmLabel="Delete Patient"
      />
      <style>{`
        tbody tr.active {
          background-color: #f0fdfa !important;
        }
        .module-mobile-card.active {
          border-color: #00828a;
          box-shadow: 0 4px 12px rgba(0,130,138,0.1);
        }
      `}</style>
    </section>
  );
}

type PatientDetailProps = {
  patientRef: Patient | string;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  canEdit: boolean;
  canReadBilling: boolean;
  canReadLab: boolean;
  ocrLanguage: string;
  languages: Record<string, string>;
  canDelete: boolean;
  onRequestDelete: (patient: Patient) => void;
  onPatientUpdated: (patientId?: string) => Promise<void>;
  refreshToken?: number;
  onNavigate?: (pageId: string) => void;
};

type PatientEditForm = {
  name: string;
  middle_name: string;
  last_name: string;
  dob: string;
  age: string;
  weight: string;
  height: string;
  gender: string;
  pregnant: boolean;
  allergies: string;
  symptoms: string;
  phone: string;
  phone_country_code: string;
  address: string;
};

const toEditForm = (patient: Patient): PatientEditForm => {
  const dobVal = patient.dob ? String(patient.dob).split("T")[0] : "";
  const calculatedAge = dobVal ? calculateAgeFromDob(dobVal) : "";
  const finalAge = calculatedAge !== "" ? calculatedAge : (patient.age === undefined || patient.age === null ? "" : String(patient.age));
  return {
    name: patient.name || "",
    middle_name: patient.middle_name || "",
    last_name: patient.last_name || "",
    dob: dobVal,
    age: finalAge,
    weight: patient.weight === undefined || patient.weight === null ? "" : String(patient.weight),
    height: patient.height === undefined || patient.height === null ? "" : String(patient.height),
    gender: patient.gender || "Female",
    pregnant: patient.gender === "Female" && (patient.pregnant === true || patient.pregnant === 1),
    allergies: patient.allergies || "",
    symptoms: patient.symptoms || "",
    phone: patient.phone || "",
    phone_country_code: patient.phone_country_code || "+91",
    address: patient.address || "",
  };
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function PatientDetail({
  patientRef,
  setNotice,
  canEdit,
  canReadBilling,
  canReadLab,
  ocrLanguage,
  languages,
  canDelete,
  onRequestDelete,
  onPatientUpdated,
  refreshToken = 0,
  onNavigate,
}: PatientDetailProps) {
  const patientId = typeof patientRef === "string" ? patientRef : patientRef.patient_id;
  const [patient, setPatient] = useState<Patient | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [movements, setMovements] = useState<PatientMovement[]>([]);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [beds, setBeds] = useState<BedAllocation[]>([]);
  const [medications, setMedications] = useState<MedicationSchedule[]>([]);
  const [notes, setNotes] = useState<ObservationNote[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [billingInvoices, setBillingInvoices] = useState<PatientInvoice[]>([]);
  const [diagnosticTransactions, setDiagnosticTransactions] = useState<PatientDiagnostic[]>([]);
  const [appointmentTransactions, setAppointmentTransactions] = useState<any[]>([]);
  const [vitalsHistory, setVitalsHistory] = useState<PatientVital[]>([]);
  const [downloadReady, setDownloadReady] = useState<Record<number, Record<string, boolean>>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [careTab, setCareTab] = useState("encounters");
  const [addingMovement, setAddingMovement] = useState(false);
  const [savingEncounter, setSavingEncounter] = useState(false);
  const [savingBed, setSavingBed] = useState(false);
  const [savingMedication, setSavingMedication] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingCertificate, setSavingCertificate] = useState(false);
  const [deletingCertificateId, setDeletingCertificateId] = useState<number | null>(null);
  const [movementForm, setMovementForm] = useState({
    admission_id: "",
    from_department: "",
    to_department: "",
  });
  const [encounterForm, setEncounterForm] = useState({
    encounter_type: "OP",
    insurance_provider: "",
    insurance_policy_no: "",
    referral_source: "",
    referral_name: "",
    is_accident: false,
  });
  const [bedForm, setBedForm] = useState({
    admission_id: "",
    ward: "",
    room_no: "",
    bed_no: "",
    status: "active",
  });
  const [medicationForm, setMedicationForm] = useState({
    medicine_name: "",
    dosage: "",
    schedule_time: "",
    administered: false,
    alert_enabled: true,
    notes: "",
  });
  const [noteForm, setNoteForm] = useState({
    admission_id: "",
    doctor_name: "",
    note: "",
    treatment_plan: "",
  });
  const [certificateForm, setCertificateForm] = useState({
    admission_id: "",
    certificate_type: "medical_certificate",
    title: "",
    body: "",
  });
  const [editForm, setEditForm] = useState<PatientEditForm | null>(null);
  const [uploadDocType, setUploadDocType] = useState("document");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<number | null>(null);
  const [processingOcrDocId, setProcessingOcrDocId] = useState<number | null>(null);
  const [expandedDocs, setExpandedDocs] = useState<Record<number, boolean>>({});
  const [deleteDocumentTarget, setDeleteDocumentTarget] = useState<DeleteDocumentTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = async () => {
    if (!patientId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const p = await apiFetch<{ patient: Patient }>(`/api/patients/${patientId}`);
      setPatient(p.patient);
      const requests: Promise<any>[] = [
        apiFetch<{ documents?: DocumentItem[] }>(`/api/patients/${patientId}/documents`),
        apiFetch<{ admissions?: Admission[] }>(`/api/patients/${patientId}/admissions`),
        apiFetch<{ movements?: PatientMovement[] }>(`/api/patients/${patientId}/movements`),
        apiFetch<{ encounters?: Encounter[] }>(`/api/patients/${patientId}/encounters`),
        apiFetch<{ beds?: BedAllocation[] }>(`/api/patients/${patientId}/beds`),
        apiFetch<{ medications?: MedicationSchedule[] }>(`/api/patients/${patientId}/medications`),
        apiFetch<{ notes?: ObservationNote[] }>(`/api/patients/${patientId}/notes`),
        apiFetch<{ certificates?: Certificate[] }>(`/api/patients/${patientId}/certificates`),
        apiFetch<{ appointments?: any[] }>(`/api/appointments?patient_id=${encodeURIComponent(patientId)}`),
        apiFetch<{ vitals?: PatientVital[] }>(`/api/patients/${patientId}/vitals`),
      ];
      if (canReadBilling) {
        requests.push(apiFetch<{ invoices?: PatientInvoice[] }>(`/api/billing/invoices?patient_id=${encodeURIComponent(patientId)}`));
      }
      if (canReadLab) {
        requests.push(apiFetch<{ diagnostics?: PatientDiagnostic[] }>(`/api/lab/diagnostics?patient_id=${encodeURIComponent(patientId)}`));
      }
      const results = await Promise.all(requests);
      const [docs, adm, mv, enc, bedData, med, noteData, certificateData, appointmentsData, vitalsData, maybeInvoices, maybeDiagnostics] = results as [
        { documents?: DocumentItem[] },
        { admissions?: Admission[] },
        { movements?: PatientMovement[] },
        { encounters?: Encounter[] },
        { beds?: BedAllocation[] },
        { medications?: MedicationSchedule[] },
        { notes?: ObservationNote[] },
        { certificates?: Certificate[] },
        { appointments?: any[] },
        { vitals?: PatientVital[] },
        ({ invoices?: PatientInvoice[] } | undefined)?,
        ({ diagnostics?: PatientDiagnostic[] } | undefined)?,
      ];
      setDocuments(docs.documents || []);
      setAdmissions(adm.admissions || []);
      setMovements(mv.movements || []);
      setEncounters(enc.encounters || []);
      setBeds(bedData.beds || []);
      setMedications(med.medications || []);
      setNotes(noteData.notes || []);
      setCertificates(certificateData.certificates || []);
      setAppointmentTransactions(appointmentsData.appointments || []);
      setVitalsHistory(vitalsData.vitals || []);
      setBillingInvoices(canReadBilling ? maybeInvoices?.invoices || [] : []);
      setDiagnosticTransactions(canReadLab ? maybeDiagnostics?.diagnostics || [] : []);
    } catch (error) {
      setPatient(null);
      setDocuments([]);
      setAdmissions([]);
      setMovements([]);
      setEncounters([]);
      setBeds([]);
      setMedications([]);
      setNotes([]);
      setCertificates([]);
      setAppointmentTransactions([]);
      setVitalsHistory([]);
      setBillingInvoices([]);
      setDiagnosticTransactions([]);
      const typedError = error as { status?: number; message?: string };
      if (typedError.status !== 401) {
        setLoadError(typedError.message || "Failed to load patient details.");
      }
      reportError(setNotice, typedError, "Failed to load patient details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [patientId, refreshToken, canReadBilling, canReadLab]);

  const parseNumber = (label: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} must be a valid number.`);
    }
    return parsed;
  };

  const startEdit = () => {
    if (!patient) return;
    setEditForm(toEditForm(patient));
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditForm(patient ? toEditForm(patient) : null);
  };

  const handleSaveEdit = async () => {
    if (!patient || !editForm) return;
    const name = editForm.name.trim();
    const lastName = editForm.last_name.trim();
    if (!name || !lastName) {
      setNotice({ type: "warning", message: "First name and last name are required." });
      return;
    }

    const phoneError = validateMobileByCountry(editForm.phone, editForm.phone_country_code, true);
    if (phoneError) {
      setNotice({ type: "warning", message: phoneError });
      return;
    }

    let age: number | null = null;
    let weight: number | null = null;
    let height: number | null = null;
    try {
      age = parseNumber("Age", editForm.age);
      weight = parseNumber("Weight", editForm.weight);
      height = parseNumber("Height", editForm.height);
    } catch (error) {
      setNotice({ type: "warning", message: (error as Error).message });
      return;
    }

    const payload = {
      name,
      middle_name: editForm.middle_name.trim(),
      last_name: lastName,
      dob: editForm.dob || null,
      age,
      weight,
      height,
      gender: editForm.gender,
      pregnant: editForm.gender === "Female" ? editForm.pregnant : false,
      allergies: editForm.allergies.trim(),
      symptoms: editForm.symptoms.trim(),
      phone: editForm.phone.trim(),
      phone_country_code: editForm.phone_country_code,
      address: editForm.address.trim(),
    };

    setSaving(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setIsEditing(false);
      setNotice({ type: "success", message: "Patient details updated." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Failed to update patient.");
    } finally {
      setSaving(false);
    }
  };

  const handleExportDoc = async (doc: DocumentItem, type: "pdf" | "word") => {
    if (!doc?.ocr_text || !patient) {
      setNotice({ type: "error", message: "No OCR text available for export." });
      return;
    }
    const payload = {
      patient_name: `${patient.name} ${patient.last_name || ""}`.trim(),
      doc_type: doc.doc_type,
      ocr_text: doc.ocr_text,
      date: doc.created_at,
    };
    try {
      const response = await fetch(`${API_BASE}/api/export/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      const blob = await response.blob();
      const filename = `${patientFilename(`${patient.name} ${patient.last_name || ""}`, patient.patient_id, doc.doc_type)}.${type === "pdf" ? "pdf" : "docx"}`;
      if (type === "pdf") {
        await exportPDF(
          blob,
          filename,
          `Export Document ${doc.doc_type}`,
          `Exported document for patient ${patient.patient_id}`,
          setNotice
        );
      } else {
        downloadPDF(blob, filename);
      }
      setDownloadReady((prev) => ({
        ...prev,
        [doc.id]: { ...(prev[doc.id] || {}), [type]: false },
      }));
    } catch (err) {
      setNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to export document."
      });
    }
  };

  const handleUploadDocument = async () => {
    if (!patient || !uploadFile) {
      setNotice({ type: "warning", message: "Select a file to upload." });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("doc_type", uploadDocType);
      const response = await fetch(`${API_BASE}/api/patients/${patient.patient_id}/documents`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Unable to upload document.");
      }
      setUploadFile(null);
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Document uploaded." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to upload document.");
    } finally {
      setUploading(false);
    }
  };

  const handleProcessDocumentOcr = async (doc: DocumentItem) => {
    if (!patient) return;
    setProcessingOcrDocId(doc.id);
    try {
      const data = await apiFetch<{ document_id: number; ocr_text: string; ocr_language: string }>(`/api/documents/${doc.id}/ocr`, {
        method: "POST",
        body: JSON.stringify({ language: ocrLanguage || doc.ocr_language || "en" }),
      });

      setDocuments((prev) =>
        prev.map((item) =>
          item.id === data.document_id
            ? {
              ...item,
              ocr_text: data.ocr_text,
              ocr_language: data.ocr_language,
            }
            : item
        )
      );
      setNotice({ type: "success", message: "OCR processed and saved." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to process OCR.");
    } finally {
      setProcessingOcrDocId(null);
    }
  };

  const handleDeleteDocument = async () => {
    if (!patient) return;
    if (!deleteDocumentTarget) return;
    setDeletingDocId(deleteDocumentTarget.id);
    try {
      await apiFetch(`/api/documents/${deleteDocumentTarget.id}`, { method: "DELETE" });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setDeleteDocumentTarget(null);
      setNotice({ type: "success", message: "Document removed." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to remove document.");
    } finally {
      setDeletingDocId(null);
    }
  };

  const handleAddMovement = async () => {
    if (!patient) return;
    const toDepartment = movementForm.to_department.trim();
    if (!toDepartment) {
      setNotice({ type: "warning", message: "Destination department is required." });
      return;
    }
    setAddingMovement(true);
    try {
      const payload: { admission_id?: number; from_department?: string; to_department: string } = {
        to_department: toDepartment,
      };
      if (movementForm.admission_id.trim()) {
        payload.admission_id = Number(movementForm.admission_id);
      }
      if (movementForm.from_department.trim()) {
        payload.from_department = movementForm.from_department.trim();
      }

      await apiFetch(`/api/patients/${patient.patient_id}/movements`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setMovementForm({
        admission_id: "",
        from_department: "",
        to_department: "",
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Patient movement recorded." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save patient movement.");
    } finally {
      setAddingMovement(false);
    }
  };

  const handleCreateEncounter = async () => {
    if (!patient) return;
    setSavingEncounter(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}/encounters`, {
        method: "POST",
        body: JSON.stringify({
          encounter_type: encounterForm.encounter_type,
          insurance_provider: encounterForm.insurance_provider.trim() || undefined,
          insurance_policy_no: encounterForm.insurance_policy_no.trim() || undefined,
          referral_source: encounterForm.referral_source.trim() || undefined,
          referral_name: encounterForm.referral_name.trim() || undefined,
          is_accident: encounterForm.is_accident,
        }),
      });
      setEncounterForm({
        encounter_type: "OP",
        insurance_provider: "",
        insurance_policy_no: "",
        referral_source: "",
        referral_name: "",
        is_accident: false,
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Encounter created." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create encounter.");
    } finally {
      setSavingEncounter(false);
    }
  };

  const handleAssignBed = async () => {
    if (!patient) return;
    if (!bedForm.admission_id || !bedForm.ward.trim() || !bedForm.room_no.trim() || !bedForm.bed_no.trim()) {
      setNotice({ type: "warning", message: "Admission, ward, room, and bed are required." });
      return;
    }
    setSavingBed(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}/beds`, {
        method: "POST",
        body: JSON.stringify({
          admission_id: Number(bedForm.admission_id),
          ward: bedForm.ward.trim(),
          room_no: bedForm.room_no.trim(),
          bed_no: bedForm.bed_no.trim(),
          status: bedForm.status,
        }),
      });
      setBedForm({
        admission_id: "",
        ward: "",
        room_no: "",
        bed_no: "",
        status: "active",
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Bed assignment saved." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to assign bed.");
    } finally {
      setSavingBed(false);
    }
  };

  const handleAddMedication = async () => {
    if (!patient) return;
    if (!medicationForm.medicine_name.trim()) {
      setNotice({ type: "warning", message: "Medicine name is required." });
      return;
    }
    setSavingMedication(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}/medications`, {
        method: "POST",
        body: JSON.stringify({
          medicine_name: medicationForm.medicine_name.trim(),
          dosage: medicationForm.dosage.trim() || undefined,
          schedule_time: medicationForm.schedule_time || undefined,
          administered: medicationForm.administered,
          alert_enabled: medicationForm.alert_enabled,
          notes: medicationForm.notes.trim() || undefined,
        }),
      });
      setMedicationForm({
        medicine_name: "",
        dosage: "",
        schedule_time: "",
        administered: false,
        alert_enabled: true,
        notes: "",
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Medication schedule saved." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save medication schedule.");
    } finally {
      setSavingMedication(false);
    }
  };

  const handleAddNote = async () => {
    if (!patient) return;
    if (!noteForm.note.trim()) {
      setNotice({ type: "warning", message: "Clinical note is required." });
      return;
    }
    setSavingNote(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          admission_id: noteForm.admission_id ? Number(noteForm.admission_id) : undefined,
          doctor_name: noteForm.doctor_name.trim() || undefined,
          note: noteForm.note.trim(),
          treatment_plan: noteForm.treatment_plan.trim() || undefined,
        }),
      });
      setNoteForm({
        admission_id: "",
        doctor_name: "",
        note: "",
        treatment_plan: "",
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Observation note saved." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save observation note.");
    } finally {
      setSavingNote(false);
    }
  };

  const handleCreateCertificate = async () => {
    if (!patient) return;
    if (!certificateForm.title.trim() || !certificateForm.body.trim()) {
      setNotice({ type: "warning", message: "Certificate title and content are required." });
      return;
    }
    setSavingCertificate(true);
    try {
      await apiFetch(`/api/patients/${patient.patient_id}/certificates`, {
        method: "POST",
        body: JSON.stringify({
          admission_id: certificateForm.admission_id ? Number(certificateForm.admission_id) : undefined,
          certificate_type: certificateForm.certificate_type,
          title: certificateForm.title.trim(),
          body: certificateForm.body.trim(),
        }),
      });
      setCertificateForm({
        admission_id: "",
        certificate_type: "medical_certificate",
        title: "",
        body: "",
      });
      await loadData();
      await onPatientUpdated(patient.patient_id);
      setNotice({ type: "success", message: "Certificate created." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create certificate.");
    } finally {
      setSavingCertificate(false);
    }
  };

  const handleDeleteCertificate = async (certificateId: number) => {
    setDeletingCertificateId(certificateId);
    try {
      await apiFetch(`/api/certificates/${certificateId}`, { method: "DELETE" });
      await loadData();
      await onPatientUpdated(patient?.patient_id);
      setNotice({ type: "success", message: "Certificate deleted." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete certificate.");
    } finally {
      setDeletingCertificateId(null);
    }
  };

  const handlePrintCertificate = (certificate: Certificate) => {
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${certificate.title || "Certificate"}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
            h1 { font-size: 24px; margin-bottom: 8px; }
            h2 { font-size: 18px; margin-top: 16px; margin-bottom: 8px; }
            p, div { margin: 8px 0; line-height: 1.5; }
            .meta { color: #555; font-size: 14px; }
            .certificate-body { white-space: pre-wrap; margin-top: 16px; }
          </style>
        </head>
        <body>
          <h1>${certificate.title || "Certificate"}</h1>
          <div class="meta">Type: ${certificate.certificate_type.replace(/_/g, " ")}</div>
          ${certificate.admission_id ? `<div class="meta">Admission: #${certificate.admission_id}</div>` : ""}
          ${certificate.issued_by ? `<div class="meta">Issued by: ${certificate.issued_by}</div>` : ""}
          ${certificate.created_at ? `<div class="meta">Created at: ${formatDateTimeIST(certificate.created_at)}</div>` : ""}
          <div class="certificate-body">${certificate.body ? certificate.body.replace(/</g, "&lt;").replace(/>/g, "&gt;") : ""}</div>
        </body>
      </html>`;
    printViaIframe(html);
  };

  const documentGroups = useMemo(() => {
    const sorted = [...documents].sort((a, b) => getTimestamp(b.created_at) - getTimestamp(a.created_at));
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
  }, [documents]);

  const formatAppointmentDate = (dateStr?: string | null) => {
    if (!dateStr) return "-";
    const date = new Date(dateStr.replace(" ", "T"));
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  };

  const realAdmissions = useMemo(() => {
    return admissions.filter(
      (adm) =>
        adm.notes &&
        adm.notes.trim().toLowerCase() !== "initial registration"
    );
  }, [admissions]);

  const visitTimeline = useMemo(() => {
    const events: { key: string; label: string; at?: string | null; detail: string; isAppointment?: boolean }[] = [];
    realAdmissions.forEach((adm) =>
      events.push({
        key: `admission-${adm.id}`,
        label: adm.discharge_date ? "Discharge" : "Admission",
        at: adm.discharge_date || adm.admission_date,
        detail: adm.notes || `Admission #${adm.id}`,
      })
    );
    encounters.forEach((enc) =>
      events.push({
        key: `encounter-${enc.id}`,
        label: `${enc.encounter_type} Encounter`,
        at: enc.arrival_at,
        detail: enc.referral_name || enc.referral_source || enc.status || "Visit created",
      })
    );
    movements.forEach((mv) =>
      events.push({
        key: `movement-${mv.id}`,
        label: "Department Transfer",
        at: mv.moved_at,
        detail: `${mv.from_department || "Unknown"} to ${mv.to_department}`,
      })
    );
    notes.forEach((entry) =>
      events.push({
        key: `note-${entry.id}`,
        label: "Clinical Note",
        at: entry.created_at,
        detail: entry.note,
      })
    );
    documents.forEach((doc) =>
      events.push({
        key: `document-${doc.id}`,
        label: "Document Added",
        at: doc.created_at,
        detail: doc.doc_type.replace(/_/g, " "),
      })
    );
    appointmentTransactions.forEach((appt) =>
      events.push({
        key: `appointment-${appt.id}`,
        label: "Appointment",
        at: appt.appointment_date,
        detail: `Dr. ${appt.doctor_name || "Unknown"} - ${appt.department || "General"} (${(appt.status || "Scheduled").replace(/_/g, " ")})`,
        isAppointment: true,
      })
    );
    return events.sort((a, b) => getTimestamp(b.at || "") - getTimestamp(a.at || ""));
  }, [realAdmissions, encounters, movements, notes, documents, appointmentTransactions]);

  if (loading) {
    return (
      <section className="panel">
        <p className="muted">Loading patient details...</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="panel">
        <Alert variant="error">{loadError}</Alert>
      </section>
    );
  }

  if (!patient) return null;

  return (
    <section className="panel patient-detail-panel">
      <h3>
        {patient.name} {patient.last_name} ({patient.patient_id})
      </h3>
      <div className="form-actions patient-detail-actions">
        <Button
          variant="secondary"
          onClick={() => {
            if (isEditing) {
              cancelEdit();
              return;
            }
            startEdit();
          }}
          disabled={!canEdit || saving}
          title={!canEdit ? "Requires patient write access." : ""}
        >
          {isEditing ? "Cancel Edit" : "Edit Patient"}
        </Button>
        {canEdit && isEditing && (
          <Button variant="primary" onClick={() => void handleSaveEdit()} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        )}
      </div>
      <div className="detail-grid">
        <div>
          <div className="module-panel-head">
            <h4>Personal Info</h4>
          </div>
          {isEditing && editForm ? (
            <>
              <p className="muted">First Name</p>
              <Input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} />
              <p className="muted">Last Name</p>
              <Input value={editForm.last_name} onChange={(event) => setEditForm({ ...editForm, last_name: event.target.value })} />
              <p className="muted">DOB</p>
              <Input
                type="date"
                value={editForm.dob ? editForm.dob.split("T")[0] : ""}
                max={new Date().toISOString().split("T")[0]}
                min="1900-01-01"
                onChange={(event) => {
                  let val = event.target.value;
                  if (val) {
                    const parts = val.split("-");
                    if (parts[0] && parts[0].length > 4) {
                      parts[0] = parts[0].slice(0, 4);
                      val = parts.join("-");
                    }
                    const todayStr = new Date().toISOString().split("T")[0];
                    if (val > todayStr) {
                      val = todayStr;
                      setNotice({ type: "warning", message: "Date of Birth cannot be in the future." });
                    }
                  }
                  const autoAge = calculateAgeFromDob(val);
                  setEditForm((prev) => {
                    if (!prev) return prev;
                    return {
                      ...prev,
                      dob: val,
                      age: autoAge,
                    };
                  });
                }}
              />
              <p className="muted">Age (Auto-calculated formula)</p>
              <Input
                value={editForm.age}
                readOnly
                placeholder="Auto-calculated from DOB"
                style={{
                  background: "#f1f5f9",
                  color: "#1e293b",
                  fontWeight: 600,
                  cursor: "not-allowed",
                }}
              />
              <p className="muted">Address / Area</p>
              <Input
                value={editForm.address}
                placeholder="Enter complete address"
                onChange={(event) => setEditForm({ ...editForm, address: event.target.value })}
              />
              <p className="muted">Gender</p>
              <Select
                value={editForm.gender}
                onChange={(event) => {
                  const gender = event.target.value;
                  setEditForm((current) => ({
                    ...current,
                    gender,
                    pregnant: gender === "Female" ? current.pregnant : false,
                  }));
                }}
              >
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Other">Other</option>
              </Select>
              <p className="muted">Phone</p>
              <PhoneInput
                required
                countryCode={editForm.phone_country_code}
                value={editForm.phone}
                onChange={({ countryCode, value }) => setEditForm({ ...editForm, phone_country_code: countryCode, phone: value })}
              />
              <p className="muted">Weight (kg)</p>
              <Input value={editForm.weight} onChange={(event) => setEditForm({ ...editForm, weight: event.target.value })} />
              <p className="muted">Height (cm)</p>
              <Input value={editForm.height} onChange={(event) => setEditForm({ ...editForm, height: event.target.value })} />
              {editForm.gender === "Female" && (
                <>
                  <p className="muted">Pregnant</p>
                  <Checkbox checked={editForm.pregnant} onChange={(event) => setEditForm({ ...editForm, pregnant: event.target.checked })} />
                </>
              )}
            </>
          ) : (
            <>
              <p>Age: {patient.age || "Not Recorded"}</p>
              <p>Gender: {patient.gender || "Not Recorded"}</p>
              <p>DOB: {patient.dob ? formatDate(patient.dob) : "Not Recorded"}</p>
              <p>Phone: {patient.phone || "Not Recorded"}</p>
              <p>Address: {patient.address || "Not Recorded"}</p>
              <p>Weight: {patient.weight ? `${patient.weight} kg` : "Not Recorded"}</p>
              <p>Height: {patient.height ? `${patient.height} cm` : "Not Recorded"}</p>
              {patient.gender === "Female" && (
                <p>Pregnant: {patient.pregnant ? "Yes" : "No"}</p>
              )}
            </>
          )}
        </div>
      </div>
      <div className="split patient-history-grid">
        <div className="panel">
          <div className="module-panel-head">
            <h4>Visit Timeline</h4>
          </div>
          {visitTimeline.length === 0 ? (
            <p className="muted">No timeline events yet.</p>
          ) : (
            <div className="care-note-list">
              {visitTimeline.slice(0, 12).map((event) => (
                <div key={event.key} className="care-note-card">
                  <div className="care-note-head">
                    <strong>{event.label}</strong>
                    <span className="muted">{event.isAppointment ? formatAppointmentDate(event.at) : formatDateTimeIST(event.at)}</span>
                  </div>
                  <p>{event.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="module-panel-head">
            <h4>Vitals History</h4>
          </div>
          {vitalsHistory.length === 0 ? (
            <p className="muted">No vitals history.</p>
          ) : (
            <div className="care-note-list">
              {vitalsHistory.map((vital) => {
                const pieces = [];
                if (vital.bp) pieces.push(`BP: ${vital.bp}`);
                if (vital.pulse) pieces.push(`Pulse: ${vital.pulse}`);
                if (vital.temperature) pieces.push(`Temp: ${vital.temperature}`);
                if (vital.weight) pieces.push(`Weight: ${vital.weight} kg`);
                if (vital.height) pieces.push(`Height: ${vital.height} cm`);
                if (vital.spo2) pieces.push(`SpO2: ${vital.spo2}%`);
                
                return (
                  <div key={`vital-${vital.id}`} className="care-note-card">
                    <div className="care-note-head">
                      <strong>Recorded Vitals</strong>
                      <span className="muted">{formatDateTimeIST(vital.recorded_at)}</span>
                    </div>
                    <p>{pieces.join(" · ")}</p>
                  </div>
                );
              })}
            </div>
          )}
          
          <div className="module-panel-head" style={{ marginTop: '2rem' }}>
            <h4>Transaction History</h4>
          </div>
          {!canReadBilling && !canReadLab ? (
            <p className="muted">No billing or diagnostics access for transaction history.</p>
          ) : (
            <>
              {canReadBilling && billingInvoices.length > 0 ? (
                <div className="transaction-group">
                  <h5>Billing</h5>
                  <div className="care-note-list">
                    {billingInvoices.slice(0, 6).map((invoice) => (
                      <div key={`invoice-${invoice.id}`} className="care-note-card">
                        <div className="care-note-head">
                          <strong>{invoice.invoice_no || `INV-${invoice.id}`}</strong>
                          <span className="muted">{formatDateTimeIST(invoice.created_at)}</span>
                        </div>
                        <p>
                          {invoice.module || "Invoice"} · Total {formatCurrency(invoice.total_amount)} · Paid {formatCurrency(invoice.paid_amount)} · Due{" "}
                          {formatCurrency(invoice.due_amount)}
                        </p>
                        <p className="muted">Status: {invoice.payment_status || "-"}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {canReadLab && diagnosticTransactions.length > 0 ? (
                <div className="transaction-group">
                  <h5>Diagnostics</h5>
                  <div className="care-note-list">
                    {diagnosticTransactions.slice(0, 6).map((record) => (
                      <div key={`diagnostic-${record.id}`} className="care-note-card">
                        <div className="care-note-head">
                          <strong>{record.test_name || `Diagnostic #${record.id}`}</strong>
                          <span className="muted">{formatDateTimeIST(record.created_at)}</span>
                        </div>
                        <p>
                          {record.invoice_no || "No invoice"} · Amount {formatCurrency(record.amount)} · Paid {formatCurrency(record.paid_amount)} · Due{" "}
                          {formatCurrency(record.due_amount)}
                        </p>
                        <p className="muted">Status: {record.status || "-"}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {appointmentTransactions.length > 0 ? (
                <div className="transaction-group">
                  <h5>Consultation Fees</h5>
                  <div className="care-note-list">
                    {appointmentTransactions.slice(0, 6).map((appt) => (
                      <div key={`appointment-${appt.id}`} className="care-note-card">
                        <div className="care-note-head">
                          <strong>Consultation Fee - Token #{appt.token_no}</strong>
                          <span className="muted">{formatAppointmentDate(appt.appointment_date)}</span>
                        </div>
                        <p>
                          Doctor: {appt.doctor_name || "Unassigned"} · Fee: {formatCurrency(appt.consultation_fee)}
                        </p>
                        <p className="muted">Status: {appt.status || "-"}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {((canReadBilling && billingInvoices.length === 0) && (canReadLab && diagnosticTransactions.length === 0) && appointmentTransactions.length === 0) ||
                (canReadBilling && !canReadLab && billingInvoices.length === 0 && appointmentTransactions.length === 0) ||
                (!canReadBilling && canReadLab && diagnosticTransactions.length === 0 && appointmentTransactions.length === 0) ? (
                <p className="muted">No transactions recorded yet.</p>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="patient-care-section panel">
        <div className="module-panel-head">
          <div>
            <h4>Certificates</h4>
            <p className="muted">Discharge summaries, medical certificates, insurance documents, and fit-to-work records.</p>
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const latest = certificates[0];
                if (latest) {
                  handlePrintCertificate(latest);
                } else {
                  setNotice({ type: "warning", message: "No certificates found for this patient." });
                }
              }}
              disabled={!patient || certificates.length === 0}
            >
              Print Latest
            </Button>
          </div>
        </div>
        <div className="care-panel-grid">
          {canEdit ? (
             <div className="care-entry panel">
               <h4>Create Certificate</h4>
               <div className="form-actions stacked-actions">
                 <Select
                  value={certificateForm.certificate_type}
                  onChange={(event) => setCertificateForm((prev) => ({ ...prev, certificate_type: event.target.value }))}
                >
                  <option value="discharge_summary">Discharge Summary</option>
                  <option value="medical_certificate">Medical Certificate</option>
                  <option value="insurance_document">Insurance Document</option>
                  <option value="fit_to_work">Fit to Work</option>
                </Select>
                <Input
                  placeholder="Certificate title"
                  value={certificateForm.title}
                  onChange={(event) => setCertificateForm((prev) => ({ ...prev, title: event.target.value }))}
                />
                <Textarea
                  placeholder="Certificate content"
                  value={certificateForm.body}
                  onChange={(event) => setCertificateForm((prev) => ({ ...prev, body: event.target.value }))}
                  rows={6}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button variant="secondary" onClick={() => void handleCreateCertificate()} disabled={savingCertificate}>
                    {savingCertificate ? "Saving..." : "Create Certificate"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const latest = certificates[0];
                      if (latest) {
                        handlePrintCertificate(latest);
                      } else {
                        setNotice({ type: "warning", message: "No certificates found for this patient." });
                      }
                    }}
                    disabled={!patient || certificates.length === 0}
                  >
                    Print Latest
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="care-entry panel">
            <h4>Certificate History</h4>
            {certificates.length === 0 ? (
              <p className="muted">No certificates created yet.</p>
            ) : (
              <div className="care-note-list">
                {certificates.map((certificate) => (
                  <div key={certificate.id} className="care-note-card">
                    <div className="care-note-head">
                      <strong>{certificate.title}</strong>
                      <span className="muted">{formatDateTimeIST(certificate.created_at)}</span>
                    </div>
                    <p className="muted">
                      {certificate.certificate_type.replace(/_/g, " ")}
                      {certificate.admission_id ? ` · Admission #${certificate.admission_id}` : ""}
                      {certificate.issued_by ? ` · Issued by ${certificate.issued_by}` : ""}
                    </p>
                    <p>{certificate.body}</p>
                    <div className="module-inline-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => handlePrintCertificate(certificate)}
                      >
                        Print
                      </Button>
                      {canEdit ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void handleDeleteCertificate(certificate.id)}
                          disabled={deletingCertificateId === certificate.id}
                        >
                          {deletingCertificateId === certificate.id ? "Deleting..." : "Delete"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="documents">
        <h4>Documents</h4>
        {canEdit && isEditing && (
          <div className="form-actions">
            <Select value={uploadDocType} onChange={(event) => setUploadDocType(event.target.value)}>
              <option value="test_docs">Test Docs</option>
              <option value="xray_mri">X-Ray / MRI</option>
              <option value="prescriptions">Prescriptions</option>
              <option value="document">Document</option>
            </Select>
            <DocumentUploadDropzone
              accept={SUPPORTED_DOCUMENT_ACCEPT}
              file={uploadFile || undefined}
              helperText={`Supported: ${SUPPORTED_DOCUMENT_EXTENSIONS.map((ext) => ext.toUpperCase()).join(", ")}`}
              disabled={uploading}
              onFileSelect={setUploadFile}
            />
            <Button variant="secondary" onClick={() => void handleUploadDocument()} disabled={uploading || !uploadFile}>
              {uploading ? "Uploading..." : "Add Document"}
            </Button>
          </div>
        )}
        {documents.length === 0 ? (
          <p className="muted">No documents uploaded.</p>
        ) : (
          documentGroups.map((group) => (
            <details key={group.key} className="doc-date-section" open>
              <summary>
                {group.label} ({group.items.length})
              </summary>
              <div className="doc-date-content">
                {group.items.map((doc) => (
                  <details
                    key={doc.id}
                    className="doc-item"
                    open={!!expandedDocs[doc.id]}
                    onToggle={(event) => {
                      const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                      setExpandedDocs((prev) => ({ ...prev, [doc.id]: isOpen }));
                    }}
                  >
                    <summary>
                      <span>{doc.doc_type.replace("_", " ")}</span>
                      <span className="summary-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedDocs((prev) => ({ ...prev, [doc.id]: !prev[doc.id] }));
                          }}
                        >
                          {expandedDocs[doc.id] ? "Close" : "Open"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            window.open(`${API_BASE}/api/documents/${doc.id}/file`, "_blank", "noopener,noreferrer");
                          }}
                        >
                          Open Original
                        </Button>
                        {canEdit && (
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setDeleteDocumentTarget({
                                id: doc.id,
                                label: stripUploadTimestampPrefix(doc.file_name) || doc.doc_type.replace("_", " "),
                              });
                            }}
                            disabled={deletingDocId === doc.id}
                          >
                            {deletingDocId === doc.id ? "Removing..." : "Delete"}
                          </Button>
                        )}
                      </span>
                    </summary>
                    <p className="muted">Language: {languages?.[doc.ocr_language || ""] || "English"}</p>
                    <div className="ocr-side-by-side">
                      <div className="ocr-preview">
                        <p className="muted">Original Document</p>
                        <SavedDocumentPreview doc={doc} />
                      </div>
                      <div className={`ocr-preview ocr-markdown-preview ${!(doc.ocr_text || "").trim() ? "ocr-markdown-needs-ocr" : ""}`}>
                        <p className="muted">Markdown OCR</p>
                        {!(doc.ocr_text || "").trim() ? (
                          <div className="ocr-empty-state">
                            <Button
                              type="button"
                              variant="primary"
                              onClick={() => void handleProcessDocumentOcr(doc)}
                              disabled={!canEdit || processingOcrDocId === doc.id}
                              title={!canEdit ? "Requires patient write access." : ""}
                            >
                              {processingOcrDocId === doc.id ? "Processing..." : "Process OCR"}
                            </Button>
                          </div>
                        ) : (
                          <div className="ocr-markdown-content">
                            <MarkdownReport text={doc.ocr_text || "No OCR data"} />
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="row-actions">
                      <Button variant="secondary" onClick={() => setDownloadReady((prev) => ({ ...prev, [doc.id]: { ...(prev[doc.id] || {}), pdf: true } }))}>
                        Prepare PDF
                      </Button>
                      <Button variant="secondary" onClick={() => setDownloadReady((prev) => ({ ...prev, [doc.id]: { ...(prev[doc.id] || {}), word: true } }))}>
                        Prepare Word
                      </Button>
                      {downloadReady[doc.id]?.pdf && (
                        <Button variant="secondary" onClick={() => void handleExportDoc(doc, "pdf")}>
                          Download PDF
                        </Button>
                      )}
                      {downloadReady[doc.id]?.word && (
                        <Button variant="secondary" onClick={() => void handleExportDoc(doc, "word")}>
                          Download Word
                        </Button>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))
        )}
      </div>
      <ConfirmDialog
        open={!!deleteDocumentTarget}
        onClose={() => setDeleteDocumentTarget(null)}
        onConfirm={handleDeleteDocument}
        loading={deletingDocId !== null}
        title="Delete document?"
        description={
          deleteDocumentTarget
            ? `This will permanently remove "${deleteDocumentTarget.label}". This action cannot be undone.`
            : "This action cannot be undone."
        }
        confirmLabel="Delete Document"
      />
    </section>
  );
}
