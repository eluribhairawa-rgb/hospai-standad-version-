import { useEffect, useMemo, useState } from "react";
import PhoneInput from "../../components/PhoneInput";
import { formatPhone, splitStoredPhone } from "../../lib/phone";
import Modal from "../../components/ui/Modal";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { apiFetch, reportError } from "../../lib/api";
import { printViaIframe } from "../../lib/printViaIframe";
import type { Patient } from "../../types";
import {
  CHANNEL_LABELS, Field, Pill, QUESTION_TYPE_LABELS, RatingInput, S, Stars, StatusPill, WHATSAPP_CATEGORY_LABELS,
  buildQuery, buildSurveyQuestionsText, disabledStyle, errorMessage, fmtDateTime, fmtRating, nowLocalInput, openWhatsApp,
  patientFullName, renderTemplate, useSurveyTemplates, useWhatsAppTemplates,
} from "./surveyCommon";
import type { Channel, SetNotice, SurveyContext, SurveyQuestion, SurveyRequest, SurveyTemplate } from "./surveyCommon";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// ------------------------------------------------------------ patient picker --

function PatientPicker({
  patients, selected, onChange, multi,
}: { patients: Patient[]; selected: string[]; onChange: (ids: string[]) => void; multi: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ip" | "op" | "phone">("phone");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return patients.filter((p) => {
      if (filter === "ip" && !p.is_inpatient) return false;
      if (filter === "op" && p.is_inpatient) return false;
      if (filter === "phone" && !(p.phone || p.family_mobile)) return false;
      if (!q) return true;
      return [patientFullName(p), p.patient_id, p.phone, p.latest_doctor_name].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }, [patients, query, filter]);
  const toggle = (pid: string) => {
    if (!multi) return onChange([pid]);
    onChange(selected.includes(pid) ? selected.filter((x) => x !== pid) : [...selected, pid]);
  };
  const shown = filtered.slice(0, 200);
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: "10px", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: "8px", padding: "8px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, UHID, mobile…" style={{ ...S.input, flex: 1, minWidth: "160px" }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ ...S.input, width: "150px" }}>
          <option value="phone">With mobile</option>
          <option value="all">All patients</option>
          <option value="ip">Inpatients</option>
          <option value="op">Outpatients</option>
        </select>
        {multi && (
          <button type="button" style={S.btn} onClick={() => onChange(Array.from(new Set([...selected, ...shown.map((p) => p.patient_id)])))}>
            Select shown ({shown.length})
          </button>
        )}
        {multi && selected.length > 0 && (
          <button type="button" style={S.btn} onClick={() => onChange([])}>Clear</button>
        )}
      </div>
      <div style={{ maxHeight: "220px", overflowY: "auto" }}>
        {shown.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "12.5px", color: "#94a3b8", textAlign: "center" }}>No patients match.</div>
        ) : (
          shown.map((p) => {
            const checked = selected.includes(p.patient_id);
            return (
              <label key={p.patient_id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 12px", borderTop: "1px solid #f1f5f9", cursor: "pointer", background: checked ? "#f0fdfa" : "#fff", fontSize: "12.5px" }}>
                <input type={multi ? "checkbox" : "radio"} checked={checked} onChange={() => toggle(p.patient_id)} />
                <span style={{ fontWeight: 700, color: "#1e293b", minWidth: "120px" }}>{patientFullName(p)}</span>
                <span style={{ color: "#00828a", fontWeight: 600 }}>{p.patient_id}</span>
                <span style={{ color: "#64748b" }}>{p.phone || p.family_mobile || "No mobile"}</span>
                <span style={{ marginLeft: "auto", fontSize: "11px", fontWeight: 700, color: p.is_inpatient ? "#0369a1" : "#475569" }}>{p.is_inpatient ? "IPD" : "OPD"}</span>
              </label>
            );
          })
        )}
      </div>
      {filtered.length > shown.length && (
        <div style={{ padding: "6px 12px", fontSize: "11.5px", color: "#94a3b8", borderTop: "1px solid #f1f5f9" }}>
          Showing first {shown.length} of {filtered.length}. Refine the search to see more.
        </div>
      )}
      {multi && (
        <div style={{ padding: "6px 12px", fontSize: "12px", fontWeight: 700, color: "#0f766e", borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
          {selected.length} patient{selected.length === 1 ? "" : "s"} selected
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- send survey --

export function SendSurveyModal({ requestId, onClose, onSent, setNotice }: {
  requestId: number | null;
  onClose: () => void;
  onSent: () => void;
  setNotice: SetNotice;
}) {
  const { templates: waTemplates, hospitalName } = useWhatsAppTemplates(setNotice, true);
  const [request, setRequest] = useState<SurveyRequest | null>(null);
  const [waTemplateId, setWaTemplateId] = useState<number | "">("");
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("+91");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    setRequest(null);
    apiFetch<SurveyRequest>(`/api/reach/surveys/${requestId}`)
      .then((req) => {
        setRequest(req);
        const stored = splitStoredPhone(req.phone, (req as { patient_phone_country_code?: string | null }).patient_phone_country_code);
        setPhone(stored.value);
        setPhoneCode(stored.countryCode);
      })
      .catch((err) => {
        reportError(setNotice, err as { message?: string; status?: number }, "Unable to load survey.");
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  // Pick a default template once both the request and templates are loaded.
  useEffect(() => {
    if (!request || waTemplateId !== "" || waTemplates.length === 0) return;
    const preferred =
      waTemplates.find((t) => t.id === request.whatsapp_template_id) ||
      waTemplates.find((t) => t.category === (request.send_count > 0 ? "REMINDER" : "SURVEY")) ||
      waTemplates.find((t) => t.category === "SURVEY") ||
      waTemplates[0];
    setWaTemplateId(preferred.id);
  }, [request, waTemplates, waTemplateId]);

  useEffect(() => {
    if (!request) return;
    const tpl = waTemplates.find((t) => t.id === waTemplateId);
    if (!tpl) return;
    setMessage(renderTemplate(tpl.body, {
      patient_name: request.patient_name || request.patient_id,
      uhid: request.patient_id,
      doctor_name: request.doctor_name,
      department: request.department,
      visit: request.encounter_label,
      survey_name: request.template_name,
      survey_questions: buildSurveyQuestionsText(request.questions || []),
      hospital_name: hospitalName,
    }));
  }, [request, waTemplateId, waTemplates, hospitalName]);

  const markSent = async (launch: boolean) => {
    if (!request || !message.trim()) return;
    if (launch) openWhatsApp(formatPhone(phoneCode, phone), message);
    setSaving(true);
    try {
      await apiFetch(`/api/reach/surveys/${request.id}/mark-sent`, {
        method: "POST",
        body: JSON.stringify({
          message, phone: formatPhone(phoneCode, phone), whatsapp_template_id: waTemplateId || null,
          template_name: waTemplates.find((t) => t.id === waTemplateId)?.name || null,
        }),
      });
      setNotice({ type: "success", message: launch ? `WhatsApp opened for ${request.patient_name || request.patient_id}. Survey marked as sent.` : "Survey marked as sent." });
      onSent();
      onClose();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not update the survey status.");
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setNotice({ type: "success", message: "Survey message copied to clipboard." });
    } catch {
      setNotice({ type: "warning", message: "Failed to copy message. Please copy manually." });
    }
  };

  return (
    <Modal open={requestId !== null} onClose={onClose} title={request?.send_count ? "Resend Survey on WhatsApp" : "Send Survey on WhatsApp"}
      description="Opens WhatsApp with the message ready to send. Replies are entered with Record Survey Response." className="ui-modal-wide">
      {!request ? (
        <div style={{ padding: "24px", color: "#94a3b8", fontSize: "13px" }}>Loading survey…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)", gap: "16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ ...S.subCard, padding: "12px 14px", background: "#f8fafc" }}>
              <div style={{ fontWeight: 800, color: "#0f172a", fontSize: "14px" }}>{request.patient_name || request.patient_id}</div>
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>{request.patient_id} · {request.template_name}</div>
              <div style={{ marginTop: "6px", display: "flex", gap: "6px", alignItems: "center" }}>
                <StatusPill status={request.status} />
                {request.send_count > 0 && <span style={{ fontSize: "11.5px", color: "#64748b" }}>Sent {request.send_count}× · last {fmtDateTime(request.sent_at)}</span>}
              </div>
            </div>
            <Field label="WhatsApp number">
              <PhoneInput countryCode={phoneCode} value={phone} onChange={({ countryCode, value }) => { setPhoneCode(countryCode); setPhone(value); }} />
            </Field>
            <Field label="WhatsApp template">
              <select value={waTemplateId} onChange={(e) => setWaTemplateId(e.target.value ? Number(e.target.value) : "")} style={S.input}>
                {waTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} · {WHATSAPP_CATEGORY_LABELS[t.category]}</option>
                ))}
              </select>
            </Field>
            <div style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.5 }}>
              {request.questions?.length || 0} question(s) are added to the message through the <code>{"{survey_questions}"}</code> placeholder.
              You can edit the message before sending.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "auto" }}>
              <button type="button" style={disabledStyle(S.btnWhatsApp, saving || !message.trim())} disabled={saving || !message.trim()} onClick={() => void markSent(true)}>
                Open WhatsApp &amp; Mark Sent
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" style={{ ...S.btn, flex: 1 }} onClick={() => void copy()}>Copy Message</button>
                <button type="button" style={disabledStyle({ ...S.btn, flex: 1 }, saving || !message.trim())} disabled={saving || !message.trim()} onClick={() => void markSent(false)}>
                  Mark as Sent
                </button>
              </div>
            </div>
          </div>
          <Field label="Message">
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={18} style={{ ...S.textarea, minHeight: "360px", fontFamily: "monospace", fontSize: "12.5px", lineHeight: 1.5 }} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// --------------------------------------------------------- new survey request --

export function NewSurveyRequestModal({
  open, onClose, onCreated, setNotice, patients, presetPatient, context,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sendRequestId: number | null) => void;
  setNotice: SetNotice;
  patients: Patient[];
  presetPatient?: Patient | null;
  context?: SurveyContext;
}) {
  const { templates } = useSurveyTemplates(setNotice, "ACTIVE");
  const { templates: waTemplates } = useWhatsAppTemplates(setNotice, true);
  const [templateId, setTemplateId] = useState<number | "">("");
  const [waTemplateId, setWaTemplateId] = useState<number | "">("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(presetPatient ? [presetPatient.patient_id] : []);
  }, [open, presetPatient?.patient_id]);

  useEffect(() => {
    if (templateId !== "" || templates.length === 0) return;
    const wanted = presetPatient ? (presetPatient.is_inpatient ? "IPD" : "OPD") : null;
    setTemplateId((templates.find((t) => t.survey_type === wanted) || templates[0]).id);
  }, [templates, templateId, presetPatient]);

  useEffect(() => {
    if (waTemplateId !== "" || waTemplates.length === 0) return;
    setWaTemplateId((waTemplates.find((t) => t.category === "SURVEY") || waTemplates[0]).id);
  }, [waTemplates, waTemplateId]);

  const submit = async (sendNow: boolean) => {
    if (!templateId || selected.length === 0) return;
    setSaving(true);
    try {
      const single = selected.length === 1;
      const res = await apiFetch<{ created: number[]; skipped: { patient_id: string; reason: string; request_id?: number }[] }>("/api/reach/surveys", {
        method: "POST",
        body: JSON.stringify({
          template_id: templateId,
          patient_ids: selected,
          whatsapp_template_id: waTemplateId || null,
          ...(single && presetPatient && context ? context : {}),
        }),
      });
      const skippedMsg = res.skipped.length ? ` ${res.skipped.length} skipped (${res.skipped[0].reason.toLowerCase()}${res.skipped.length > 1 ? ", …" : ""}).` : "";
      if (res.created.length === 0) {
        setNotice({ type: "warning", message: `No new survey was created.${skippedMsg}` });
        // A single patient with an open survey: offer to (re)send that one.
        const existing = single ? res.skipped[0]?.request_id : undefined;
        if (sendNow && existing) onCreated(existing);
        else onCreated(null);
      } else {
        setNotice({ type: "success", message: `${res.created.length} survey${res.created.length === 1 ? "" : "s"} queued.${skippedMsg}` });
        onCreated(sendNow && res.created.length === 1 ? res.created[0] : null);
      }
      onClose();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not create the survey.");
    } finally {
      setSaving(false);
    }
  };

  const tpl = templates.find((t) => t.id === templateId);
  const canSubmit = !!templateId && selected.length > 0 && !saving;
  return (
    <Modal open={open} onClose={onClose} title="New Survey Request" description="Queue a feedback survey for one or more patients, then send it on WhatsApp." className="ui-modal-wide">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Field label="Survey">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : "")} style={S.input}>
              {templates.length === 0 && <option value="">No active surveys - create one in Survey Templates</option>}
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.question_count} questions)</option>)}
            </select>
          </Field>
          <Field label="WhatsApp template">
            <select value={waTemplateId} onChange={(e) => setWaTemplateId(e.target.value ? Number(e.target.value) : "")} style={S.input}>
              <option value="">Choose when sending</option>
              {waTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} · {WHATSAPP_CATEGORY_LABELS[t.category]}</option>)}
            </select>
          </Field>
        </div>
        {tpl?.description && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "-6px" }}>{tpl.description}</div>}
        {presetPatient ? (
          <div style={{ ...S.subCard, padding: "12px 14px", background: "#f8fafc", fontSize: "13px" }}>
            <strong>{patientFullName(presetPatient)}</strong> · {presetPatient.patient_id} · {presetPatient.phone || presetPatient.family_mobile || "No mobile"}
            {context?.encounter_label && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Visit: {context.encounter_label}{context.doctor_name ? ` · Dr. ${context.doctor_name}` : ""}</div>}
          </div>
        ) : (
          <Field label="Patients">
            <PatientPicker patients={patients} selected={selected} onChange={setSelected} multi />
          </Field>
        )}
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          Patients who already have this survey queued or awaiting a reply are skipped. Messages are sent one at a time from WhatsApp; queued surveys appear as <strong>Not Sent</strong> until you send them.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
          <button type="button" style={disabledStyle(S.btnPrimary, !canSubmit)} disabled={!canSubmit} onClick={() => void submit(false)}>
            {saving ? "Saving…" : `Queue Survey${selected.length > 1 ? `s (${selected.length})` : ""}`}
          </button>
          {selected.length === 1 && (
            <button type="button" style={disabledStyle(S.btnWhatsApp, !canSubmit)} disabled={!canSubmit} onClick={() => void submit(true)}>
              Queue &amp; Send on WhatsApp
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------- record survey response --

type AnswerState = { rating_value: number | null; answer_text: string; answer_options: string[] };

export function RecordSurveyResponseModal({
  open, onClose, onSaved, setNotice, patients, presetPatient, requestId, context,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  setNotice: SetNotice;
  patients: Patient[];
  presetPatient?: Patient | null;
  requestId?: number | null;
  context?: SurveyContext;
}) {
  const { templates } = useSurveyTemplates(setNotice, "ACTIVE");
  const [patientId, setPatientId] = useState("");
  const [openRequests, setOpenRequests] = useState<SurveyRequest[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<number | "new" | "">("");
  const [templateId, setTemplateId] = useState<number | "">("");
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({});
  const [overall, setOverall] = useState<number | null>(null);
  const [comments, setComments] = useState("");
  const [channel, setChannel] = useState<Channel>("WHATSAPP");
  const [submittedAt, setSubmittedAt] = useState(nowLocalInput());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setPatientId(presetPatient?.patient_id || "");
    setSelectedRequest(requestId || "");
    setTemplateId("");
    setQuestions([]);
    setAnswers({});
    setOverall(null);
    setComments("");
    setChannel("WHATSAPP");
    setSubmittedAt(nowLocalInput());
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetPatient?.patient_id, requestId]);

  // Surveys waiting for this patient's reply.
  useEffect(() => {
    if (!open || !patientId) {
      setOpenRequests([]);
      return;
    }
    let alive = true;
    Promise.all([
      apiFetch<{ items: SurveyRequest[] }>(`/api/reach/surveys${buildQuery({ patient_id: patientId, status: "PENDING", limit: 50 })}`),
      apiFetch<{ items: SurveyRequest[] }>(`/api/reach/surveys${buildQuery({ patient_id: patientId, status: "NOT_SENT", limit: 50 })}`),
    ])
      .then(([pending, notSent]) => {
        if (!alive) return;
        const list = [...pending.items, ...notSent.items];
        setOpenRequests(list);
        setSelectedRequest((cur) => {
          if (cur && cur !== "new" && list.some((r) => r.id === cur)) return cur;
          if (requestId && list.some((r) => r.id === requestId)) return requestId;
          return list.length ? list[0].id : "new";
        });
      })
      .catch(() => alive && setOpenRequests([]));
    return () => {
      alive = false;
    };
  }, [open, patientId, requestId]);

  useEffect(() => {
    if (selectedRequest !== "new" || templateId !== "" || templates.length === 0) return;
    const p = patients.find((x) => x.patient_id === patientId) || presetPatient;
    const wanted = p ? (p.is_inpatient ? "IPD" : "OPD") : null;
    setTemplateId((templates.find((t) => t.survey_type === wanted) || templates[0]).id);
  }, [selectedRequest, templateId, templates, patients, patientId, presetPatient]);

  // Load the questions of the chosen survey.
  const effectiveTemplateId = selectedRequest && selectedRequest !== "new"
    ? openRequests.find((r) => r.id === selectedRequest)?.template_id
    : templateId || undefined;
  useEffect(() => {
    if (!open || !effectiveTemplateId) {
      setQuestions([]);
      return;
    }
    let alive = true;
    setLoadingQuestions(true);
    apiFetch<SurveyTemplate>(`/api/reach/survey-templates/${effectiveTemplateId}`)
      .then((tpl) => {
        if (!alive) return;
        setQuestions(tpl.questions || []);
        setAnswers({});
      })
      .catch((err) => alive && setError(errorMessage(err, "Unable to load survey questions.")))
      .finally(() => alive && setLoadingQuestions(false));
    return () => {
      alive = false;
    };
  }, [open, effectiveTemplateId]);

  const setAnswer = (qid: number, patch: Partial<AnswerState>) =>
    setAnswers((prev) => ({ ...prev, [qid]: { rating_value: null, answer_text: "", answer_options: [], ...prev[qid], ...patch } }));

  const ratingValues = questions.filter((q) => q.question_type === "RATING").map((q) => answers[q.id!]?.rating_value).filter((v): v is number => typeof v === "number");
  const suggestedOverall = ratingValues.length ? Math.round(ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) : null;

  const submit = async () => {
    setError("");
    const missing = questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => {
        if (!q.is_required) return false;
        const a = answers[q.id!];
        if (!a) return true;
        if (q.question_type === "RATING") return a.rating_value === null;
        if (q.question_type === "MULTI_CHOICE") return a.answer_options.length === 0;
        return !a.answer_text.trim();
      })
      .map(({ i }) => i + 1);
    if (!patientId) return setError("Select a patient.");
    if (!selectedRequest || (selectedRequest === "new" && !templateId)) return setError("Select a survey.");
    if (missing.length) return setError(`Please answer the required question(s): ${missing.join(", ")}.`);
    if (overall === null) return setError("Give an overall rating.");
    setSaving(true);
    try {
      await apiFetch("/api/reach/survey-responses", {
        method: "POST",
        body: JSON.stringify({
          request_id: selectedRequest !== "new" ? selectedRequest : null,
          template_id: selectedRequest === "new" ? templateId : null,
          patient_id: patientId,
          overall_rating: overall,
          comments,
          channel,
          submitted_at: submittedAt,
          answers: questions.map((q) => ({ question_id: q.id, ...(answers[q.id!] || {}) })),
          ...(presetPatient && presetPatient.patient_id === patientId && context ? context : {}),
        }),
      });
      setNotice({ type: "success", message: "Survey response recorded." });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not save the survey response."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record Survey Response" description="Enter the feedback the patient sent on WhatsApp (or gave by phone / in person)." className="ui-modal-wide">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {presetPatient ? (
          <div style={{ ...S.subCard, padding: "10px 14px", background: "#f8fafc", fontSize: "13px" }}>
            <strong>{patientFullName(presetPatient)}</strong> · {presetPatient.patient_id} · {presetPatient.phone || presetPatient.family_mobile || "No mobile"}
          </div>
        ) : (
          <Field label="Patient">
            <PatientPicker patients={patients} selected={patientId ? [patientId] : []} onChange={(ids) => { setPatientId(ids[0] || ""); setSelectedRequest(""); setTemplateId(""); }} multi={false} />
          </Field>
        )}

        {patientId && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Field label="Survey">
              <select
                value={selectedRequest}
                onChange={(e) => setSelectedRequest(e.target.value === "new" ? "new" : e.target.value ? Number(e.target.value) : "")}
                style={S.input}
              >
                {openRequests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.template_name} · {r.status === "PENDING" ? `sent ${fmtDateTime(r.sent_at)}` : "not sent yet"}
                  </option>
                ))}
                <option value="new">Feedback without a sent survey…</option>
              </select>
            </Field>
            {selectedRequest === "new" ? (
              <Field label="Survey template">
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : "")} style={S.input}>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            ) : <div />}
          </div>
        )}

        {loadingQuestions ? (
          <div style={{ color: "#94a3b8", fontSize: "13px" }}>Loading questions…</div>
        ) : questions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {questions.map((q, i) => {
              const a = answers[q.id!] || { rating_value: null, answer_text: "", answer_options: [] };
              return (
                <div key={q.id} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "10px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b" }}>
                      {i + 1}. {q.question_text} {q.is_required && <span style={{ color: "#dc2626" }}>*</span>}
                    </span>
                    {q.category && <Pill label={q.category} bg="#f1f5f9" color="#475569" />}
                  </div>
                  {q.question_type === "RATING" && <RatingInput value={a.rating_value} onChange={(v) => setAnswer(q.id!, { rating_value: v })} />}
                  {(q.question_type === "SINGLE_CHOICE" || q.question_type === "YES_NO") && (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {q.options.map((o, j) => {
                        const active = a.answer_text === o;
                        return (
                          <button key={o} type="button" onClick={() => setAnswer(q.id!, { answer_text: active ? "" : o })}
                            style={{ ...S.btnSmall, height: "32px", borderColor: active ? "#0f766e" : "#cbd5e1", background: active ? "#f0fdfa" : "#fff", color: active ? "#0f766e" : "#334155" }}>
                            {q.question_type === "SINGLE_CHOICE" ? `${String.fromCharCode(97 + j)}) ` : ""}{o}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q.question_type === "MULTI_CHOICE" && (
                    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                      {q.options.map((o) => (
                        <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px", cursor: "pointer" }}>
                          <input type="checkbox" checked={a.answer_options.includes(o)}
                            onChange={() => setAnswer(q.id!, { answer_options: a.answer_options.includes(o) ? a.answer_options.filter((x) => x !== o) : [...a.answer_options, o] })} />
                          {o}
                        </label>
                      ))}
                    </div>
                  )}
                  {q.question_type === "TEXT" && (
                    <textarea value={a.answer_text} onChange={(e) => setAnswer(q.id!, { answer_text: e.target.value })} rows={2} maxLength={2000} style={S.textarea} placeholder="Patient's answer" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {questions.length > 0 && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr", gap: "12px", alignItems: "end" }}>
              <Field label="Overall rating *">
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <RatingInput value={overall} onChange={setOverall} />
                  {suggestedOverall !== null && overall !== suggestedOverall && (
                    <button type="button" style={S.btnSmall} onClick={() => setOverall(suggestedOverall)}>Use average ({suggestedOverall})</button>
                  )}
                </div>
              </Field>
              <Field label="Received via">
                <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} style={S.input}>
                  {(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
                </select>
              </Field>
              <Field label="Received on">
                <input type="datetime-local" value={submittedAt} max={nowLocalInput()} onChange={(e) => setSubmittedAt(e.target.value)} style={S.input} />
              </Field>
            </div>
            <Field label="Comments">
              <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={2000} style={S.textarea} placeholder="Patient's comments or staff notes" />
            </Field>
          </>
        )}

        {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
          <button type="button" style={disabledStyle(S.btnPrimary, saving || questions.length === 0)} disabled={saving || questions.length === 0} onClick={() => void submit()}>
            {saving ? "Saving…" : "Submit Response"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ survey detail --

export function SurveyDetailModal({
  requestId, onClose, onChanged, setNotice, canWrite, onSend, onRecord,
}: {
  requestId: number | null;
  onClose: () => void;
  onChanged: () => void;
  setNotice: SetNotice;
  canWrite: boolean;
  onSend: (requestId: number) => void;
  onRecord: (request: SurveyRequest) => void;
}) {
  const [req, setReq] = useState<SurveyRequest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    setReq(null);
    apiFetch<SurveyRequest>(`/api/reach/surveys/${requestId}`)
      .then(setReq)
      .catch((err) => {
        reportError(setNotice, err as { message?: string; status?: number }, "Unable to load survey.");
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const deleteResponse = async () => {
    if (!req?.response_id) return;
    setBusy(true);
    try {
      await apiFetch(`/api/reach/survey-responses/${req.response_id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Survey response deleted." });
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not delete the response.");
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await apiFetch(`/api/reach/surveys/${req.id}/cancel`, { method: "POST" });
      setNotice({ type: "success", message: "Survey cancelled." });
      onChanged();
      onClose();
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Could not cancel the survey.");
    } finally {
      setBusy(false);
    }
  };

  const answerText = (a: { question_type: string; rating_value: number | null; answer_text: string | null }) =>
    a.question_type === "RATING" ? (a.rating_value !== null ? `${a.rating_value} / 5` : "—") : a.answer_text || "—";

  const print = () => {
    if (!req) return;
    const rows = (req.answers || [])
      .map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.question_text)}</td><td>${esc(a.category || "")}</td><td><strong>${esc(answerText(a))}</strong></td></tr>`)
      .join("");
    printViaIframe(`<!doctype html><html><head><meta charset="utf-8"><title>Survey Response - ${esc(req.patient_name)}</title>
      <style>body{font-family:Arial,sans-serif;color:#1e293b;font-size:13px;padding:24px}h1{font-size:20px;color:#00828a;margin:0 0 4px}
      table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;font-size:12px}th{background:#f1f5f9}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-top:12px}</style></head><body>
      <h1>Patient Feedback - ${esc(req.template_name)}</h1>
      <div class="grid">
        <div><strong>Patient:</strong> ${esc(req.patient_name)} (${esc(req.patient_id)})</div>
        <div><strong>Mobile:</strong> ${esc(req.phone || "—")}</div>
        <div><strong>Doctor:</strong> ${esc(req.doctor_name || "—")}</div>
        <div><strong>Department:</strong> ${esc(req.department || "—")}</div>
        <div><strong>Submitted:</strong> ${esc(fmtDateTime(req.submitted_at))}</div>
        <div><strong>Overall rating:</strong> ${esc(fmtRating(req.overall_rating))} / 5</div>
        <div><strong>Received via:</strong> ${esc(req.channel ? CHANNEL_LABELS[req.channel] : "—")}</div>
        <div><strong>Recorded by:</strong> ${esc(req.recorded_by || "—")}</div>
      </div>
      <table><thead><tr><th>#</th><th>Question</th><th>Category</th><th>Answer</th></tr></thead><tbody>${rows}</tbody></table>
      <p><strong>Comments:</strong> ${esc(req.comments || "—")}</p>
      </body></html>`);
  };

  return (
    <Modal open={requestId !== null} onClose={onClose} title="Survey Details" description={req ? `${req.patient_name || req.patient_id} · ${req.template_name}` : undefined} className="ui-modal-wide">
      {!req ? (
        <div style={{ padding: "24px", color: "#94a3b8", fontSize: "13px" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px", fontSize: "12.5px", color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 14px" }}>
            <div><strong>UHID:</strong> {req.patient_id}</div>
            <div><strong>Mobile:</strong> {req.phone || "—"}</div>
            <div><strong>Doctor:</strong> {req.doctor_name || "—"}</div>
            <div><strong>Department:</strong> {req.department || "—"}</div>
            {req.encounter_label && <div><strong>Visit:</strong> {req.encounter_label}</div>}
            <div><strong>Status:</strong> <StatusPill status={req.status} /></div>
            <div><strong>Queued:</strong> {fmtDateTime(req.created_at)}{req.created_by ? ` by ${req.created_by}` : ""}</div>
            <div><strong>Sent:</strong> {req.sent_at ? `${fmtDateTime(req.sent_at)} (${req.send_count}×)` : "—"}</div>
            {req.submitted_at && <div><strong>Response:</strong> {fmtDateTime(req.submitted_at)}</div>}
          </div>

          {req.response_id ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                <div style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a" }}>{fmtRating(req.overall_rating)}<span style={{ fontSize: "15px", color: "#64748b" }}> / 5</span></div>
                <Stars value={req.overall_rating} size={22} />
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  {req.channel ? CHANNEL_LABELS[req.channel] : ""}{req.recorded_by ? ` · recorded by ${req.recorded_by}` : ""}
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["#", "Question", "Type", "Category", "Answer"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {(req.answers || []).map((a, i) => (
                      <tr key={a.id}>
                        <td style={S.td}>{i + 1}</td>
                        <td style={S.td}>{a.question_text}</td>
                        <td style={{ ...S.td, whiteSpace: "nowrap" }}>{QUESTION_TYPE_LABELS[a.question_type]}</td>
                        <td style={S.td}>{a.category || "—"}</td>
                        <td style={{ ...S.td, fontWeight: 700, color: "#0f172a" }}>
                          {a.question_type === "RATING" && a.rating_value !== null ? <><span style={{ color: "#f59e0b" }}>★</span> {a.rating_value}</> : answerText(a)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: "13px" }}><strong>Comments:</strong> <span style={{ color: "#475569" }}>{req.comments || "—"}</span></div>
            </>
          ) : (
            <div style={{ fontSize: "13px", color: "#64748b" }}>No response recorded yet.</div>
          )}

          {(req.messages || []).length > 0 && (
            <div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>WhatsApp messages sent</div>
              {(req.messages || []).map((m) => (
                <details key={m.id} style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "8px 12px", marginBottom: "6px", fontSize: "12.5px" }}>
                  <summary style={{ cursor: "pointer", color: "#334155" }}>{fmtDateTime(m.sent_at)} · {m.template_name || "Custom message"} → {m.phone || "—"}{m.sent_by ? ` · ${m.sent_by}` : ""}</summary>
                  <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontFamily: "inherit", color: "#475569" }}>{m.message}</pre>
                </details>
              ))}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
            {req.response_id && <button type="button" style={S.btn} onClick={print}>Print</button>}
            {canWrite && req.response_id && (
              <button type="button" style={{ ...S.btn, color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => setConfirmDelete(true)}>Delete Response</button>
            )}
            {canWrite && (req.status === "NOT_SENT" || req.status === "PENDING") && (
              <>
                <button type="button" style={disabledStyle({ ...S.btn, color: "#b91c1c", borderColor: "#fecaca" }, busy)} disabled={busy} onClick={() => void cancelRequest()}>Cancel Survey</button>
                <button type="button" style={S.btnWhatsApp} onClick={() => { onClose(); onSend(req.id); }}>{req.status === "PENDING" ? "Resend" : "Send"} on WhatsApp</button>
                <button type="button" style={S.btnPrimary} onClick={() => { onClose(); onRecord(req); }}>Record Response</button>
              </>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteResponse}
        loading={busy}
        title="Delete this survey response?"
        description="The answers will be removed and the survey goes back to Pending (or is removed if it was never sent)."
        confirmLabel="Delete"
      />
    </Modal>
  );
}
