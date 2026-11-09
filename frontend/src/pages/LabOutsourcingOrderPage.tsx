import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Label, Select } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";
import {
  BasketTable, BillSummary, OrderResultPanel, PatientChooser, TestPicker,
  loadOrderWithInvoice, money, patientFields, useBillTotals, useDraftCheckout, useTestBasket,
} from "../components/lab/LabCheckout";
import type { LabInvoice, LabOrder, PatientChoice, Vendor } from "../components/lab/LabCheckout";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };
type VendorRate = { vendor_id: number; service_id: number; cost: number };

// Outsourcing: tests collected here and sent to a partner laboratory. Patient is billed at catalogue rates.
export default function LabOutsourcingOrderPage({ setNotice }: Props) {
  const [patient, setPatient] = useState<PatientChoice>({ mode: "registered", patient: null });
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [rates, setRates] = useState<VendorRate[] | null>(null); // null = not permitted / not loaded
  const [result, setResult] = useState<{ order: LabOrder; invoice: LabInvoice | null } | null>(null);
  const { services, basket, add, update, remove, clear } = useTestBasket(setNotice);
  const bill = useBillTotals(basket);
  const { checkout, busy, resetDraft } = useDraftCheckout("/api/diag/service-orders");

  useEffect(() => {
    apiFetch<{ vendors: Vendor[] }>("/api/lab/vendors-list")
      .then((d) => setVendors((d.vendors || []).filter((v) => (v.status || "active") === "active")))
      .catch((err) => reportError(setNotice, err, "Could not load partner laboratories."));
    // Hospital cost per partner lab is visible to catalogue managers only; others simply don't see the column.
    apiFetch<{ rates: VendorRate[] }>("/api/diag/vendor-rates", { background: true })
      .then((d) => setRates(d.rates || []))
      .catch(() => setRates(null));
  }, [setNotice]);

  const costOf = useCallback((serviceId: number, vid: number | null | undefined) =>
    rates?.find((r) => r.service_id === serviceId && r.vendor_id === vid)?.cost, [rates]);

  const marginTotal = useMemo(() => {
    if (!rates) return null;
    let margin = 0;
    for (const b of basket) {
      const cost = costOf(b.service_id, b.vendor_id || (vendorId || null));
      if (cost === undefined) return null;
      margin += b.rate * b.quantity - b.discount - cost * b.quantity;
    }
    return margin - bill.totals.billDiscount;
  }, [rates, basket, vendorId, costOf, bill.totals.billDiscount]);

  const submit = async () => {
    try {
      if (!vendorId) throw new Error("Select the partner laboratory.");
      if (basket.length === 0) throw new Error("Add at least one test.");
      const payload = {
        service_type: "OUTSOURCING", outsource_vendor_id: vendorId, ...patientFields(patient),
        items: bill.itemsForApi(), notes: bill.discountNote,
      };
      const res = await checkout(payload);
      setResult(res);
      setNotice({ type: "success", message: `Invoice generated for ${res.order.order_no}: ${money(res.invoice?.total_amount)}. Record the payment below.` });
    } catch (err: any) {
      reportError(setNotice, err, "Could not create the outsourcing order.");
    }
  };

  const startNew = () => {
    setResult(null); clear(); bill.reset(); resetDraft(); setVendorId(""); setPatient({ mode: "registered", patient: null });
  };

  if (result) {
    return (
      <div className="diag-page">
        <OrderResultPanel result={result} setNotice={setNotice} onNew={startNew}
          onReload={() => void loadOrderWithInvoice(result.order.id).then(setResult).catch((err) => reportError(setNotice, err, "Could not reload the order."))} />
        <div className="diag-note-box">
          Collect the sample from the Laboratory worklist. When it is received at the lab, each test is dispatched to its partner lab
          and appears under External referrals; enter or upload the partner lab's results on the same test.
        </div>
      </div>
    );
  }

  return (
    <div className="diag-page">
      <div className="diag-split diag-split-wide">
        <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
          <PatientChooser value={patient} onChange={setPatient} />

          <div className="diag-card">
            <div className="diag-card-header"><h3>Partner laboratory</h3></div>
            <Label>Send tests to *</Label>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">-- Select partner lab --</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
            </Select>
            {vendors.length === 0 && <p className="muted">No partner laboratories configured. Add them under Laboratory vendors.</p>}
          </div>

          <div className="diag-card">
            <div className="diag-card-header"><h3>Select tests</h3></div>
            <TestPicker services={services} onAdd={add} labOnly />
            <div className="diag-section-title">Selected tests</div>
            <BasketTable
              basket={basket} onUpdate={update} onRemove={remove}
              extraHeader={rates ? "Partner lab / cost" : "Partner lab"}
              renderExtra={(b) => {
                const effective = b.vendor_id || (vendorId || null);
                const cost = costOf(b.service_id, effective);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <Select value={b.vendor_id || ""} onChange={(e) => update(b.service_id, { vendor_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Same as order</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                    </Select>
                    {rates && <span className="muted" style={{ fontSize: 12 }}>{cost === undefined ? "Cost not set" : `Cost ${money(cost)}`}</span>}
                  </div>
                );
              }}
            />
          </div>
        </div>

        <BillSummary
          bill={bill}
          note={<>Patient is billed at catalogue rates.{marginTotal !== null && basket.length > 0 && <> Estimated margin: <strong>{money(marginTotal)}</strong>.</>}</>}
        >
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Working..." : "Generate invoice"}</Button>
        </BillSummary>
      </div>
    </div>
  );
}
