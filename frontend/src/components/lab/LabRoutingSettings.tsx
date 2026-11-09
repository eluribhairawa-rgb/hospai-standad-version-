// Catalogue: which machines run a test + its preferred partner lab, and Lab settings
// (home-visit fee, partner-lab cost per test).
import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Label, Select } from "../ui";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { money } from "./LabCheckout";
import type { Vendor } from "./LabCheckout";

type Equipment = { id: number; asset_id: string; name: string; operational_status: string; open_hold_scope?: string | null };
type ServiceRouting = {
  service_id: number; service_type: string; preferred_vendor_id: number | null; equipment: Equipment[];
};
type VendorRate = { id: number; vendor_id: number; vendor_name: string; service_id: number; service_code: string; service_name: string; patient_rate: number; cost: number; margin: number };
type ServiceOption = { id: number; code: string; name: string; service_type: string; rate: number };

const statusText = (e: Equipment) =>
  e.operational_status !== "ready" ? e.operational_status.replace("_", " ") : e.open_hold_scope ? "QC hold" : "ready";

export function ServiceRoutingEditor({ serviceId, setNotice }: { serviceId: number; setNotice: Dispatch<SetStateAction<Notice | null>> }) {
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [routing, setRouting] = useState<ServiceRouting | null>(null);
  const [linked, setLinked] = useState<number[]>([]);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch<{ equipment: Equipment[] }>("/api/diag/equipment"),
      apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list"),
      apiFetch<ServiceRouting>(`/api/diag/services/${serviceId}/routing`),
    ]).then(([e, v, r]) => {
      setAllEquipment(e.equipment || []);
      setVendors((v.vendors || []).filter((x) => (x.status || "active") === "active"));
      setRouting(r);
      setLinked(r.equipment.map((x) => x.id));
      setVendorId(r.preferred_vendor_id || "");
    }).catch((err) => reportError(setNotice, err, "Could not load processing settings."));
  }, [serviceId, setNotice]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiFetch<ServiceRouting>(`/api/diag/services/${serviceId}/routing`, {
        method: "PUT", body: JSON.stringify({ equipment_ids: linked, preferred_vendor_id: vendorId || null }),
      });
      setRouting(r);
      setNotice({ type: "success", message: "Processing settings saved." });
    } catch (err: any) {
      reportError(setNotice, err, "Could not save processing settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!routing) return <p className="muted">Loading...</p>;
  if (routing.service_type !== "LAB") return <p className="muted">Equipment links and partner labs apply to laboratory tests only.</p>;
  const toggle = (id: number) => setLinked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="diag-form-grid">
      <div className="diag-form-full">
        <Label>Equipment that can run this test</Label>
        <p className="muted" style={{ fontSize: 12 }}>
          Home-visit samples run in-house when at least one of these is ready with no open QC hold; otherwise they go to the preferred partner lab.
          With nothing ticked the test is always processed in-house.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
          {allEquipment.map((e) => (
            <label key={e.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={linked.includes(e.id)} onChange={() => toggle(e.id)} />
              {e.name} <span className="muted">({e.asset_id} · {statusText(routing.equipment.find((x) => x.id === e.id) || e)})</span>
            </label>
          ))}
          {allEquipment.length === 0 && <span className="muted">No equipment registered yet (Quality &amp; Equipment).</span>}
        </div>
      </div>
      <div className="diag-form-full">
        <Label>Preferred partner lab (when in-house equipment is unavailable)</Label>
        <Select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">None: staff choose when needed</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
        </Select>
      </div>
      <div className="diag-form-full"><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save processing settings"}</Button></div>
    </div>
  );
}

export function LabSettingsEditor({ services, setNotice }: { services: ServiceOption[]; setNotice: Dispatch<SetStateAction<Notice | null>> }) {
  const [fee, setFee] = useState<number | "">("");
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [rates, setRates] = useState<VendorRate[]>([]);
  const [newRate, setNewRate] = useState<{ vendor_id: number | ""; service_id: number | ""; cost: number | "" }>({ vendor_id: "", service_id: "", cost: "" });

  const loadRates = useCallback(() => {
    apiFetch<{ rates: VendorRate[] }>("/api/diag/vendor-rates").then((d) => setRates(d.rates || []))
      .catch((err) => reportError(setNotice, err, "Could not load partner-lab costs."));
  }, [setNotice]);

  useEffect(() => {
    apiFetch<{ home_visit_fee: number }>("/api/diag/settings").then((s) => setFee(s.home_visit_fee)).catch(() => {});
    apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list").then((v) => setVendors(v.vendors || [])).catch(() => {});
    loadRates();
  }, [loadRates]);

  const saveFee = async () => {
    try {
      const s = await apiFetch<{ home_visit_fee: number }>("/api/diag/settings", { method: "PUT", body: JSON.stringify({ home_visit_fee: fee === "" ? 0 : fee }) });
      setFee(s.home_visit_fee);
      setNotice({ type: "success", message: `Home visit fee set to ${money(s.home_visit_fee)}.` });
    } catch (err: any) {
      reportError(setNotice, err, "Could not save the home visit fee.");
    }
  };

  const saveRate = async (vendor_id: number | "", service_id: number | "", cost: number | "" | null) => {
    if (!vendor_id || !service_id) { setNotice({ type: "warning", message: "Select the partner lab and the test." }); return; }
    try {
      await apiFetch("/api/diag/vendor-rates", { method: "PUT", body: JSON.stringify({ vendor_id, service_id, cost: cost === "" ? null : cost }) });
      setNewRate({ vendor_id: "", service_id: "", cost: "" });
      loadRates();
    } catch (err: any) {
      reportError(setNotice, err, "Could not save the cost.");
    }
  };

  const labServices = services.filter((s) => s.service_type === "LAB");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="diag-note-box">
        <Label>Home visit convenience fee (default per visit)</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <Input type="number" min={0} value={fee} onChange={(e) => setFee(e.target.value === "" ? "" : Math.max(Number(e.target.value) || 0, 0))} />
          <Button variant="primary" onClick={() => void saveFee()}>Save</Button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Staff can change it on an individual visit.</span>
      </div>

      <div>
        <Label>Partner-lab cost per test (hospital's cost; the patient is billed the catalogue rate)</Label>
        <table className="diag-data-table">
          <thead><tr><th>Partner lab</th><th>Test</th><th>Patient rate</th><th>Cost</th><th>Margin</th><th></th></tr></thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id}>
                <td>{r.vendor_name}</td><td>{r.service_name} <span className="muted">({r.service_code})</span></td>
                <td>{money(r.patient_rate)}</td><td>{money(r.cost)}</td>
                <td style={{ color: r.margin < 0 ? "#b91c1c" : undefined }}>{money(r.margin)}</td>
                <td><Button size="sm" variant="ghost" onClick={() => void saveRate(r.vendor_id, r.service_id, null)}>Remove</Button></td>
              </tr>
            ))}
            <tr>
              <td><Select value={newRate.vendor_id} onChange={(e) => setNewRate({ ...newRate, vendor_id: e.target.value ? Number(e.target.value) : "" })}>
                <option value="">Partner lab</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </Select></td>
              <td><Select value={newRate.service_id} onChange={(e) => setNewRate({ ...newRate, service_id: e.target.value ? Number(e.target.value) : "" })}>
                <option value="">Test</option>{labServices.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
              </Select></td>
              <td>{newRate.service_id ? money(labServices.find((s) => s.id === newRate.service_id)?.rate) : "-"}</td>
              <td><Input type="number" min={0} style={{ width: 90 }} value={newRate.cost} onChange={(e) => setNewRate({ ...newRate, cost: e.target.value === "" ? "" : Number(e.target.value) })} /></td>
              <td />
              <td><Button size="sm" variant="primary" onClick={() => void saveRate(newRate.vendor_id, newRate.service_id, newRate.cost)}>Add / update</Button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
