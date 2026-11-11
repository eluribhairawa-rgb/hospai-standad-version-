import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Button, Input, Label, Modal } from "../../components/ui";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type Claim = {
  id: number;
  invoice_id: number;
  invoice_no: string;
  patient_id: string;
  patient_name: string;
  admission_id: number | null;
  insurer_name: string;
  membership_ref: string | null;
  authorization_ref: string | null;
  claim_amount: number;
  claim_status: string;
  settlement_status: string | null;
  patient_responsibility: number | null;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
  payment_status: string;
  submitted_at: string;
  stock_deducted: boolean;
  notes: string | null;
};

type Action =
  | { kind: "settle"; claim: Claim }
  | { kind: "close"; claim: Claim; outcome: "rejected" | "closed" }
  | { kind: "collect"; claim: Claim };

const money = (n: number | null | undefined) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isFinished = (c: Claim) => ["rejected", "closed", "settled"].includes(c.claim_status) || c.settlement_status === "paid";

function statusChip(c: Claim) {
  if (c.claim_status === "rejected") return { label: "Rejected", bg: "#fee2e2", fg: "#b91c1c" };
  if (c.claim_status === "closed") return { label: "Closed (short)", bg: "#fef3c7", fg: "#92400e" };
  if (c.settlement_status === "paid") return { label: "Settled", bg: "#dcfce7", fg: "#15803d" };
  if (c.settlement_status === "part_paid") return { label: "Part paid", bg: "#e0f2fe", fg: "#0369a1" };
  return { label: "Awaiting insurer", bg: "#ede9fe", fg: "#6d28d9" };
}

export default function PharmacyInsuranceClaims({ setNotice }: Props) {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [mode, setMode] = useState("bank_transfer");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ claims: Claim[] }>(`/api/pharmacy/insurance-claims?status=${tab}`);
      setClaims(res.claims || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load insurance claims.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return claims;
    return claims.filter((c) =>
      [c.patient_name, c.patient_id, c.invoice_no, c.insurer_name, c.membership_ref, c.authorization_ref]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
  }, [claims, search]);

  const totals = useMemo(() => ({
    count: shown.length,
    due: shown.reduce((s, c) => s + Number(c.due_amount || 0), 0),
    awaitingStock: shown.filter((c) => !c.stock_deducted).length,
  }), [shown]);

  const openAction = (a: Action) => {
    setAction(a);
    setAmount(a.kind === "close" ? "" : String(Number(a.claim.due_amount || 0).toFixed(2)));
    setReference("");
    setReason("");
    setMode(a.kind === "collect" ? "cash" : "bank_transfer");
  };

  const submit = async () => {
    if (!action) return;
    const c = action.claim;
    setSaving(true);
    try {
      if (action.kind === "settle") {
        const amt = Number(amount);
        if (!amt || amt <= 0) throw new Error("Enter the amount received from the insurer.");
        const res = await apiFetch<{ settlement_status: string }>(`/api/pharmacy/insurance-cases/${c.id}/settle`, {
          method: "POST",
          body: JSON.stringify({ amount: amt, reference: reference.trim() || undefined, payment_mode: mode }),
        });
        setNotice({
          type: "success",
          message: res.settlement_status === "paid"
            ? `Claim ${c.invoice_no} fully settled. Stock for these medicines has now been deducted.`
            : `Insurer payment of ${money(amt)} recorded. Stock is deducted once the claim is fully settled, rejected or closed.`,
        });
      } else if (action.kind === "close") {
        if (!reason.trim()) throw new Error("Enter a reason.");
        const res = await apiFetch<{ patient_payable: number }>(`/api/pharmacy/insurance-cases/${c.id}/close`, {
          method: "POST",
          body: JSON.stringify({ outcome: action.outcome, reason: reason.trim() }),
        });
        setNotice({
          type: "success",
          message: `Claim ${action.outcome === "rejected" ? "rejected" : "closed"}. Stock deducted. ${money(res.patient_payable)} is now payable by the patient on ${c.invoice_no}.`,
        });
      } else {
        const amt = Number(amount);
        if (!amt || amt <= 0) throw new Error("Enter the amount collected from the patient.");
        await apiFetch(`/api/pharmacy/invoices/${c.invoice_id}/payments`, {
          method: "POST",
          body: JSON.stringify({ amount: amt, payment_mode: mode, gateway_ref: reference.trim() || undefined }),
        });
        setNotice({ type: "success", message: `${money(amt)} collected from the patient on ${c.invoice_no}.` });
      }
      setAction(null);
      void load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const th: React.CSSProperties = { textAlign: "left", padding: "10px 12px", fontSize: "12px", color: "#475569", fontWeight: 700, borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 12px", fontSize: "13px", color: "#0f172a", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" };
  const linkBtn = (color: string): React.CSSProperties => ({ background: "none", border: "none", color, fontWeight: 700, fontSize: "12px", cursor: "pointer", padding: "2px 4px" });

  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", margin: 0 }}>Pharmacy Insurance Claims</h1>
          <p style={{ fontSize: "13px", color: "#64748b", margin: "4px 0 0" }}>
            Medicines billed to insurance stay as Due and are not deducted from stock until the claim is settled, rejected or closed.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, UHID, invoice, insurer, policy" style={{ minWidth: "260px" }} />
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
        {(["open", "closed"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "7px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 700, cursor: "pointer",
              border: `1.5px solid ${tab === t ? "#00828a" : "#cbd5e1"}`, background: tab === t ? "#e6f6f7" : "#fff", color: tab === t ? "#00666c" : "#475569",
            }}
          >
            {t === "open" ? "Open claims" : "Finished claims"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: "13px", color: "#475569", alignSelf: "center" }}>
          {totals.count} claim(s) · Due {money(totals.due)}
          {totals.awaitingStock > 0 && <> · <strong style={{ color: "#6d28d9" }}>{totals.awaitingStock} awaiting stock deduction</strong></>}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: "12px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Invoice / Date</th>
              <th style={th}>Patient</th>
              <th style={th}>Insurer / Policy</th>
              <th style={th}>Claim</th>
              <th style={th}>Paid</th>
              <th style={th}>Due</th>
              <th style={th}>Status</th>
              <th style={th}>Stock</th>
              <th style={{ ...th, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={{ ...td, textAlign: "center", color: "#64748b" }} colSpan={9}>Loading claims…</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td style={{ ...td, textAlign: "center", color: "#64748b" }} colSpan={9}>No {tab === "open" ? "open" : "finished"} pharmacy insurance claims.</td></tr>
            )}
            {!loading && shown.map((c) => {
              const chip = statusChip(c);
              const finished = isFinished(c);
              const patientOwes = finished && Number(c.due_amount || 0) > 0;
              return (
                <tr key={c.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 700 }}>{c.invoice_no}</div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>{String(c.submitted_at || "").slice(0, 16).replace("T", " ")}</div>
                  </td>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{c.patient_name || "-"}</div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>{c.patient_id}{c.admission_id ? ` · IP #${c.admission_id}` : " · OP"}</div>
                  </td>
                  <td style={td}>
                    <div>{c.insurer_name}</div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      {c.membership_ref ? `Policy ${c.membership_ref}` : "No policy no."}{c.authorization_ref ? ` · Pre-auth ${c.authorization_ref}` : ""}
                    </div>
                  </td>
                  <td style={td}>{money(c.claim_amount)}</td>
                  <td style={td}>{money(c.paid_amount)}</td>
                  <td style={{ ...td, fontWeight: 700, color: Number(c.due_amount) > 0 ? "#b45309" : "#15803d" }}>
                    {money(c.due_amount)}
                    {patientOwes && <div style={{ fontSize: "11px", fontWeight: 600, color: "#b91c1c" }}>payable by patient</div>}
                  </td>
                  <td style={td}>
                    <span style={{ background: chip.bg, color: chip.fg, borderRadius: "999px", padding: "2px 10px", fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap" }}>
                      {chip.label}
                    </span>
                  </td>
                  <td style={{ ...td, fontSize: "12px", fontWeight: 600, color: c.stock_deducted ? "#15803d" : "#6d28d9", whiteSpace: "nowrap" }}>
                    {c.stock_deducted ? "Deducted" : "Not deducted"}
                  </td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    {!finished && (
                      <>
                        <button type="button" style={linkBtn("#00828a")} onClick={() => openAction({ kind: "settle", claim: c })}>Record payment</button>
                        <button type="button" style={linkBtn("#b45309")} onClick={() => openAction({ kind: "close", claim: c, outcome: "closed" })}>Close short</button>
                        <button type="button" style={linkBtn("#b91c1c")} onClick={() => openAction({ kind: "close", claim: c, outcome: "rejected" })}>Reject</button>
                      </>
                    )}
                    {patientOwes && (
                      <button type="button" style={linkBtn("#00828a")} onClick={() => openAction({ kind: "collect", claim: c })}>Collect from patient</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {action && (
        <Modal
          open
          onClose={() => setAction(null)}
          title={
            action.kind === "settle" ? `Record insurer payment · ${action.claim.invoice_no}`
              : action.kind === "collect" ? `Collect from patient · ${action.claim.invoice_no}`
              : action.outcome === "rejected" ? `Reject claim · ${action.claim.invoice_no}` : `Close claim short · ${action.claim.invoice_no}`
          }
        >
          <div style={{ padding: "0.25rem 0", display: "grid", gap: "12px" }}>
            <div style={{ fontSize: "13px", color: "#475569" }}>
              {action.claim.patient_name} ({action.claim.patient_id}) · {action.claim.insurer_name} · Due <strong>{money(action.claim.due_amount)}</strong>
            </div>
            {action.kind === "close" ? (
              <>
                <div style={{ fontSize: "13px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "8px", padding: "10px", color: "#9a3412" }}>
                  {action.outcome === "rejected"
                    ? "The insurer will pay nothing more on this claim."
                    : "Final settlement: what the insurer has paid so far is all it will pay."}{" "}
                  The medicines' stock is deducted now, and the unpaid {money(action.claim.due_amount)} becomes payable by the patient on this invoice.
                </div>
                <div>
                  <Label>Reason <span style={{ color: "#ef4444" }}>*</span></Label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action.outcome === "rejected" ? "e.g. Policy lapsed / not covered" : "e.g. Co-pay / deduction by TPA"} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label>Amount <span style={{ color: "#ef4444" }}>*</span></Label>
                  <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <Label>Payment mode</Label>
                    <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "100%", height: "40px", borderRadius: "8px", border: "1px solid #cbd5e1", padding: "0 8px", fontSize: "13px" }}>
                      {(action.kind === "settle" ? ["bank_transfer", "cheque", "net_banking"] : ["cash", "upi", "card", "bank_transfer"]).map((m) => (
                        <option key={m} value={m}>{m.replace("_", " ").toUpperCase()}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Reference</Label>
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={action.kind === "settle" ? "UTR / settlement ref." : "Receipt / txn ref."} />
                  </div>
                </div>
                {action.kind === "settle" && (
                  <div style={{ fontSize: "12px", color: "#64748b" }}>
                    When the full due amount is received, the claim is marked settled and the stock is deducted.
                  </div>
                )}
              </>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <Button variant="secondary" onClick={() => setAction(null)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void submit()} disabled={saving}>
                {saving ? "Saving…" : action.kind === "close" ? (action.outcome === "rejected" ? "Reject claim" : "Close claim") : "Save"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
