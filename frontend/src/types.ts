export type UserType = "admin" | "normal" | "super_admin";
export type ModuleId =
  | "dashboard"
  | "patient-registration"
  | "patients"
  | "queue-management"
  | "consultation"
  | "doctor-prescription"
  | "billing"
  | "pharmacy"
  | "laboratory"
  | "finance"
  | "reports"
  | "bed-management"
  | "doctor-scheduling"
  | "hrms"
  | "insurance-desk"
  | "consent-desk"
  | "follow-up"
  | "ip-management"
  | "op-management"
  | "settings"
  | "lab"
  | "ot"
  | "accounts"
  | "employees"
  | "doctors-history"
  | "lab-diagnostics"
  | "analytics"
  | "emergency"
  | "patient-reach-ai";

export interface UserTypeOption {
  value: UserType;
  label: string;
  description: string;
}

export interface ModuleOption {
  value: ModuleId;
  label: string;
  description: string;
}

export interface Notice {
  type: "success" | "error" | "warning" | "info";
  message: string;
}

export interface User {
  username: string;
  full_name?: string;
  role?: string;
  access_role?: string;
  user_type?: UserType;
  module_access?: ModuleId[];
  permissions?: string[];
  employee_id?: string;
  status?: string;
  hospital_id?: number;
  hospital_code?: string;
  session_expires_at?: string;
  job_role?: string;
  /** Doctor this login is linked to (job title Doctor); OP queue is limited to their patients. */
  doctor_name?: string | null;
}

export interface Stats {
  total: number;
  today: number;
  active_admissions: number;
  documents: number;
  readmitted_patients: number;
  revisits?: number;
  follow_ups?: number;
}

export interface DistributionItem {
  label: string;
  count: number;
}

export interface TrendPoint {
  date: string;
  count: number;
}

export interface EmployeeAnalytics {
  total: number;
  status_distribution: DistributionItem[];
  department_distribution: DistributionItem[];
  access_role_distribution: DistributionItem[];
}

export interface DashboardAnalytics {
  window_days: number;
  patients_trend: TrendPoint[];
  documents_trend: TrendPoint[];
  gender_distribution: DistributionItem[];
  doc_type_distribution: DistributionItem[];
  admission_status_distribution: DistributionItem[];
  employee?: EmployeeAnalytics;
}

export interface OperationStatusSummary {
  count: number;
  completed: number;
  pending: number;
}

export interface HospitalSummary {
  ip_op_counts: {
    daily_ip: number;
    daily_op: number;
    monthly_ip: number;
    monthly_op: number;
  };
  accidents: {
    daily: number;
    monthly: number;
  };
  revenue: {
    total: number;
    today_total?: number;
    weekly_revenue?: number;
    weekly_total?: number;
    monthly_total?: number;
    monthly_revenue?: number;
    yearly_revenue?: number;
    yearly_total?: number;
    due: number;
    today_collection?: number;
    total_collection?: number;
    pending_payments?: number;
    paid_payments?: number;
    doctor_payout_ready?: number;
    payment_mode_breakdown: DistributionItem[];
    module_breakdown?: {
      today?: {
        op_billing?: number;
        lab_diagnostics?: number;
        pharmacy?: number;
        lab_earned?: number;
        lab_collected?: number;
        lab_due?: number;
      };
      monthly?: {
        op_billing?: number;
        lab_diagnostics?: number;
        pharmacy?: number;
      };
    };
  };
  diagnostics_summary: {
    monthly_income: number;
  };
  pharmacy_summary?: {
    today_sales?: number;
    monthly_sales?: number;
    today_transactions?: number;
    today_indents_dispensed?: number;
  };
  bed_stats?: {
    capacity: number;
    occupied: number;
    available: number;
    occupancy_rate: number;
  };
  bed_ward_breakdown?: {
    ward: string;
    capacity: number;
    occupied: number;
    available: number;
  }[];
  payment_summary?: {
    total_collection?: number;
    pending_payments?: number;
    paid_payments?: number;
    today_collection?: number;
  };
  operations_today?: {
    patient_registration?: OperationStatusSummary;
    queue_management?: OperationStatusSummary;
    doctor_consultation?: OperationStatusSummary;
    bed_management?: OperationStatusSummary;
    pharmacy?: OperationStatusSummary;
    billing?: OperationStatusSummary;
    payment_collection?: OperationStatusSummary;
    revenue_reporting?: OperationStatusSummary;
    doctor_payout?: OperationStatusSummary;
  };
  referrals: DistributionItem[];
  registration_summary?: RegistrationSummary;
}

export interface VisitRecord {
  patient_id?: string;
  patient_name?: string;
  age?: number | string;
  gender?: string;
  phone?: string;
  doctor_name?: string;
  department?: string;
  visit_type?: string;
  appointment_kind?: string;
  notes?: string;
  token_no?: number | string;
  source?: "appointment" | "admission" | string;
  visit_date?: string;
}

export interface RegistrationSummary {
  date?: string;
  new_registrations: number;
  revisits: number;
  follow_ups: number;
  total_visits: number;
  revisit_records?: VisitRecord[];
  follow_up_records?: VisitRecord[];
}

export interface Patient {
  id?: number;
  patient_id: string;
  admission_id?: string;
  name: string;
  middle_name?: string;
  last_name?: string;
  dob?: string;
  last_consultation_date?: string | null;
  age?: number | string | null;
  weight?: number | string | null;
  height?: number | string | null;
  bp?: string | null;
  temperature?: string | null;
  pulse?: string | null;
  spo2?: string | null;
  gender?: string;
  pregnant?: boolean | number;
  allergies?: string;
  allergy_status?: "not_recorded" | "confirmed_none" | "has_allergies";
  no_known_allergies?: boolean;
  is_inpatient?: boolean;
  symptoms?: string;
  phone?: string;
  email?: string;
  address?: string;
  emergency_contact?: string;
  emergency_relation?: string;
  family_mobile?: string;
  marital_status?: string;
  nationality?: string;
  created_at?: string;
  registration_date?: string;
  created_on?: string;
  has_appointments?: number | boolean;
  eligible_for_free_followup?: boolean;
  last_department?: string;
  last_doctor?: string;
  consultation_fee?: string | number;
  latest_visit_type?: string | null;
  latest_doctor_name?: string | null;
  latest_department?: string | null;
  insurance_provider?: string | null;
  insurance_policy_no?: string | null;
  insurance_verified?: boolean;
  insurance_verified_by?: string | null;
  insurance_verified_at?: string | null;
}

export interface PatientVital {
  id: number;
  patient_id: string;
  bp?: string | null;
  pulse?: number | null;
  temperature?: number | null;
  weight?: number | null;
  height?: number | null;
  spo2?: number | null;
  recorded_at: string;
}

export interface Admission {
  id: number;
  admission_date: string;
  discharge_date?: string | null;
  notes?: string;
}

export interface PatientMovement {
  id: number;
  patient_id: string;
  admission_id?: number | null;
  from_department?: string | null;
  to_department: string;
  moved_at: string;
  moved_by?: string | null;
}

export interface Encounter {
  id: number;
  patient_id: string;
  encounter_type: string;
  insurance_provider?: string | null;
  insurance_policy_no?: string | null;
  is_accident?: boolean | number;
  referral_source?: string | null;
  referral_name?: string | null;
  status?: string | null;
  created_by?: string | null;
  arrival_at?: string;
}

export interface BedAllocation {
  id: number;
  admission_id: number;
  patient_id: string;
  ward: string;
  room_no: string;
  bed_no: string;
  status?: string | null;
  allocated_at?: string;
}

export interface MedicationSchedule {
  id: number;
  patient_id: string;
  medicine_name: string;
  dosage?: string | null;
  schedule_time?: string;
  administered?: boolean | number;
  alert_enabled?: boolean | number;
  notes?: string | null;
  created_at?: string;
}

export interface ObservationNote {
  id: number;
  patient_id: string;
  admission_id?: number | null;
  doctor_name?: string | null;
  note: string;
  treatment_plan?: string | null;
  created_at?: string;
}


export interface AuditLog {
  id: number;
  actor_username?: string | null;
  action?: string | null;
  module_name?: string | null;
  entity_key?: string | null;
  payload?: string | null;
  created_at?: string;
}

export interface Appointment {
  id: number;
  patient_id?: string | null;
  patient_name: string;
  visit_type: string;
  department?: string | null;
  doctor_name?: string | null;
  appointment_date: string;
  token_no: number;
  status: string;
  appointment_kind?: string;
  follow_up_for?: number | null;
  reminder_sent_at?: string | null;
  no_show_marked?: boolean | number;
  consultation_fee?: number | null;
  notes?: string | null;
  created_at?: string;
}

export interface PrescriptionMedicine {
  id: number;
  prescription_id: number;
  sequence_no: number;
  medicine: string;
  dosage?: string | null;
  frequency?: string | null;
  duration?: string | null;
  instructions?: string | null;
}

export interface Prescription {
  id: number;
  appointment_id?: number | null;
  patient_id: string;
  doctor_name?: string | null;
  department?: string | null;
  diagnosis?: string | null;
  lab_tests?: string | null;
  advice?: string | null;
  follow_up_date?: string | null;
  created_at: string;
  medicines: PrescriptionMedicine[];
}

export interface DoctorSchedule {
  id: number;
  doctor_name: string;
  department?: string | null;
  schedule_date: string;
  start_time: string;
  end_time: string;
  slot_capacity?: number | null;
  consultation_fee?: number | null;
  review_fee?: number | null;
  status?: string | null;
  notes?: string | null;
  created_at?: string;
}

export interface OpSummary {
  date: string;
  total_appointments: number;
  follow_ups: number;
  active_queue: number;
  no_shows: number;
  reminders_sent: number;
  available_doctors: number;
}

export interface Certificate {
  id: number;
  patient_id: string;
  admission_id?: number | null;
  certificate_type: string;
  title: string;
  body: string;
  issued_by?: string | null;
  created_at?: string;
}

export interface ReportsOverview {
  hospital_summary: {
    ip_op_counts: {
      daily_ip: number;
      daily_op: number;
      monthly_ip: number;
      monthly_op: number;
    };
    accidents: {
      daily: number;
      monthly: number;
    };
    revenue: {
      total: number;
      due: number;
      payment_mode_breakdown: DistributionItem[];
    };
    diagnostics_summary: {
      monthly_income: number;
    };
    referrals: DistributionItem[];
  };
  billing_summary: {
    total_billed: number;
    total_collected: number;
    total_due: number;
    total_advance: number;
    total_refunded: number;
    payment_mode_breakdown: DistributionItem[];
    collections_by_module: DistributionItem[];
  };
  lab_summary: {
    total_amount: number;
    total_paid: number;
    total_due: number;
  };
  employee_summary: {
    total: number;
    active: number;
    inactive: number;
  };
  accounts_summary: {
    ledger_income: number;
    ledger_expense: number;
    net_position: number;
    vendor_paid_total: number;
    doctor_paid_total: number;
    doctor_due_total: number;
  };
  doctor_income: DistributionItem[];
  clinic_income: DistributionItem[];
  discount_by_module: DistributionItem[];
  payment_status_breakdown: DistributionItem[];
  alos_summary: {
    average_los_days: number;
    admission_count: number;
  };
  patient_financials: Array<{
    label: string;
    total_billed: number;
    total_due: number;
  }>;
  diagnostics_by_doctor: DistributionItem[];
}

export interface OtSummary {
  theatre_count: number;
  available_theatres: number;
  scheduled_surgeries: number;
  completed_surgeries: number;
  scheduled_hours: number;
  completed_hours: number;
  theatre_utilization: DistributionItem[];
}

export interface DocumentItem {
  id: number;
  doc_type: string;
  created_at: string;
  file_path?: string;
  file_name?: string;
  mime_type?: string;
  has_file_data?: number;
  ocr_text?: string;
  ocr_language?: string;
}

export interface SignupForm {
  username: string;
  password: string;
  full_name: string;
  email: string;
  phone: string;
  user_type: UserType;
  module_access: ModuleId[];
  job_role: string;
  doctor_name: string;
  address: string;
  emergency_contact: string;
}

export interface PatientForm {
  [key: string]: string | boolean | undefined;
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
  no_known_allergies: boolean;
  symptoms: string;
  phone: string;
  address: string;
  emergency_contact: string;
  emergency_relation: string;
  family_mobile: string;
  marital_status: string;
  nationality: string;
  email?: string;
  emergency_mobile?: string;
}

export interface NavItem {
  id: string;
  label: string;
  permission?: string;
  module?: ModuleId;
  deniedHint?: string;
  group?: "overview" | "registration" | "operations" | "finance" | "admin" | "op-management" | "billing" | "pharmacy" | "inpatient" | "lab-diagnostics" | "emergency" | "patient-reach-ai";
  hidden?: boolean;
}

export interface Employee {
  username: string;
  employee_id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  department?: string;
  address?: string;
  emergency_contact?: string;
  status?: string;
  job_role?: string;
  access_role?: string;
  user_type?: UserType;
  module_access?: ModuleId[];
  date_joined?: string;
  doctor_name?: string | null;
}

export interface Alert {
  id: string;
  type: "error" | "warning" | "info" | "success";
  icon: "emergency" | "rupee" | "stock" | "lab" | "backup";
  title: string;
  desc: string;
  time: string;
  read: boolean;
  module?: string;
}
