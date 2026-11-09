import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Modal, Select, Tabs, TabsTrigger, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import {
  BasketTable, BillSummary, OrderResultPanel, PatientChooser, PaymentModal, ROUTING_LABELS, TestPicker,
  loadOrderWithInvoice, money, patientFields, printLabInvoice, useBillTotals, useDraftCheckout, useTestBasket,
} from "../components/lab/LabCheckout";
import type { LabInvoice, LabOrder, LabOrderItem, PatientChoice, Vendor } from "../components/lab/LabCheckout";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };
type View = "new" | "board" | "pending";
type BoardFilter = "today" | "upcoming" | "scheduled" | "collected" | "received" | "cancelled" | "all";
type Visit = {
  id: number; order_no: string; status: string; patient_id?: string | null; patient_name?: string; patient_phone?: string;
  visit_address: string; visit_scheduled_at: string; visit_status: string; visit_collected_by?: string; visit_collected_at?: string;
  home_visit_fee: number; invoice_id?: number | null; invoice_no?: string; total_amount?: number; paid_amount?: number;
  due_amount?: number; payment_status?: string; items: LabOrderItem[];
};
type RoutingOutcome = { item_id: number; service_name: string; routing: string; reason: string; vendor_name?: string | null };
type PendingItem = { item_id: number; service_name: string; routing_reason: string; order_no: string; patient_name?: string; patient_id?: string };

const VISIT_BADGE: Record<string, string> = {
  scheduled: "diag-badge-warning", collected: "diag-badge-info", received: "diag-badge-active", cancelled: "diag-badge-muted",
};
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function LabHomeVisitsPage({ setNotice }: Props) {
  const [view, setView] = useState<View>("new");
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = useCallback(() => {
    apiFetch<{ items: PendingItem[] }>("/api/diag/routing/pending-vendor", { background: true })
      .then((d) => setPendingCount((d.items || []).length)).catch(() => {});
  }, []);
  useEffect(() => { refreshPendingCount(); }, [refreshPendingCount, view]);

  return (
    <div className="diag-page">
      <Tabs>
        <TabsTrigger active={view === "new"} onClick={() => setView("new")}>New home visit</TabsTrigger>
        <TabsTrigger active={view === "board"} onClick={() => setView("board")}>Visit board</TabsTrigger>
        <TabsTrigger active={view === "pending"} onClick={() => setView("pending")}>
          Needs partner lab{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </TabsTrigger>
      </Tabs>
      {view === "new" && <NewHomeVisit setNotice={setNotice} onOpenBoard={() => setView("board")} />}
      {view === "board" && <VisitBoard setNotice={setNotice} onRouted={refreshPendingCount} />}
      {view === "pending" && <PendingVendorQueue setNotice={setNotice} onChange={refreshPendingCount} />}
    </div>
  );
}

// ------------------------------------------------------------------ new visit --

function NewHomeVisit({ setNotice, onOpenBoard }: { setNotice: Props["setNotice"]; onOpenBoard: () => void }) {
  const [patient, setPatient] = useState<PatientChoice>({ mode: "walkin", name: "", mobile: "", age: "", gender: "" });
  const [address, setAddress] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600 * 1000)));
  const [defaultFee, setDefaultFee] = useState(0);
  const [fee, setFee] = useState<number | "">("");
  const [result, setResult] = useState<{ order: LabOrder; invoice: LabInvoice | null } | null>(null);
  const { services, basket, add, update, remove, clear } = useTestBasket(setNotice);
  const effectiveFee = fee === "" ? defaultFee : fee;
  const bill = useBillTotals(basket, effectiveFee);
  const { checkout, busy, resetDraft } = useDraftCheckout("/api/diag/service-orders");

  useEffect(() => {
    apiFetch<{ home_visit_fee: number }>("/api/diag/settings").then((s) => setDefaultFee(Number(s.home_visit_fee) || 0)).catch(() => {});
  }, []);

  // Prefill the service address from the registered patient's record.
  useEffect(() => {
    if (patient.mode === "registered" && patient.patient?.address && !address.trim()) setAddress(patient.patient.address);
  }, [patient, address]);

  const submit = async () => {
    try {
      if (address.trim().length < 5) throw new Error("Enter the full service address.");
      if (!when) throw new Error("Select the visit date and time.");
      if (new Date(when).getTime() < Date.now() - 15 * 60 * 1000) throw new Error("The visit date and time cannot be in the past.");
      if (basket.length === 0) throw new Error("Add at least one test.");
      const payload = {
        service_type: "HOME_VISIT", ...patientFields(patient), visit_address: address.trim(), visit_scheduled_at: when,
        home_visit_fee: effectiveFee, items: bill.itemsForApi(), notes: bill.discountNote,
      };
      const res = await checkout(payload);
      setResult(res);
      setNotice({ type: "success", message: `Home visit ${res.order.order_no} booked for ${new Date(when).toLocaleString()}. Invoice ${money(res.invoice?.total_amount)}.` });
    } catch (err: any) {
      reportError(setNotice, err, "Could not book the home visit.");
    }
  };

  const startNew = () => {
    setResult(null); clear(); bill.reset(); resetDraft(); setFee(""); setAddress("");
    setWhen(toLocalInput(new Date(Date.now() + 2 * 3600 * 1000)));
    setPatient({ mode: "walkin", name: "", mobile: "", age: "", gender: "" });
  };

  if (result) {
    return (
      <>
        <OrderResultPanel result={result} setNotice={setNotice} onNew={startNew}
          onReload={() => void loadOrderWithInvoice(result.order.id).then(setResult).catch((err) => reportError(setNotice, err, "Could not reload the order."))} />
        <div className="diag-form-actions"><Button variant="secondary" onClick={onOpenBoard}>Open visit board</Button></div>
      </>
    );
  }

  return (
    <div className="diag-split diag-split-wide">
      <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
        <PatientChooser value={patient} onChange={setPatient} />
        <div className="diag-card">
          <div className="diag-card-header"><h3>Visit details</h3></div>
          <div className="diag-form-grid">
            <div className="diag-form-full"><Label>Service address *</Label>
              <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House no, street, area, landmark, city" />
            </div>
            <div><Label>Visit date &amp; time *</Label>
              <Input type="datetime-local" value={when} min={toLocalInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="diag-card">
          <div className="diag-card-header"><h3>Select tests</h3></div>
          <TestPicker services={services} onAdd={add} />
          <div className="diag-section-title">Selected tests</div>
          <BasketTable basket={basket} onUpdate={update} onRemove={remove} />
        </div>
      </div>
      <BillSummary
        bill={bill}
        feeLabel="Home visit fee"
        feeEditor={(
          <div className="diag-note-box" style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <strong>Home visit fee</strong>
            <Input type="number" min={0} value={fee === "" ? defaultFee : fee} onChange={(e) => setFee(e.target.value === "" ? "" : Math.max(Number(e.target.value) || 0, 0))} />
            <span className="muted" style={{ fontSize: 12 }}>Default from Lab settings: {money(defaultFee)}</span>
          </div>
        )}
        note="When the samples reach the lab, each test runs in-house if its analyser is available, otherwise it is sent to the test's partner lab, on this same order."
      >
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Working..." : "Book visit & generate invoice"}</Button>
      </BillSummary>
    </div>
  );
}

// ---------------------------------------------------------------- visit board --

function VisitBoard({ setNotice, onRouted }: { setNotice: Props["setNotice"]; onRouted: () => void }) {
  const [filter, setFilter] = useState<BoardFilter>("today");
  const [search, setSearch] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(false);
  const [collectFor, setCollectFor] = useState<Visit | null>(null);
  const [identityOk, setIdentityOk] = useState(false);
  const [collectNotes, setCollectNotes] = useState("");
  const [rescheduleFor, setRescheduleFor] = useState<Visit | null>(null);
  const [newWhen, setNewWhen] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [cancelFor, setCancelFor] = useState<Visit | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [routing, setRouting] = useState<{ visit: Visit; outcomes: RoutingOutcome[] } | null>(null);
  const [payFor, setPayFor] = useState<LabInvoice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const today = isoDate(new Date());
      if (filter === "today") { params.set("date_from", today); params.set("date_to", today); }
      if (filter === "upcoming") params.set("date_from", today);
      if (["scheduled", "collected", "received", "cancelled"].includes(filter)) params.set("visit_status", filter);
      if (filter === "upcoming") params.set("visit_status", "scheduled");
      if (search.trim()) params.set("q", search.trim());
      const data = await apiFetch<{ visits: Visit[] }>(`/api/diag/home-visits?${params.toString()}`);
      setVisits(data.visits || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load home visits.");
    } finally {
      setLoading(false);
    }
  }, [filter, search, setNotice]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const act = async (visit: Visit, fn: () => Promise<void>) => {
    setBusyId(visit.id);
    try { await fn(); await load(); } finally { setBusyId(null); }
  };

  const collect = () => collectFor && act(collectFor, async () => {
    try {
      await apiFetch(`/api/diag/home-visits/${collectFor.id}/collect`, {
        method: "POST", body: JSON.stringify({ identity_verified: identityOk, collection_notes: collectNotes || undefined }),
      });
      setNotice({ type: "success", message: `Samples collected for ${collectFor.order_no}.` });
      setCollectFor(null);
    } catch (err: any) { reportError(setNotice, err, "Could not mark samples collected."); }
  });

  const receive = (visit: Visit) => act(visit, async () => {
    try {
      const res = await apiFetch<{ routing: RoutingOutcome[] }>(`/api/diag/home-visits/${visit.id}/receive`, { method: "POST", body: JSON.stringify({}) });
      setRouting({ visit, outcomes: res.routing || [] });
      onRouted();
    } catch (err: any) { reportError(setNotice, err, "Could not receive the samples."); }
  });

  const reschedule = () => rescheduleFor && act(rescheduleFor, async () => {
    try {
      await apiFetch(`/api/diag/home-visits/${rescheduleFor.id}/reschedule`, {
        method: "POST", body: JSON.stringify({ visit_scheduled_at: newWhen, visit_address: newAddress }),
      });
      setNotice({ type: "success", message: `${rescheduleFor.order_no} rescheduled to ${new Date(newWhen).toLocaleString()}.` });
      setRescheduleFor(null);
    } catch (err: any) { reportError(setNotice, err, "Could not reschedule."); }
  });

  const cancel = () => cancelFor && act(cancelFor, async () => {
    try {
      const res = await apiFetch<{ refund_amount: number }>(`/api/diag/home-visits/${cancelFor.id}/cancel`, {
        method: "POST", body: JSON.stringify({ reason: cancelReason }),
      });
      setNotice({ type: "success", message: `${cancelFor.order_no} cancelled.${res.refund_amount > 0 ? ` Refund ${money(res.refund_amount)} recorded.` : ""}` });
      setCancelFor(null);
    } catch (err: any) { reportError(setNotice, err, "Could not cancel the visit."); }
  });

  const printVisit = async (visit: Visit) => {
    try {
      const { order, invoice } = await loadOrderWithInvoice(visit.id);
      printLabInvoice(order, invoice);
    } catch (err: any) { reportError(setNotice, err, "Could not load the invoice."); }
  };

  const filters: { key: BoardFilter; label: string }[] = [
    { key: "today", label: "Today" }, { key: "upcoming", label: "Upcoming" }, { key: "collected", label: "Collected" },
    { key: "received", label: "Received" }, { key: "cancelled", label: "Cancelled" }, { key: "all", label: "All" },
  ];

  return (
    <div className="diag-card">
      <div className="diag-card-header"><h3>Home visits</h3></div>
      <div className="diag-filters-row" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        {filters.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? "primary" : "secondary"} onClick={() => setFilter(f.key)}>{f.label}</Button>
        ))}
        <div style={{ flex: 1, minWidth: 200 }}><Input placeholder="Search name, UHID, mobile or order no" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      <div className="diag-table-card" style={{ overflowX: "auto" }}>
        <table className="diag-data-table">
          <thead><tr><th>Visit</th><th>Patient</th><th>Address</th><th>Tests</th><th>Bill</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="diag-empty">Loading...</td></tr>}
            {!loading && visits.length === 0 && <tr><td colSpan={7} className="diag-empty">No home visits for this filter.</td></tr>}
            {!loading && visits.map((v) => {
              const active = v.items.filter((i) => !i.cancelled_at);
              const isBusy = busyId === v.id;
              return (
                <tr key={v.id}>
                  <td><strong>{new Date(v.visit_scheduled_at).toLocaleString()}</strong><div className="muted">{v.order_no}</div></td>
                  <td>{v.patient_name || "-"}<div className="muted">{v.patient_id ? `UHID ${v.patient_id}` : "Walk-in"}{v.patient_phone ? ` · ${v.patient_phone}` : ""}</div></td>
                  <td style={{ maxWidth: 220 }}>{v.visit_address}</td>
                  <td>
                    {active.map((i) => (
                      <div key={i.id}>{i.service_name}{i.routing && (
                        <span className={`diag-badge ${i.routing === "outsourced" ? "diag-badge-warning" : i.routing === "pending_vendor" ? "diag-badge-critical" : "diag-badge-active"}`} style={{ marginLeft: 6 }}
                          title={i.routing_reason || ""}>{ROUTING_LABELS[i.routing]}{i.routing_vendor_name ? `: ${i.routing_vendor_name}` : ""}</span>
                      )}</div>
                    ))}
                  </td>
                  <td>
                    {v.status === "draft" ? <span className="muted">Draft (not billed)</span> : (
                      <>{money(v.total_amount)}<div className="muted">{v.payment_status}{(v.due_amount || 0) > 0 ? ` · due ${money(v.due_amount)}` : ""}</div></>
                    )}
                  </td>
                  <td><span className={`diag-badge ${VISIT_BADGE[v.visit_status] || "diag-badge-muted"}`}>{v.visit_status}</span>
                    {v.visit_collected_by && <div className="muted">by {v.visit_collected_by}</div>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {v.status === "confirmed" && v.visit_status === "scheduled" && (
                      <Button size="sm" variant="primary" disabled={isBusy} onClick={() => { setCollectFor(v); setIdentityOk(false); setCollectNotes(""); }}>Collect</Button>
                    )}
                    {v.visit_status === "collected" && <Button size="sm" variant="primary" disabled={isBusy} onClick={() => void receive(v)}>Receive at lab</Button>}
                    {v.visit_status === "scheduled" && v.status !== "cancelled" && (
                      <>
                        <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => { setRescheduleFor(v); setNewWhen(toLocalInput(new Date(v.visit_scheduled_at))); setNewAddress(v.visit_address); }}>Reschedule</Button>
                        <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => { setCancelFor(v); setCancelReason(""); }}>Cancel</Button>
                      </>
                    )}
                    {v.invoice_id && (v.due_amount || 0) > 0 && v.visit_status !== "cancelled" && (
                      <Button size="sm" variant="secondary" onClick={() => setPayFor({ id: v.invoice_id!, invoice_no: v.invoice_no || "", total_amount: v.total_amount || 0, paid_amount: v.paid_amount || 0, due_amount: v.due_amount || 0, payment_status: v.payment_status || "" })}>Pay</Button>
                    )}
                    {v.invoice_id && <Button size="sm" variant="ghost" onClick={() => void printVisit(v)}>Print</Button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal open={!!collectFor} onClose={() => setCollectFor(null)} title={`Collect samples - ${collectFor?.order_no || ""}`}>
        <div className="diag-form-grid">
          <div className="diag-form-full">
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={identityOk} onChange={(e) => setIdentityOk(e.target.checked)} />
              Patient identity verified ({collectFor?.patient_name})
            </label>
          </div>
          <div className="diag-form-full"><Label>Collection notes</Label><Textarea rows={2} value={collectNotes} onChange={(e) => setCollectNotes(e.target.value)} /></div>
          <div className="diag-form-full"><Button variant="primary" disabled={!identityOk} onClick={() => void collect()}>Mark samples collected</Button></div>
        </div>
      </Modal>

      <Modal open={!!rescheduleFor} onClose={() => setRescheduleFor(null)} title={`Reschedule - ${rescheduleFor?.order_no || ""}`}>
        <div className="diag-form-grid">
          <div><Label>New date &amp; time</Label><Input type="datetime-local" value={newWhen} min={toLocalInput(new Date())} onChange={(e) => setNewWhen(e.target.value)} /></div>
          <div className="diag-form-full"><Label>Service address</Label><Textarea rows={2} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} /></div>
          <div className="diag-form-full"><Button variant="primary" onClick={() => void reschedule()}>Save</Button></div>
        </div>
      </Modal>

      <Modal open={!!cancelFor} onClose={() => setCancelFor(null)} title={`Cancel home visit - ${cancelFor?.order_no || ""}`}>
        <div className="diag-form-grid">
          <div className="diag-form-full"><Label>Reason *</Label><Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></div>
          <div className="diag-form-full muted">All tests and the visit fee are cancelled; anything already paid is refunded in the original payment mode.</div>
          <div className="diag-form-full"><Button variant="destructive" disabled={!cancelReason.trim()} onClick={() => void cancel()}>Cancel visit</Button></div>
        </div>
      </Modal>

      <Modal open={!!routing} onClose={() => setRouting(null)} title={`Samples received - ${routing?.visit.order_no || ""}`}>
        <table className="diag-data-table">
          <thead><tr><th>Test</th><th>Processed</th><th>Why</th></tr></thead>
          <tbody>
            {(routing?.outcomes || []).map((o) => (
              <tr key={o.item_id}>
                <td>{o.service_name}</td>
                <td><strong>{ROUTING_LABELS[o.routing] || o.routing}</strong>{o.vendor_name ? ` - ${o.vendor_name}` : ""}</td>
                <td className="muted">{o.reason}</td>
              </tr>
            ))}
            {routing && routing.outcomes.length === 0 && <tr><td colSpan={3} className="diag-empty">No laboratory tests to route.</td></tr>}
          </tbody>
        </table>
        {routing?.outcomes.some((o) => o.routing === "pending_vendor") && (
          <div className="diag-note-box">Some tests have no available analyser and no preferred partner lab. Assign one under "Needs partner lab".</div>
        )}
      </Modal>

      <PaymentModal invoice={payFor} open={!!payFor} onClose={() => setPayFor(null)} setNotice={setNotice}
        onPaid={() => { setPayFor(null); void load(); }} />
    </div>
  );
}

// ------------------------------------------------------- pending partner lab --

function PendingVendorQueue({ setNotice, onChange }: { setNotice: Props["setNotice"]; onChange: () => void }) {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [choice, setChoice] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, v] = await Promise.all([
        apiFetch<{ items: PendingItem[] }>("/api/diag/routing/pending-vendor"),
        apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list"),
      ]);
      setItems(p.items || []);
      setVendors((v.vendors || []).filter((x) => (x.status || "active") === "active"));
    } catch (err: any) {
      reportError(setNotice, err, "Could not load tests awaiting a partner lab.");
    } finally {
      setLoading(false);
    }
  }, [setNotice]);
  useEffect(() => { void load(); }, [load]);

  const assign = async (item: PendingItem) => {
    const vendorId = choice[item.item_id];
    if (!vendorId) { setNotice({ type: "warning", message: "Select a partner lab." }); return; }
    try {
      await apiFetch(`/api/diag/order-items/${item.item_id}/assign-vendor`, { method: "POST", body: JSON.stringify({ vendor_id: vendorId }) });
      setNotice({ type: "success", message: `${item.service_name} (${item.order_no}) sent to ${vendors.find((v) => v.id === vendorId)?.vendor_name}.` });
      await load();
      onChange();
    } catch (err: any) {
      reportError(setNotice, err, "Could not assign the partner lab.");
    }
  };

  const empty = useMemo(() => !loading && items.length === 0, [loading, items]);
  return (
    <div className="diag-card">
      <div className="diag-card-header"><h3>Tests waiting for a partner lab</h3></div>
      <p className="muted">These tests could not run in-house (analyser unavailable) and the test has no preferred partner lab set in the catalogue.</p>
      <table className="diag-data-table">
        <thead><tr><th>Order</th><th>Patient</th><th>Test</th><th>Why</th><th>Partner lab</th><th></th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="diag-empty">Loading...</td></tr>}
          {empty && <tr><td colSpan={6} className="diag-empty">Nothing waiting.</td></tr>}
          {items.map((i) => (
            <tr key={i.item_id}>
              <td>{i.order_no}</td>
              <td>{i.patient_name || "-"}{i.patient_id && <div className="muted">UHID {i.patient_id}</div>}</td>
              <td>{i.service_name}</td>
              <td className="muted" style={{ maxWidth: 260 }}>{i.routing_reason}</td>
              <td>
                <Select value={choice[i.item_id] || ""} onChange={(e) => setChoice((c) => ({ ...c, [i.item_id]: Number(e.target.value) }))}>
                  <option value="">-- Select --</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </Select>
              </td>
              <td><Button size="sm" variant="primary" onClick={() => void assign(i)}>Send</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
