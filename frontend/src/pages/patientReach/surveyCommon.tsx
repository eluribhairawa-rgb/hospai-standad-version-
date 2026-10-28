import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice, Patient } from "../../types";

export type SetNotice = Dispatch<SetStateAction<Notice | null>>;

export type QuestionType = "RATING" | "SINGLE_CHOICE" | "MULTI_CHOICE" | "YES_NO" | "TEXT";
export type SurveyType = "IPD" | "OPD" | "EMERGENCY" | "GENERAL";
export type TemplateStatus = "DRAFT" | "ACTIVE" | "INACTIVE";
export type RequestStatus = "NOT_SENT" | "PENDING" | "COMPLETED" | "CANCELLED";
export type WhatsAppCategory = "SURVEY" | "DISCHARGE" | "FOLLOW_UP" | "REMINDER" | "GENERAL";
export type Channel = "WHATSAPP" | "PHONE" | "IN_PERSON";

export type SurveyQuestion = {
  id?: number;
  position?: number;
  question_text: string;
  question_type: QuestionType;
  category: string | null;
  options: string[];
  is_required: boolean;
};

export type SurveyTemplate = {
  id: number;
  name: string;
  description: string | null;
  survey_type: SurveyType;
  status: TemplateStatus;
  question_count?: number;
  response_count?: number;
  open_count?: number;
  avg_rating?: number | null;
  last_response_at?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  questions?: SurveyQuestion[];
};

export type WhatsAppTemplate = {
  id: number;
  name: string;
  category: WhatsAppCategory;
  body: string;
  is_active: boolean;
  updated_at?: string | null;
  updated_by?: string | null;
};

export type SurveyAnswer = {
  id: number;
  question_id: number | null;
  question_text: string;
  question_type: QuestionType;
  category: string | null;
  rating_value: number | null;
  answer_text: string | null;
  answer_options: string[];
};

export type SurveyRequest = {
  id: number;
  template_id: number;
  template_name: string;
  survey_type: SurveyType;
  patient_id: string;
  patient_name: string | null;
  age?: string | number | null;
  gender?: string | null;
  phone: string | null;
  encounter_type: string | null;
  encounter_id: number | null;
  encounter_label: string | null;
  doctor_name: string | null;
  department: string | null;
  whatsapp_template_id: number | null;
  message: string | null;
  status: RequestStatus;
  send_count: number;
  sent_at: string | null;
  sent_by: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  response_id: number | null;
  overall_rating: number | null;
  comments: string | null;
  channel: Channel | null;
  submitted_at: string | null;
  recorded_by: string | null;
  category_ratings: Record<string, number>;
  questions?: SurveyQuestion[];
  answers?: SurveyAnswer[];
  messages?: { id: number; phone: string | null; template_name: string | null; message: string; sent_by: string | null; sent_at: string }[];
};

export type SurveySummary = {
  total: number;
  pending: number;
  completed: number;
  not_sent: number;
  cancelled: number;
  responses: number;
  avg_rating: number | null;
  response_rate: number;
  categories: { category: string; avg_rating: number; answers: number }[];
  trend: { total_pct: number | null; pending_pct: number | null; completed_pct: number | null; avg_rating_delta: number | null };
};

/** Encounter and doctor details of the visit a survey is about. */
export type SurveyContext = {
  encounter_type?: string | null;
  encounter_id?: number | null;
  encounter_label?: string | null;
  doctor_name?: string | null;
  department?: string | null;
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  RATING: "Rating (1-5)",
  SINGLE_CHOICE: "Single choice",
  MULTI_CHOICE: "Multiple choice",
  YES_NO: "Yes / No",
  TEXT: "Text answer",
};

export const SURVEY_TYPE_LABELS: Record<SurveyType, string> = {
  IPD: "Inpatient (IPD)",
  OPD: "Outpatient (OPD)",
  EMERGENCY: "Emergency",
  GENERAL: "General",
};

export const WHATSAPP_CATEGORY_LABELS: Record<WhatsAppCategory, string> = {
  SURVEY: "Survey Request",
  REMINDER: "Survey Reminder",
  DISCHARGE: "Discharge",
  FOLLOW_UP: "Follow-up",
  GENERAL: "General",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  WHATSAPP: "WhatsApp reply",
  PHONE: "Phone call",
  IN_PERSON: "In person",
};

export const STATUS_META: Record<RequestStatus, { label: string; bg: string; color: string }> = {
  NOT_SENT: { label: "Not Sent", bg: "#f1f5f9", color: "#475569" },
  PENDING: { label: "Pending", bg: "#fffbeb", color: "#b45309" },
  COMPLETED: { label: "Completed", bg: "#ecfdf5", color: "#047857" },
  CANCELLED: { label: "Cancelled", bg: "#fef2f2", color: "#b91c1c" },
};

export const TEMPLATE_STATUS_META: Record<TemplateStatus, { label: string; bg: string; color: string }> = {
  ACTIVE: { label: "Active", bg: "#ecfdf5", color: "#047857" },
  DRAFT: { label: "Draft", bg: "#eff6ff", color: "#1d4ed8" },
  INACTIVE: { label: "Inactive", bg: "#f1f5f9", color: "#64748b" },
};

export const STANDARD_CATEGORIES = [
  "Doctor Behaviour", "Nursing Care", "Cleanliness", "Discharge Process", "Overall Experience",
  "Front Office", "Billing", "Pharmacy", "Lab & Diagnostics", "Food & Amenities", "Suggestions",
];

/** The four category columns shown in the responses table; every category is in the detail view. */
export const TABLE_CATEGORIES = ["Doctor Behaviour", "Nursing Care", "Cleanliness", "Discharge Process"];

export const CATEGORY_COLORS = ["#10b981", "#3b82f6", "#8b5cf6", "#f97316", "#06b6d4", "#ec4899", "#eab308", "#64748b"];

export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "{patient_name}", label: "Patient name" },
  { key: "{uhid}", label: "UHID" },
  { key: "{doctor_name}", label: "Doctor" },
  { key: "{department}", label: "Department" },
  { key: "{visit}", label: "Visit / encounter" },
  { key: "{survey_name}", label: "Survey name" },
  { key: "{survey_questions}", label: "Survey questions" },
  { key: "{hospital_name}", label: "Hospital name" },
  { key: "{date}", label: "Today's date" },
];

// ------------------------------------------------------------------ helpers --

export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export const fmtRating = (value?: number | null) => (value === null || value === undefined ? "—" : Number(value).toFixed(1));

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => isoDate(new Date());
export const monthStartIso = () => {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
};
export const nowLocalInput = () => {
  const d = new Date();
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const buildQuery = (params: Record<string, string | number | null | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") search.set(k, String(v).trim());
  });
  const s = search.toString();
  return s ? `?${s}` : "";
};

export const patientFullName = (p?: Partial<Patient> | null) =>
  p ? [p.name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "";

export const cleanPhoneForWhatsApp = (rawPhone?: string | null): string => {
  if (!rawPhone) return "";
  let digits = rawPhone.replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = digits.substring(1);
  if (digits.length === 10) return "91" + digits;
  return digits;
};

export const openWhatsApp = (phone: string | null | undefined, message: string) => {
  const cleaned = cleanPhoneForWhatsApp(phone);
  const encoded = encodeURIComponent(message);
  const url = cleaned ? `https://wa.me/${cleaned}?text=${encoded}` : `https://api.whatsapp.com/send?text=${encoded}`;
  window.open(url, "_blank", "noopener,noreferrer");
};

/** Numbered question list for a WhatsApp survey message. */
export const buildSurveyQuestionsText = (questions: SurveyQuestion[]) =>
  questions
    .map((q, i) => {
      const n = i + 1;
      const req = q.is_required ? "" : " (optional)";
      if (q.question_type === "RATING") return `${n}. ${q.question_text}${req}\n   Reply 1 to 5`;
      if (q.question_type === "YES_NO") return `${n}. ${q.question_text}${req}\n   Reply Yes or No`;
      if (q.question_type === "SINGLE_CHOICE" || q.question_type === "MULTI_CHOICE") {
        const letters = q.options.map((o, j) => `   ${String.fromCharCode(97 + j)}) ${o}`).join("\n");
        const hint = q.question_type === "MULTI_CHOICE" ? " (choose one or more)" : "";
        return `${n}. ${q.question_text}${hint}${req}\n${letters}`;
      }
      return `${n}. ${q.question_text}${req}`;
    })
    .join("\n\n");

export type TemplateValues = {
  patient_name?: string;
  uhid?: string;
  doctor_name?: string | null;
  department?: string | null;
  visit?: string | null;
  survey_name?: string;
  survey_questions?: string;
  hospital_name?: string;
};

export const renderTemplate = (body: string, values: TemplateValues) => {
  const doctor = values.doctor_name ? (/^dr\.?\s/i.test(values.doctor_name) ? values.doctor_name : `Dr. ${values.doctor_name}`) : "our doctor";
  const map: Record<string, string> = {
    "{patient_name}": values.patient_name || "Patient",
    "{uhid}": values.uhid || "",
    "{doctor_name}": doctor,
    "{department}": values.department || "the department",
    "{visit}": values.visit || "your recent visit",
    "{survey_name}": values.survey_name || "Patient Feedback",
    "{survey_questions}": values.survey_questions || "",
    "{hospital_name}": values.hospital_name || "our hospital",
    "{date}": new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
  };
  return body.replace(/\{[a-z_]+\}/g, (m) => (m in map ? map[m] : m));
};

export const errorMessage = (err: unknown, fallback: string) => {
  const e = err as { message?: string; error?: string } | null;
  return e?.message || e?.error || fallback;
};

// -------------------------------------------------------------------- hooks --

export function useSurveyTemplates(setNotice: SetNotice, status?: TemplateStatus) {
  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ templates: SurveyTemplate[] }>(`/api/reach/survey-templates${buildQuery({ status })}`);
      setTemplates(res.templates || []);
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load survey templates.");
    } finally {
      setLoading(false);
    }
  }, [setNotice, status]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { templates, loading, reload };
}

export function useWhatsAppTemplates(setNotice: SetNotice, activeOnly = false) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [hospitalName, setHospitalName] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ templates: WhatsAppTemplate[]; hospital_name: string }>(
        `/api/reach/whatsapp-templates${buildQuery({ active_only: activeOnly ? "true" : "" })}`
      );
      setTemplates(res.templates || []);
      setHospitalName(res.hospital_name || "");
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load WhatsApp templates.");
    } finally {
      setLoading(false);
    }
  }, [setNotice, activeOnly]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { templates, hospitalName, loading, reload };
}

export function usePatientDirectory(initial?: Patient[]) {
  const [patients, setPatients] = useState<Patient[]>(initial || []);
  useEffect(() => {
    if (initial && initial.length) {
      setPatients(initial);
      return;
    }
    let alive = true;
    apiFetch<{ patients?: Patient[] }>("/api/patients")
      .then((res) => {
        if (alive) setPatients(res.patients || []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [initial]);
  return patients;
}

// ---------------------------------------------------------------- UI pieces --

export const S = {
  card: { background: "#ffffff", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "20px 24px" } as CSSProperties,
  subCard: { border: "1px solid #e2e8f0", borderRadius: "12px", padding: "16px 20px", background: "#fff" } as CSSProperties,
  h3: { fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: "0 0 2px" } as CSSProperties,
  muted: { fontSize: "12.5px", color: "#64748b", margin: 0 } as CSSProperties,
  label: { display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "4px" } as CSSProperties,
  input: {
    width: "100%", height: "36px", boxSizing: "border-box", borderRadius: "8px", border: "1.5px solid #cbd5e1",
    padding: "0 10px", fontSize: "13px", background: "#fff", color: "#1e293b", outline: "none",
  } as CSSProperties,
  textarea: {
    width: "100%", boxSizing: "border-box", borderRadius: "8px", border: "1.5px solid #cbd5e1", padding: "8px 10px",
    fontSize: "13px", fontFamily: "inherit", resize: "vertical", color: "#1e293b",
  } as CSSProperties,
  btn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "36px", padding: "0 14px",
    borderRadius: "8px", background: "#fff", border: "1px solid #cbd5e1", fontSize: "12.5px", fontWeight: 600, color: "#334155",
    cursor: "pointer", whiteSpace: "nowrap",
  } as CSSProperties,
  btnPrimary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "36px", padding: "0 16px",
    borderRadius: "8px", background: "#0f766e", border: "1px solid #0f766e", fontSize: "12.5px", fontWeight: 700, color: "#fff",
    cursor: "pointer", whiteSpace: "nowrap",
  } as CSSProperties,
  btnWhatsApp: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "36px", padding: "0 14px",
    borderRadius: "8px", background: "#25D366", border: "1px solid #25D366", fontSize: "12.5px", fontWeight: 700, color: "#fff",
    cursor: "pointer", whiteSpace: "nowrap",
  } as CSSProperties,
  btnSmall: {
    height: "28px", padding: "0 10px", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", fontSize: "12px",
    fontWeight: 600, color: "#334155", cursor: "pointer", whiteSpace: "nowrap",
  } as CSSProperties,
  th: { padding: "10px 8px", textAlign: "left", fontSize: "11.5px", fontWeight: 700, color: "#475569", background: "#f8fafc", whiteSpace: "nowrap" } as CSSProperties,
  td: { padding: "10px 8px", fontSize: "12.5px", color: "#334155", borderTop: "1px solid #f1f5f9", verticalAlign: "middle" } as CSSProperties,
};

export const disabledStyle = (style: CSSProperties, disabled: boolean): CSSProperties =>
  disabled ? { ...style, opacity: 0.55, cursor: "not-allowed" } : style;

export function Pill({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "999px", fontSize: "11px", fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: RequestStatus }) {
  const meta = STATUS_META[status] || STATUS_META.NOT_SENT;
  return <Pill label={`${status === "COMPLETED" ? "✓ " : ""}${meta.label}`} bg={meta.bg} color={meta.color} />;
}

export function Stars({ value, size = 18 }: { value: number | null | undefined; size?: number }) {
  const v = Number(value || 0);
  return (
    <span style={{ fontSize: `${size}px`, letterSpacing: "1px", whiteSpace: "nowrap" }} aria-label={`${fmtRating(value)} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ color: n <= Math.round(v) ? "#f59e0b" : "#cbd5e1" }}>★</span>
      ))}
    </span>
  );
}

export function RatingInput({ value, onChange, disabled }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean }) {
  const labels = ["Poor", "Fair", "Good", "Very good", "Excellent"];
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const active = value !== null && n <= value;
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            title={labels[n - 1]}
            onClick={() => onChange(value === n ? null : n)}
            style={{
              width: "40px", height: "36px", borderRadius: "8px", fontSize: "16px", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
              border: active ? "1.5px solid #f59e0b" : "1px solid #e2e8f0", background: active ? "#fffbeb" : "#fff", color: active ? "#b45309" : "#94a3b8",
            }}
          >
            {n}★
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ icon = "📋", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center", color: "#64748b" }}>
      <div style={{ fontSize: "32px", marginBottom: "8px" }}>{icon}</div>
      <div style={{ fontSize: "14px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>{title}</div>
      {children && <div style={{ fontSize: "12.5px" }}>{children}</div>}
    </div>
  );
}

export function Bar({ value, max = 5, color }: { value: number; max?: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div style={{ height: "7px", borderRadius: "4px", background: "#e2e8f0", width: "100%" }}>
      <div style={{ width: `${pct}%`, height: "100%", borderRadius: "4px", background: color }} />
    </div>
  );
}

export function Field({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={style}>
      <label style={S.label}>{label}</label>
      {children}
    </div>
  );
}
