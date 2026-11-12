import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from "react";
import { FiSettings } from "react-icons/fi";
import AuthView from "./components/AuthView";
import SettingsModal from "./components/SettingsModal";
import ShareModal from "./components/ShareModal";
import ExportShareModal from "./components/ExportShareModal";
import Toast from "./components/ui/Toast";
import { useIdleLogout } from "./lib/useIdleLogout";
import SessionTimeoutWarning from "./components/SessionTimeoutWarning";
import ConfirmDialog from "./components/ui/ConfirmDialog";
import { Button, Container } from "./components/ui";
import AddPatientPage from "./pages/AddPatientPage";
import AdminPage from "./pages/AdminPage";
import OpPage from "./pages/OpPage";
import OpQueuePage from "./pages/OpQueuePage";
import DashboardPage from "./pages/DashboardPage";
import AnalysisPage from "./pages/AnalysisPage";
import EmployeesPage from "./pages/EmployeesPage";
import BrandingPage from "./pages/BrandingPage";
import { applyBranding, loadBranding } from "./lib/branding";
import BillingClaimsPage from "./pages/BillingClaimsPage";
import BillingOverviewPage from "./pages/billing/BillingOverviewPage";
import PatientBillsPaymentsPage from "./pages/billing/PatientBillsPaymentsPage";
import IpDischargeBillingPage from "./pages/billing/IpDischargeBillingPage";
import AdvancesRefundsPage from "./pages/billing/AdvancesRefundsPage";
import DoctorPayoutsPage from "./pages/billing/DoctorPayoutsPage";
import ReportsDayClosePage from "./pages/billing/ReportsDayClosePage";
import LabPage from "./pages/LabPage";
import HrmsPage from "./pages/HrmsPage";
import OtPage from "./pages/OtPage";
import AccountsOverviewPage from "./pages/AccountsOverviewPage";
import AccountsLedgerPage from "./pages/AccountsLedgerPage";
import AccountsVendorPaymentsPage from "./pages/AccountsVendorPaymentsPage";
import AccountsDoctorPayoutsPage from "./pages/AccountsDoctorPayoutsPage";
import PatientsPage from "./pages/PatientsPage";
import ReadmitPage from "./pages/ReadmitPage";
import ReportsPage from "./pages/ReportsPage";
import PharmacyOverview from "./pages/pharmacy/PharmacyOverview";
import PharmacyOpDispense from "./pages/pharmacy/PharmacyOpDispense";
import PharmacyIpDispense from "./pages/pharmacy/PharmacyIpDispense";
import PharmacyInventoryStock from "./pages/pharmacy/PharmacyInventoryStock";
import PharmacyPurchasesGrn from "./pages/pharmacy/PharmacyPurchasesGrn";
import PharmacySuppliers from "./pages/pharmacy/PharmacySuppliers";
import PharmacyReports from "./pages/pharmacy/PharmacyReports";
import PharmacyInsuranceClaims from "./pages/pharmacy/PharmacyInsuranceClaims";
import PharmacyProfitAnalysis from "./pages/pharmacy/PharmacyProfitAnalysis";
import PharmacySettings from "./pages/pharmacy/PharmacySettings";
import LabDiagnosticsCataloguePage from "./pages/LabDiagnosticsCataloguePage";
import LabDiagnosticsOverviewPage from "./pages/LabDiagnosticsOverviewPage";
import EmergencyWorklistPage from "./pages/EmergencyWorklistPage";
import LabDiagnosticsSalesPage from "./pages/LabDiagnosticsSalesPage";
import LabDiagnosticsLabPage from "./pages/LabDiagnosticsLabPage";
import LabDiagnosticsImagingPage from "./pages/LabDiagnosticsImagingPage";
import LabDiagnosticsReportsPage from "./pages/LabDiagnosticsReportsPage";
import LabDiagnosticsReportsHistoryPage from "./pages/LabDiagnosticsReportsHistoryPage";
import LabDiagnosticsQualityPage from "./pages/LabDiagnosticsQualityPage";
import SettingsPage from "./pages/SettingsPage";
import PlatformAdminPage from "./pages/PlatformAdminPage";
import RegistrationDeskPage from "./pages/RegistrationDeskPage";
import PatientJourneyPage from "./pages/PatientJourneyPage";
import DischargeSummaryPage from "./pages/DischargeSummaryPage";
import PatientReachAiPage from "./pages/PatientReachAiPage";
import DoctorsHistoryPage from "./pages/DoctorsHistoryPage";
import InpatientAdmissionPage from "./pages/InpatientAdmissionPage";
import BedManagementPage from "./pages/BedManagementPage";
import InpatientPatientsPage from "./pages/InpatientPatientsPage";
import NurseEmarPage from "./pages/NurseEmarPage";
import DoctorPrescriptionPage from "./pages/DoctorPrescriptionPage";
import PreBookingPage from "./pages/PreBookingPage";
import HospitalBrand from "./components/HospitalBrand";
import { API_BASE, EMPTY_PATIENT_FORM, EMPTY_STATS, LEGACY_MODULE_EXPANSIONS, NAV_ITEMS, PAGE_MODULE_MAP } from "./lib/constants";
import { apiFetch, getHospitalCode, reportError, setHospitalCode } from "./lib/api";
import { canViewHospitalOverview, getScopedDoctor } from "./lib/access";
import { resolvePermissions } from "./lib/format";
import type { DashboardAnalytics, HospitalSummary, Notice, Patient, Stats, User } from "./types";
import { downloadExportBlob } from "./lib/exportShare";

type SidebarIconName = "dashboard" | "add" | "patients" | "readmit" | "billing" | "lab" | "hrms" | "ot" | "employees" | "settings" | "logout" | "profile" | "appointment" | "home" | "prescription" | "pill" | "box" | "cart" | "shield-check" | "chart" | "team" | "user-doctor" | "bed" | "check-circle" | "document-list" | "patient-reach-ai";

export const normalizeRouteAlias = (rawPage: string): string => {
  const p = (rawPage || "").toLowerCase().trim();
  switch (p) {
    case "billing":
      return "billing-overview";
    case "pharmacy":
      return "pharmacy-overview";
    case "pharmacy-inventory-stock":
      return "pharmacy-inventory";
    case "pharmacy-purchases-grn":
      return "pharmacy-purchases";
    case "pharmacy-dispense":
      return "pharmacy-op-dispense";
    case "lab":
    case "laboratory":
    case "diag":
    case "lab-diagnostics":
      return "diag-overview";
    case "inpatient":
      return "inpatient-patients";
    case "emergency":
      return "emergency-worklist";
    case "registration":
    case "registration-desk":
    case "patient-registration":
      return "add";
    case "accounts":
      return "accounts-overview";
    default:
      return rawPage;
  }
};

// Every page id the app's content switch recognizes. Used to validate the
// URL path so an unknown/stale link (e.g. an old "/login" bookmark) falls
// back to the dashboard instead of rendering a blank page.
const VALID_PAGE_IDS = new Set([
  "access-denied", "accounts", "accounts-doctor-payouts", "accounts-ledger", "accounts-overview", "analytics",
  "accounts-vendor-payments", "add", "registration", "registration-desk", "patient-registration", "admin", "branding", "bed-management",
  "billing", "billing-aging", "billing-create-invoice", "billing-record-payment",
  "billing-insurance-claims", "billing-invoices", "billing-mode-breakdown", "billing-module-collections",
  "billing-reconciliation", "billing-overview", "billing-patient-bills", "billing-ip-discharge",
  "billing-advances-refunds", "billing-doctor-payouts", "billing-reports-day-close",
  "consent-desk", "dashboard", "diag", "lab-diagnostics", "diag-catalogue", "diag-imaging", "diag-laboratory",
  "diag-orders-billing", "diag-overview", "discharge-summary", "patient-reach-ai", "reach-survey-management", "reach-survey-templates", "reach-whatsapp-templates", "reach-survey-reports", "diag-quality-equipment", "diag-reports-approval", "diag-reports-history", "doctor-prescription",
  "doctors-history", "emergency", "emergency-worklist", "employees", "hrms", "inpatient", "inpatient-patients", "insurance-desk", "ip-admission", "lab", "laboratory",
  "nurse-station", "op-desk", "op-queue-management", "ot", "patient-journey", "patients", "pre-booking",
  "pharmacy", "pharmacy-overview", "pharmacy-op-dispense", "pharmacy-ip-dispense", "pharmacy-inventory", "pharmacy-inventory-stock",
  "pharmacy-purchases", "pharmacy-purchases-grn", "pharmacy-suppliers", "pharmacy-reports", "pharmacy-insurance-claims", "pharmacy-profit-analysis", "pharmacy-settings",
  "pharmacy-billing-insurance", "pharmacy-dispense", "pharmacy-emar",
  "pharmacy-inventory-batches", "pharmacy-inventory-expiry", "pharmacy-inventory-medicines",
  "pharmacy-inventory-transfers", "pharmacy-medication-orders",
  "pharmacy-purchases-po", "pharmacy-purchases-pr",
  "pharmacy-purchases-suppliers", "pharmacy-ward-indents", "readmit", "reports", "settings",
]);

const NAV_ICON_MAP: Record<string, SidebarIconName> = {
  dashboard: "dashboard",
  add: "add",
  "pre-booking": "appointment",
  "op-desk": "patients",
  "consent-desk": "add",
  "insurance-desk": "billing",
  "op-queue-management": "patients",
  patients: "patients",
  "patient-journey": "patients",
  "discharge-summary": "bed",
  "patient-reach-ai": "patient-reach-ai",
  "reach-survey-management": "check-circle",
  "reach-survey-templates": "document-list",
  "reach-whatsapp-templates": "patient-reach-ai",
  "reach-survey-reports": "chart",
  readmit: "readmit",
  billing: "billing",
  "billing-overview": "dashboard",
  "billing-patient-bills": "billing",
  "billing-ip-discharge": "bed",
  "billing-advances-refunds": "readmit",
  "billing-doctor-payouts": "team",
  "billing-reports-day-close": "chart",
  "billing-aging": "billing",
  "billing-reconciliation": "billing",
  "billing-create-invoice": "billing",
  "billing-insurance-claims": "billing",
  "billing-invoices": "billing",
  "billing-mode-breakdown": "billing",
  "billing-module-collections": "billing",
  lab: "lab",
  "diag-overview": "dashboard",
  "diag-orders-billing": "billing",
  "diag-laboratory": "lab",
  "diag-imaging": "lab",
  "diag-reports-approval": "check-circle",
  "diag-reports-history": "check-circle",
  "diag-catalogue": "box",
  "diag-quality-equipment": "shield-check",
  "emergency-worklist": "shield-check",
  hrms: "hrms",
  ot: "ot",
  accounts: "billing",
  "accounts-overview": "billing",
  "accounts-ledger": "billing",
  "accounts-vendor-payments": "billing",
  "accounts-doctor-payouts": "billing",
  reports: "dashboard",
  employees: "employees",
  branding: "employees",
  settings: "settings",
  "doctors-history": "appointment",
  "doctor-prescription": "prescription",
  "ip-admission": "add",
  "bed-management": "box",
  "inpatient-patients": "patients",
  "nurse-station": "prescription",
  "pharmacy-overview": "home",
  "pharmacy-op-dispense": "pill",
  "pharmacy-ip-dispense": "bed",
  "pharmacy-inventory": "box",
  "pharmacy-purchases": "cart",
  "pharmacy-suppliers": "team",
  "pharmacy-reports": "chart",
  "pharmacy-insurance-claims": "shield-check",
  "pharmacy-profit-analysis": "billing",
  "pharmacy-settings": "settings",
  "pharmacy-dispense": "pill",
  "pharmacy-billing-insurance": "shield-check",
};

function SidebarIcon({ name }: { name: SidebarIconName }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  const paths: Record<SidebarIconName, ReactNode> = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.2" {...stroke} />
        <rect x="14" y="3" width="7" height="11" rx="1.2" {...stroke} />
        <rect x="3" y="14" width="7" height="7" rx="1.2" {...stroke} />
        <rect x="14" y="18" width="7" height="3" rx="1.2" {...stroke} />
      </>
    ),
    add: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" {...stroke} />
        <path d="M12 8v8" {...stroke} />
        <path d="M8 12h8" {...stroke} />
      </>
    ),
    appointment: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2.6" {...stroke} />
        <path d="M8 3v4M16 3v4M4 10h16M9 14h6M9 17h4" {...stroke} />
      </>
    ),
    patients: (
      <>
        <circle cx="9" cy="9" r="3" {...stroke} />
        <path d="M3.5 19c.8-2.7 2.9-4 5.5-4s4.7 1.3 5.5 4" {...stroke} />
        <circle cx="17.5" cy="10" r="2.5" {...stroke} />
        <path d="M14.8 18.8c.5-1.7 1.8-2.8 3.7-3.2" {...stroke} />
      </>
    ),
    readmit: (
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.7" {...stroke} />
        <path d="M20 4v6h-6" {...stroke} />
      </>
    ),
    billing: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
        <path d="M7 9h10M7 13h6M7 17h4" {...stroke} />
      </>
    ),
    lab: (
      <>
        <path d="M10 3v5l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3.5L14 8V3" {...stroke} />
        <path d="M8.5 13h7" {...stroke} />
      </>
    ),
    hrms: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
        <path d="M8 8h8M8 12h8M8 16h5" {...stroke} />
      </>
    ),
    ot: (
      <>
        <rect x="4" y="5" width="16" height="14" rx="2.5" {...stroke} />
        <path d="M9 5V3M15 5V3M8 12h8M12 8v8" {...stroke} />
      </>
    ),
    employees: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
        <path d="M3 9.5h18" {...stroke} />
        <path d="M8 7v-2M16 7v-2" {...stroke} />
        <path d="M8.5 14.5h7M8.5 17.5h5" {...stroke} />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3.2" {...stroke} />
        <path d="M12 3v2.1M12 18.9V21M3 12h2.1M18.9 12H21M5.7 5.7l1.5 1.5M16.8 16.8l1.5 1.5M18.3 5.7l-1.5 1.5M7.2 16.8l-1.5 1.5" {...stroke} />
      </>
    ),
    logout: (
      <>
        <path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" {...stroke} />
        <path d="M14 8l4 4-4 4" {...stroke} />
        <path d="M18 12H9" {...stroke} />
      </>
    ),
    profile: (
      <>
        <circle cx="12" cy="8.2" r="3.1" {...stroke} />
        <path d="M5.5 19c.9-3 3.2-4.7 6.5-4.7s5.6 1.7 6.5 4.7" {...stroke} />
      </>
    ),
    home: (
      <>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...stroke} />
        <polyline points="9 22 9 12 15 12 15 22" {...stroke} />
      </>
    ),
    prescription: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...stroke} />
        <polyline points="14 2 14 8 20 8" {...stroke} />
        <line x1="16" y1="13" x2="8" y2="13" {...stroke} />
        <line x1="16" y1="17" x2="8" y2="17" {...stroke} />
      </>
    ),
    pill: (
      <>
        <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" {...stroke} />
        <path d="m8.5 8.5 7 7" {...stroke} />
      </>
    ),
    box: (
      <>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" {...stroke} />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" {...stroke} />
        <line x1="12" y1="22.08" x2="12" y2="12" {...stroke} />
      </>
    ),
    cart: (
      <>
        <circle cx="9" cy="21" r="1" {...stroke} />
        <circle cx="20" cy="21" r="1" {...stroke} />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" {...stroke} />
      </>
    ),
    "shield-check": (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...stroke} />
        <path d="m9 12 2 2 4-4" {...stroke} />
      </>
    ),
    chart: (
      <>
        <line x1="18" y1="20" x2="18" y2="10" {...stroke} />
        <line x1="12" y1="20" x2="12" y2="4" {...stroke} />
        <line x1="6" y1="20" x2="6" y2="14" {...stroke} />
      </>
    ),
    team: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...stroke} />
        <circle cx="9" cy="7" r="4" {...stroke} />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" {...stroke} />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" {...stroke} />
      </>
    ),
    "user-doctor": (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" {...stroke} />
        <circle cx="9" cy="7" r="4" {...stroke} />
        <path d="M19 8v6M16 11h6" {...stroke} />
      </>
    ),
    bed: (
      <>
        <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" {...stroke} />
        <circle cx="6" cy="11" r="2" {...stroke} />
      </>
    ),
    "check-circle": (
      <>
        <circle cx="12" cy="12" r="9" {...stroke} />
        <path d="m9 12 2 2 4-4" {...stroke} />
      </>
    ),
    "document-list": (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...stroke} />
        <polyline points="14 2 14 8 20 8" {...stroke} />
        <line x1="16" y1="13" x2="8" y2="13" {...stroke} />
        <line x1="16" y1="17" x2="8" y2="17" {...stroke} />
        <line x1="10" y1="9" x2="8" y2="9" {...stroke} />
      </>
    ),
    "patient-reach-ai": (
      <>
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" {...stroke} />
        <path d="M9.5 9h.01M14.5 9h.01M12 14c-1.5 0-2.5-.8-3-1.5" {...stroke} />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

type SidebarTabProps = {
  label: string;
  pageId?: string;
  icon: SidebarIconName;
  active: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
};

function SidebarTab({ label, pageId, icon, active, disabled = false, hint, onClick }: SidebarTabProps) {
  return (
    <button
      type="button"
      data-page={pageId}
      className={active ? "sidebar-tab active" : "sidebar-tab"}
      disabled={disabled}
      title={hint || ""}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <span className="sidebar-tab-icon">
        <SidebarIcon name={icon} />
      </span>
      <span>{label}</span>
    </button>
  );
}

const PAGE_SUBTITLES: Record<string, string> = {
  "diag-overview": "Live orders, collection, processing and TAT status at a glance.",
  "emergency-worklist": "Active Emergency patients, triage priority and disposition.",
  "diag-orders-billing": "Manage lab orders and generate invoices.",
  "diag-laboratory": "Orders, samples and reports in one workspace.",
  "diag-imaging": "Appointments, examinations and signed reports.",
  "diag-reports-approval": "Review, authorize and release patient reports.",
  "diag-reports-history": "Search, view, print and share any past lab or imaging report.",
  "diag-catalogue": "Manage services, prices and reporting templates.",
  "diag-quality-equipment": "Track quality checks, maintenance and reagent readiness.",
  patients: "Search and view detailed patient records.",
  add: "Register new patients and set up appointments.",
  "op-queue-management": "Monitor and update outpatient queues.",
  "patient-journey": "Track patient outpatient milestones.",
  "discharge-summary": "AI discharge summary from the patient's records across all modules.",
  "patient-reach-ai": "Patient outreach & clinical discharge summaries via WhatsApp.",
  "reach-survey-management": "Queue, send and track patient feedback surveys over WhatsApp.",
  "reach-survey-templates": "Create survey questions and answer options.",
  "reach-whatsapp-templates": "Reusable WhatsApp messages for surveys, reminders and follow-ups.",
  "reach-survey-reports": "Detailed patient feedback reports and exports.",
  "op-desk": "Manage doctors and outpatient schedules.",
  "doctor-prescription": "Create branded prescriptions with medicines, lab tests, advice, and follow-up.",
  "ip-admission": "Admit patient and request bed allocation.",
  "bed-management": "Monitor and allocate hospital beds.",
  "inpatient-patients": "View and manage admitted patients.",
  "nurse-station": "Track vitals, medication administration, shift notes, and nursing tasks.",
  readmit: "Schedule revisits and consult follow-ups.",
  "doctors-history": "Audit doctor patient histories.",
  lab: "Generate lab bills and view test reports.",
  "billing-overview": "Real-time revenue tracking, cashier operations, and departmental clearances.",
  "billing-patient-bills": "Patient bill lookup, multi-bill allocation, split payments, and receipt issuance.",
  "billing-ip-discharge": "Consolidate stay charges, pharmacy, tests, apply advances, and finalise clearance.",
  "billing-advances-refunds": "Patient security deposits, refund request reservation, and supervisor vouchers.",
  "billing-doctor-payouts": "Contractual doctor earnings, fee splits, adjustments, and payout vouchers.",
  "billing-reports-day-close": "Daily tender reconciliation, drawer cash balancing, and financial exports.",
  "billing-module-collections": "Live revenue snapshot and collection summary.",
  "accounts-doctor-payouts": "Manage doctor commission balances and payouts.",
  reports: "Comprehensive daily/monthly diagnostic and sales audits.",
  settings: "Configure clinic metadata and credentials.",
  admin: "Clinic administration panel.",
};

const DEFAULT_IDLE_TIMEOUT_SECONDS = 20 * 60;

function formatMinutes(ms: number): string {
  const minutes = Math.round((ms / 60000) * 10) / 10;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function App() {
  const isAdminRoutePath = typeof window !== "undefined" && window.location.pathname === "/admin";
  const isPlatformAdminRoute = typeof window !== "undefined" && window.location.pathname === "/platform-admin";
  const [user, setUser] = useState<User | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  // Doctor-linked logins only see their own patients (enforced by the API; the UI just locks the doctor pickers).
  const scopedDoctor = getScopedDoctor(user);
    // Ensure required asterisks are visually prominent across the app
    useEffect(() => {
      try {
        const labels = Array.from(document.querySelectorAll("label"));
        labels.forEach((label) => {
          // Skip labels already containing a styled required-marker
          if (label.querySelector(".required-marker")) return;

          const text = label.textContent || "";
          if (!text.includes("*")) return;

          // Ensure label uses the UI label class so CSS selectors apply
          if (!label.classList.contains("ui-label")) label.classList.add("ui-label");

          // Remove literal '*' characters from any direct text nodes to avoid duplicates
          Array.from(label.childNodes).forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              node.textContent = (node.textContent || "").replace(/\*/g, "");
            }
          });

          // Append standardized required marker
          const span = document.createElement("span");
          span.className = "required-marker";
          span.setAttribute("aria-hidden", "true");
          span.textContent = "*";
          label.appendChild(span);
        });
      } catch {
        // silent
      }
    }, []);
  const getPageFromUrl = () => {
    if (typeof window === "undefined") return "dashboard";
    const segment = decodeURIComponent(window.location.pathname.replace(/^\/+|\/+$/g, ""));
    const normalized = normalizeRouteAlias(segment);
    if (normalized && VALID_PAGE_IDS.has(normalized)) return normalized;
    if (segment && VALID_PAGE_IDS.has(segment)) return segment;
    return "dashboard";
  };
  const [page, setPage] = useState(isAdminRoutePath ? "admin" : getPageFromUrl());
  const [pageKeys, setPageKeys] = useState<Record<string, number>>({});
  const [patientsPageKey, setPatientsPageKey] = useState(0);

  useEffect(() => {
    setPageKeys((prev) => ({
      ...prev,
      [page]: (prev[page] || 0) + 1,
    }));
  }, [page]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [dashboardAnalytics, setDashboardAnalytics] = useState<DashboardAnalytics | null>(null);
  const [hospitalSummary, setHospitalSummary] = useState<HospitalSummary | null>(null);
  const [dashboardAnalyticsLoading, setDashboardAnalyticsLoading] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [patientDetailRefreshToken, setPatientDetailRefreshToken] = useState(0);
  const [languages, setLanguages] = useState<Record<string, string>>({ en: "English" });
  const [ocrLanguage, setOcrLanguage] = useState("en");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Share Modal States
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareOptions, setShareOptions] = useState<{
    blob: Blob;
    filename: string;
    title: string;
    text?: string;
    shareUrl: string;
  } | null>(null);

  useEffect(() => {
    window.__hospai_share__ = (options) => {
      setShareOptions(options);
      setShareModalOpen(true);
    };
    window.__hospai_export_share__ = (options) => {
      setExportShareOptions(options);
      setExportShareModalOpen(true);
    };
    return () => {
      window.__hospai_share__ = undefined;
      window.__hospai_export_share__ = undefined;
    };
  }, []);

  const [exportShareModalOpen, setExportShareModalOpen] = useState(false);
  const [exportShareOptions, setExportShareOptions] = useState<{
    blob: Blob;
    filename: string;
    title: string;
    text?: string;
    shareUrl?: string;
    phone?: string | null;
    phoneCountryCode?: string | null;
  } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [dashboardDate, setDashboardDate] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
  const [hospitalCode, setHospitalCodeState] = useState(getHospitalCode());
  const [collapsedSidebarGroups, setCollapsedSidebarGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const permissions = useMemo(() => resolvePermissions(user), [user]);
  const hasPermission = (permission?: string) => !permission || (!!user && permissions.includes(permission));
  const isAdmin = hasPermission("admin.use");
  const hasModuleAccess = (moduleId?: import("./types").ModuleId) => {
    if (!moduleId || isAdmin) return true;
    const assigned = new Set(user?.module_access || []);
    if (assigned.has(moduleId)) return true;
    if (moduleId === "finance" && assigned.has("accounts")) return true;
    if (moduleId === "laboratory" && assigned.has("lab" as any)) return true;
    if (moduleId === "lab-diagnostics" && (assigned.has("laboratory") || assigned.has("lab" as any) || assigned.has("diag" as any) || assigned.has("lab-diagnostics"))) return true;
    return false;
  };
  const canAccessNavItem = (itemId: string, permission?: string, moduleId?: import("./types").ModuleId) => {
    if (itemId === "employees") return hasPermission("admin.users.read");
    return hasModuleAccess(moduleId) && hasPermission(permission);
  };
  // Mirrors the page-access check applied on navigation, so role dashboards only offer reachable pages.
  const canOpenPage = (targetPage: string) => {
    const nav = NAV_ITEMS.find((item) => item.id === targetPage);
    if (!hasModuleAccess(nav?.module || PAGE_MODULE_MAP[targetPage])) return false;
    return nav ? canAccessNavItem(nav.id, nav.permission, nav.module) : true;
  };
  const sidebarNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => item.id !== "settings" && !item.hidden && canAccessNavItem(item.id, item.permission, item.module)),
    [permissions, user?.module_access, isAdmin]
  );
  const sidebarGroups = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: typeof sidebarNavItems }> = [
      { key: "overview", label: "Overview Module", items: [] },
      { key: "op-management", label: "OP Management Module", items: [] },
      { key: "emergency", label: "Emergency / Casualty", items: [] },
      { key: "inpatient", label: "Inpatient (IPD) Module", items: [] },
      { key: "lab-diagnostics", label: "Lab & Diagnostics Department", items: [] },
      { key: "pharmacy", label: "Pharmacy Module", items: [] },
      { key: "billing", label: "Billing & Accounts Department", items: [] },
      { key: "patient-reach-ai", label: "Patient Reach AI", items: [] },
      { key: "admin", label: "Administration", items: [] },
    ];
    sidebarNavItems.forEach((item) => {
      const target = groups.find((group) => group.key === (item.group || "overview"));
      target?.items.push(item);
    });
    return groups.filter((group) => group.items.length > 0);
  }, [sidebarNavItems]);
  useEffect(() => {
    setCollapsedSidebarGroups((current) => {
      const next = { ...current };
      sidebarGroups.forEach((group) => {
        if (!(group.key in next)) next[group.key] = false;
      });
      return next;
    });
  }, [sidebarGroups]);

  const getDefaultPage = (currentUser: User | null) => {
    const currentPermissions = resolvePermissions(currentUser);
    const candidatePages = [
      "dashboard",
      "op-desk",
      "pre-booking",
      "add",
      "op-queue-management",
      "doctor-prescription",
      "readmit",
      "patients",
      "patient-journey",
      "doctors-history",
      "billing-overview",
      "billing-module-collections",
      "billing-doctor-payouts",
      "accounts-doctor-payouts",
      "reports",
      "pharmacy-overview",
      "settings",
    ];
    for (const candidate of candidatePages) {
      const navItem = NAV_ITEMS.find((item) => item.id === candidate);
      if (!navItem) continue;
      const assigned = new Set(currentUser?.module_access || []);
      const moduleAllowed = currentUser?.user_type === "super_admin" || currentUser?.user_type === "admin" || !navItem.module || assigned.has(navItem.module) || (navItem.module === "finance" && assigned.has("accounts")) || (navItem.module === "laboratory" && assigned.has("lab" as any)) || (navItem.module === "lab-diagnostics" && (assigned.has("laboratory") || assigned.has("lab" as any) || assigned.has("diag" as any) || assigned.has("lab-diagnostics")));
      if (moduleAllowed && (!navItem.permission || currentPermissions.includes(navItem.permission))) {
        return candidate;
      }
    }
    return "access-denied";
  };

  const syncUrlForPage = (nextPage: string) => {
    if (typeof window === "undefined") return;
    const target = nextPage === "admin" ? "/admin" : `/${nextPage}`;
    if (window.location.pathname !== target || window.location.search) {
      window.history.pushState({}, "", target);
    }
  };

  // Without a valid session the app must show /login, not whatever page was
  // last requested — and once authenticated it must leave /login. "/admin"
  // and "/platform-admin" have their own separate auth flows, so they're
  // exempt from this main-session gate.
  const goToLogin = () => {
    if (typeof window === "undefined" || isAdminRoutePath || isPlatformAdminRoute) return;
    if (window.location.pathname !== "/login") {
      window.history.replaceState({}, "", "/login");
    }
  };
  const leaveLoginPath = () => {
    if (typeof window === "undefined") return;
    if (window.location.pathname === "/login") {
      window.history.replaceState({}, "", "/dashboard");
    }
  };

  useEffect(() => {
    fetch(`${API_BASE}/api/languages`)
      .then((res) => res.json())
      .then((data) => setLanguages(data.languages || { en: "English" }))
      .catch(() => setLanguages({ en: "English" }));
  }, []);

  useEffect(() => {
    const handlePopState = () => setPage(getPageFromUrl());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Each page lives at its own clean path ("/dashboard", "/pharmacy-purchases-pr", ...),
  // with "/login", "/admin" and "/platform-admin" as separate dedicated
  // views. The bare root "/" is not a real page on its own -- normalize it
  // (and any other unrecognized path: an old bookmark, a typo, a stale
  // shared link) to "/dashboard" instead of leaving a dead or ambiguous URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const { pathname } = window.location;
    if (pathname === "/login" || pathname === "/admin" || pathname === "/platform-admin") return;
    const segment = decodeURIComponent(pathname.replace(/^\/+|\/+$/g, ""));
    const normalized = normalizeRouteAlias(segment);
    if (!VALID_PAGE_IDS.has(segment) && !VALID_PAGE_IDS.has(normalized)) {
      window.history.replaceState({}, "", "/dashboard");
    }
  }, []);

  // Global document branding feeds every print/PDF path; falls back to HospAI defaults if none/unavailable.
  const brandingUserKey = user ? `${user.username || ""}` : "";
  useEffect(() => {
    if (brandingUserKey) void loadBranding();
    else applyBranding(null);
  }, [brandingUserKey]);

  useEffect(() => {
    let active = true;
    apiFetch<{ user?: User }>("/api/auth/session")
      .then((data) => {
        if (!active) return;
        if (data.user) {
          setUser(data.user);
          leaveLoginPath();
          if (!isAdminRoutePath) {
            setPage(getPageFromUrl());
          }
        } else {
          goToLogin();
        }
      })
      .catch(() => {
        if (active) goToLogin();
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Pick up access changes an admin makes while this employee is already signed in
  // (a newly granted or revoked module). Without this the module list is only read at login
  // or page load, so a grant stays invisible until the employee logs in again.
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const refreshAccess = () => {
      // "background" so this never keeps an idle session alive.
      apiFetch<{ user?: User }>("/api/auth/session", { background: true })
        .then((data) => {
          const fresh = data.user;
          if (cancelled || !fresh) return;
          setUser((current) => {
            if (!current) return current;
            const key = (u: User) => JSON.stringify([u.user_type, u.module_access, u.permissions]);
            return key(current) === key(fresh) ? current : fresh;
          });
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refreshAccess, 60_000);
    window.addEventListener("focus", refreshAccess);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshAccess);
    };
  }, [signedIn]);

  useEffect(() => {
    // The server rejected the session (idle timeout reached server-side, or
    // the employee signed in on another browser/device): drop all in-memory
    // user state and return to the login screen.
    const handleUnauthorized = () => {
      const wasSignedIn = Boolean(userRef.current);
      setUser(null);
      setPage(getDefaultPage(null));
      setSelectedPatient(null);
      setIsSidebarOpen(false);
      setNotice(
        wasSignedIn
          ? { type: "info", message: "Your session has ended (inactivity or a sign-in on another device). Please log in again." }
          : null
      );
      goToLogin();
    };
    window.addEventListener("app:unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("app:unauthorized", handleUnauthorized);
    };
  }, []);

  const loadStats = async (date?: string) => {
    try {
      const targetDate = date || dashboardDate;
      const url = targetDate ? `/api/stats?date=${encodeURIComponent(targetDate)}` : "/api/stats";
      const data = await apiFetch<Stats>(url);
      setStats({ ...EMPTY_STATS, ...data });
      return true;
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load dashboard stats.");
      return false;
    }
  };

  const loadPatients = async () => {
    try {
      const data = await apiFetch<{ patients?: Patient[] }>("/api/patients");
      setPatients(data.patients || []);
      return true;
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load patient list.");
      return false;
    }
  };

  const loadDashboardAnalytics = async (date?: string, forUser: User | null = userRef.current) => {
    // Hospital-wide analytics are only served to admins / reporting staff (enforced by the API).
    if (!canViewHospitalOverview(forUser)) {
      setDashboardAnalytics(null);
      return true;
    }
    setDashboardAnalyticsLoading(true);
    try {
      const targetDate = date || dashboardDate;
      const url = targetDate ? `/api/dashboard/analytics?days=14&date=${encodeURIComponent(targetDate)}` : "/api/dashboard/analytics?days=14";
      const data = await apiFetch<DashboardAnalytics>(url);
      setDashboardAnalytics(data);
      return true;
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load dashboard analytics.");
      setDashboardAnalytics(null);
      return false;
    } finally {
      setDashboardAnalyticsLoading(false);
    }
  };

  const loadHospitalSummary = async (date?: string, forUser: User | null = userRef.current) => {
    if (!canViewHospitalOverview(forUser)) {
      setHospitalSummary(null);
      return true;
    }
    try {
      const targetDate = date || dashboardDate;
      const url = targetDate
        ? `/api/dashboard/hospital-summary?date=${encodeURIComponent(targetDate)}`
        : "/api/dashboard/hospital-summary";
      const data = await apiFetch<HospitalSummary>(url);
      setHospitalSummary(data);
      return true;
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load operational hospital summary.");
      setHospitalSummary(null);
      return false;
    }
  };

  // One-time cleanup of stale local storage test queues
  useEffect(() => {
    try {
      if (!localStorage.getItem("hospai_data_reset_20260912")) {
        ["hospai_recent_registrations", "hospai_pending_ip_admission", "hospai_op_queue", "hospai_op_queue_v2"].forEach((k) => localStorage.removeItem(k));
        localStorage.setItem("hospai_data_reset_20260912", "true");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const handleDashboardRefresh = () => {
      void loadStats();
      void loadPatients();
      void loadDashboardAnalytics();
      void loadHospitalSummary(dashboardDate);
    };
    window.addEventListener("dashboard:refresh", handleDashboardRefresh);
    return () => window.removeEventListener("dashboard:refresh", handleDashboardRefresh);
  }, [user, dashboardDate]);

  useEffect(() => {
    if (!user) return;
    if (hasPermission("patients.read")) {
      void loadStats();
      void loadPatients();
      void loadDashboardAnalytics();
    } else {
      setStats(EMPTY_STATS);
      setDashboardAnalytics(null);
      setHospitalSummary(null);
      setPatients([]);
      setSelectedPatient(null);
    }
  }, [user, permissions]);

  useEffect(() => {
    if (!user) return;
    if (hasPermission("patients.read")) {
      void loadHospitalSummary(dashboardDate);
      void loadStats(dashboardDate);
      void loadDashboardAnalytics(dashboardDate);
    }
  }, [dashboardDate, user]);

  useEffect(() => {
    if (!user) return;
    const activeNav = NAV_ITEMS.find((item) => item.id === page);
    const requiredModule = activeNav?.module || PAGE_MODULE_MAP[page];
    if (requiredModule && !hasModuleAccess(requiredModule)) {
      setPage("access-denied");
      setNotice({ type: "warning", message: "You do not have permission to access this module." });
      return;
    }
    if (activeNav && !canAccessNavItem(activeNav.id, activeNav.permission, activeNav.module)) {
      setPage("access-denied");
      setNotice({ type: "warning", message: activeNav.deniedHint || "You do not have permission to access this module." });
      return;
    }
    if (!isAdminRoutePath && page === "admin" && !hasPermission("admin.users.create")) {
      const fallbackPage = getDefaultPage(user);
      setPage(fallbackPage);
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", `/${fallbackPage}`);
      }
      setNotice({ type: "warning", message: "Only super admins can access the /admin page." });
      return;
    }
    if (page === "patients" && hasPermission("patients.read")) {
      setSelectedPatient(null);
      void loadPatients();
    }
    if (page === "dashboard" && hasPermission("patients.read")) {
      void loadStats();
      void loadPatients();
      void loadDashboardAnalytics();
      void loadHospitalSummary();
    }
  }, [page, user, permissions]);

  const recentPatients = useMemo(() => patients.slice(0, 5), [patients]);

  const handleLogin = async (username: string, password: string) => {
    // Single-tenant login: the hospital is resolved server-side from the
    // stored default (see request_hospital_id() in app.py) -- no visible
    // hospital-code field on this form.
    const inputHospitalCode = getHospitalCode();
    const data = await apiFetch<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: { "X-Hospital-Code": inputHospitalCode },
    });
    setAuthChecked(true);
    setUser(data.user);
    const defaultPage = getDefaultPage(data.user);
    setPage(defaultPage);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", defaultPage === "admin" ? "/admin" : `/${defaultPage}`);
    }
    setNotice({ type: "success", message: "Login successful." });
    if (resolvePermissions(data.user).includes("patients.read")) {
      void loadStats();
      void loadPatients();
      void loadDashboardAnalytics(undefined, data.user);
      void loadHospitalSummary(undefined, data.user);
    }
  };

  const readPlatformAdminCreds = (form: HTMLFormElement) => ({
    username: ((form.elements.namedItem("platform_admin_username") as HTMLInputElement)?.value || "").trim(),
    password: (form.elements.namedItem("platform_admin_password") as HTMLInputElement)?.value || "",
  });

  const platformHeaders = (platformAdminUsername: string, platformAdminPassword: string, hospitalCodeValue: string) => ({
    "Content-Type": "application/json",
    "X-Hospital-Code": hospitalCodeValue.trim().toLowerCase(),
    "X-Platform-Admin-Username": platformAdminUsername,
    "X-Platform-Admin-Password": platformAdminPassword,
  });

  const handleCreateHospital = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const creds = readPlatformAdminCreds(form);
    const hospitalCodeValue = ((form.elements.namedItem("hospital_code") as HTMLInputElement)?.value || "").trim().toLowerCase();
    const hospitalNameValue = ((form.elements.namedItem("hospital_name") as HTMLInputElement)?.value || "").trim();

    try {
      const response = await fetch(`${API_BASE}/api/platform/hospitals`, {
        method: "POST",
        headers: platformHeaders(creds.username, creds.password, hospitalCodeValue),
        body: JSON.stringify({ hospital_code: hospitalCodeValue, name: hospitalNameValue || undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || "Unable to create hospital.");
      setNotice({ type: "success", message: `Hospital ${hospitalCodeValue} is ready.` });
      setHospitalCode(hospitalCodeValue);
      setHospitalCodeState(hospitalCodeValue);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create hospital.");
    }
  };

  const handleSetupHospitalAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const creds = readPlatformAdminCreds(form);
    const hospitalCodeValue = ((form.elements.namedItem("hospital_code") as HTMLInputElement)?.value || "").trim().toLowerCase();
    const adminUsername = ((form.elements.namedItem("admin_username") as HTMLInputElement)?.value || "").trim();
    const adminPassword = (form.elements.namedItem("admin_password") as HTMLInputElement)?.value || "";
    const adminFullName = ((form.elements.namedItem("admin_full_name") as HTMLInputElement)?.value || "").trim();
    const adminEmail = ((form.elements.namedItem("admin_email") as HTMLInputElement)?.value || "").trim();
    const adminPhone = ((form.elements.namedItem("admin_phone") as HTMLInputElement)?.value || "").trim();
    const adminPhoneCountryCode = ((form.elements.namedItem("admin_phone_country_code") as HTMLInputElement)?.value || "+91").trim();

    try {
      const response = await fetch(`${API_BASE}/api/auth/setup-admin`, {
        method: "POST",
        headers: platformHeaders(creds.username, creds.password, hospitalCodeValue),
        body: JSON.stringify({
          username: adminUsername,
          password: adminPassword,
          full_name: adminFullName,
          email: adminEmail,
          phone: adminPhone,
          phone_country_code: adminPhoneCountryCode,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || "Unable to onboard hospital admin.");
      setNotice({ type: "success", message: `Admin created for ${hospitalCodeValue}.` });
      setHospitalCode(hospitalCodeValue);
      setHospitalCodeState(hospitalCodeValue);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to onboard hospital admin.");
    }
  };

  const handleResetHospitalAdminPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const creds = readPlatformAdminCreds(form);
    const hospitalCodeValue = ((form.elements.namedItem("hospital_code") as HTMLInputElement)?.value || "").trim().toLowerCase();
    const adminUsername = ((form.elements.namedItem("admin_username") as HTMLInputElement)?.value || "").trim();
    const newPassword = (form.elements.namedItem("new_password") as HTMLInputElement)?.value || "";

    try {
      const response = await fetch(`${API_BASE}/api/platform/hospitals/${encodeURIComponent(hospitalCodeValue)}/admin/reset-password`, {
        method: "POST",
        headers: platformHeaders(creds.username, creds.password, hospitalCodeValue),
        body: JSON.stringify({ username: adminUsername, new_password: newPassword }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || "Unable to reset admin password.");
      setNotice({ type: "success", message: `Admin password reset for ${hospitalCodeValue}.` });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to reset admin password.");
    }
  };

  const handleToggleHospitalAccess = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const creds = readPlatformAdminCreds(form);
    const hospitalCodeValue = ((form.elements.namedItem("hospital_code") as HTMLInputElement)?.value || "").trim().toLowerCase();
    const action = ((form.elements.namedItem("action") as HTMLInputElement)?.value || "").trim().toLowerCase();
    const reason = ((form.elements.namedItem("reason") as HTMLInputElement)?.value || "").trim();
    const endpoint = action === "enable" ? "enable" : "disable";

    try {
      const response = await fetch(`${API_BASE}/api/platform/hospitals/${encodeURIComponent(hospitalCodeValue)}/${endpoint}`, {
        method: "POST",
        headers: platformHeaders(creds.username, creds.password, hospitalCodeValue),
        body: JSON.stringify(endpoint === "disable" ? { reason } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || "Unable to update hospital status.");
      setNotice({ type: "success", message: `Hospital ${hospitalCodeValue} is now ${endpoint === "disable" ? "disabled" : "enabled"}.` });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update hospital status.");
    }
  };

  const handleLogout = () => {
    void apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    setPage("dashboard");
    setSelectedPatient(null);
    setIsSidebarOpen(false);
    goToLogin();
  };

  const idleTimeoutMs = (user?.session_ttl_seconds || DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  const idleSession = useIdleLogout({
    enabled: Boolean(user),
    timeoutMs: idleTimeoutMs,
    onIdle: () => {
      handleLogout();
      setNotice({ type: "info", message: `You were logged out after ${formatMinutes(idleTimeoutMs)} of inactivity.` });
    },
    // Tells the server about activity that didn't involve an API call (e.g.
    // typing into a long form). A missing session means the server already
    // expired or revoked it.
    onKeepAlive: () =>
      apiFetch<{ user?: User }>("/api/auth/session").then((data) => {
        if (!data.user) window.dispatchEvent(new Event("app:unauthorized"));
      }),
  });

  const navigateToPage = (targetPage: string) => {
    const nextPage = normalizeRouteAlias(targetPage);
    if (nextPage === "patients") {
      setPatientsPageKey((prev) => prev + 1);
    }
    if (nextPage === page) {
      setPageKeys((prev) => ({
        ...prev,
        [nextPage]: (prev[nextPage] || 0) + 1,
      }));
    }
    syncUrlForPage(nextPage);
    setPage(nextPage);
    setIsSidebarOpen(false);
  };

  const refreshPatients = async () => {
    const data = await apiFetch<{ patients?: Patient[] }>("/api/patients");
    setPatients(data.patients || []);
  };

  const handleCreatePatient = async (
    payload: Record<string, unknown>,
    setForm: Dispatch<SetStateAction<any>>,
    setDuplicateInfo?: Dispatch<SetStateAction<any>>,
    refreshPatientId?: () => Promise<void>
  ): Promise<{ patient_id: string; admission_id?: string } | null> => {
    try {
      const data = await apiFetch<{ patient_id: string; admission_id?: string }>("/api/patients", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await refreshPatients();
      await loadStats();
      await loadHospitalSummary();
      setSelectedPatient({
        patient_id: data.patient_id,
        admission_id: data.admission_id,
        name: String(payload.name || ""),
        last_name: String(payload.last_name || ""),
        middle_name: String(payload.middle_name || ""),
      });
      setDuplicateInfo?.(null);
      setNotice({ type: "success", message: `Patient ${data.patient_id} registered.` });
      setForm({ ...EMPTY_PATIENT_FORM });
      await refreshPatientId?.();
      return data;
    } catch (error) {
      const typedError = error as { status?: number; payload?: any; message?: string };
      if (typedError.status === 409) {
        setDuplicateInfo?.(typedError.payload?.duplicate || null);
        setNotice({ type: "warning", message: typedError.message || "Possible duplicate" });
        return null;
      }
      reportError(setNotice, typedError);
      return null;
    }
  };

  const handleDeletePatient = async (patientId: string) => {
    try {
      await apiFetch(`/api/patients/${patientId}`, { method: "DELETE" });
      await refreshPatients();
      await loadStats();
      await loadHospitalSummary();
      if (selectedPatient?.patient_id === patientId) {
        setSelectedPatient(null);
      }
      setNotice({ type: "success", message: "Patient removed." });
    } catch (error) {
      const err = error as { message?: string; status?: number };
      setNotice({ type: "error", message: err.message || "Login failed. Please check credentials." });
      console.error("HospAI login failed", err);
    }
  };

  const handleExportPatientsCsv = async (query = "") => {
    try {
      const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const response = await fetch(`${API_BASE}/api/export/patients/csv${params}`, {
        method: "GET",
        credentials: "include",
        headers: { "X-Hospital-Code": getHospitalCode() },
      });
      if (!response.ok) {
        throw new Error("Unable to export patients CSV.");
      }
      const blob = await response.blob();
      downloadExportBlob(blob, `patients_${new Date().toISOString().slice(0, 10)}.csv`);
      setNotice({ type: "success", message: "Patients CSV exported." });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to export patients CSV.");
    }
  };

  const handleSelectPatient = (patient: Patient | null) => {
    if (!patient) {
      setSelectedPatient(null);
      return;
    }
    setSelectedPatient(patient);
  };

  const handleOpenPatientProfile = async (patientId: string) => {
    const cleanId = String(patientId || "").trim();
    if (!cleanId) {
      setNotice({ type: "warning", message: "Patient identifier not available." });
      return;
    }

    let patient = patients.find(
      (item) =>
        (item.patient_id || "").trim().toLowerCase() === cleanId.toLowerCase() ||
        (item.name || "").trim().toLowerCase() === cleanId.toLowerCase()
    ) || null;

    if (!patient) {
      try {
        const fetched = await apiFetch<{ patient?: Patient } & Patient>(`/api/patients/${encodeURIComponent(cleanId)}`);
        const found = fetched?.patient || (fetched?.patient_id ? (fetched as Patient) : null);
        if (found && found.patient_id) {
          patient = found;
          setPatients((prev) => [found, ...prev.filter((p) => (p.patient_id || "").toLowerCase() !== (found.patient_id || "").toLowerCase())]);
        }
      } catch (e) {
        console.error("Failed to fetch patient for profile view", e);
      }
    }

    if (!patient) {
      try {
        const searchRes = await apiFetch<{ patients?: Patient[] }>(`/api/patients?q=${encodeURIComponent(cleanId)}`);
        const list = searchRes?.patients || [];
        if (list.length > 0) {
          patient = list[0];
          setPatients((prev) => [patient!, ...prev.filter((p) => (p.patient_id || "").toLowerCase() !== (patient!.patient_id || "").toLowerCase())]);
        }
      } catch (e) {
        // ignore
      }
    }

    if (!patient) {
      patient = {
        patient_id: cleanId,
        name: cleanId,
      } as Patient;
    }

    handleSelectPatient(patient);
    navigateToPage("patients");
  };

  const refreshPatientData = async (patientId?: string) => {
    await Promise.allSettled([loadStats(), loadPatients(), loadHospitalSummary()]);
    if (patientId) {
      setSelectedPatient((prev) => (prev?.patient_id === patientId ? { ...prev } : prev));
    }
    setPatientDetailRefreshToken((prev) => prev + 1);
  };

  if (isAdminRoutePath) {
    return (
      <div className="app-shell app-shell-single">
        <main className="admin-route-main">
          <Container size="full" className="admin-route-container">
            <header className="topbar admin-route-topbar">
              <div>
                <h2>Admin</h2>
                <p className="muted">Separate admin route authentication.</p>
              </div>
            </header>
            <AdminPage setNotice={setNotice} />
          </Container>
        </main>
        {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
      </div>
    );
  }

  if (!authChecked) {
    if (isPlatformAdminRoute) {
      return (
        <>
          <PlatformAdminPage
            initialHospitalCode={hospitalCode}
            onCreateHospital={handleCreateHospital}
            onSetupHospitalAdmin={handleSetupHospitalAdmin}
            onResetHospitalAdminPassword={handleResetHospitalAdminPassword}
            onToggleHospitalAccess={handleToggleHospitalAccess}
          />
          {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
        </>
      );
    }
    return <div className="auth-page">Checking session...</div>;
  }

  if (isPlatformAdminRoute) {
    return (
      <>
        <PlatformAdminPage
          initialHospitalCode={hospitalCode}
          onCreateHospital={handleCreateHospital}
          onSetupHospitalAdmin={handleSetupHospitalAdmin}
          onResetHospitalAdminPassword={handleResetHospitalAdminPassword}
          onToggleHospitalAccess={handleToggleHospitalAccess}
        />
        {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
      </>
    );
  }

  if (!user) {
    return (
      <>
        <AuthView onLogin={handleLogin} />
        {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
      </>
    );
  }

  const isBillingRoute =
    page === "billing" ||
    page.startsWith("billing-") ||
    page === "accounts-doctor-payouts";

  return (
    <div className="app-shell">
      {isSidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setIsSidebarOpen(false)} />
      )}
      {page.startsWith("pharmacy-") ? (
        <aside className={`sidebar pharmacy-sidebar-mode ${isSidebarOpen ? "open" : ""}`}>
          <div className="pharmacy-brand-header">
            <HospitalBrand variant="sidebar" />
          </div>
          <div className="sidebar-scroll-region">
            <nav className="sidebar-nav">
              {/* 1. Overview */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-overview" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-overview");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="home" /></span>
                <span>Overview</span>
              </button>

              {/* 2. OP Dispense */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-op-dispense" || page === "pharmacy-dispense" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-op-dispense");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="pill" /></span>
                <span>OP Dispense</span>
              </button>

              {/* 3. IP Dispense */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-ip-dispense" || page === "pharmacy-ward-indents" || page === "pharmacy-medication-orders" || page === "pharmacy-emar" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-ip-dispense");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="bed" /></span>
                <span>IP Dispense</span>
              </button>

              {/* 4. Inventory / Stock */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-inventory" || page.startsWith("pharmacy-inventory-") ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-inventory");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="box" /></span>
                <span>Inventory / Stock</span>
              </button>

              {/* 5. Purchase & GRN */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-purchases" || (page.startsWith("pharmacy-purchases-") && page !== "pharmacy-purchases-suppliers") ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-purchases");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="cart" /></span>
                <span>Purchase & GRN</span>
              </button>

              {/* 6. Suppliers */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-suppliers" || page === "pharmacy-purchases-suppliers" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-suppliers");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="team" /></span>
                <span>Suppliers</span>
              </button>

              {/* Insurance Claims (pharmacy insurance Due bills awaiting settlement) */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-insurance-claims" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-insurance-claims");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="shield-check" /></span>
                <span>Insurance Claims</span>
              </button>

              {/* 7. Reports */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-reports" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-reports");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="chart" /></span>
                <span>Reports</span>
              </button>

              {/* 8. Profit & Loss Analysis */}
              {hasPermission("pharmacy.report") && (
                <button
                  type="button"
                  className={`sidebar-tab ${page === "pharmacy-profit-analysis" ? "active" : ""}`}
                  onClick={() => {
                    setIsSidebarOpen(false);
                    navigateToPage("pharmacy-profit-analysis");
                  }}
                >
                  <span className="sidebar-tab-icon"><SidebarIcon name="billing" /></span>
                  <span>Profit &amp; Loss Analysis</span>
                </button>
              )}

              {/* 9. Settings */}
              <button
                type="button"
                className={`sidebar-tab ${page === "pharmacy-settings" ? "active" : ""}`}
                onClick={() => {
                  setIsSidebarOpen(false);
                  navigateToPage("pharmacy-settings");
                }}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="settings" /></span>
                <span>Settings</span>
              </button>
            </nav>
          </div>
          <div className="sidebar-footer" style={{ padding: "0.75rem 1rem 1rem", borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
            {(!user?.module_access || user.module_access.length > 1 || isAdmin) && (
              <button
                type="button"
                className="sidebar-tab"
                style={{ color: "#38bdf8", fontWeight: 600, background: "rgba(14, 165, 233, 0.1)", border: "1px solid rgba(14, 165, 233, 0.2)", width: "100%", textAlign: "left", marginBottom: "8px", borderRadius: "6px" }}
                onClick={() => navigateToPage("dashboard")}
              >
                <span className="sidebar-tab-icon"><SidebarIcon name="dashboard" /></span>
                <span>Main Hospital HIS</span>
              </button>
            )}
            <button
              type="button"
              className="sidebar-tab"
              style={{ color: "#94a3b8", fontWeight: 600, background: "transparent", border: "none", width: "100%", textAlign: "left" }}
              onClick={() => setNotice({ type: "info", message: "Pharmacy team: Chief Pharmacist John, Lead Tech Sarah, Dispensing Assistant Ravi." })}
            >
              <span className="sidebar-tab-icon"><SidebarIcon name="team" /></span>
              <span>Pharmacy Team</span>
            </button>
            <button
              type="button"
              className="sidebar-tab logout-footer-btn"
              onClick={() => setLogoutConfirmOpen(true)}
              style={{ marginTop: "4px", color: "#94a3b8", fontWeight: 600 }}
            >
              <span className="sidebar-tab-icon"><SidebarIcon name="logout" /></span>
              <span>Sign out</span>
            </button>
          </div>
        </aside>
      ) : (
        <aside className={`sidebar ${isSidebarOpen ? "open" : ""}`}>
          <div className="brand-header">
            <HospitalBrand variant="sidebar" />
          </div>
          <div className="sidebar-scroll-region">
            <nav>
              {sidebarGroups.map((group) => (
                <section key={group.key} className="sidebar-nav-group">
                  <button
                    type="button"
                    className="sidebar-nav-toggle"
                    onClick={() => setCollapsedSidebarGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}
                    aria-expanded={!collapsedSidebarGroups[group.key]}
                  >
                    <span className="sidebar-nav-heading">
                      <span className="sidebar-nav-title">{group.label}</span>
                      <span className="sidebar-nav-count">{group.items.length}</span>
                    </span>
                    <span className={collapsedSidebarGroups[group.key] ? "sidebar-nav-chevron collapsed" : "sidebar-nav-chevron"} aria-hidden="true">
                      <span className="sidebar-nav-chevron-chip">▾</span>
                    </span>
                  </button>
                  {!collapsedSidebarGroups[group.key] && (
                    <div className="sidebar-nav-items">
                      {group.items.map((item) => {
                        const blocked = !!item.permission && !hasPermission(item.permission);
                        const isActive =
                          page === item.id ||
                          (item.id === "billing-overview" && ["billing-module-collections", "billing-aging", "billing-reconciliation", "billing-mode-breakdown"].includes(page)) ||
                          (item.id === "billing-patient-bills" && ["billing-invoices", "billing-create-invoice", "billing-record-payment"].includes(page)) ||
                          (item.id === "billing-doctor-payouts" && page === "accounts-doctor-payouts") ||
                          (item.id === "billing-reports-day-close" && page === "reports");
                        return (
                          <SidebarTab
                            key={item.id}
                            label={item.label}
                            pageId={item.id}
                            icon={NAV_ICON_MAP[item.id] || "dashboard"}
                            active={isActive}
                            disabled={blocked}
                            hint={blocked ? item.deniedHint : ""}
                            onClick={() => {
                              setIsSidebarOpen(false);
                              if (blocked) {
                                setNotice({ type: "warning", message: item.deniedHint || "Access denied." });
                                return;
                              }
                              navigateToPage(item.id);
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
            </nav>
          </div>
          <div className="sidebar-footer" style={{ padding: "0.75rem 1rem 1rem", borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
            <button 
              type="button" 
              className="sidebar-tab logout-footer-btn" 
              onClick={() => setLogoutConfirmOpen(true)}
              style={{ color: "#94a3b8", fontWeight: 600 }}
            >
              <span className="sidebar-tab-icon">
                <SidebarIcon name="logout" />
              </span>
              <span>Sign out</span>
            </button>
          </div>
        </aside>
      )}
      <main className="app-main-content" aria-live="polite">
        <div className="mobile-top-bar">
          <button type="button" className="hamburger-menu-btn" onClick={() => setIsSidebarOpen(true)} aria-label="Open sidebar menu">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="mobile-top-bar-title">HospAI</span>
        </div>
        <Container size="full">
        {page !== "dashboard" && !page.startsWith("pharmacy-") && !isBillingRoute && page !== "doctor-prescription" && page !== "op-queue-management" && page !== "add" && page !== "pre-booking" && page !== "ip-admission" && page !== "patient-journey" && page !== "discharge-summary" && page !== "patient-reach-ai" && !page.startsWith("reach-") && page !== "bed-management" && page !== "inpatient-patients" && (
          <header className="topbar module-unified-topbar">
            <div className="module-topbar-breadcrumb-row">
              <div className="module-topbar-breadcrumb">
                <span className="breadcrumb-root" onClick={() => window.history.back()}>HospAI</span>
                <span className="breadcrumb-sep">/</span>
                {NAV_ITEMS.find((item) => item.id === page)?.group === "lab-diagnostics" && (
                  <><span className="breadcrumb-active">Lab &amp; Diagnostics</span><span className="breadcrumb-sep">/</span></>
                )}
                <span className="breadcrumb-active">{page === "admin" ? "Admin" : NAV_ITEMS.find((item) => item.id === page)?.label || "Dashboard"}</span>
              </div>
            </div>
            <div className="module-topbar-heading-row">
              <div className="module-topbar-titles">
                <h2>{page === "admin" ? "Admin" : NAV_ITEMS.find((item) => item.id === page)?.label || "Dashboard"}</h2>
                <p className="muted">{PAGE_SUBTITLES[page] || "Stay ahead with real-time care intelligence."}</p>
              </div>
            </div>
          </header>
        )}

        {page === "dashboard" && (
          <DashboardPage
            key={pageKeys[page] || 0}
            stats={stats}
            recentPatients={recentPatients}
            patients={patients}
            analytics={dashboardAnalytics}
            hospitalSummary={hospitalSummary}
            analyticsLoading={dashboardAnalyticsLoading}
            onNavigate={navigateToPage}
            user={user}
            onLogout={() => setLogoutConfirmOpen(true)}
            onRefreshDashboard={async () => {
              const r1 = await loadStats();
              const r2 = await loadPatients();
              const r3 = await loadDashboardAnalytics();
              const r4 = await loadHospitalSummary(dashboardDate);
              return r1 !== false && r2 !== false && r3 !== false && r4 !== false;
            }}
            setNotice={setNotice}
            dashboardDate={dashboardDate}
            setDashboardDate={setDashboardDate}
            canOpenPage={canOpenPage}
          />
        )}

        {page === "analytics" && (
          <AnalysisPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
            hospitalSummary={hospitalSummary}
            analytics={dashboardAnalytics}
            analyticsLoading={dashboardAnalyticsLoading}
            dashboardDate={dashboardDate}
            setDashboardDate={setDashboardDate}
          />
        )}

        {page === "add" && (
          <AddPatientPage
            key={pageKeys[page] || 0}
            ocrLanguage={ocrLanguage}
            onCreate={handleCreatePatient}
            selectedPatient={selectedPatient}
            setNotice={setNotice}
            onDocumentSaved={refreshPatientData}
            onNavigate={navigateToPage}
          />
        )}

        {page === "pre-booking" && (
          <PreBookingPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
          />
        )}

        {page === "consent-desk" && hasPermission("patients.write") && (
          <RegistrationDeskPage key={pageKeys[page] || 0} mode="consent" selectedPatient={selectedPatient} setNotice={setNotice} />
        )}

        {page === "insurance-desk" && hasPermission("patients.write") && (
          <RegistrationDeskPage key={pageKeys[page] || 0} mode="insurance" selectedPatient={selectedPatient} setNotice={setNotice} />
        )}

        {page === "op-queue-management" && hasPermission("patients.read") && (
          <OpQueuePage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onOpenPatient={handleOpenPatientProfile}
            onNavigate={navigateToPage}
            scopedDoctor={scopedDoctor}
          />
        )}
        {page === "op-desk" && hasPermission("patients.read") && <OpPage key={pageKeys[page] || 0} setNotice={setNotice} canEdit={hasPermission("patients.write")} />}
        {page === "doctor-prescription" && (
          <DoctorPrescriptionPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onOpenPatient={handleOpenPatientProfile}
            onNavigate={navigateToPage}
            scopedDoctor={scopedDoctor}
          />
        )}
        {page === "ip-admission" && hasPermission("patients.write") && <InpatientAdmissionPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />}
        {page === "bed-management" && hasPermission("patients.write") && <BedManagementPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />}
        {page === "inpatient-patients" && hasPermission("patients.read") && <InpatientPatientsPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />}
        {page === "nurse-station" && hasPermission("patients.write") && (
          <NurseEmarPage key={pageKeys[page] || 0} setNotice={setNotice} />
        )}

        {page === "patient-journey" && hasPermission("patients.read") && (
          <PatientJourneyPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
            selectedPatient={selectedPatient}
          />
        )}

        {page === "discharge-summary" && hasPermission("patients.read") && (
          <DischargeSummaryPage key={pageKeys[page] || 0} setNotice={setNotice} selectedPatient={selectedPatient} canEdit={hasPermission("patients.write")} canApprove={hasPermission("clinical.author")} />
        )}

        {page === "patient-reach-ai" && hasPermission("patients.read") && (
          <PatientReachAiPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
            onNavigate={navigateToPage}
            canWriteSurveys={hasPermission("reach.write")}
          />
        )}

        {(page === "reach-survey-management" || page === "reach-survey-templates" || page === "reach-whatsapp-templates" || page === "reach-survey-reports") && hasPermission("reach.read") && (
          <PatientReachAiPage
            key={`${page}-${pageKeys[page] || 0}`}
            view={page.replace("reach-", "") as "survey-management" | "survey-templates" | "whatsapp-templates" | "survey-reports"}
            setNotice={setNotice}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
            onNavigate={navigateToPage}
            canWriteSurveys={hasPermission("reach.write")}
          />
        )}

        {page === "patients" && (
          <PatientsPage
            key={pageKeys[page] || 0}
            patients={patients}
            onSelect={handleSelectPatient}
            onDelete={handleDeletePatient}
            onPatientUpdated={refreshPatientData}
            onExportCsv={handleExportPatientsCsv}
            selectedPatient={selectedPatient}
            setNotice={setNotice}
            canEdit={hasPermission("patients.write")}
            canDelete={hasPermission("patients.delete")}
            canReadBilling={hasPermission("billing.read")}
            canReadLab={hasPermission("lab.read")}
            ocrLanguage={ocrLanguage}
            languages={languages}
            refreshToken={patientDetailRefreshToken}
            onNavigate={navigateToPage}
          />
        )}

        {page === "readmit" && (
          <ReadmitPage key={pageKeys[page] || 0} onSelect={handleSelectPatient} setNotice={setNotice} onReadmitComplete={refreshPatientData} ocrLanguage={ocrLanguage} onNavigate={navigateToPage} />
        )}

        {page === "doctors-history" && (
          <DoctorsHistoryPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            scopedDoctor={scopedDoctor}
            onOpenPatient={(patientId) => {
              const patient = patients.find((item) => item.patient_id === patientId) || null;
              handleSelectPatient(patient);
              navigateToPage("patients");
            }}
          />
        )}

        {(page === "billing-overview" || page === "billing-module-collections" || page === "billing-aging" || page === "billing-reconciliation" || page === "billing-mode-breakdown") && hasPermission("billing.read") && (
          <BillingOverviewPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "billing-patient-bills" || page === "billing-invoices" || page === "billing-create-invoice" || page === "billing-record-payment") && hasPermission("billing.read") && (
          <PatientBillsPaymentsPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
          />
        )}
        {page === "billing-ip-discharge" && hasPermission("billing.read") && (
          <IpDischargeBillingPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
          />
        )}
        {page === "billing-advances-refunds" && hasPermission("billing.read") && (
          <AdvancesRefundsPage
            key={pageKeys[page] || 0}
            setNotice={setNotice}
            onNavigate={navigateToPage}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
          />
        )}
        {(page === "billing-doctor-payouts" || page === "accounts-doctor-payouts") && (hasPermission("accounts.read") || hasPermission("billing.read")) && (
          <DoctorPayoutsPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "billing-reports-day-close" || page === "reports") && (hasPermission("reports.read") || hasPermission("billing.read")) && (
          <ReportsDayClosePage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "billing-insurance-claims" && hasPermission("billing.write") && (
          <BillingClaimsPage key={pageKeys[page] || 0} setNotice={setNotice} />
        )}

        {page === "diag-overview" && (hasPermission("diag.read") || hasPermission("lab.read")) && (
          <LabDiagnosticsOverviewPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "emergency-worklist" && hasPermission("patients.read") && (
          <EmergencyWorklistPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-orders-billing" && (hasPermission("diag.read") || hasPermission("lab.read") || hasPermission("diag.order")) && (
          <LabDiagnosticsSalesPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-laboratory" && (hasPermission("diag.read") || hasPermission("lab.read")) && (
          <LabDiagnosticsLabPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-imaging" && (hasPermission("diag.read") || hasPermission("lab.read")) && (
          <LabDiagnosticsImagingPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-reports-approval" && (hasPermission("diag.read") || hasPermission("lab.read") || hasPermission("diag.report")) && (
          <LabDiagnosticsReportsPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-reports-history" && (hasPermission("diag.read") || hasPermission("lab.read")) && (
          <LabDiagnosticsReportsHistoryPage key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "diag-catalogue" && (hasPermission("diag.read") || hasPermission("lab.read") || hasPermission("diag.catalogue")) && (
          <LabDiagnosticsCataloguePage key={pageKeys[page] || 0} setNotice={setNotice} />
        )}
        {page === "diag-quality-equipment" && (hasPermission("diag.read") || hasPermission("lab.read") || hasPermission("diag.qc")) && (
          <LabDiagnosticsQualityPage key={pageKeys[page] || 0} setNotice={setNotice} />
        )}
        {(page === "lab" || page === "laboratory") && (hasPermission("lab.read") || hasPermission("diag.read")) && (
          <LabPage key={pageKeys[page] || 0} setNotice={setNotice} user={user} />
        )}

        {page === "hrms" && hasPermission("hr.read") && <HrmsPage key={pageKeys[page] || 0} setNotice={setNotice} />}

        {page === "ot" && hasPermission("ot.read") && <OtPage key={pageKeys[page] || 0} setNotice={setNotice} />}

        {page === "accounts" && hasPermission("accounts.read") && <AccountsOverviewPage key={pageKeys[page] || 0} setNotice={setNotice} />}
        {page === "accounts-overview" && hasPermission("accounts.read") && <AccountsOverviewPage key={pageKeys[page] || 0} setNotice={setNotice} />}
        {page === "accounts-ledger" && hasPermission("accounts.read") && <AccountsLedgerPage key={pageKeys[page] || 0} setNotice={setNotice} />}
        {page === "accounts-vendor-payments" && hasPermission("accounts.read") && <AccountsVendorPaymentsPage key={pageKeys[page] || 0} setNotice={setNotice} />}

        {page === "pharmacy-overview" && hasPermission("pharmacy.read") && (
          <PharmacyOverview key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "pharmacy-op-dispense" || page === "pharmacy-dispense" || page === "pharmacy-billing-insurance") && hasPermission("pharmacy.read") && (
          <PharmacyOpDispense key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "pharmacy-ip-dispense" || page === "pharmacy-ward-indents" || page === "pharmacy-medication-orders" || page === "pharmacy-emar") && hasPermission("pharmacy.read") && (
          <PharmacyIpDispense key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "pharmacy-inventory" || page.startsWith("pharmacy-inventory-")) && hasPermission("pharmacy.read") && (
          <PharmacyInventoryStock key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "pharmacy-purchases" || (page.startsWith("pharmacy-purchases-") && page !== "pharmacy-purchases-suppliers")) && hasPermission("pharmacy.read") && (
          <PharmacyPurchasesGrn key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {(page === "pharmacy-suppliers" || page === "pharmacy-purchases-suppliers") && hasPermission("pharmacy.read") && (
          <PharmacySuppliers key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "pharmacy-insurance-claims" && hasPermission("pharmacy.read") && (
          <PharmacyInsuranceClaims key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "pharmacy-reports" && hasPermission("pharmacy.read") && (
          <PharmacyReports key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "pharmacy-profit-analysis" && hasPermission("pharmacy.report") && (
          <PharmacyProfitAnalysis key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}
        {page === "pharmacy-settings" && hasPermission("pharmacy.read") && (
          <PharmacySettings key={pageKeys[page] || 0} setNotice={setNotice} onNavigate={navigateToPage} />
        )}

        {page === "employees" && hasPermission("admin.users.read") && <EmployeesPage key={pageKeys[page] || 0} setNotice={setNotice} canWriteEmployees={hasPermission("admin.users.update") || hasPermission("admin.users.create")} />}

        {page === "branding" && hasPermission("admin.use") && <BrandingPage key={pageKeys[page] || 0} setNotice={setNotice} />}

        {page === "admin" && hasPermission("admin.users.create") && <AdminPage key={pageKeys[page] || 0} setNotice={setNotice} />}

        {page === "access-denied" && (
          <section className="panel">
            <h3>Access Denied</h3>
            <p className="muted">You do not have permission to access this module. Contact an administrator to request access.</p>
          </section>
        )}
        {page === "settings" && <SettingsPage key={pageKeys[page] || 0} stats={stats} user={user} canReadAudit={hasPermission("audit.read")} />}
        </Container>
      </main>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        languages={languages}
        ocrLanguage={ocrLanguage}
        onOcrLanguageChange={setOcrLanguage}
      />
      <ShareModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        options={shareOptions}
      />
      <ExportShareModal
        open={exportShareModalOpen}
        onClose={() => setExportShareModalOpen(false)}
        options={exportShareOptions}
      />
      <ConfirmDialog
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          handleLogout();
        }}
        title="Log out?"
        description="You will be signed out of this account."
        confirmLabel="Log out"
      />
      <SessionTimeoutWarning
        open={Boolean(user) && idleSession.warning}
        secondsLeft={idleSession.secondsLeft}
        onContinue={idleSession.continueSession}
        onLogout={handleLogout}
      />
      {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

export default App;
