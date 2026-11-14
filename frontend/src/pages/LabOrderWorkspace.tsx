// Orders & Billing: one order screen for all four service types (In-house, External,
// Outsourcing, Home Visit). Patient Details changes per type; Select Services and the
// Order summary (bill, discount, remarks, Save Draft / Generate Invoice) are shared.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { FiClock, FiTrash2 } from "react-icons/fi";
import { Button, Input, Label, Modal, Select, Textarea } from "../components/ui";
import PatientSearchPicker from "../components/PatientSearchPicker";
import PartnerLabManager from "../components/lab/PartnerLabManager";
import type { PartnerLab } from "../components/lab/PartnerLabManager";
import PhoneInput from "../components/PhoneInput";
import { validateMobileByCountry } from "../lib/phone";
import { apiFetch, reportError } from "../lib/api";
import type { Notice, Patient } from "../types";
import {
  PAYMENT_MODES, SERVICE_TYPE_BADGE, SERVICE_TYPE_LABELS, loadOrderWithInvoice, money, printLabInvoice,
} from "../components/lab/LabCheckout";
import type { DiagService, LabInvoice, LabOrder, ServiceType, Vendor } from "../components/lab/LabCheckout";

type Props = {
  serviceType: ServiceType;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onOrderSaved: () => void;
  onViewHistory: (query: string) => void;
};

type ServiceTab = "LAB" | "IMAGING" | "PROCEDURES" | "OTHERS";
type Line = { service_id: number; code: string; name: string; department?: string; service_type: string; rate: number; vendor_id?: number | null; duplicate_reason?: string };
type Encounter = { key: string; kind: "OP" | "EMERGENCY" | "IP"; id: number; label: string; doctor_name?: string };
type RecentOrder = { service_id: number; service_name: string; order_no: string; ordered_at: string };
type Walkin = { name: string; mobile: string; countryCode: string; age: string; gender: string };

const SERVICE_TABS: { key: ServiceTab; label: string }[] = [
  { key: "LAB", label: "Laboratory" }, { key: "IMAGING", label: "Imaging" },
  { key: "PROCEDURES", label: "Procedures" }, { key: "OTHERS", label: "Others" },
];
const OUTSIDE = "OUTSIDE";
const EMPTY_WALKIN: Walkin = { name: "", mobile: "", countryCode: "+91", age: "", gender: "" };

function tabOf(s: { service_type: string; department?: string }): ServiceTab {
  if (s.service_type === "LAB") return "LAB";
  if (s.service_type === "IMAGING") return "IMAGING";
  return /proced/i.test(s.department || "") ? "PROCEDURES" : "OTHERS";
}

function ageOf(p: Patient): string {
  if (p.age !== undefined && p.age !== null && p.age !== "") return String(p.age);
  if (!p.dob) return "";
  const dob = new Date(p.dob);
  if (Number.isNaN(dob.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate())) age -= 1;
  return age >= 0 ? String(age) : "";
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function LabOrderWorkspace({ serviceType, setNotice, onOrderSaved, onViewHistory }: Props) {
  const labOnly = serviceType === "OUTSOURCING" || serviceType === "HOME_VISIT";
  const allowsWalkin = serviceType !== "IN_HOUSE";
  const allowsRegistered = serviceType !== "EXTERNAL";

  // ---- patient ----
  const [mode, setMode] = useState<"registered" | "walkin">(serviceType === "EXTERNAL" ? "walkin" : "registered");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [walkin, setWalkin] = useState<Walkin>(EMPTY_WALKIN);
  const [referringDoctor, setReferringDoctor] = useState("");
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [encounterKey, setEncounterKey] = useState("");
  const [outsideSource, setOutsideSource] = useState("");

  // ---- type specific ----
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [labManagerOpen, setLabManagerOpen] = useState(false);
  const handlePartnerLabsChanged = (labs: PartnerLab[], added?: PartnerLab) => {
    const active = labs.filter((v) => (v.status || "active") === "active");
    setVendors(active);
    // Keep selections valid: a deactivated lab can no longer be chosen for a new order.
    setVendorId((cur) => (added ? added.id : cur && !active.some((v) => v.id === cur) ? "" : cur));
  };
  const [vendorId, setVendorId] = useState<number | "">("");
  const [address, setAddress] = useState("");
  const [visitAt, setVisitAt] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600 * 1000)));
  const [defaultFee, setDefaultFee] = useState(0);
  const [fee, setFee] = useState<number | "">("");

  // ---- services + summary ----
  const [services, setServices] = useState<DiagService[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<ServiceTab>("LAB");
  const [lines, setLines] = useState<Line[]>([]);
  const [discountType, setDiscountType] = useState<"percent" | "flat">("percent");
  const [discountVal, setDiscountVal] = useState<number | "">("");
  const [priority, setPriority] = useState("Routine");
  const [remarks, setRemarks] = useState("");
  const [duplicateIds, setDuplicateIds] = useState<number[]>([]);
  const [recent, setRecent] = useState<RecentOrder[]>([]);

  // ---- draft / checkout ----
  const [draft, setDraft] = useState<{ id: number; orderNo: string; signature: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<{ order: LabOrder; invoice: LabInvoice | null } | null>(null);

  useEffect(() => {
    apiFetch<{ services: DiagService[] }>("/api/diag/services?active_only=true")
      .then((d) => setServices(d.services || []))
      .catch((err) => reportError(setNotice, err, "Could not load the test catalogue."));
    if (serviceType === "OUTSOURCING") {
      apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list")
        .then((d) => setVendors((d.vendors || []).filter((v) => (v.status || "active") === "active")))
        .catch((err) => reportError(setNotice, err, "Could not load partner laboratories."));
    }
    if (serviceType === "HOME_VISIT") {
      apiFetch<{ home_visit_fee: number }>("/api/diag/settings").then((s) => setDefaultFee(Number(s.home_visit_fee) || 0)).catch(() => {});
    }
  }, [serviceType, setNotice]);

  // Patient Journey's "Order tests" hands a UHID over for an in-house order.
  useEffect(() => {
    if (serviceType !== "IN_HOUSE") return;
    const saved = localStorage.getItem("selected_diag_patient");
    if (!saved) return;
    localStorage.removeItem("selected_diag_patient");
    apiFetch<{ patient?: Patient }>(`/api/patients/${encodeURIComponent(saved)}`)
      .then((res) => { if (res?.patient?.patient_id) void selectPatient(res.patient); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType]);

  const selectPatient = useCallback(async (p: Patient) => {
    setPatient(p);
    setEncounters([]);
    setEncounterKey("");
    if (serviceType === "HOME_VISIT" && p.address) setAddress((a) => a || p.address || "");
    if (serviceType !== "IN_HOUSE") return;
    const [appts, admissions] = await Promise.all([
      apiFetch<{ appointments: any[] }>(`/api/appointments?patient_id=${encodeURIComponent(p.patient_id)}`).catch(() => ({ appointments: [] })),
      apiFetch<{ admissions: any[] }>(`/api/patients/${encodeURIComponent(p.patient_id)}/admissions`).catch(() => ({ admissions: [] })),
    ]);
    const opts: Encounter[] = [];
    (appts.appointments || []).forEach((a) => {
      const kind = (a.visit_type || "").toLowerCase() === "emergency" ? "EMERGENCY" : "OP";
      opts.push({ key: `${kind}-${a.id}`, kind, id: a.id, doctor_name: a.doctor_name,
        label: `${kind === "EMERGENCY" ? "Emergency" : "OPD"} visit · ${a.department || ""} · ${new Date(a.appointment_date).toLocaleDateString()}` });
    });
    (admissions.admissions || []).filter((a) => !a.discharge_date).forEach((a) => {
      opts.push({ key: `IP-${a.id}`, kind: "IP", id: a.id, label: `Inpatient admission · ADM-${a.id} · since ${new Date(a.admission_date).toLocaleDateString()}` });
    });
    setEncounters(opts);
    // An active admission wins; otherwise a single visit is unambiguous. Several stay unselected.
    const ip = opts.filter((o) => o.kind === "IP");
    if (ip.length === 1) setEncounterKey(ip[0].key);
    else if (ip.length === 0 && opts.length === 1) setEncounterKey(opts[0].key);
  }, [serviceType]);

  const encounter = useMemo(() => encounters.find((e) => e.key === encounterKey), [encounters, encounterKey]);
  useEffect(() => { if (encounter?.doctor_name) setReferringDoctor(encounter.doctor_name); }, [encounter]);

  // In-house: same test already active on this visit needs a reason; same test elsewhere this week is a note.
  const lineKey = lines.map((l) => l.service_id).join(",");
  useEffect(() => {
    if (serviceType !== "IN_HOUSE" || !patient || !lineKey) { setDuplicateIds([]); setRecent([]); return; }
    let stale = false;
    const params = new URLSearchParams({ patient_id: patient.patient_id });
    lineKey.split(",").forEach((id) => params.append("service_id", id));
    if (encounter?.kind === "IP") params.set("admission_id", String(encounter.id));
    else if (encounter) params.set("appointment_id", String(encounter.id));
    apiFetch<{ duplicate_service_ids: number[]; recent?: RecentOrder[] }>(`/api/diag/orders/check-duplicates?${params.toString()}`)
      .then((d) => { if (!stale) { setDuplicateIds(d.duplicate_service_ids || []); setRecent(d.recent || []); } })
      .catch(() => {});
    return () => { stale = true; };
  }, [serviceType, patient, encounter, lineKey]);

  // ---- services table ----
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services.filter((s) => tabOf(s) === tab && (!q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)));
  }, [services, tab, search]);
  const selected = useMemo(() => new Set(lines.map((l) => l.service_id)), [lines]);
  const add = (s: DiagService) => setLines((prev) => (prev.some((l) => l.service_id === s.id) ? prev
    : [...prev, { service_id: s.id, code: s.code, name: s.name, department: s.department, service_type: s.service_type, rate: s.rate }]));
  const remove = (id: number) => setLines((prev) => prev.filter((l) => l.service_id !== id));
  const toggle = (s: DiagService) => (selected.has(s.id) ? remove(s.id) : add(s));
  const allShownSelected = shown.length > 0 && shown.every((s) => selected.has(s.id));
  const toggleAllShown = () => (allShownSelected ? shown.forEach((s) => remove(s.id)) : shown.forEach(add));
  const patchLine = (id: number, patch: Partial<Line>) => setLines((prev) => prev.map((l) => (l.service_id === id ? { ...l, ...patch } : l)));

  // ---- bill ----
  const gross = lines.reduce((sum, l) => sum + l.rate, 0);
  const discountNum = Number(discountVal) || 0;
  const discount = Math.min(Math.round(discountType === "percent" ? (gross * Math.min(discountNum, 100)) / 100 : discountNum), gross);
  const visitFee = serviceType === "HOME_VISIT" ? Math.max(fee === "" ? defaultFee : Number(fee) || 0, 0) : 0;
  const total = Math.max(gross - discount, 0) + visitFee;

  const buildRequest = (): { path: string; payload: Record<string, unknown> } => {
    if (lines.length === 0) throw new Error("Add at least one test or service.");
    // Spread the bill discount across lines so the invoiced lines add up to the total.
    let left = discount;
    const items = lines.map((l, i) => {
      const share = i === lines.length - 1 ? left : Math.round(gross > 0 ? (l.rate / gross) * discount : 0);
      left -= share;
      return {
        service_id: l.service_id, quantity: 1, discount: Math.max(share, 0),
        ...(l.vendor_id ? { vendor_id: l.vendor_id } : {}),
        ...(duplicateIds.includes(l.service_id) ? { is_duplicate_repeat: true, duplicate_reason: l.duplicate_reason } : {}),
      };
    });
    const missing = lines.find((l) => duplicateIds.includes(l.service_id) && !l.duplicate_reason?.trim());
    if (missing) throw new Error(`${missing.name} is already ordered on this visit: enter a reason to repeat it.`);
    const notes = [discount > 0 ? `Discount: ${money(discount)} (${discountType === "percent" ? `${discountNum}%` : "flat"})` : "", remarks.trim()]
      .filter(Boolean).join(" | ") || undefined;
    const common = { items, notes, priority, referring_clinician: referringDoctor.trim() || undefined };

    const patientFields = () => {
      if (mode === "registered") {
        if (!patient) throw new Error("Search and select the patient by UHID or name.");
        return { patient_id: patient.patient_id };
      }
      if (!walkin.name.trim()) throw new Error("Enter the patient name.");
      const mobileError = validateMobileByCountry(walkin.mobile, walkin.countryCode, true);
      if (mobileError) throw new Error(mobileError);
      return { walkin_name: walkin.name.trim(), walkin_mobile: walkin.mobile, walkin_country_code: walkin.countryCode, walkin_age: walkin.age || undefined, walkin_gender: walkin.gender || undefined };
    };

    if (serviceType === "IN_HOUSE") {
      if (!patient) throw new Error("Search and select the patient by UHID or name.");
      if (!encounterKey) throw new Error("Select the patient's visit or admission.");
      if (encounterKey === OUTSIDE && !outsideSource.trim()) throw new Error("Enter who referred the patient.");
      return { path: "/api/diag/orders", payload: {
        ...common, patient_id: patient.patient_id,
        encounter_type: encounter ? encounter.kind : "EXTERNAL",
        appointment_id: encounter && encounter.kind !== "IP" ? encounter.id : undefined,
        admission_id: encounter?.kind === "IP" ? encounter.id : undefined,
        external_source: encounterKey === OUTSIDE ? outsideSource.trim() : undefined,
      } };
    }
    if (serviceType === "EXTERNAL") {
      return { path: "/api/diag/orders", payload: { ...common, sale_type: "EXTERNAL", ...patientFields() } };
    }
    if (serviceType === "OUTSOURCING") {
      if (!vendorId) throw new Error("Select the partner laboratory.");
      return { path: "/api/diag/service-orders", payload: { ...common, service_type: "OUTSOURCING", outsource_vendor_id: vendorId, ...patientFields() } };
    }
    if (address.trim().length < 5) throw new Error("Enter the full service address.");
    if (!visitAt || new Date(visitAt).getTime() < Date.now() - 15 * 60 * 1000) throw new Error("Pick a visit date and time that is not in the past.");
    return { path: "/api/diag/service-orders", payload: {
      ...common, service_type: "HOME_VISIT", ...patientFields(), visit_address: address.trim(), visit_scheduled_at: visitAt, home_visit_fee: visitFee,
    } };
  };

  /** The draft matching the form, reusing the last one if nothing changed (and discarding a stale one). */
  const ensureDraft = async () => {
    const { path, payload } = buildRequest();
    const signature = JSON.stringify(payload);
    if (draft && draft.signature === signature) return { ...draft, created: false };
    if (draft) await apiFetch(`/api/diag/orders/${draft.id}/cancel`, { method: "POST" }).catch(() => {});
    const res = await apiFetch<{ order_id: number }>(path, { method: "POST", body: JSON.stringify(payload) });
    const order = await apiFetch<LabOrder>(`/api/diag/orders/${res.order_id}`);
    const next = { id: order.id, orderNo: order.order_no, signature };
    setDraft(next);
    return { ...next, created: true };
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      const d = await ensureDraft();
      setNotice(d.created ? { type: "success", message: `Draft ${d.orderNo} saved. No invoice yet.` } : { type: "info", message: `Draft ${d.orderNo} is up to date.` });
      onOrderSaved();
    } catch (err: any) {
      reportError(setNotice, err, "Could not save the draft.");
    } finally {
      setBusy(false);
    }
  };

  const generateInvoice = async () => {
    setBusy(true);
    try {
      const d = await ensureDraft();
      await apiFetch(`/api/diag/orders/${d.id}/confirm`, { method: "POST" });
      setDraft(null);
      setCheckout(await loadOrderWithInvoice(d.id));
      onOrderSaved();
    } catch (err: any) {
      reportError(setNotice, err, "Could not generate the invoice.");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPatient(null); setWalkin(EMPTY_WALKIN); setReferringDoctor(""); setEncounters([]); setEncounterKey(""); setOutsideSource("");
    setVendorId(""); setAddress(""); setFee(""); setVisitAt(toLocalInput(new Date(Date.now() + 2 * 3600 * 1000)));
    setLines([]); setDiscountVal(""); setDiscountType("percent"); setPriority("Routine"); setRemarks(""); setDraft(null);
    setDuplicateIds([]); setRecent([]);
  };

  const patientName = patient ? [patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ") : "";

  return (
    <div className="lab-ob-grid">
      <div className="lab-ob-main">
        {/* ---------------------------------------------------------- patient --- */}
        <section className="diag-card">
          <div className="lab-ob-card-head">
            <h3>Patient Details</h3>
            {mode === "registered" && (
              <Button size="sm" variant="secondary" disabled={!patient} onClick={() => patient && onViewHistory(patient.patient_id)}>
                <FiClock style={{ marginRight: 6 }} />View History
              </Button>
            )}
          </div>
          {allowsWalkin && allowsRegistered && (
            <div className="lab-ob-segment" role="tablist" style={{ marginBottom: "0.75rem" }}>
              <button type="button" className={mode === "registered" ? "active" : ""} onClick={() => { setMode("registered"); }}>Registered (UHID)</button>
              <button type="button" className={mode === "walkin" ? "active" : ""} onClick={() => { setMode("walkin"); setPatient(null); }}>Walk-in (no UHID)</button>
            </div>
          )}
          {mode === "registered" ? (
            <div className="lab-ob-patient-row">
              <div className="lab-ob-search"><Label>Search Patient (UHID)</Label>
                <PatientSearchPicker placeholder="Enter UHID or Patient Name" onSelect={(p) => void selectPatient(p)} />
              </div>
              <div><Label>Patient Name</Label><Input value={patientName} readOnly placeholder="-" /></div>
              <div><Label>UHID</Label><Input value={patient?.patient_id || ""} readOnly placeholder="-" /></div>
              <div><Label>Age / Gender</Label><Input value={patient ? [ageOf(patient), patient.gender].filter(Boolean).join(" / ") : ""} readOnly placeholder="-" /></div>
            </div>
          ) : (
            <div className="lab-ob-patient-row">
              <div><Label>Patient Name *</Label><Input value={walkin.name} onChange={(e) => setWalkin({ ...walkin, name: e.target.value })} /></div>
              <div className="lab-ob-span2"><Label>Mobile *</Label>
                <PhoneInput required countryCode={walkin.countryCode} value={walkin.mobile}
                  onChange={({ countryCode, value }) => setWalkin({ ...walkin, countryCode, mobile: value })} />
              </div>
              <div><Label>Age</Label><Input inputMode="numeric" maxLength={3} value={walkin.age} onChange={(e) => setWalkin({ ...walkin, age: e.target.value.replace(/\D/g, "") })} /></div>
              <div><Label>Gender</Label>
                <Select value={walkin.gender} onChange={(e) => setWalkin({ ...walkin, gender: e.target.value })}>
                  <option value="">Select</option><option>Male</option><option>Female</option><option>Other</option>
                </Select>
              </div>
            </div>
          )}

          {serviceType === "IN_HOUSE" && patient && (
            <div className="lab-ob-patient-row" style={{ marginTop: "0.75rem" }}>
              <div className="lab-ob-span2"><Label>Visit / admission *</Label>
                <Select value={encounterKey} onChange={(e) => setEncounterKey(e.target.value)}>
                  <option value="">Select visit or admission</option>
                  {encounters.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
                  <option value={OUTSIDE}>No visit here: referred from outside</option>
                </Select>
              </div>
              {encounterKey === OUTSIDE && (
                <div className="lab-ob-span2"><Label>Referred by *</Label><Input value={outsideSource} onChange={(e) => setOutsideSource(e.target.value)} placeholder="Clinic or doctor" /></div>
              )}
              {encounter?.kind === "IP" && <div className="lab-ob-span2 muted" style={{ alignSelf: "end", fontSize: 13 }}>Inpatient: charges go on the discharge bill.</div>}
            </div>
          )}
          {serviceType !== "IN_HOUSE" && (
            <div className="lab-ob-patient-row" style={{ marginTop: "0.75rem" }}>
              <div className="lab-ob-span2"><Label>Referring doctor</Label><Input value={referringDoctor} onChange={(e) => setReferringDoctor(e.target.value)} placeholder="Optional" /></div>
              {serviceType === "OUTSOURCING" && (
                <div className="lab-ob-span2">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <Label>Partner laboratory *</Label>
                    <button
                      type="button"
                      onClick={() => setLabManagerOpen(true)}
                      style={{ background: "none", border: "none", color: "#00828a", fontWeight: 700, fontSize: "12px", cursor: "pointer", padding: 0 }}
                    >
                      + Add / Manage
                    </button>
                  </div>
                  <Select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
                    <option value="">{vendors.length ? "Select partner lab" : "No partner labs yet: use + Add / Manage"}</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                  </Select>
                  <PartnerLabManager
                    open={labManagerOpen}
                    onClose={() => setLabManagerOpen(false)}
                    setNotice={setNotice}
                    onChanged={handlePartnerLabsChanged}
                  />
                </div>
              )}
            </div>
          )}
          {serviceType === "HOME_VISIT" && (
            <div className="lab-ob-patient-row" style={{ marginTop: "0.75rem" }}>
              <div className="lab-ob-span3"><Label>Service address *</Label><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House no, street, area, landmark, city" /></div>
              <div><Label>Visit date &amp; time *</Label><Input type="datetime-local" value={visitAt} min={toLocalInput(new Date())} onChange={(e) => setVisitAt(e.target.value)} /></div>
            </div>
          )}
        </section>

        {/* --------------------------------------------------------- services --- */}
        <section className="diag-card">
          <div className="lab-ob-card-head"><h3>Select Services</h3></div>
          <Input placeholder="Search test name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="lab-ob-tabs">
            {SERVICE_TABS.map((t) => {
              const disabled = labOnly && t.key !== "LAB";
              return (
                <button key={t.key} type="button" className={tab === t.key ? "active" : ""} disabled={disabled}
                  title={disabled ? `${SERVICE_TYPE_LABELS[serviceType]} orders are for laboratory tests` : undefined}
                  onClick={() => setTab(t.key)}>{t.label}</button>
              );
            })}
          </div>
          <div className="lab-ob-table-wrap">
            <table className="diag-data-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all shown" checked={allShownSelected} onChange={toggleAllShown} /></th>
                  <th>Service</th><th>Department</th><th style={{ textAlign: "right" }}>Rate (Rs.)</th><th style={{ width: 90 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td><input type="checkbox" aria-label={`Select ${s.name}`} checked={selected.has(s.id)} onChange={() => toggle(s)} /></td>
                    <td>{s.name}</td>
                    <td>{s.department || "-"}</td>
                    <td style={{ textAlign: "right" }}>{s.rate}</td>
                    <td>{selected.has(s.id)
                      ? <span className="lab-ob-added">Added</span>
                      : <Button size="sm" variant="secondary" onClick={() => add(s)}>+ Add</Button>}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={5} className="diag-empty">No services match.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ----------------------------------------------------------- summary --- */}
      <aside className="diag-card lab-ob-summary">
        <div className="lab-ob-card-head">
          <h3>Order summary</h3>
          <span className={`diag-badge ${SERVICE_TYPE_BADGE[serviceType]}`}>{SERVICE_TYPE_LABELS[serviceType]}</span>
        </div>
        <table className="diag-data-table lab-ob-summary-table">
          <thead><tr><th>#</th><th>Test / Service</th><th>Dept.</th><th style={{ textAlign: "right" }} title="Rate (Rs.)">Rate</th><th style={{ textAlign: "center" }}>Action</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.service_id}>
                <td>{i + 1}</td>
                <td>
                  {l.name}
                  {serviceType === "OUTSOURCING" && (
                    <Select className="lab-ob-inline-select" value={l.vendor_id || ""} onChange={(e) => patchLine(l.service_id, { vendor_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Same partner lab</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                    </Select>
                  )}
                  {duplicateIds.includes(l.service_id) && (
                    <Input className="lab-ob-inline-select" placeholder="Already ordered on this visit: reason to repeat *"
                      value={l.duplicate_reason || ""} onChange={(e) => patchLine(l.service_id, { duplicate_reason: e.target.value })} />
                  )}
                </td>
                <td>{l.department || "-"}</td>
                <td style={{ textAlign: "right" }}>{l.rate}</td>
                <td><button type="button" className="lab-ob-trash" aria-label={`Remove ${l.name}`} onClick={() => remove(l.service_id)}><FiTrash2 /></button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={5} className="diag-empty">No tests added yet.</td></tr>}
          </tbody>
        </table>
        {recent.length > 0 && (
          <div className="diag-note-box" style={{ fontSize: 13 }}>
            Done recently: {recent.map((r) => `${r.service_name} (${new Date(r.ordered_at).toLocaleDateString()}, ${r.order_no})`).join(", ")}
          </div>
        )}

        <div className="lab-ob-discount-head">
          <Label>Discount</Label>
          <div className="lab-ob-segment small">
            <button type="button" className={discountType === "percent" ? "active" : ""} onClick={() => setDiscountType("percent")}>%</button>
            <button type="button" className={discountType === "flat" ? "active" : ""} onClick={() => setDiscountType("flat")}>Flat</button>
          </div>
        </div>
        <Input
          type="number"
          name="discount"
          aria-label="Discount"
          min={0}
          max={discountType === "percent" ? 100 : gross}
          placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 100"}
          value={discountVal}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9.]/g, "");
            setDiscountVal(raw === "" ? "" : Math.max(Number(raw) || 0, 0));
          }}
        />

        {serviceType === "HOME_VISIT" && (
          <div style={{ marginTop: "0.75rem" }}>
            <Label>Home visit fee (default {money(defaultFee)})</Label>
            <Input type="number" min={0} value={fee === "" ? defaultFee : fee} onChange={(e) => setFee(e.target.value === "" ? "" : Math.max(Number(e.target.value) || 0, 0))} />
          </div>
        )}

        <div className="lab-ob-totals">
          <div><span>Gross subtotal</span><span>{money(gross)}</span></div>
          <div><span>Discount</span><span>{discount > 0 ? `- ${money(discount)}` : money(0)}</span></div>
          {serviceType === "HOME_VISIT" && <div><span>Home visit fee</span><span>{money(visitFee)}</span></div>}
          <div className="lab-ob-total"><span>Total</span><span>{money(total)}</span></div>
        </div>

        <div className="lab-ob-patient-row" style={{ gridTemplateColumns: "1fr" }}>
          <div><Label>Priority</Label>
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>Routine</option><option>Urgent</option><option>STAT</option>
            </Select>
          </div>
          <div><Label>Remarks (Optional)</Label><Textarea rows={2} placeholder="Add remarks here..." value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        </div>

        <div className="lab-ob-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void saveDraft()}>Save Draft</Button>
          <Button variant="primary" disabled={busy} onClick={() => void generateInvoice()}>{busy ? "Working..." : "Generate Invoice"}</Button>
        </div>
        {draft && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Draft {draft.orderNo} saved.</p>}
      </aside>

      <CheckoutModal
        result={checkout}
        setNotice={setNotice}
        onReload={async () => { if (checkout) setCheckout(await loadOrderWithInvoice(checkout.order.id)); onOrderSaved(); }}
        onDone={() => { setCheckout(null); reset(); }}
      />
    </div>
  );
}

/** After Generate Invoice: the invoice, payment (Cash / Card / Online) and receipt. */
function CheckoutModal({ result, setNotice, onReload, onDone }: {
  result: { order: LabOrder; invoice: LabInvoice | null } | null;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onReload: () => Promise<void>;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<"cash" | "card" | "online">("cash");
  const [onlineMode, setOnlineMode] = useState("upi");
  const [amount, setAmount] = useState(0);
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);
  const invoice = result?.invoice || null;
  useEffect(() => { if (invoice) { setAmount(invoice.due_amount); setRef(""); } }, [invoice]);
  if (!result) return null;
  const { order } = result;

  const pay = async () => {
    if (!invoice) return;
    if (!(amount > 0) || amount > invoice.due_amount + 0.005) {
      setNotice({ type: "warning", message: `Enter an amount between 1 and ${money(invoice.due_amount)}.` });
      return;
    }
    const mode = method === "online" ? onlineMode : method;
    setSaving(true);
    try {
      await apiFetch(`/api/diag/invoices/${invoice.id}/payments`, {
        method: "POST", body: JSON.stringify({ amount, payment_mode: mode, gateway_ref: ref.trim() || undefined }),
      });
      setNotice({ type: "success", message: `Payment of ${money(amount)} recorded (${PAYMENT_MODES.find((m) => m.value === mode)?.label}).` });
      await onReload();
    } catch (err: any) {
      reportError(setNotice, err, "Could not record the payment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onDone} title={`Invoice ${invoice?.invoice_no || ""} - ${order.order_no}`}>
      <div className="lab-ob-totals" style={{ marginTop: 0 }}>
        <div><span>Patient</span><span>{order.patient_name || order.walkin_name}{order.patient_id ? ` (${order.patient_id})` : ""}</span></div>
        <div><span>Tests</span><span>{order.items.filter((i) => !i.cancelled_at).map((i) => i.service_name).join(", ")}</span></div>
        {Number(order.home_visit_fee || 0) > 0 && <div><span>Home visit fee</span><span>{money(order.home_visit_fee)}</span></div>}
        {invoice ? (
          <>
            <div className="lab-ob-total"><span>Total</span><span>{money(invoice.total_amount)}</span></div>
            <div><span>Paid</span><span>{money(invoice.paid_amount)}</span></div>
            <div><span>Balance due</span><strong>{money(invoice.due_amount)}</strong></div>
          </>
        ) : <div className="diag-note-box">Inpatient order: billed on the discharge bill, so no payment is taken here.</div>}
      </div>
      {invoice && invoice.due_amount > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <Label>Payment mode</Label>
          <div className="lab-ob-segment" style={{ marginBottom: "0.6rem" }}>
            {(["cash", "card", "online"] as const).map((m) => (
              <button key={m} type="button" className={method === m ? "active" : ""} onClick={() => setMethod(m)}>{m === "cash" ? "Cash" : m === "card" ? "Card" : "Online"}</button>
            ))}
          </div>
          <div className="lab-ob-patient-row" style={{ gridTemplateColumns: method === "online" ? "1fr 1fr" : "1fr" }}>
            {method === "online" && (
              <div><Label>Online method</Label>
                <Select value={onlineMode} onChange={(e) => setOnlineMode(e.target.value)}>
                  <option value="upi">UPI</option><option value="bank">Bank transfer</option>
                </Select>
              </div>
            )}
            <div><Label>Amount</Label><Input type="number" min={0} value={amount} readOnly aria-readonly="true" /></div>
          </div>
          {method !== "cash" && (
            <div style={{ marginTop: "0.5rem" }}><Label>Reference no. (optional)</Label><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Card slip / UPI / bank reference" /></div>
          )}
        </div>
      )}
      <div className="lab-ob-actions" style={{ marginTop: "1rem" }}>
        <Button variant="secondary" onClick={() => printLabInvoice(order, invoice)}>{invoice && invoice.due_amount <= 0 ? "Print receipt" : "Print invoice"}</Button>
        {invoice && invoice.due_amount > 0
          ? <Button variant="primary" disabled={saving} onClick={() => void pay()}>{saving ? "Saving..." : "Record payment"}</Button>
          : <Button variant="primary" onClick={onDone}>Done</Button>}
      </div>
      {invoice && invoice.due_amount > 0 && <button type="button" className="lab-ob-link" onClick={onDone}>Pay later (stays due in Order History)</button>}
    </Modal>
  );
}
