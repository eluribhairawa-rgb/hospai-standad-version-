import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Modal from "../../components/ui/Modal";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { apiFetch, getHospitalCode, reportError } from "../../lib/api";
import { API_BASE } from "../../lib/constants";
import { downloadCsv } from "../../lib/csvExport";
import { downloadPDF, generatePDFBlob } from "../../lib/exportService";
import type { StandardPdfSection } from "../../lib/exportService";
import type { Patient } from "../../types";
import {
  Bar, CATEGORY_COLORS, CHANNEL_LABELS, EmptyState, Field, PLACEHOLDERS, Pill, QUESTION_TYPE_LABELS, S, STANDARD_CATEGORIES,
  STATUS_META, SURVEY_TYPE_LABELS, Stars, StatusPill, TABLE_CATEGORIES, TEMPLATE_STATUS_META, WHATSAPP_CATEGORY_LABELS,
  buildQuery, buildSurveyQuestionsText, disabledStyle, errorMessage, fmtDate, fmtDateTime, fmtRating, monthStartIso,
  renderTemplate, todayIso, useSurveyTemplates, useWhatsAppTemplates,
} from "./surveyCommon";
import type {
  QuestionType, RequestStatus, SetNotice, SurveyContext, SurveyQuestion, SurveyRequest, SurveySummary, SurveyTemplate,
  SurveyType, TemplateStatus, WhatsAppCategory, WhatsAppTemplate,
} from "./surveyCommon";
import { NewSurveyRequestModal, RecordSurveyResponseModal, SendSurveyModal, SurveyDetailModal } from "./SurveyModals";

// ------------------------------------------------------------------ shared --

async function downloadFromApi(path: string, filename: string) {
  const base = (API_BASE || "").replace(/\/+$/, "");
  const url = base.endsWith("/api") && path.startsWith("/api/") ? `${base.slice(0, -4)}${path}` : `${base}${path}`;
  const res = await fetch(url, { credentials: "include", headers: { "X-Hospital-Code": getHospitalCode() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Download failed.");
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 15000);
}

function ExportMenu({ onCsv, onExcel, onPdf, disabled }: { onCsv: () => void; onExcel: () => void; onPdf: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item: CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "8px 14px", background: "none", border: "none", fontSize: "12.5px", color: "#334155", cursor: "pointer" };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" style={disabledStyle(S.btn, !!disabled)} disabled={disabled} onClick={() => setOpen((v) => !v)}>⇪ Export ▾</button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "40px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "8px", boxShadow: "0 8px 24px rgba(15,23,42,0.12)", zIndex: 20, minWidth: "160px", padding: "4px 0" }}>
          <button type="button" style={item} onClick={() => { setOpen(false); onCsv(); }}>CSV (.csv)</button>
          <button type="button" style={item} onClick={() => { setOpen(false); onExcel(); }}>Excel (.xlsx)</button>
          <button type="button" style={item} onClick={() => { setOpen(false); onPdf(); }}>PDF report</button>
        </div>
      )}
    </div>
  );
}

function PanelHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
      <div>
        <h3 style={S.h3}>{title}</h3>
        <p style={S.muted}>{subtitle}</p>
      </div>
      {children && <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>{children}</div>}
    </div>
  );
}

function Donut({ completed, pending, notSent }: { completed: number; pending: number; notSent: number }) {
  const all = completed + pending + notSent;
  const cPct = all ? (completed / all) * 100 : 0;
  const pPct = all ? (pending / all) * 100 : 0;
  const rate = completed + pending ? Math.round((completed / (completed + pending)) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
      <div style={{ position: "relative", width: "96px", height: "96px", flexShrink: 0 }}>
        <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: all ? `conic-gradient(#10b981 0 ${cPct}%, #f59e0b ${cPct}% ${cPct + pPct}%, #cbd5e1 ${cPct + pPct}% 100%)` : "#e2e8f0" }} />
        <div style={{ position: "absolute", inset: "12px", borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>{rate}%</div>
      </div>
      <div style={{ fontSize: "12.5px", color: "#475569", display: "flex", flexDirection: "column", gap: "6px" }}>
        <span><span style={{ color: "#10b981" }}>●</span> Completed ({completed})</span>
        <span><span style={{ color: "#f59e0b" }}>●</span> Pending ({pending})</span>
        <span><span style={{ color: "#cbd5e1" }}>●</span> Not Sent ({notSent})</span>
      </div>
    </div>
  );
}

type ListFilters = { q: string; status: string; rating: string; template_id: string; date_from: string; date_to: string };
const EMPTY_FILTERS: ListFilters = { q: "", status: "", rating: "", template_id: "", date_from: "", date_to: "" };
const PAGE_SIZE = 50;

function useSurveyList(patientId: string | null, applied: ListFilters, refreshKey: number, setNotice: SetNotice) {
  const [items, setItems] = useState<SurveyRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: SurveyRequest[]; total: number }>(
        `/api/reach/surveys${buildQuery({ ...applied, patient_id: patientId, limit: PAGE_SIZE, offset })}`
      );
      setItems((prev) => (offset ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load surveys.");
    } finally {
      setLoading(false);
    }
  }, [applied, patientId, setNotice]);
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);
  return { items, total, loading, loadMore: () => void load(items.length) };
}

async function fetchAllSurveys(patientId: string | null, applied: ListFilters) {
  const res = await apiFetch<{ items: SurveyRequest[] }>(`/api/reach/surveys${buildQuery({ ...applied, patient_id: patientId, limit: 5000 })}`);
  return res.items;
}

function exportSurveysCsv(rows: SurveyRequest[], filename: string) {
  const cats = Array.from(new Set(rows.flatMap((r) => Object.keys(r.category_ratings || {})))).sort();
  downloadCsv(
    filename,
    ["Sl.No", "Patient Name", "UHID", "Phone", "Survey", "Doctor", "Department", "Status", "Sent On", "Submitted On", "Overall Rating", ...cats, "Comments", "Channel", "Recorded By"],
    rows.map((r, i) => [
      i + 1, r.patient_name, r.patient_id, r.phone, r.template_name, r.doctor_name, r.department, STATUS_META[r.status]?.label,
      r.sent_at ? fmtDateTime(r.sent_at) : "", r.submitted_at ? fmtDateTime(r.submitted_at) : "", r.overall_rating ?? "",
      ...cats.map((c) => r.category_ratings?.[c] ?? ""), r.comments, r.channel ? CHANNEL_LABELS[r.channel] : "", r.recorded_by,
    ])
  );
}

async function exportSurveysPdf(rows: SurveyRequest[], title: string, subtitle: string) {
  const sections: StandardPdfSection[] = [{
    title: "Survey Responses",
    headers: ["#", "Patient", "UHID", "Survey", "Status", "Submitted", "Overall", "Doctor", "Nursing", "Cleanliness", "Discharge", "Comments"],
    rows: rows.map((r, i) => [
      i + 1, r.patient_name, r.patient_id, r.template_name, STATUS_META[r.status]?.label, r.submitted_at ? fmtDateTime(r.submitted_at) : "—",
      fmtRating(r.overall_rating), ...TABLE_CATEGORIES.map((c) => fmtRating(r.category_ratings?.[c])), r.comments || "",
    ]),
  }];
  const { blob, filename } = await generatePDFBlob({ title, subtitle, filename: "Survey_Responses", sections });
  downloadPDF(blob, filename);
}

function FilterBar({ draft, setDraft, onApply, onClear, templates, showTemplate = true, showStatus = true, showRating = true }: {
  draft: ListFilters;
  setDraft: (f: ListFilters) => void;
  onApply: () => void;
  onClear: () => void;
  templates: SurveyTemplate[];
  showTemplate?: boolean;
  showStatus?: boolean;
  showRating?: boolean;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onApply(); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
      <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="Search responses by patient name, UHID, mobile, comments…" style={{ ...S.input, flex: "2 1 240px" }} />
      {showStatus && (
        <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} style={{ ...S.input, flex: "0 1 140px" }}>
          <option value="">All Status</option>
          {(Object.keys(STATUS_META) as RequestStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
      )}
      {showRating && (
        <select value={draft.rating} onChange={(e) => setDraft({ ...draft, rating: e.target.value })} style={{ ...S.input, flex: "0 1 140px" }}>
          <option value="">All Ratings</option>
          {["5", "4", "3", "2", "1"].map((r) => <option key={r} value={r}>{r} ★</option>)}
          <option value="high">4 ★ and above</option>
          <option value="low">2 ★ and below</option>
        </select>
      )}
      {showTemplate && (
        <select value={draft.template_id} onChange={(e) => setDraft({ ...draft, template_id: e.target.value })} style={{ ...S.input, flex: "0 1 180px" }}>
          <option value="">All Surveys</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <input type="date" value={draft.date_from} max={draft.date_to || undefined} onChange={(e) => setDraft({ ...draft, date_from: e.target.value })} style={{ ...S.input, flex: "0 1 140px" }} title="From date" />
      <span style={{ color: "#94a3b8", fontSize: "12px" }}>to</span>
      <input type="date" value={draft.date_to} min={draft.date_from || undefined} onChange={(e) => setDraft({ ...draft, date_to: e.target.value })} style={{ ...S.input, flex: "0 1 140px" }} title="To date" />
      <button type="submit" style={{ ...S.btnPrimary, background: "#10b981", borderColor: "#10b981" }}>Apply</button>
      <button type="button" style={S.btn} onClick={onClear}>Clear</button>
    </form>
  );
}

const toPatient = (r: SurveyRequest): Patient => ({ patient_id: r.patient_id, name: r.patient_name || r.patient_id, phone: r.phone || undefined });

/** Shared modal wiring for the responses and management panels. */
function useSurveyActions(onChanged: () => void) {
  const [sendQueue, setSendQueue] = useState<number[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [record, setRecord] = useState<{ patient: Patient | null; requestId: number | null } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const sentRef = useRef(false);
  return {
    sendQueue, setSendQueue, detailId, setDetailId, record, setRecord, newOpen, setNewOpen,
    sendModalProps: {
      requestId: sendQueue[0] ?? null,
      onSent: () => {
        sentRef.current = true;
        onChanged();
      },
      onClose: () => {
        // After a send, move on to the next queued survey; closing without sending stops the queue.
        setSendQueue((q) => (sentRef.current ? q.slice(1) : []));
        sentRef.current = false;
      },
    },
  };
}

// -------------------------------------------------------- survey responses --

export function SurveyResponsesPanel({
  setNotice, canWrite, patients, activePatient, context, refreshKey, onChanged,
}: {
  setNotice: SetNotice;
  canWrite: boolean;
  patients: Patient[];
  activePatient: Patient | null;
  context?: SurveyContext;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { templates } = useSurveyTemplates(setNotice);
  const [scopeAll, setScopeAll] = useState(!activePatient);
  const patientId = scopeAll ? null : activePatient?.patient_id || null;
  const [draft, setDraft] = useState<ListFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ListFilters>(EMPTY_FILTERS);
  const [localKey, setLocalKey] = useState(0);
  const changed = () => {
    setLocalKey((k) => k + 1);
    onChanged();
  };
  const { items, total, loading, loadMore } = useSurveyList(patientId, applied, refreshKey + localKey, setNotice);
  const [summary, setSummary] = useState<SurveySummary | null>(null);
  const actions = useSurveyActions(changed);

  useEffect(() => {
    apiFetch<SurveySummary>(`/api/reach/survey-summary${buildQuery({ patient_id: patientId })}`)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [patientId, refreshKey, localKey]);

  const scopeLabel = patientId ? activePatient && [activePatient.name, activePatient.last_name].filter(Boolean).join(" ") : "All patients";
  const exportRows = async (kind: "csv" | "xlsx" | "pdf") => {
    try {
      if (kind === "xlsx") {
        await downloadFromApi(`/api/reach/surveys/export.xlsx${buildQuery({ ...applied, patient_id: patientId })}`, `survey-responses-${todayIso()}.xlsx`);
        return;
      }
      const rows = await fetchAllSurveys(patientId, applied);
      if (!rows.length) {
        setNotice({ type: "info", message: "No survey responses to export for these filters." });
        return;
      }
      if (kind === "csv") exportSurveysCsv(rows, `survey-responses-${todayIso()}.csv`);
      else await exportSurveysPdf(rows, "Patient Survey Responses", `${scopeLabel} · ${applied.date_from || "all dates"} to ${applied.date_to || "today"}`);
    } catch (err) {
      setNotice({ type: "error", message: errorMessage(err, "Export failed.") });
    }
  };

  const cats = (summary?.categories || []).filter((c) => c.category !== "Suggestions").slice(0, 6);
  return (
    <div style={S.card}>
      <PanelHeader title="Survey Responses" subtitle={`Patient feedback received through WhatsApp (manual entry) · ${scopeLabel}`}>
        {canWrite && (
          <button type="button" style={S.btnPrimary} onClick={() => actions.setRecord({ patient: patientId ? activePatient : null, requestId: null })}>
            ⊕ Record Survey Response
          </button>
        )}
        {activePatient && (
          <button type="button" style={S.btn} onClick={() => setScopeAll((v) => !v)}>
            ☰ {scopeAll ? "This Patient Only" : "View All Responses"}
          </button>
        )}
        <ExportMenu onCsv={() => void exportRows("csv")} onExcel={() => void exportRows("xlsx")} onPdf={() => void exportRows("pdf")} />
      </PanelHeader>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        <div style={S.subCard}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155" }}>Overall Satisfaction</div>
          <div style={{ fontSize: "34px", fontWeight: 800, color: "#0f172a", margin: "8px 0 4px" }}>
            {fmtRating(summary?.avg_rating)}<span style={{ fontSize: "18px", color: "#475569" }}> / 5</span>
          </div>
          <Stars value={summary?.avg_rating} size={26} />
          <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>{summary?.responses || 0} response(s)</div>
        </div>
        <div style={S.subCard}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Responses by Category</div>
          {cats.length === 0 ? (
            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No ratings yet.</div>
          ) : cats.map((c, i) => (
            <div key={c.category} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 140px) 34px 1fr", alignItems: "center", gap: "8px", fontSize: "12.5px", color: "#475569", marginBottom: "8px" }}>
              <span>{c.category}</span>
              <strong style={{ color: "#0f172a" }}>{fmtRating(c.avg_rating)}</strong>
              <Bar value={c.avg_rating} color={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
            </div>
          ))}
        </div>
        <div style={S.subCard}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Response Rate</div>
          <Donut completed={summary?.completed || 0} pending={summary?.pending || 0} notSent={summary?.not_sent || 0} />
        </div>
      </div>

      <FilterBar draft={draft} setDraft={setDraft} onApply={() => setApplied({ ...draft })} onClear={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }} templates={templates} />

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Sl.No", "Patient Name", "UHID", "Survey", "Submitted On", "Overall Rating", ...TABLE_CATEGORIES, "Comments", "Status", "Actions"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => (
              <tr key={r.id}>
                <td style={S.td}>{i + 1}</td>
                <td style={{ ...S.td, fontWeight: 600, color: "#1e293b" }}>{r.patient_name || "—"}</td>
                <td style={{ ...S.td, fontSize: "11.5px", color: "#475569", whiteSpace: "nowrap" }}>{r.patient_id}</td>
                <td style={{ ...S.td, fontSize: "12px" }}>{r.template_name}</td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}>{r.submitted_at ? fmtDateTime(r.submitted_at) : <span style={{ color: "#94a3b8" }}>{r.sent_at ? `Sent ${fmtDate(r.sent_at)}` : "—"}</span>}</td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}>{r.overall_rating !== null ? <><span style={{ color: "#f59e0b" }}>★</span> {r.overall_rating}</> : "—"}</td>
                {TABLE_CATEGORIES.map((c) => <td key={c} style={S.td}>{r.category_ratings?.[c] ?? "—"}</td>)}
                <td style={{ ...S.td, maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.comments || ""}>{r.comments || "—"}</td>
                <td style={S.td}><StatusPill status={r.status} /></td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                  <button type="button" style={S.btnSmall} onClick={() => actions.setDetailId(r.id)}>👁 View</button>
                  {canWrite && r.status !== "COMPLETED" && r.status !== "CANCELLED" && (
                    <button type="button" style={{ ...S.btnSmall, marginLeft: "6px" }} onClick={() => actions.setRecord({ patient: toPatient(r), requestId: r.id })}>Record</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && (
          <EmptyState icon="💬" title="No survey responses found">
            {canWrite ? "Send a survey from Survey Management, or record feedback received from a patient." : "Try changing the filters."}
          </EmptyState>
        )}
        {loading && <div style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>}
        {!loading && items.length < total && (
          <div style={{ textAlign: "center", marginTop: "12px" }}>
            <button type="button" style={S.btn} onClick={loadMore}>Load more ({items.length} of {total})</button>
          </div>
        )}
      </div>

      <SurveyDetailModal requestId={actions.detailId} onClose={() => actions.setDetailId(null)} onChanged={changed} setNotice={setNotice} canWrite={canWrite}
        onSend={(id) => actions.setSendQueue([id])} onRecord={(r) => actions.setRecord({ patient: toPatient(r), requestId: r.id })} />
      <SendSurveyModal {...actions.sendModalProps} setNotice={setNotice} />
      <RecordSurveyResponseModal open={actions.record !== null} onClose={() => actions.setRecord(null)} onSaved={changed} setNotice={setNotice}
        patients={patients} presetPatient={actions.record?.patient || null} requestId={actions.record?.requestId || null}
        context={actions.record?.patient?.patient_id === activePatient?.patient_id ? context : undefined} />
    </div>
  );
}

// ------------------------------------------------------- survey management --

export function SurveyManagementPanel({
  setNotice, canWrite, patients, activePatient, context, refreshKey, onChanged,
}: {
  setNotice: SetNotice;
  canWrite: boolean;
  patients: Patient[];
  activePatient?: Patient | null;
  context?: SurveyContext;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { templates } = useSurveyTemplates(setNotice);
  const patientId = activePatient?.patient_id || null;
  const [draft, setDraft] = useState<ListFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ListFilters>(EMPTY_FILTERS);
  const [localKey, setLocalKey] = useState(0);
  const changed = () => {
    setLocalKey((k) => k + 1);
    onChanged();
  };
  const { items, total, loading, loadMore } = useSurveyList(patientId, applied, refreshKey + localKey, setNotice);
  const [summary, setSummary] = useState<SurveySummary | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmCancel, setConfirmCancel] = useState<SurveyRequest | null>(null);
  const actions = useSurveyActions(changed);

  useEffect(() => {
    apiFetch<SurveySummary>(`/api/reach/survey-summary${buildQuery({ patient_id: patientId })}`)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [patientId, refreshKey, localKey]);
  useEffect(() => setSelected([]), [items]);

  const setStatus = (status: string) => {
    const next = { ...applied, status };
    setDraft(next);
    setApplied(next);
  };

  const cancel = async () => {
    if (!confirmCancel) return;
    try {
      await apiFetch(`/api/reach/surveys/${confirmCancel.id}/cancel`, { method: "POST" });
      setNotice({ type: "success", message: "Survey cancelled." });
      changed();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not cancel the survey.");
    } finally {
      setConfirmCancel(null);
    }
  };

  const sendable = items.filter((r) => r.status === "NOT_SENT" || r.status === "PENDING");
  const exportRows = async (kind: "csv" | "xlsx" | "pdf") => {
    try {
      if (kind === "xlsx") {
        await downloadFromApi(`/api/reach/surveys/export.xlsx${buildQuery({ ...applied, patient_id: patientId })}`, `surveys-${todayIso()}.xlsx`);
        return;
      }
      const rows = await fetchAllSurveys(patientId, applied);
      if (!rows.length) return setNotice({ type: "info", message: "Nothing to export for these filters." });
      if (kind === "csv") exportSurveysCsv(rows, `surveys-${todayIso()}.csv`);
      else await exportSurveysPdf(rows, "Patient Survey Tracker", `${applied.status ? STATUS_META[applied.status as RequestStatus]?.label : "All statuses"} · ${applied.date_from || "all dates"} to ${applied.date_to || "today"}`);
    } catch (err) {
      setNotice({ type: "error", message: errorMessage(err, "Export failed.") });
    }
  };

  const kpis: { key: string; label: string; value: string | number; color: string; bg: string }[] = [
    { key: "NOT_SENT", label: "Not Sent", value: summary?.not_sent ?? 0, color: "#475569", bg: "#f8fafc" },
    { key: "PENDING", label: "Awaiting Reply", value: summary?.pending ?? 0, color: "#b45309", bg: "#fffbeb" },
    { key: "COMPLETED", label: "Completed", value: summary?.completed ?? 0, color: "#047857", bg: "#ecfdf5" },
    { key: "CANCELLED", label: "Cancelled", value: summary?.cancelled ?? 0, color: "#b91c1c", bg: "#fef2f2" },
    { key: "", label: "Response Rate", value: `${summary?.response_rate ?? 0}%`, color: "#1d4ed8", bg: "#eff6ff" },
  ];

  return (
    <div style={S.card}>
      <PanelHeader title="Survey Management" subtitle={patientId ? `Surveys for ${[activePatient?.name, activePatient?.last_name].filter(Boolean).join(" ")}` : "Queue surveys, send them on WhatsApp and track replies"}>
        {canWrite && <button type="button" style={S.btnPrimary} onClick={() => actions.setNewOpen(true)}>⊕ New Survey Request</button>}
        {canWrite && <button type="button" style={S.btn} onClick={() => actions.setRecord({ patient: activePatient || null, requestId: null })}>Record Survey Response</button>}
        <ExportMenu onCsv={() => void exportRows("csv")} onExcel={() => void exportRows("xlsx")} onPdf={() => void exportRows("pdf")} />
      </PanelHeader>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "16px" }}>
        {kpis.map((k) => {
          const active = k.key !== "" && applied.status === k.key;
          return (
            <button key={k.label} type="button" onClick={() => k.key !== "" && setStatus(active ? "" : k.key)}
              style={{ textAlign: "left", padding: "12px 14px", borderRadius: "10px", background: k.bg, border: active ? `1.5px solid ${k.color}` : "1px solid #e2e8f0", cursor: k.key ? "pointer" : "default" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>{k.label}</div>
              <div style={{ fontSize: "22px", fontWeight: 800, color: k.color }}>{k.value}</div>
            </button>
          );
        })}
      </div>

      <FilterBar draft={draft} setDraft={setDraft} onApply={() => setApplied({ ...draft })} onClear={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }} templates={templates} showRating={false} />

      {canWrite && selected.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: "8px", marginBottom: "10px", fontSize: "12.5px" }}>
          <strong style={{ color: "#0f766e" }}>{selected.length} selected</strong>
          <button type="button" style={S.btnWhatsApp} onClick={() => actions.setSendQueue(selected)}>Send one by one on WhatsApp</button>
          <button type="button" style={S.btn} onClick={() => setSelected([])}>Clear</button>
          <span style={{ color: "#64748b" }}>Each message opens in WhatsApp; the next one opens after you mark the current one sent.</span>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {canWrite && (
                <th style={{ ...S.th, width: "28px" }}>
                  <input type="checkbox" aria-label="Select all sendable"
                    checked={sendable.length > 0 && sendable.every((r) => selected.includes(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? sendable.map((r) => r.id) : [])} />
                </th>
              )}
              {["Patient", "Mobile", "Survey", "Doctor / Dept", "Status", "Queued On", "Last Sent", "Rating", "Actions"].map((h) => <th key={h} style={S.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const open = r.status === "NOT_SENT" || r.status === "PENDING";
              return (
                <tr key={r.id}>
                  {canWrite && (
                    <td style={S.td}>
                      {open && <input type="checkbox" checked={selected.includes(r.id)} onChange={() => setSelected((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id]))} />}
                    </td>
                  )}
                  <td style={S.td}>
                    <div style={{ fontWeight: 700, color: "#1e293b" }}>{r.patient_name || "—"}</div>
                    <div style={{ fontSize: "11.5px", color: "#00828a" }}>{r.patient_id}</div>
                  </td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>{r.phone || <span style={{ color: "#dc2626" }}>No mobile</span>}</td>
                  <td style={S.td}>{r.template_name}</td>
                  <td style={{ ...S.td, fontSize: "12px" }}>{r.doctor_name || "—"}{r.department ? <div style={{ color: "#64748b" }}>{r.department}</div> : null}</td>
                  <td style={S.td}><StatusPill status={r.status} /></td>
                  <td style={{ ...S.td, whiteSpace: "nowrap", fontSize: "12px" }}>{fmtDateTime(r.created_at)}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap", fontSize: "12px" }}>{r.sent_at ? <>{fmtDateTime(r.sent_at)}{r.send_count > 1 && <div style={{ color: "#64748b" }}>{r.send_count}× sent</div>}</> : "—"}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>{r.overall_rating !== null ? <><span style={{ color: "#f59e0b" }}>★</span> {r.overall_rating}</> : "—"}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {canWrite && open && (
                        <button type="button" style={{ ...S.btnSmall, background: "#25D366", borderColor: "#25D366", color: "#fff" }} onClick={() => actions.setSendQueue([r.id])}>
                          {r.status === "PENDING" ? "Resend" : "Send"}
                        </button>
                      )}
                      {canWrite && open && <button type="button" style={S.btnSmall} onClick={() => actions.setRecord({ patient: toPatient(r), requestId: r.id })}>Record</button>}
                      <button type="button" style={S.btnSmall} onClick={() => actions.setDetailId(r.id)}>View</button>
                      {canWrite && open && <button type="button" style={{ ...S.btnSmall, color: "#b91c1c" }} onClick={() => setConfirmCancel(r)} title="Cancel survey">✕</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && items.length === 0 && (
          <EmptyState icon="📨" title="No surveys yet">{canWrite ? "Use New Survey Request to queue a feedback survey for patients." : "Try changing the filters."}</EmptyState>
        )}
        {loading && <div style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>}
        {!loading && items.length < total && (
          <div style={{ textAlign: "center", marginTop: "12px" }}>
            <button type="button" style={S.btn} onClick={loadMore}>Load more ({items.length} of {total})</button>
          </div>
        )}
      </div>

      <NewSurveyRequestModal open={actions.newOpen} onClose={() => actions.setNewOpen(false)} setNotice={setNotice} patients={patients}
        presetPatient={activePatient || null} context={context}
        onCreated={(sendId) => { changed(); if (sendId) actions.setSendQueue([sendId]); }} />
      <SendSurveyModal {...actions.sendModalProps} setNotice={setNotice} />
      <SurveyDetailModal requestId={actions.detailId} onClose={() => actions.setDetailId(null)} onChanged={changed} setNotice={setNotice} canWrite={canWrite}
        onSend={(id) => actions.setSendQueue([id])} onRecord={(r) => actions.setRecord({ patient: toPatient(r), requestId: r.id })} />
      <RecordSurveyResponseModal open={actions.record !== null} onClose={() => actions.setRecord(null)} onSaved={changed} setNotice={setNotice}
        patients={patients} presetPatient={actions.record?.patient || null} requestId={actions.record?.requestId || null}
        context={activePatient && actions.record?.patient?.patient_id === activePatient.patient_id ? context : undefined} />
      <ConfirmDialog open={confirmCancel !== null} onClose={() => setConfirmCancel(null)} onConfirm={cancel}
        title="Cancel this survey?" description={confirmCancel ? `${confirmCancel.template_name} for ${confirmCancel.patient_name || confirmCancel.patient_id} will be marked cancelled.` : undefined}
        confirmLabel="Cancel Survey" cancelLabel="Keep" />
    </div>
  );
}

// -------------------------------------------------------- survey templates --

type DraftQuestion = SurveyQuestion & { key: string };
let draftKey = 0;
const newQuestion = (): DraftQuestion => ({ key: `q${++draftKey}`, question_text: "", question_type: "RATING", category: "", options: [], is_required: true });

function TemplateEditor({ template, onClose, onSaved, setNotice }: {
  template: SurveyTemplate | "new";
  onClose: () => void;
  onSaved: () => void;
  setNotice: SetNotice;
}) {
  const isNew = template === "new";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [surveyType, setSurveyType] = useState<SurveyType>("GENERAL");
  const [status, setStatus] = useState<TemplateStatus>("ACTIVE");
  const [questions, setQuestions] = useState<DraftQuestion[]>([newQuestion()]);
  const [responseCount, setResponseCount] = useState(0);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (template === "new") return;
    apiFetch<SurveyTemplate & { response_count: number }>(`/api/reach/survey-templates/${template.id}`)
      .then((t) => {
        setName(t.name);
        setDescription(t.description || "");
        setSurveyType(t.survey_type);
        setStatus(t.status);
        setResponseCount(t.response_count || 0);
        setQuestions((t.questions || []).map((q) => ({ ...q, category: q.category || "", key: `q${++draftKey}` })));
      })
      .catch((err) => {
        reportError(setNotice, err as { message?: string; status?: number }, "Unable to load survey.");
        onClose();
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (key: string, patch: Partial<DraftQuestion>) => setQuestions((qs) => qs.map((q) => (q.key === key ? { ...q, ...patch } : q)));
  const move = (idx: number, dir: -1 | 1) => setQuestions((qs) => {
    const next = [...qs];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return qs;
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const changeType = (q: DraftQuestion, type: QuestionType) => {
    const options = type === "SINGLE_CHOICE" || type === "MULTI_CHOICE" ? (q.options.length >= 2 && q.question_type !== "YES_NO" ? q.options : ["", ""]) : type === "YES_NO" ? ["Yes", "No"] : [];
    update(q.key, { question_type: type, options });
  };

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("Survey name is required.");
    if (questions.length === 0) return setError("Add at least one question.");
    for (const [i, q] of questions.entries()) {
      if (!q.question_text.trim()) return setError(`Question ${i + 1}: enter the question text.`);
      if ((q.question_type === "SINGLE_CHOICE" || q.question_type === "MULTI_CHOICE") && q.options.filter((o) => o.trim()).length < 2) {
        return setError(`Question ${i + 1}: add at least two answer options.`);
      }
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        name, description, survey_type: surveyType, status,
        questions: questions.map((q) => ({ id: q.id, question_text: q.question_text, question_type: q.question_type, category: q.category, options: q.options.filter((o) => o.trim()), is_required: q.is_required })),
      });
      if (template === "new") await apiFetch("/api/reach/survey-templates", { method: "POST", body });
      else await apiFetch(`/api/reach/survey-templates/${template.id}`, { method: "PUT", body });
      setNotice({ type: "success", message: `Survey "${name}" saved.` });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not save the survey."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isNew ? "Create Survey Template" : "Edit Survey Template"} description="Questions, answer options and categories used in feedback reports." className="ui-modal-wide">
      {loading ? (
        <div style={{ padding: "24px", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "12px" }}>
            <Field label="Survey name *"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} style={S.input} placeholder="e.g. IPD Discharge Feedback" /></Field>
            <Field label="Survey type">
              <select value={surveyType} onChange={(e) => setSurveyType(e.target.value as SurveyType)} style={S.input}>
                {(Object.keys(SURVEY_TYPE_LABELS) as SurveyType[]).map((t) => <option key={t} value={t}>{SURVEY_TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as TemplateStatus)} style={S.input}>
                {(Object.keys(TEMPLATE_STATUS_META) as TemplateStatus[]).map((t) => <option key={t} value={t}>{TEMPLATE_STATUS_META[t].label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} style={S.input} placeholder="When and to whom this survey is sent" /></Field>
          {responseCount > 0 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}>
              This survey already has {responseCount} response(s). Recorded answers keep the question text they were given with; edits apply to new responses.
            </div>
          )}

          <datalist id="reach-survey-categories">{STANDARD_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {questions.map((q, i) => (
              <div key={q.key} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 14px", background: "#fcfdfe" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <span style={{ fontWeight: 800, color: "#0f766e", paddingTop: "8px", minWidth: "22px" }}>{i + 1}.</span>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
                    <input value={q.question_text} onChange={(e) => update(q.key, { question_text: e.target.value })} maxLength={500} style={S.input} placeholder="Question text" />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", alignItems: "center" }}>
                      <select value={q.question_type} onChange={(e) => changeType(q, e.target.value as QuestionType)} style={S.input}>
                        {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => <option key={t} value={t}>{QUESTION_TYPE_LABELS[t]}</option>)}
                      </select>
                      <input list="reach-survey-categories" value={q.category || ""} onChange={(e) => update(q.key, { category: e.target.value })} maxLength={100} style={S.input} placeholder="Report category (e.g. Nursing Care)" />
                      <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px", whiteSpace: "nowrap" }}>
                        <input type="checkbox" checked={q.is_required} onChange={(e) => update(q.key, { is_required: e.target.checked })} /> Required
                      </label>
                    </div>
                    {(q.question_type === "SINGLE_CHOICE" || q.question_type === "MULTI_CHOICE") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingLeft: "4px" }}>
                        {q.options.map((o, j) => (
                          <div key={j} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                            <span style={{ fontSize: "12px", color: "#64748b", width: "18px" }}>{String.fromCharCode(97 + j)})</span>
                            <input value={o} onChange={(e) => update(q.key, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} maxLength={200} style={{ ...S.input, height: "32px" }} placeholder={`Option ${j + 1}`} />
                            <button type="button" style={S.btnSmall} disabled={q.options.length <= 2} onClick={() => update(q.key, { options: q.options.filter((_, k) => k !== j) })} title="Remove option">✕</button>
                          </div>
                        ))}
                        {q.options.length < 12 && (
                          <button type="button" style={{ ...S.btnSmall, alignSelf: "flex-start" }} onClick={() => update(q.key, { options: [...q.options, ""] })}>+ Add option</button>
                        )}
                      </div>
                    )}
                    {q.question_type === "RATING" && <div style={{ fontSize: "11.5px", color: "#64748b" }}>Patient answers 1 (Poor) to 5 (Excellent). Rating answers feed the category averages in reports.</div>}
                    {q.question_type === "YES_NO" && <div style={{ fontSize: "11.5px", color: "#64748b" }}>Answer options: Yes / No</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <button type="button" style={S.btnSmall} disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                    <button type="button" style={S.btnSmall} disabled={i === questions.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                    <button type="button" style={{ ...S.btnSmall, color: "#b91c1c" }} disabled={questions.length <= 1} onClick={() => setQuestions((qs) => qs.filter((x) => x.key !== q.key))} title="Delete question">🗑</button>
                  </div>
                </div>
              </div>
            ))}
            {questions.length < 50 && <button type="button" style={{ ...S.btn, alignSelf: "flex-start" }} onClick={() => setQuestions((qs) => [...qs, newQuestion()])}>+ Add Question</button>}
          </div>

          {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
            <button type="button" style={disabledStyle(S.btnPrimary, saving)} disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save Survey"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TemplatePreview({ templateId, onClose, setNotice }: { templateId: number; onClose: () => void; setNotice: SetNotice }) {
  const [tpl, setTpl] = useState<SurveyTemplate | null>(null);
  useEffect(() => {
    apiFetch<SurveyTemplate>(`/api/reach/survey-templates/${templateId}`).then(setTpl).catch((err) => {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load survey.");
      onClose();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);
  return (
    <Modal open onClose={onClose} title={tpl ? tpl.name : "Survey Preview"} description={tpl?.description || "Questions as they appear in the WhatsApp message."} className="ui-modal-wide">
      {!tpl ? <div style={{ padding: "24px", color: "#94a3b8" }}>Loading…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {(tpl.questions || []).map((q, i) => (
              <div key={q.id} style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}>
                <div style={{ fontWeight: 700, color: "#1e293b" }}>{i + 1}. {q.question_text}{q.is_required && <span style={{ color: "#dc2626" }}> *</span>}</div>
                <div style={{ color: "#64748b", marginTop: "2px" }}>{QUESTION_TYPE_LABELS[q.question_type]}{q.category ? ` · ${q.category}` : ""}{q.options.length ? ` · ${q.options.join(" / ")}` : ""}</div>
              </div>
            ))}
          </div>
          <div>
            <div style={S.label}>WhatsApp text for {"{survey_questions}"}</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "12px", fontSize: "12px", fontFamily: "inherit", color: "#14532d", maxHeight: "460px", overflowY: "auto" }}>
              {buildSurveyQuestionsText(tpl.questions || [])}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function SurveyTemplatesPanel({ setNotice, canWrite }: { setNotice: SetNotice; canWrite: boolean }) {
  const { templates, loading, reload } = useSurveyTemplates(setNotice);
  const [editing, setEditing] = useState<SurveyTemplate | "new" | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SurveyTemplate | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const act = async (fn: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await fn();
      setNotice({ type: "success", message: success });
      void reload();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, failure);
    }
  };

  const shown = templates.filter((t) => (!statusFilter || t.status === statusFilter) && (!query.trim() || `${t.name} ${t.description || ""}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div style={S.card}>
      <PanelHeader title="Survey Templates" subtitle="Survey questions, answer options and report categories">
        {canWrite && <button type="button" style={S.btnPrimary} onClick={() => setEditing("new")}>⊕ Create Survey</button>}
      </PanelHeader>
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search surveys…" style={{ ...S.input, flex: "1 1 240px" }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...S.input, flex: "0 1 160px" }}>
          <option value="">All statuses</option>
          {(Object.keys(TEMPLATE_STATUS_META) as TemplateStatus[]).map((s) => <option key={s} value={s}>{TEMPLATE_STATUS_META[s].label}</option>)}
        </select>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Survey", "Type", "Status", "Questions", "Responses", "Awaiting", "Avg Rating", "Last Updated", "Actions"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((t) => {
              const meta = TEMPLATE_STATUS_META[t.status];
              return (
                <tr key={t.id}>
                  <td style={S.td}>
                    <div style={{ fontWeight: 700, color: "#1e293b" }}>{t.name}</div>
                    {t.description && <div style={{ fontSize: "11.5px", color: "#64748b", maxWidth: "320px" }}>{t.description}</div>}
                  </td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>{SURVEY_TYPE_LABELS[t.survey_type]}</td>
                  <td style={S.td}><Pill label={meta.label} bg={meta.bg} color={meta.color} /></td>
                  <td style={S.td}>{t.question_count}</td>
                  <td style={S.td}>{t.response_count}</td>
                  <td style={S.td}>{t.open_count}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>{t.avg_rating !== null && t.avg_rating !== undefined ? <><span style={{ color: "#f59e0b" }}>★</span> {fmtRating(t.avg_rating)}</> : "—"}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap", fontSize: "12px" }}>{fmtDate(t.updated_at)}{t.updated_by ? <div style={{ color: "#64748b" }}>{t.updated_by}</div> : null}</td>
                  <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button type="button" style={S.btnSmall} onClick={() => setPreviewId(t.id)}>Preview</button>
                      {canWrite && <button type="button" style={S.btnSmall} onClick={() => setEditing(t)}>Edit</button>}
                      {canWrite && <button type="button" style={S.btnSmall} onClick={() => void act(() => apiFetch(`/api/reach/survey-templates/${t.id}/duplicate`, { method: "POST" }), `Copy of "${t.name}" created as a draft.`, "Could not duplicate the survey.")}>Duplicate</button>}
                      {canWrite && (
                        <button type="button" style={S.btnSmall} onClick={() => void act(
                          () => apiFetch(`/api/reach/survey-templates/${t.id}/status`, { method: "PUT", body: JSON.stringify({ status: t.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }) }),
                          `"${t.name}" ${t.status === "ACTIVE" ? "deactivated" : "activated"}.`, "Could not change the status.")}>
                          {t.status === "ACTIVE" ? "Deactivate" : "Activate"}
                        </button>
                      )}
                      {canWrite && <button type="button" style={{ ...S.btnSmall, color: "#b91c1c" }} onClick={() => setConfirmDelete(t)} title="Delete survey">🗑</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <EmptyState icon="📝" title="No survey templates">{canWrite ? "Create a survey to start collecting patient feedback." : ""}</EmptyState>}
        {loading && <div style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>}
      </div>
      {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} setNotice={setNotice} />}
      {previewId !== null && <TemplatePreview templateId={previewId} onClose={() => setPreviewId(null)} setNotice={setNotice} />}
      <ConfirmDialog open={confirmDelete !== null} onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const t = confirmDelete;
          setConfirmDelete(null);
          if (t) await act(() => apiFetch(`/api/reach/survey-templates/${t.id}`, { method: "DELETE" }), `"${t.name}" deleted.`, "Could not delete the survey.");
        }}
        title="Delete this survey template?"
        description={confirmDelete ? `"${confirmDelete.name}" will be removed from the list. Recorded responses stay in reports, and surveys not yet sent are cancelled.` : undefined}
        confirmLabel="Delete" />
    </div>
  );
}

// ------------------------------------------------------ whatsapp templates --

const SAMPLE_VALUES = {
  patient_name: "Kajal A", uhid: "PAT-20261028-0016", doctor_name: "Physician", department: "General Medicine",
  visit: "IPD - ADM-12", survey_name: "IPD Discharge Feedback",
  survey_questions: "1. How would you rate the nursing care?\n   Reply 1 to 5\n\n2. Would you recommend us?\n   Reply Yes or No",
};

function WhatsAppTemplateEditor({ template, hospitalName, onClose, onSaved, setNotice }: {
  template: WhatsAppTemplate | "new";
  hospitalName: string;
  onClose: () => void;
  onSaved: () => void;
  setNotice: SetNotice;
}) {
  const isNew = template === "new";
  const [name, setName] = useState(isNew ? "" : template.name);
  const [category, setCategory] = useState<WhatsAppCategory>(isNew ? "SURVEY" : template.category);
  const [body, setBody] = useState(isNew ? "Dear {patient_name},\n\n\n\n- {hospital_name}" : template.body);
  const [isActive, setIsActive] = useState(isNew ? true : template.is_active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const insert = (token: string) => {
    const el = ref.current;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("Template name is required.");
    if (!body.trim()) return setError("Message body is required.");
    setSaving(true);
    try {
      const payload = JSON.stringify({ name, category, body, is_active: isActive });
      if (template === "new") await apiFetch("/api/reach/whatsapp-templates", { method: "POST", body: payload });
      else await apiFetch(`/api/reach/whatsapp-templates/${template.id}`, { method: "PUT", body: payload });
      setNotice({ type: "success", message: `WhatsApp template "${name}" saved.` });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not save the template."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isNew ? "Create WhatsApp Template" : "Edit WhatsApp Template"} description="Placeholders are filled with the patient's details when the message is opened in WhatsApp." className="ui-modal-wide">
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: "12px", alignItems: "end" }}>
          <Field label="Template name *"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} style={S.input} /></Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as WhatsAppCategory)} style={S.input}>
              {(Object.keys(WHATSAPP_CATEGORY_LABELS) as WhatsAppCategory[]).map((c) => <option key={c} value={c}>{WHATSAPP_CATEGORY_LABELS[c]}</option>)}
            </select>
          </Field>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px", height: "36px" }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
          </label>
        </div>
        <div>
          <div style={S.label}>Insert placeholder</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {PLACEHOLDERS.map((p) => (
              <button key={p.key} type="button" style={{ ...S.btnSmall, fontFamily: "monospace" }} title={p.label} onClick={() => insert(p.key)}>{p.key}</button>
            ))}
          </div>
          {category === "SURVEY" || category === "REMINDER" ? (
            <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "4px" }}>Survey messages should include <code>{"{survey_questions}"}</code> so the patient can reply with answers.</div>
          ) : null}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "12px" }}>
          <Field label={`Message (${body.length}/4000)`}>
            <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} rows={16} maxLength={4000} style={{ ...S.textarea, fontFamily: "monospace", fontSize: "12.5px", minHeight: "300px" }} />
          </Field>
          <Field label="Preview (sample patient)">
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "12px", fontSize: "12.5px", fontFamily: "inherit", color: "#14532d", minHeight: "300px", boxSizing: "border-box" }}>
              {renderTemplate(body, { ...SAMPLE_VALUES, hospital_name: hospitalName })}
            </pre>
          </Field>
        </div>
        {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
          <button type="button" style={disabledStyle(S.btnPrimary, saving)} disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save Template"}</button>
        </div>
      </div>
    </Modal>
  );
}

export function WhatsAppTemplatesPanel({ setNotice, canWrite }: { setNotice: SetNotice; canWrite: boolean }) {
  const { templates, hospitalName, loading, reload } = useWhatsAppTemplates(setNotice);
  const [editing, setEditing] = useState<WhatsAppTemplate | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WhatsAppTemplate | null>(null);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");

  const act = async (fn: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await fn();
      setNotice({ type: "success", message: success });
      void reload();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, failure);
    }
  };

  const shown = templates.filter((t) => (!category || t.category === category) && (!query.trim() || `${t.name} ${t.body}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div style={S.card}>
      <PanelHeader title="WhatsApp Templates" subtitle="Reusable messages for surveys, reminders and follow-ups (sent manually through WhatsApp)">
        {canWrite && <button type="button" style={S.btnPrimary} onClick={() => setEditing("new")}>⊕ Create Template</button>}
      </PanelHeader>
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates…" style={{ ...S.input, flex: "1 1 240px" }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...S.input, flex: "0 1 180px" }}>
          <option value="">All categories</option>
          {(Object.keys(WHATSAPP_CATEGORY_LABELS) as WhatsAppCategory[]).map((c) => <option key={c} value={c}>{WHATSAPP_CATEGORY_LABELS[c]}</option>)}
        </select>
      </div>
      {loading && <div style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>}
      {!loading && shown.length === 0 && <EmptyState icon="💬" title="No WhatsApp templates">{canWrite ? "Create a template to reuse messages." : ""}</EmptyState>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px" }}>
        {shown.map((t) => (
          <div key={t.id} style={{ ...S.subCard, display: "flex", flexDirection: "column", gap: "8px", opacity: t.is_active ? 1 : 0.7 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 800, color: "#0f172a", fontSize: "14px" }}>{t.name}</div>
                <div style={{ fontSize: "11.5px", color: "#64748b" }}>Updated {fmtDate(t.updated_at)}{t.updated_by ? ` by ${t.updated_by}` : ""}</div>
              </div>
              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Pill label={WHATSAPP_CATEGORY_LABELS[t.category]} bg="#ecfeff" color="#0e7490" />
                <Pill label={t.is_active ? "Active" : "Inactive"} bg={t.is_active ? "#ecfdf5" : "#f1f5f9"} color={t.is_active ? "#047857" : "#64748b"} />
              </div>
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", background: "#f8fafc", border: "1px solid #f1f5f9", borderRadius: "8px", padding: "10px", fontSize: "12px", fontFamily: "inherit", color: "#475569", maxHeight: "160px", overflow: "hidden" }}>{t.body}</pre>
            {canWrite && (
              <div style={{ display: "flex", gap: "6px", marginTop: "auto" }}>
                <button type="button" style={S.btnSmall} onClick={() => setEditing(t)}>Edit</button>
                <button type="button" style={S.btnSmall} onClick={() => void act(
                  () => apiFetch(`/api/reach/whatsapp-templates/${t.id}`, { method: "PUT", body: JSON.stringify({ ...t, is_active: !t.is_active }) }),
                  `"${t.name}" ${t.is_active ? "deactivated" : "activated"}.`, "Could not update the template.")}>
                  {t.is_active ? "Deactivate" : "Activate"}
                </button>
                <button type="button" style={S.btnSmall} onClick={() => void act(
                  () => apiFetch("/api/reach/whatsapp-templates", { method: "POST", body: JSON.stringify({ ...t, name: `${t.name} (Copy)`.slice(0, 200) }) }),
                  `Copy of "${t.name}" created.`, "Could not duplicate the template.")}>
                  Duplicate
                </button>
                <button type="button" style={{ ...S.btnSmall, color: "#b91c1c", marginLeft: "auto" }} onClick={() => setConfirmDelete(t)}>🗑</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {editing && <WhatsAppTemplateEditor template={editing} hospitalName={hospitalName} onClose={() => setEditing(null)} onSaved={() => void reload()} setNotice={setNotice} />}
      <ConfirmDialog open={confirmDelete !== null} onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const t = confirmDelete;
          setConfirmDelete(null);
          if (t) await act(() => apiFetch(`/api/reach/whatsapp-templates/${t.id}`, { method: "DELETE" }), `"${t.name}" deleted.`, "Could not delete the template.");
        }}
        title="Delete this WhatsApp template?" description={confirmDelete ? `"${confirmDelete.name}" will no longer be available when sending messages.` : undefined} confirmLabel="Delete" />
    </div>
  );
}

// ----------------------------------------------------------- survey reports --

type GroupRow = { label: string; responses: number; avg_rating: number | null; low_count: number };
type ReportResponseRow = {
  response_id: number; request_id: number | null; patient_id: string; patient_name: string; phone: string | null; template_name: string;
  doctor_name: string | null; department: string | null; overall_rating: number; comments: string | null; channel: string; submitted_at: string;
};
type SurveyReport = {
  summary: {
    responses: number; avg_rating: number | null; promoters: number; passives: number; detractors: number; with_comments: number;
    satisfaction_pct: number; nps: number | null; response_rate: number; status_counts: Record<RequestStatus, number>;
  };
  rating_distribution: { rating: number; count: number }[];
  categories: { category: string; avg_rating: number; answers: number; low_count: number }[];
  daily: { day: string; responses: number; avg_rating: number | null }[];
  by_doctor: GroupRow[];
  by_department: GroupRow[];
  by_template: GroupRow[];
  questions: {
    question_id: number | null; template_name: string; question_text: string; question_type: QuestionType; category: string | null;
    answers: number; avg_rating: number | null; options: { option: string; count: number }[];
    rating_distribution: { rating: number; count: number }[]; text_answers: { answer: string; submitted_at: string; patient_name: string }[];
  }[];
  low_ratings: ReportResponseRow[];
  comments: ReportResponseRow[];
  filter_options: { doctors: string[]; departments: string[] };
};

function GroupTable({ title, rows }: { title: string; rows: GroupRow[] }) {
  return (
    <div style={S.subCard}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "8px" }}>{title}</div>
      {rows.length === 0 ? <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No data.</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Name", "Responses", "Avg", "Low (≤2)"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={S.td}>{r.label}</td>
                <td style={S.td}>{r.responses}</td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}><span style={{ color: "#f59e0b" }}>★</span> {fmtRating(r.avg_rating)}</td>
                <td style={{ ...S.td, color: r.low_count ? "#b91c1c" : "#334155", fontWeight: r.low_count ? 700 : 400 }}>{r.low_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TrendChart({ daily }: { daily: SurveyReport["daily"] }) {
  if (daily.length === 0) return <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No responses in this period.</div>;
  const max = Math.max(...daily.map((d) => d.responses), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "150px", overflowX: "auto", paddingBottom: "22px", position: "relative" }}>
      {daily.map((d) => (
        <div key={d.day} title={`${fmtDate(d.day)}: ${d.responses} response(s), avg ${fmtRating(d.avg_rating)}`}
          style={{ flex: "1 0 18px", maxWidth: "40px", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", height: "100%", justifyContent: "flex-end", position: "relative" }}>
          <span style={{ fontSize: "10px", color: "#64748b" }}>{d.responses}</span>
          <div style={{ width: "100%", height: `${(d.responses / max) * 100}%`, minHeight: "3px", borderRadius: "4px 4px 0 0", background: (d.avg_rating ?? 0) >= 4 ? "#10b981" : (d.avg_rating ?? 0) >= 3 ? "#f59e0b" : "#ef4444" }} />
          <span style={{ position: "absolute", bottom: "-20px", fontSize: "9.5px", color: "#94a3b8", whiteSpace: "nowrap" }}>{d.day.slice(8, 10)}/{d.day.slice(5, 7)}</span>
        </div>
      ))}
    </div>
  );
}

export function SurveyReportsPanel({ setNotice }: { setNotice: SetNotice }) {
  const { templates } = useSurveyTemplates(setNotice);
  const initial = { date_from: monthStartIso(), date_to: todayIso(), template_id: "", survey_type: "", doctor: "", department: "" };
  const [draft, setDraft] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [report, setReport] = useState<SurveyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiFetch<SurveyReport>(`/api/reach/survey-reports${buildQuery(applied)}`)
      .then((r) => alive && setReport(r))
      .catch((err) => alive && reportError(setNotice, err as { message?: string; status?: number }, "Unable to load the survey report."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [applied, setNotice]);

  const period = `${fmtDate(applied.date_from)} – ${fmtDate(applied.date_to)}`;
  const tplName = templates.find((t) => String(t.id) === applied.template_id)?.name;
  const filterText = [period, tplName, applied.survey_type && SURVEY_TYPE_LABELS[applied.survey_type as SurveyType], applied.doctor, applied.department].filter(Boolean).join(" · ");

  const reportSections = (r: SurveyReport): StandardPdfSection[] => [
    {
      title: "Summary",
      headers: ["Metric", "Value"],
      rows: [
        ["Responses", r.summary.responses], ["Average rating", `${fmtRating(r.summary.avg_rating)} / 5`],
        ["Satisfied (4-5 ★)", `${r.summary.promoters} (${r.summary.satisfaction_pct}%)`], ["Neutral (3 ★)", r.summary.passives],
        ["Dissatisfied (1-2 ★)", r.summary.detractors], ["Net satisfaction score", r.summary.nps ?? "—"],
        ["Response rate", `${r.summary.response_rate}%`], ["Surveys awaiting reply", r.summary.status_counts.PENDING],
        ["Surveys not sent", r.summary.status_counts.NOT_SENT],
      ],
    },
    { title: "Rating Distribution", headers: ["Rating", "Responses"], rows: r.rating_distribution.map((d) => [`${d.rating} ★`, d.count]) },
    { title: "Category Ratings", headers: ["Category", "Average", "Answers", "Low (≤2)"], rows: r.categories.map((c) => [c.category, fmtRating(c.avg_rating), c.answers, c.low_count]) },
    { title: "By Doctor", headers: ["Doctor", "Responses", "Average", "Low (≤2)"], rows: r.by_doctor.map((g) => [g.label, g.responses, fmtRating(g.avg_rating), g.low_count]) },
    { title: "By Department", headers: ["Department", "Responses", "Average", "Low (≤2)"], rows: r.by_department.map((g) => [g.label, g.responses, fmtRating(g.avg_rating), g.low_count]) },
    { title: "By Survey", headers: ["Survey", "Responses", "Average", "Low (≤2)"], rows: r.by_template.map((g) => [g.label, g.responses, fmtRating(g.avg_rating), g.low_count]) },
    {
      title: "Question-wise Results",
      headers: ["Survey", "Question", "Type", "Answers", "Result"],
      rows: r.questions.map((q) => [q.template_name, q.question_text, QUESTION_TYPE_LABELS[q.question_type], q.answers,
        q.question_type === "RATING" ? `Avg ${fmtRating(q.avg_rating)}` : q.question_type === "TEXT" ? `${q.text_answers.length} comment(s)` : q.options.map((o) => `${o.option}: ${o.count}`).join(", ")]),
    },
    {
      title: "Low Ratings (≤2 ★)",
      headers: ["Submitted", "Patient", "UHID", "Survey", "Doctor", "Rating", "Comments"],
      rows: r.low_ratings.map((x) => [fmtDateTime(x.submitted_at), x.patient_name, x.patient_id, x.template_name, x.doctor_name || "—", x.overall_rating, x.comments || ""]),
    },
    {
      title: "Recent Comments",
      headers: ["Submitted", "Patient", "Rating", "Comments"],
      rows: r.comments.map((x) => [fmtDateTime(x.submitted_at), x.patient_name, x.overall_rating, x.comments || ""]),
    },
  ];

  const exportReport = async (kind: "csv" | "xlsx" | "pdf") => {
    if (!report) return;
    try {
      if (kind === "xlsx") {
        await downloadFromApi(`/api/reach/surveys/export.xlsx${buildQuery({ status: "COMPLETED", template_id: applied.template_id, survey_type: applied.survey_type, date_from: applied.date_from, date_to: applied.date_to })}`,
          `survey-report-responses-${todayIso()}.xlsx`);
        return;
      }
      const sections = reportSections(report);
      if (kind === "csv") {
        const rows: (string | number | null | undefined)[][] = [];
        sections.forEach((s) => {
          rows.push([s.title]);
          rows.push(s.headers);
          s.rows.forEach((r) => rows.push(r));
          rows.push([]);
        });
        downloadCsv(`survey-report-${todayIso()}.csv`, [`Patient Survey Report · ${filterText}`], rows);
      } else {
        const { blob, filename } = await generatePDFBlob({ title: "Patient Survey Report", subtitle: filterText, filename: "Patient_Survey_Report", sections });
        downloadPDF(blob, filename);
      }
    } catch (err) {
      setNotice({ type: "error", message: errorMessage(err, "Export failed.") });
    }
  };

  const s = report?.summary;
  const maxDist = Math.max(...(report?.rating_distribution || []).map((d) => d.count), 1);
  const kpis = s ? [
    { label: "Responses", value: s.responses, color: "#059669" },
    { label: "Average Rating", value: `${fmtRating(s.avg_rating)} / 5`, color: "#7c3aed" },
    { label: "Satisfied (4-5 ★)", value: `${s.satisfaction_pct}%`, color: "#2563eb" },
    { label: "Net Satisfaction", value: s.nps ?? "—", color: "#0f766e", hint: "% satisfied minus % dissatisfied" },
    { label: "Response Rate", value: `${s.response_rate}%`, color: "#d97706" },
    { label: "Low Ratings (≤2 ★)", value: s.detractors, color: "#dc2626" },
  ] : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={S.card}>
        <PanelHeader title="Survey Reports" subtitle={`Detailed patient feedback · ${filterText}`}>
          <ExportMenu disabled={!report} onCsv={() => void exportReport("csv")} onExcel={() => void exportReport("xlsx")} onPdf={() => void exportReport("pdf")} />
        </PanelHeader>
        <form onSubmit={(e) => { e.preventDefault(); setApplied({ ...draft }); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="From"><input type="date" value={draft.date_from} max={draft.date_to || undefined} onChange={(e) => setDraft({ ...draft, date_from: e.target.value })} style={{ ...S.input, width: "150px" }} /></Field>
          <Field label="To"><input type="date" value={draft.date_to} min={draft.date_from || undefined} onChange={(e) => setDraft({ ...draft, date_to: e.target.value })} style={{ ...S.input, width: "150px" }} /></Field>
          <Field label="Survey">
            <select value={draft.template_id} onChange={(e) => setDraft({ ...draft, template_id: e.target.value })} style={{ ...S.input, width: "190px" }}>
              <option value="">All surveys</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={draft.survey_type} onChange={(e) => setDraft({ ...draft, survey_type: e.target.value })} style={{ ...S.input, width: "150px" }}>
              <option value="">All types</option>
              {(Object.keys(SURVEY_TYPE_LABELS) as SurveyType[]).map((t) => <option key={t} value={t}>{SURVEY_TYPE_LABELS[t]}</option>)}
            </select>
          </Field>
          <Field label="Doctor">
            <select value={draft.doctor} onChange={(e) => setDraft({ ...draft, doctor: e.target.value })} style={{ ...S.input, width: "170px" }}>
              <option value="">All doctors</option>
              {(report?.filter_options.doctors || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Department">
            <select value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} style={{ ...S.input, width: "170px" }}>
              <option value="">All departments</option>
              {(report?.filter_options.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <button type="submit" style={{ ...S.btnPrimary, background: "#10b981", borderColor: "#10b981" }}>Apply</button>
          <button type="button" style={S.btn} onClick={() => { setDraft(initial); setApplied(initial); }}>Reset</button>
        </form>
      </div>

      {loading && !report && <div style={{ ...S.card, color: "#94a3b8", fontSize: "13px" }}>Loading report…</div>}
      {report && s && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", opacity: loading ? 0.6 : 1 }}>
            {kpis.map((k) => (
              <div key={k.label} style={{ ...S.subCard, padding: "14px 16px" }} title={k.hint}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>{k.label}</div>
                <div style={{ fontSize: "24px", fontWeight: 800, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
            <div style={S.subCard}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Rating Distribution</div>
              {report.rating_distribution.map((d) => (
                <div key={d.rating} style={{ display: "grid", gridTemplateColumns: "40px 1fr 40px", gap: "8px", alignItems: "center", fontSize: "12.5px", marginBottom: "8px" }}>
                  <span style={{ color: "#475569" }}>{d.rating} ★</span>
                  <Bar value={d.count} max={maxDist} color={d.rating >= 4 ? "#10b981" : d.rating === 3 ? "#f59e0b" : "#ef4444"} />
                  <strong style={{ textAlign: "right" }}>{d.count}</strong>
                </div>
              ))}
            </div>
            <div style={S.subCard}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Category Ratings</div>
              {report.categories.length === 0 ? <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No rating answers.</div> : report.categories.map((c, i) => (
                <div key={c.category} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 150px) 34px 1fr", gap: "8px", alignItems: "center", fontSize: "12.5px", marginBottom: "8px" }} title={`${c.answers} answers, ${c.low_count} low`}>
                  <span style={{ color: "#475569" }}>{c.category}</span>
                  <strong>{fmtRating(c.avg_rating)}</strong>
                  <Bar value={c.avg_rating} color={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                </div>
              ))}
            </div>
            <div style={S.subCard}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Survey Status (sent in period)</div>
              <Donut completed={s.status_counts.COMPLETED} pending={s.status_counts.PENDING} notSent={s.status_counts.NOT_SENT} />
              {s.status_counts.CANCELLED > 0 && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "8px" }}>{s.status_counts.CANCELLED} cancelled</div>}
            </div>
          </div>

          <div style={S.subCard}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>Daily Responses <span style={{ fontWeight: 500, color: "#64748b" }}>(bar colour = average rating)</span></div>
            <TrendChart daily={report.daily} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
            <GroupTable title="By Doctor" rows={report.by_doctor} />
            <GroupTable title="By Department" rows={report.by_department} />
            <GroupTable title="By Survey" rows={report.by_template} />
          </div>

          <div style={S.card}>
            <h3 style={{ ...S.h3, fontSize: "16px", marginBottom: "12px" }}>Question-wise Results</h3>
            {report.questions.length === 0 ? <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No answers in this period.</div> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "12px" }}>
                {report.questions.map((q, idx) => {
                  const maxOpt = Math.max(...q.options.map((o) => o.count), ...q.rating_distribution.map((o) => o.count), 1);
                  return (
                    <div key={`${q.question_id ?? q.question_text}-${idx}`} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 14px" }}>
                      <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "2px" }}>{q.template_name}{q.category ? ` · ${q.category}` : ""}</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "8px" }}>{q.question_text}</div>
                      <div style={{ fontSize: "11.5px", color: "#64748b", marginBottom: "8px" }}>{QUESTION_TYPE_LABELS[q.question_type]} · {q.answers} answer(s){q.avg_rating !== null ? ` · avg ${fmtRating(q.avg_rating)}` : ""}</div>
                      {q.question_type === "RATING" && q.rating_distribution.map((d) => (
                        <div key={d.rating} style={{ display: "grid", gridTemplateColumns: "34px 1fr 30px", gap: "6px", alignItems: "center", fontSize: "12px", marginBottom: "4px" }}>
                          <span>{d.rating} ★</span><Bar value={d.count} max={maxOpt} color="#f59e0b" /><span style={{ textAlign: "right" }}>{d.count}</span>
                        </div>
                      ))}
                      {q.options.length > 0 && q.options.map((o) => (
                        <div key={o.option} style={{ display: "grid", gridTemplateColumns: "minmax(80px, 140px) 1fr 30px", gap: "6px", alignItems: "center", fontSize: "12px", marginBottom: "4px" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.option}>{o.option}</span>
                          <Bar value={o.count} max={maxOpt} color="#3b82f6" /><span style={{ textAlign: "right" }}>{o.count}</span>
                        </div>
                      ))}
                      {q.question_type === "TEXT" && (q.text_answers.length === 0 ? <div style={{ fontSize: "12px", color: "#94a3b8" }}>No text answers.</div> : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "160px", overflowY: "auto" }}>
                          {q.text_answers.map((t, i) => (
                            <div key={i} style={{ fontSize: "12px", background: "#f8fafc", borderRadius: "6px", padding: "6px 8px" }}>
                              “{t.answer}” <span style={{ color: "#94a3b8" }}>— {t.patient_name}, {fmtDate(t.submitted_at)}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }}>
            {([["Low Ratings (≤2 ★) - needs follow-up", report.low_ratings, "🎉", "No low ratings in this period."], ["Recent Comments", report.comments, "💬", "No comments in this period."]] as const).map(([title, rows, icon, empty]) => (
              <div key={title} style={S.card}>
                <h3 style={{ ...S.h3, fontSize: "16px", marginBottom: "10px" }}>{title}</h3>
                {rows.length === 0 ? <EmptyState icon={icon} title={empty} /> : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "420px", overflowY: "auto" }}>
                    {rows.map((r) => (
                      <div key={r.response_id} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "10px 12px", fontSize: "12.5px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
                          <strong style={{ color: "#1e293b" }}>{r.patient_name} <span style={{ color: "#00828a", fontWeight: 600 }}>{r.patient_id}</span></strong>
                          <Stars value={r.overall_rating} size={14} />
                        </div>
                        <div style={{ color: "#64748b", fontSize: "11.5px", margin: "2px 0 4px" }}>{fmtDateTime(r.submitted_at)} · {r.template_name}{r.doctor_name ? ` · ${r.doctor_name}` : ""}{r.phone ? ` · ${r.phone}` : ""}</div>
                        {r.comments && <div style={{ color: "#334155" }}>{r.comments}</div>}
                        {r.request_id && <button type="button" style={{ ...S.btnSmall, marginTop: "6px" }} onClick={() => setDetailId(r.request_id)}>View response</button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <SurveyDetailModal requestId={detailId} onClose={() => setDetailId(null)} onChanged={() => setApplied((a) => ({ ...a }))} setNotice={setNotice} canWrite={false}
        onSend={() => undefined} onRecord={() => undefined} />
    </div>
  );
}
