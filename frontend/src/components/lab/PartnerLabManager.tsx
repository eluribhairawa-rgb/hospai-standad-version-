import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, reportError } from "../../lib/api";
import type { Notice } from "../../types";
import { Button, Input, Label, Modal } from "../ui";

export type PartnerLab = { id: number; vendor_name: string; contact_person?: string | null; phone?: string | null; status?: string | null };

type Props = {
  open: boolean;
  onClose: () => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  /** Called after any change with the fresh list, and with the lab just added (to auto-select it). */
  onChanged: (labs: PartnerLab[], added?: PartnerLab) => void;
};

const EMPTY = { vendor_name: "", contact_person: "", phone: "" };

/** Add, rename, edit contact details and activate/deactivate partner laboratories. */
export default function PartnerLabManager({ open, onClose, setNotice, onChanged }: Props) {
  const [labs, setLabs] = useState<PartnerLab[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const load = async (added?: PartnerLab) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ vendors: PartnerLab[] }>("/api/lab/vendors-list");
      const list = res.vendors || [];
      setLabs(list);
      onChanged(list, added);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load partner labs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setEditingId(null);
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startEdit = (lab: PartnerLab) => {
    setEditingId(lab.id);
    setForm({ vendor_name: lab.vendor_name || "", contact_person: lab.contact_person || "", phone: lab.phone || "" });
  };

  const save = async () => {
    if (!form.vendor_name.trim()) {
      setNotice({ type: "warning", message: "Enter the partner lab name." });
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        vendor_name: form.vendor_name.trim(),
        contact_person: form.contact_person.trim(),
        phone: form.phone.trim(),
      });
      if (editingId) {
        await apiFetch(`/api/lab/vendors-list/${editingId}`, { method: "PUT", body });
        setNotice({ type: "success", message: `Partner lab "${form.vendor_name.trim()}" updated.` });
        setForm(EMPTY);
        setEditingId(null);
        await load();
      } else {
        const res = await apiFetch<{ vendor: PartnerLab }>("/api/lab/vendors-list", { method: "POST", body });
        setNotice({ type: "success", message: `Partner lab "${res.vendor.vendor_name}" added.` });
        setForm(EMPTY);
        await load(res.vendor);
      }
    } catch (err: any) {
      reportError(setNotice, err, "Could not save the partner lab.");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (lab: PartnerLab) => {
    const next = (lab.status || "active") === "active" ? "inactive" : "active";
    try {
      await apiFetch(`/api/lab/vendors-list/${lab.id}`, { method: "PUT", body: JSON.stringify({ status: next }) });
      setNotice({
        type: "success",
        message: next === "inactive"
          ? `"${lab.vendor_name}" deactivated. It no longer appears for new orders; past orders keep it.`
          : `"${lab.vendor_name}" is active again.`,
      });
      await load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not change the partner lab status.");
    }
  };

  const visible = labs.filter((l) => showInactive || (l.status || "active") === "active");
  const inactiveCount = labs.filter((l) => (l.status || "active") !== "active").length;

  return (
    <Modal open={open} onClose={onClose} title="Manage Partner Laboratories">
      <div style={{ display: "grid", gap: "14px", padding: "0.25rem 0" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", alignItems: "end" }}>
          <div>
            <Label>Lab name *</Label>
            <Input value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })} placeholder="e.g. City Reference Labs" />
          </div>
          <div>
            <Label>Contact person</Label>
            <Input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} placeholder="Optional" />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Optional" />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          {editingId && (
            <Button variant="secondary" onClick={() => { setEditingId(null); setForm(EMPTY); }} disabled={saving}>Cancel edit</Button>
          )}
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : editingId ? "Save changes" : "Add partner lab"}
          </Button>
        </div>

        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <strong style={{ fontSize: "13px", color: "#0f172a" }}>Partner labs</strong>
            {inactiveCount > 0 && (
              <label style={{ fontSize: "12px", color: "#475569", display: "flex", gap: "6px", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                Show inactive ({inactiveCount})
              </label>
            )}
          </div>
          {loading ? (
            <div style={{ fontSize: "13px", color: "#64748b", padding: "8px 0" }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div style={{ fontSize: "13px", color: "#64748b", padding: "8px 0" }}>No partner labs yet. Add the first one above.</div>
          ) : (
            <div style={{ display: "grid", gap: "6px", maxHeight: "300px", overflowY: "auto" }}>
              {visible.map((lab) => {
                const active = (lab.status || "active") === "active";
                return (
                  <div
                    key={lab.id}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px",
                      padding: "8px 10px", borderRadius: "8px", border: `1px solid ${editingId === lab.id ? "#00828a" : "#e2e8f0"}`,
                      background: active ? "#fff" : "#f8fafc",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: "13px", color: active ? "#0f172a" : "#94a3b8" }}>
                        {lab.vendor_name}{!active && " (inactive)"}
                      </div>
                      {(lab.contact_person || lab.phone) && (
                        <div style={{ fontSize: "12px", color: "#64748b" }}>{[lab.contact_person, lab.phone].filter(Boolean).join(" · ")}</div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                      <button type="button" onClick={() => startEdit(lab)} style={{ background: "none", border: "none", color: "#00828a", fontWeight: 700, fontSize: "12px", cursor: "pointer" }}>
                        Edit
                      </button>
                      <button type="button" onClick={() => void toggleStatus(lab)} style={{ background: "none", border: "none", color: active ? "#b91c1c" : "#15803d", fontWeight: 700, fontSize: "12px", cursor: "pointer" }}>
                        {active ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
