import type { ModuleOption, ModuleId, NavItem, PatientForm, SignupForm, UserTypeOption } from "../types";

const rawApiBase = (import.meta.env.VITE_API_BASE || "").trim().replace(/\/+$/, "");
export const API_BASE = rawApiBase === "/api"
  ? ""
  : (rawApiBase.endsWith("/api") ? rawApiBase.slice(0, -4) : (rawApiBase || ((typeof window !== "undefined" && window.location.protocol === "file:") ? "http://127.0.0.1:5001" : "")));

export const USER_TYPE_OPTIONS: UserTypeOption[] = [
  {
    value: "normal",
    label: "Normal User",
    description: "Access only to assigned modules.",
  },
  {
    value: "super_admin",
    label: "Super Admin",
    description: "Full system control, including user administration and credentials.",
  },
  {
    value: "admin",
    label: "Admin User",
    description: "Full operational access. No user administration.",
  },
];

export const USER_TYPE_LABELS = USER_TYPE_OPTIONS.reduce<Record<string, string>>((acc, role) => {
  acc[role.value] = role.label;
  return acc;
}, {});

export const NAV_ITEMS: NavItem[] = [
  // 1. Overview
  { id: "dashboard", label: "Overview Dashboard", group: "overview", module: "dashboard", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "analytics", label: "Analysis", group: "overview", module: "analytics", permission: "reports.read", deniedHint: "You do not have permission to access this module." },

  // Patient Reach AI
  { id: "patient-reach-ai", label: "Patient Reach AI", group: "patient-reach-ai", module: "patient-reach-ai", permission: "patients.read", deniedHint: "You do not have permission to access Patient Reach AI." },

  // 2. OP Management
  { id: "patients", label: "Patients", group: "op-management", module: "patients", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "add", label: "Patient Registration", group: "op-management", module: "patient-registration", permission: "patients.write", deniedHint: "You do not have permission to access this module." },
  { id: "op-queue-management", label: "Queue Management", group: "op-management", module: "queue-management", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "doctor-prescription", label: "Doctor Prescription", group: "op-management", module: "doctor-prescription", permission: "patients.read", deniedHint: "You do not have permission to access Doctor Prescription." },
  { id: "patient-journey", label: "Patient Journey", group: "op-management", module: "consultation", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "op-desk", label: "Doctor Scheduling", group: "op-management", module: "doctor-scheduling", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "readmit", label: "Follow-up / Re-visit", group: "op-management", module: "follow-up", permission: "patients.write", deniedHint: "You do not have permission to access this module." },
  { id: "doctors-history", label: "Doctors History", group: "op-management", module: "doctors-history", permission: "patients.read", deniedHint: "You do not have permission to access this module." },

  // 3. Emergency / Casualty
  { id: "emergency-worklist", label: "Emergency Worklist", group: "emergency", module: "emergency", permission: "patients.read", deniedHint: "You do not have permission to access Emergency." },

  // 4. Inpatient (IPD)
  { id: "ip-admission", label: "Inpatient Admission", group: "inpatient", module: "ip-management", permission: "patients.write", deniedHint: "You do not have permission to access this module." },
  { id: "bed-management", label: "Bed Management", group: "inpatient", module: "bed-management", permission: "patients.write", deniedHint: "You do not have permission to access this module." },
  { id: "inpatient-patients", label: "Inpatient Patients", group: "inpatient", module: "ip-management", permission: "patients.read", deniedHint: "You do not have permission to access this module." },
  { id: "nurse-station", label: "Nursing Station", group: "inpatient", module: "ip-management", permission: "patients.write", deniedHint: "You do not have permission to access this module." },
  { id: "discharge-summary", label: "Discharge Summary", group: "inpatient", module: "ip-management", permission: "patients.read", deniedHint: "You do not have permission to access this module." },

  // 5. Pharmacy Module
  { id: "pharmacy-overview", label: "Overview", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-op-dispense", label: "OP Dispense", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-ip-dispense", label: "IP Dispense", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-inventory", label: "Inventory / Stock", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-purchases", label: "Purchase & GRN", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-suppliers", label: "Suppliers", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-reports", label: "Reports", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },
  { id: "pharmacy-settings", label: "Settings", group: "pharmacy", module: "pharmacy", permission: "pharmacy.read", deniedHint: "You do not have permission to access Pharmacy." },

  // 6. Lab & Diagnostics Department
  { id: "diag-overview", label: "Overview", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-orders-billing", label: "Orders & Billing", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-laboratory", label: "Laboratory", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-imaging", label: "Imaging / Radiology", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-reports-approval", label: "Reports & Approval", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-reports-history", label: "Reports History", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-quality-equipment", label: "Quality & Equipment", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },
  { id: "diag-catalogue", label: "Test Catalogue", group: "lab-diagnostics", module: "lab-diagnostics", permission: "diag.read", deniedHint: "You do not have permission to access Lab & Diagnostics." },

  // 7. Billing & Accounts Department (Just below Lab & Diagnostics)
  { id: "billing-overview", label: "Overview", group: "billing", module: "billing", permission: "billing.read", deniedHint: "You do not have permission to access Billing." },
  { id: "billing-patient-bills", label: "Patient Bills & Payments", group: "billing", module: "billing", permission: "billing.read", deniedHint: "You do not have permission to access Billing." },
  { id: "billing-ip-discharge", label: "IP Discharge Billing", group: "billing", module: "billing", permission: "billing.read", deniedHint: "You do not have permission to access Billing." },
  { id: "billing-advances-refunds", label: "Advances & Refunds", group: "billing", module: "billing", permission: "billing.read", deniedHint: "You do not have permission to access Billing." },
  { id: "billing-doctor-payouts", label: "Doctor Payouts", group: "billing", module: "finance", permission: "accounts.read", deniedHint: "You do not have permission to access Doctor Payouts." },
  { id: "billing-reports-day-close", label: "Reports & Day Close", group: "billing", module: "reports", permission: "reports.read", deniedHint: "You do not have permission to access Reports." },
  { id: "billing-module-collections", label: "Revenue Reports", group: "billing", module: "billing", permission: "billing.read", hidden: true },
  { id: "accounts-doctor-payouts", label: "Doctor Payout", group: "billing", module: "finance", permission: "accounts.read", hidden: true },
  { id: "reports", label: "Daily / Monthly Reports", group: "billing", module: "reports", permission: "reports.read", hidden: true },
  { id: "billing-invoices", label: "Invoices", group: "billing", module: "billing", permission: "billing.read", hidden: true },
  { id: "billing-create-invoice", label: "Create Invoice", group: "billing", module: "billing", permission: "billing.write", hidden: true },
  { id: "billing-insurance-claims", label: "Insurance Claims", group: "billing", module: "billing", permission: "billing.write", hidden: true },

  // 8. Administration
  { id: "employees", label: "Employee Management", group: "admin", module: "employees", permission: "admin.users.read", deniedHint: "Only Super Admins can access Employee Management." },
  { id: "settings", label: "Settings", module: "settings" },
];

const EXCLUDED_MODULES: ModuleId[] = ["settings", "hrms", "insurance-desk", "consent-desk", "employees"];

const MODULE_CUSTOM_INFO: Partial<Record<ModuleId, { label: string; description: string }>> = {
  "ip-management": {
    label: "Inpatient (IPD) Management",
    description: "Access to Inpatient Admissions, Patient Tracking, and Nursing Station.",
  },
  "bed-management": {
    label: "Bed Management (IPD)",
    description: "Access to Bed Capacity, Allocations, and Occupancy workflows.",
  },
  pharmacy: {
    label: "Pharmacy Module",
    description: "Access to Pharmacy Dispensing, Inventory, Procurement, and Reports.",
  },
  "lab-diagnostics": {
    label: "Lab & Diagnostics Department",
    description: "Access to Orders & Billing, Laboratory, Imaging, Approval, Reports History, and Test Catalogue.",
  },
  billing: {
    label: "Billing & Accounts Department",
    description: "Access to Overview, Patient Bills, IP Discharge, Advances & Refunds, Doctor Payouts, and Day Close.",
  },
  "doctor-prescription": {
    label: "Doctor Prescription",
    description: "Access to Doctor OPD Prescription, Queued Patient Consultations, and Rx Generation.",
  },
  "patient-reach-ai": {
    label: "Patient Reach AI",
    description: "Access to AI patient outreach, clinical discharge summaries, and WhatsApp messaging.",
  },
};

export const MODULE_OPTIONS: ModuleOption[] = (() => {
  const seen = new Set<ModuleId>();
  const options: ModuleOption[] = [];
  for (const item of NAV_ITEMS) {
    if (item.module && !item.hidden && !EXCLUDED_MODULES.includes(item.module) && !seen.has(item.module)) {
      seen.add(item.module);
      const custom = MODULE_CUSTOM_INFO[item.module];
      options.push({
        value: item.module,
        label: custom?.label || item.label,
        description: custom?.description || `Access to ${item.label} workflows.`,
      });
    }
  }
  return options;
})();

export const DEFAULT_MODULE_ACCESS: ModuleId[] = ["dashboard", "patients", "bed-management", "ip-management", "emergency", "patient-reach-ai"];
export const ALL_ASSIGNABLE_MODULES: ModuleId[] = MODULE_OPTIONS.map((module) => module.value);

export const ADMIN_PERMISSIONS: string[] = [
  "patients.read", "patients.write", "patients.delete",
  "billing.read", "billing.write", "lab.read", "lab.write", "hr.read", "hr.write",
  "ot.read", "ot.write", "accounts.read", "accounts.write", "reports.read", "audit.read",
  "admin.use", "symptom_ai.use", "pharmacy.read", "pharmacy.write", "clinical.author",
  "pharmacy.dispense", "pharmacy.receive", "pharmacy.adjust", "pharmacy.return",
  "pharmacy.collect", "pharmacy.settle", "pharmacy.report",
  "diag.read", "diag.order", "diag.bill", "diag.specimen", "diag.result",
  "diag.imaging", "diag.report", "diag.authorize", "diag.catalogue", "diag.qc",
];

export const SUPER_ADMIN_PERMISSIONS: string[] = [
  ...ADMIN_PERMISSIONS,
  "admin.users.create",
  "admin.users.read",
  "admin.users.update",
  "admin.users.deactivate",
  "admin.users.roles.manage",
  "admin.credentials.issue",
  "admin.credentials.reset",
  "admin.sessions.revoke",
];

export const MODULE_PERMISSIONS: Record<ModuleId, string[]> = {
  dashboard: ["patients.read"],
  analytics: ["reports.read", "patients.read", "billing.read"],
  "patient-registration": ["patients.write"],
  patients: ["patients.read", "patients.write"],
  "queue-management": ["patients.read", "patients.write"],
  consultation: ["patients.read", "patients.write"],
  "doctors-history": ["patients.read"],
  "doctor-prescription": ["patients.read", "patients.write", "clinical.author"],
  billing: ["billing.read", "billing.write"],
  pharmacy: [
    "pharmacy.read", "pharmacy.write", "patients.read",
    "pharmacy.dispense", "pharmacy.receive", "pharmacy.adjust",
    "pharmacy.return", "pharmacy.collect", "pharmacy.settle", "pharmacy.report",
  ],
  laboratory: ["lab.read", "lab.write"],
  "lab-diagnostics": [
    "diag.read", "diag.order", "diag.bill", "diag.specimen", "diag.result",
    "diag.imaging", "diag.report", "diag.authorize", "diag.catalogue", "diag.qc",
    "patients.read",
  ],
  finance: ["accounts.read", "accounts.write"],
  reports: ["reports.read"],
  "bed-management": ["patients.read", "patients.write"],
  "doctor-scheduling": ["patients.read", "patients.write"],
  hrms: ["hr.read", "hr.write"],
  "insurance-desk": ["billing.read", "billing.write"],
  "consent-desk": ["patients.read", "patients.write"],
  "follow-up": ["patients.read", "patients.write"],
  "ip-management": ["patients.read", "patients.write"],
  "op-management": ["patients.read", "patients.write"],
  emergency: ["patients.read", "patients.write"],
  "patient-reach-ai": ["patients.read"],
  settings: [],
  employees: ["admin.users.read", "admin.users.update"],
  // Legacy stored values remain supported.
  lab: ["lab.read", "lab.write"],
  ot: ["ot.read", "ot.write"],
  accounts: ["accounts.read", "accounts.write"],
};

export const LEGACY_MODULE_EXPANSIONS: Partial<Record<ModuleId, ModuleId[]>> = {};

export const PAGE_MODULE_MAP: Record<string, ModuleId> = {
  dashboard: "dashboard",
  analytics: "analytics",
  add: "patient-registration",
  registration: "patient-registration",
  "registration-desk": "patient-registration",
  patients: "patients",
  "op-queue-management": "queue-management",
  "patient-journey": "consultation",
  "discharge-summary": "ip-management",
  "patient-reach-ai": "patient-reach-ai",
  "doctors-history": "doctors-history",
  "doctor-prescription": "doctor-prescription",
  billing: "billing",
  "billing-overview": "billing",
  "billing-patient-bills": "billing",
  "billing-ip-discharge": "billing",
  "billing-advances-refunds": "billing",
  "billing-doctor-payouts": "finance",
  "billing-reports-day-close": "reports",
  "billing-module-collections": "billing",
  "billing-aging": "billing",
  "billing-reconciliation": "billing",
  "billing-mode-breakdown": "billing",
  "billing-invoices": "billing",
  "billing-create-invoice": "billing",
  "billing-insurance-claims": "billing",
  "billing-record-payment": "billing",
  pharmacy: "pharmacy",
  "pharmacy-overview": "pharmacy",
  "pharmacy-op-dispense": "pharmacy",
  "pharmacy-ip-dispense": "pharmacy",
  "pharmacy-inventory": "pharmacy",
  "pharmacy-inventory-stock": "pharmacy",
  "pharmacy-purchases": "pharmacy",
  "pharmacy-purchases-grn": "pharmacy",
  "pharmacy-suppliers": "pharmacy",
  "pharmacy-reports": "pharmacy",
  "pharmacy-settings": "pharmacy",
  "pharmacy-dispense": "pharmacy",
  "pharmacy-ward-indents": "pharmacy",
  "pharmacy-medication-orders": "pharmacy",
  "pharmacy-emar": "pharmacy",
  "pharmacy-inventory-medicines": "pharmacy",
  "pharmacy-inventory-batches": "pharmacy",
  "pharmacy-inventory-expiry": "pharmacy",
  "pharmacy-inventory-transfers": "pharmacy",
  "pharmacy-purchases-pr": "pharmacy",
  "pharmacy-purchases-po": "pharmacy",
  "pharmacy-purchases-suppliers": "pharmacy",
  "pharmacy-billing-insurance": "pharmacy",
  diag: "lab-diagnostics",
  "lab-diagnostics": "lab-diagnostics",
  "diag-overview": "lab-diagnostics",
  "diag-orders-billing": "lab-diagnostics",
  "diag-laboratory": "lab-diagnostics",
  "diag-imaging": "lab-diagnostics",
  "emergency-worklist": "emergency",
  emergency: "emergency",
  "diag-reports-approval": "lab-diagnostics",
  "diag-reports-history": "lab-diagnostics",
  "diag-catalogue": "lab-diagnostics",
  "diag-quality-equipment": "lab-diagnostics",
  lab: "laboratory",
  laboratory: "laboratory",
  accounts: "finance",
  "accounts-overview": "finance",
  "accounts-ledger": "finance",
  "accounts-vendor-payments": "finance",
  "accounts-doctor-payouts": "finance",
  reports: "reports",
  inpatient: "ip-management",
  "inpatient-patients": "ip-management",
  "bed-management": "bed-management",
  "op-desk": "doctor-scheduling",
  hrms: "hrms",
  "insurance-desk": "insurance-desk",
  "consent-desk": "consent-desk",
  readmit: "follow-up",
  "ip-admission": "ip-management",
  "nurse-station": "ip-management",
  settings: "settings",
  employees: "employees",
};

// NAV_ITEMS moved to the top to prevent temporal dead zone for MODULE_OPTIONS dynamic calculation

export const DOC_TYPES = [
  { value: "test_docs", label: "Test Documents" },
  { value: "xray_mri", label: "X-Ray / MRI" },
  { value: "prescriptions", label: "Prescription" },
];

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "gif",
  "heic",
  "heif",
];

const SUPPORTED_DOCUMENT_EXTENSION_SET = new Set(SUPPORTED_DOCUMENT_EXTENSIONS);

export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export const isSupportedDocumentFile = (file: File) => {
  const parts = file.name.toLowerCase().split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  return SUPPORTED_DOCUMENT_EXTENSION_SET.has(ext);
};

export const EMPTY_PATIENT_FORM: PatientForm = {
  name: "",
  middle_name: "",
  last_name: "",
  dob: "",
  age: "",
  weight: "",
  height: "",
  gender: "",
  pregnant: false,
  marital_status: "",
  nationality: "",
  allergies: "",
  no_known_allergies: false,
  symptoms: "",
  phone: "",
  address: "",
  emergency_contact: "",
  emergency_relation: "",
  family_mobile: "",
  email: "",
  emergency_mobile: "",
};

export const EMPTY_SIGNUP_FORM: SignupForm = {
  username: "",
  password: "",
  full_name: "",
  email: "",
  phone: "",
  user_type: "normal",
  module_access: [...DEFAULT_MODULE_ACCESS],
  job_role: "",
  address: "",
  emergency_contact: "",
};

export const EMPTY_STATS = { total: 0, today: 0, active_admissions: 0, documents: 0, readmitted_patients: 0 };
