import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Checkbox, Input, Label, Modal, Select, Tabs, TabsTrigger } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

type ServiceParam = {
  id?: number;
  name: string;
  data_type: "numeric" | "text" | "qualitative";
  unit?: string;
  method?: string;
  ref_low?: number | null;
  ref_high?: number | null;
  ref_text?: string;
  critical_low?: number | null;
  critical_high?: number | null;
  sex_specific?: string | null;
  age_min?: number | null;
  age_max?: number | null;
  display_order?: number;
  comments?: string;
};

type DiagService = {
  id: number;
  code: string;
  name: string;
  service_type: "LAB" | "IMAGING" | "OTHER";
  department?: string;
  active: boolean;
  turnaround_time?: string;
  turnaround_hours?: number | null;
  preparation_requirements?: string;
  specimen_type?: string;
  container_type?: string;
  modality?: string;
  body_region?: string;
  laterality?: string;
  requires_scheduling?: boolean;
  report_template?: string;
  rate: number;
  parameters?: ServiceParam[];
  pricing_history?: { id: number; rate: number; payer_type: string; changed_by?: string; changed_at: string }[];
};

type DiagPackage = {
  id: number;
  code: string;
  name: string;
  active: boolean;
  rate: number;
  items: { id: number; code: string; name: string; service_type: string; rate: number }[];
};

type ReportTemplate = {
  id: number;
  code: string;
  name: string;
  report_type: string;
  layout: string;
};

type EditTab = "details" | "parameters" | "pricing" | "history";

const blankService = (): Partial<DiagService> => ({
  code: "", name: "", service_type: "LAB", department: "", active: true, rate: 0,
  turnaround_time: "", turnaround_hours: null, preparation_requirements: "", specimen_type: "", container_type: "",
  modality: "", body_region: "", laterality: "", requires_scheduling: false, report_template: "generic",
});

const blankParam = (order: number): ServiceParam => ({ name: "", data_type: "numeric", display_order: order });

const numOrNull = (value: string): number | null => (value === "" ? null : Number(value));

const statusBadge = (active?: boolean) => (
  <span className={`diag-badge ${active ? "diag-badge-active" : "diag-badge-muted"}`}>
    {active ? "Active" : "Inactive"}
  </span>
);

export default function LabDiagnosticsCataloguePage({ setNotice }: Props) {
  const [services, setServices] = useState<DiagService[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");

  const [selected, setSelected] = useState<DiagService | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState<Partial<DiagService>>(blankService());
  const [params, setParams] = useState<ServiceParam[]>([]);
  const [editTab, setEditTab] = useState<EditTab>("details");
  const [saving, setSaving] = useState(false);

  const [packagesOpen, setPackagesOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [packages, setPackages] = useState<DiagPackage[]>([]);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const query: Record<string, string> = {};
      if (search.trim()) query.q = search.trim();
      if (typeFilter) query.service_type = typeFilter;
      if (statusFilter !== "all") query.active_only = statusFilter === "active" ? "true" : "false";
      const qs = new URLSearchParams(query).toString();
      const data = await apiFetch<{ services: DiagService[] }>(`/api/diag/services?${qs}`);
      setServices(data.services || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load test catalogue.");
    } finally {
      setLoading(false);
    }
  };

  // Filter changes reload immediately; typing in the search box debounces so we
  // don't reload on every keystroke. A single effect avoids double-fetching on mount.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, search ? 300 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, typeFilter, statusFilter]);

  const counts = useMemo(() => ({
    total: services.length,
    lab: services.filter((s) => s.service_type === "LAB").length,
    imaging: services.filter((s) => s.service_type === "IMAGING").length,
    inactive: services.filter((s) => !s.active).length,
  }), [services]);

  const patchForm = (patch: Partial<DiagService>) => setForm((f) => ({ ...f, ...patch }));

  const openService = async (svc: DiagService) => {
    try {
      const full = await apiFetch<DiagService>(`/api/diag/services/${svc.id}`);
      setSelected(full);
      setIsNew(false);
      setForm(full);
      setParams(full.parameters || []);
      setEditTab("details");
    } catch (err: any) {
      reportError(setNotice, err, "Could not load service.");
    }
  };

  const openNew = () => {
    setSelected(null);
    setIsNew(true);
    setForm(blankService());
    setParams([]);
    setEditTab("details");
  };

  const closeEditor = () => {
    setSelected(null);
    setIsNew(false);
  };

  const saveDetails = async () => {
    if (!form.code?.trim() || !form.name?.trim()) {
      setNotice({ type: "warning", message: "Code and name are required." });
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, rate: Number(form.rate || 0) };
      if (isNew) {
        const res = await apiFetch<{ service_id: number }>(`/api/diag/services`, { method: "POST", body: JSON.stringify(payload) });
        setNotice({ type: "success", message: `${form.name} added to the catalogue.` });
        await load();
        const full = await apiFetch<DiagService>(`/api/diag/services/${res.service_id}`);
        setSelected(full);
        setIsNew(false);
        setForm(full);
      } else if (selected) {
        await apiFetch(`/api/diag/services/${selected.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice({ type: "success", message: `${form.name} updated.` });
        await load();
        await openService(selected);
      }
    } catch (err: any) {
      reportError(setNotice, err, "Could not save service.");
    } finally {
      setSaving(false);
    }
  };

  const updateParam = (idx: number, patch: Partial<ServiceParam>) => {
    setParams((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const removeParam = (idx: number) => setParams((prev) => prev.filter((_, i) => i !== idx));

  const addParamRow = () => setParams((prev) => [...prev, blankParam(prev.length)]);

  const saveParameters = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await apiFetch(`/api/diag/services/${selected.id}/parameters`, { method: "PUT", body: JSON.stringify({ parameters: params }) });
      setNotice({ type: "success", message: "Parameters saved." });
      await openService(selected);
    } catch (err: any) {
      reportError(setNotice, err, "Could not save parameters.");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async () => {
    if (!selected) return;
    if (!window.confirm(`Deactivate ${selected.name}? Historical orders and reports keep their original data.`)) return;
    try {
      await apiFetch(`/api/diag/services/${selected.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: `${selected.name} deactivated.` });
      setSelected(null);
      await load();
    } catch (err: any) {
      reportError(setNotice, err, "Could not deactivate service.");
    }
  };

  const loadPackages = async () => {
    try {
      const data = await apiFetch<{ packages: DiagPackage[] }>(`/api/diag/packages`);
      setPackages(data.packages || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load packages.");
    }
  };

  const loadTemplates = async () => {
    try {
      const data = await apiFetch<{ templates: ReportTemplate[] }>(`/api/diag/report-templates`);
      setTemplates(data.templates || []);
    } catch (err: any) {
      reportError(setNotice, err, "Could not load report templates.");
    }
  };

  return (
    <div className="diag-page">
      <div className="diag-stat-row">
        <div className="diag-stat-card"><span>Total services</span><strong>{counts.total}</strong></div>
        <div className="diag-stat-card"><span>Laboratory</span><strong>{counts.lab}</strong></div>
        <div className="diag-stat-card"><span>Imaging</span><strong>{counts.imaging}</strong></div>
        <div className="diag-stat-card"><span>Inactive</span><strong>{counts.inactive}</strong></div>
      </div>

      <div className="diag-split">
        <div className="diag-card diag-services-list">
          <div className="diag-card-header">
            <h3>Services</h3>
            <Button variant="primary" size="sm" onClick={openNew}>+ Add service</Button>
          </div>
          <div className="diag-filters-row">
            <Input placeholder="Search service name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              <option value="LAB">Laboratory</option>
              <option value="IMAGING">Imaging</option>
              <option value="OTHER">Other</option>
            </Select>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">Active</option>
              <option value="all">All</option>
              <option value="inactive">Inactive</option>
            </Select>
          </div>
          <div className="diag-table-card">
            <table className="diag-data-table">
              <thead>
                <tr><th>Code</th><th>Service</th><th>Department</th><th>Rate</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="diag-empty">Loading...</td></tr>}
                {!loading && services.length === 0 && <tr><td colSpan={6} className="diag-empty">No services found.</td></tr>}
                {services.map((svc) => (
                  <tr key={svc.id} className={selected?.id === svc.id ? "diag-row-active" : ""}>
                    <td>{svc.code}</td>
                    <td>{svc.name}</td>
                    <td>{svc.department || "-"}</td>
                    <td>Rs. {svc.rate}</td>
                    <td>{statusBadge(svc.active)}</td>
                    <td><Button variant="secondary" size="sm" onClick={() => openService(svc)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="diag-card-header" style={{ marginTop: "1rem" }}>
            <h3>Catalogue settings</h3>
          </div>
          <div className="diag-settings-row">
            <button type="button" className="diag-settings-tile" onClick={() => { setPackagesOpen(true); void loadPackages(); }}>
              <strong>Panels & packages</strong><span>Manage included tests</span>
            </button>
            <button type="button" className="diag-settings-tile" onClick={() => { setTemplatesOpen(true); void loadTemplates(); }}>
              <strong>Report templates</strong><span>Maintain approved formats</span>
            </button>
          </div>
        </div>

        <div className="diag-card diag-edit-panel">
          {!selected && !isNew && <p className="muted">Select a service to edit, or add a new one.</p>}
          {(selected || isNew) && (
            <>
              <div className="diag-card-header">
                <h3>{isNew ? "Add service" : form.name}</h3>
                {!isNew && statusBadge(form.active)}
              </div>
              <Tabs>
                <TabsTrigger active={editTab === "details"} onClick={() => setEditTab("details")}>Details</TabsTrigger>
                <TabsTrigger active={editTab === "parameters"} onClick={() => setEditTab("parameters")} disabled={isNew}>Parameters</TabsTrigger>
                <TabsTrigger active={editTab === "pricing"} onClick={() => setEditTab("pricing")} disabled={isNew}>Pricing</TabsTrigger>
                <TabsTrigger active={editTab === "history"} onClick={() => setEditTab("history")} disabled={isNew}>History</TabsTrigger>
              </Tabs>

              {editTab === "details" && (
                <div className="diag-form-grid">
                  <div><Label>Service code</Label><Input value={form.code || ""} onChange={(e) => patchForm({ code: e.target.value })} disabled={!isNew} /></div>
                  <div><Label>Service name</Label><Input value={form.name || ""} onChange={(e) => patchForm({ name: e.target.value })} /></div>
                  <div><Label>Type</Label>
                    <Select value={form.service_type} onChange={(e) => patchForm({ service_type: e.target.value as DiagService["service_type"] })}>
                      <option value="LAB">Laboratory</option>
                      <option value="IMAGING">Imaging</option>
                      <option value="OTHER">Other</option>
                    </Select>
                  </div>
                  <div><Label>Department</Label><Input value={form.department || ""} onChange={(e) => patchForm({ department: e.target.value })} /></div>
                  <div><Label>Rate (Rs.)</Label><Input type="number" min={0} value={(form.rate as any) === "" ? "" : (form.rate ?? "")} onChange={(e) => patchForm({ rate: e.target.value === "" ? ("" as any) : Number(e.target.value) })} placeholder="0" /></div>
                  <div><Label>Turnaround time</Label><Input value={form.turnaround_time || ""} onChange={(e) => patchForm({ turnaround_time: e.target.value })} placeholder="e.g. 6 hours" /></div>
                  <div><Label>TAT (hours)</Label><Input type="number" step="any" min={0} value={form.turnaround_hours ?? ""} onChange={(e) => patchForm({ turnaround_hours: e.target.value === "" ? null : Number(e.target.value) })} placeholder="e.g. 6" /></div>
                  {form.service_type === "LAB" && (
                    <>
                      <div><Label>Specimen type</Label><Input value={form.specimen_type || ""} onChange={(e) => patchForm({ specimen_type: e.target.value })} /></div>
                      <div><Label>Container</Label><Input value={form.container_type || ""} onChange={(e) => patchForm({ container_type: e.target.value })} /></div>
                    </>
                  )}
                  {form.service_type === "IMAGING" && (
                    <>
                      <div><Label>Modality</Label><Input value={form.modality || ""} onChange={(e) => patchForm({ modality: e.target.value })} placeholder="X-ray / Ultrasound / CT" /></div>
                      <div><Label>Body region</Label><Input value={form.body_region || ""} onChange={(e) => patchForm({ body_region: e.target.value })} /></div>
                      <div><Label>Laterality</Label>
                        <Select value={form.laterality || ""} onChange={(e) => patchForm({ laterality: e.target.value })}>
                          <option value="">Not applicable</option>
                          <option value="Left">Left</option>
                          <option value="Right">Right</option>
                          <option value="Bilateral">Bilateral</option>
                        </Select>
                      </div>
                      <div className="diag-checkbox-field">
                        <label><Checkbox checked={!!form.requires_scheduling} onChange={(e) => patchForm({ requires_scheduling: e.target.checked })} /> Requires appointment scheduling</label>
                      </div>
                    </>
                  )}
                  <div className="diag-form-full"><Label>Preparation requirements</Label><Input value={form.preparation_requirements || ""} onChange={(e) => patchForm({ preparation_requirements: e.target.value })} placeholder="e.g. Fasting 8 hours" /></div>
                  <div><Label>Report template</Label>
                    <Select value={form.report_template || "generic"} onChange={(e) => patchForm({ report_template: e.target.value })}>
                      <option value="generic">Generic</option>
                      <option value="microbiology">Microbiology (narrative)</option>
                      <option value="histopathology">Histopathology (narrative)</option>
                    </Select>
                  </div>
                  {!isNew && (
                    <div className="diag-checkbox-field">
                      <label><Checkbox checked={!!form.active} onChange={(e) => patchForm({ active: e.target.checked })} /> Active</label>
                    </div>
                  )}
                  <div className="diag-form-full diag-form-actions">
                    <Button variant="primary" disabled={saving} onClick={() => void saveDetails()}>{saving ? "Saving..." : "Save changes"}</Button>
                    {!isNew && <Button variant="destructive" onClick={() => void deactivate()}>Deactivate service</Button>}
                    <Button variant="ghost" onClick={closeEditor}>Cancel</Button>
                  </div>
                </div>
              )}

              {editTab === "parameters" && selected && (
                <div>
                  <table className="diag-data-table">
                    <thead><tr><th>Name</th><th>Type</th><th>Unit</th><th>Ref low</th><th>Ref high</th><th>Reference (text)</th><th>Critical low</th><th>Critical high</th><th></th></tr></thead>
                    <tbody>
                      {params.map((p, idx) => (
                        <tr key={idx}>
                          <td><Input value={p.name} onChange={(e) => updateParam(idx, { name: e.target.value })} /></td>
                          <td>
                            <Select value={p.data_type} onChange={(e) => updateParam(idx, { data_type: e.target.value as ServiceParam["data_type"] })}>
                              <option value="numeric">Numeric</option>
                              <option value="text">Text</option>
                              <option value="qualitative">Qualitative</option>
                            </Select>
                          </td>
                          <td><Input value={p.unit || ""} onChange={(e) => updateParam(idx, { unit: e.target.value })} /></td>
                          <td><Input type="number" disabled={p.data_type !== "numeric"} value={p.ref_low ?? ""} onChange={(e) => updateParam(idx, { ref_low: numOrNull(e.target.value) })} /></td>
                          <td><Input type="number" disabled={p.data_type !== "numeric"} value={p.ref_high ?? ""} onChange={(e) => updateParam(idx, { ref_high: numOrNull(e.target.value) })} /></td>
                          <td>
                            <Input
                              value={p.ref_text || ""}
                              disabled={p.data_type === "numeric"}
                              onChange={(e) => updateParam(idx, { ref_text: e.target.value })}
                              placeholder={p.data_type === "numeric" ? "n/a" : "e.g. Negative, Non-reactive"}
                            />
                          </td>
                          <td><Input type="number" value={p.critical_low ?? ""} onChange={(e) => updateParam(idx, { critical_low: numOrNull(e.target.value) })} /></td>
                          <td><Input type="number" value={p.critical_high ?? ""} onChange={(e) => updateParam(idx, { critical_high: numOrNull(e.target.value) })} /></td>
                          <td><Button variant="ghost" size="sm" onClick={() => removeParam(idx)}>Remove</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="diag-form-actions">
                    <Button variant="secondary" size="sm" onClick={addParamRow}>+ Add parameter</Button>
                    <Button variant="primary" disabled={saving} onClick={() => void saveParameters()}>{saving ? "Saving..." : "Save parameters"}</Button>
                  </div>
                  <p className="muted" style={{ marginTop: "0.5rem" }}>
                    Reference intervals and critical thresholds set here are the only values used during result entry -- they are never invented at the bedside.
                  </p>
                </div>
              )}

              {editTab === "pricing" && selected && (
                <table className="diag-data-table">
                  <thead><tr><th>Rate</th><th>Payer type</th><th>Changed by</th><th>Changed at</th></tr></thead>
                  <tbody>
                    {(selected.pricing_history || []).map((h) => (
                      <tr key={h.id}><td>Rs. {h.rate}</td><td>{h.payer_type}</td><td>{h.changed_by || "-"}</td><td>{new Date(h.changed_at).toLocaleString()}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}

              {editTab === "history" && selected && (
                <p className="muted">Historical orders and reports retain the price, units and reference intervals that were configured at the time they were created, even if this catalogue entry changes later.</p>
              )}
            </>
          )}
        </div>
      </div>

      <Modal open={packagesOpen} onClose={() => setPackagesOpen(false)} title="Panels & packages" description="Group services into a billable panel.">
        <PackagesEditor services={services} packages={packages} setNotice={setNotice} onChanged={loadPackages} />
      </Modal>

      <Modal open={templatesOpen} onClose={() => setTemplatesOpen(false)} title="Report templates" description="Approved report formats for laboratory and imaging.">
        <TemplatesEditor templates={templates} setNotice={setNotice} onChanged={loadTemplates} />
      </Modal>
    </div>
  );
}

type PackagesEditorProps = {
  services: DiagService[];
  packages: DiagPackage[];
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onChanged: () => void;
};

function PackagesEditor({ services, packages, setNotice, onChanged }: PackagesEditorProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [rate, setRate] = useState<number | "">("");
  const [ids, setIds] = useState<number[]>([]);

  const toggleService = (id: number, checked: boolean) => {
    setIds((prev) => (checked ? [...prev, id] : prev.filter((i) => i !== id)));
  };

  const create = async () => {
    if (!code.trim() || !name.trim() || ids.length === 0) {
      setNotice({ type: "warning", message: "Code, name and at least one service are required." });
      return;
    }
    try {
      await apiFetch(`/api/diag/packages`, { method: "POST", body: JSON.stringify({ code, name, rate: Number(rate || 0), service_ids: ids }) });
      setNotice({ type: "success", message: `Package ${name} created.` });
      setCode(""); setName(""); setRate(""); setIds([]);
      onChanged();
    } catch (err: any) {
      reportError(setNotice, err, "Could not create package.");
    }
  };

  return (
    <div>
      <table className="diag-data-table">
        <thead><tr><th>Code</th><th>Name</th><th>Rate</th><th>Included services</th></tr></thead>
        <tbody>
          {packages.map((p) => (
            <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>Rs. {p.rate}</td><td>{p.items.map((i) => i.name).join(", ") || "-"}</td></tr>
          ))}
          {packages.length === 0 && <tr><td colSpan={4} className="diag-empty">No packages yet.</td></tr>}
        </tbody>
      </table>
      <div className="diag-form-grid" style={{ marginTop: "1rem" }}>
        <div><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label>Package rate (Rs.)</Label><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value === "" ? "" : Number(e.target.value))} placeholder="0" /></div>
        <div className="diag-form-full">
          <Label>Included services</Label>
          <div className="diag-checkbox-list">
            {services.filter((s) => s.active).map((s) => (
              <label key={s.id}>
                <Checkbox checked={ids.includes(s.id)} onChange={(e) => toggleService(s.id, e.target.checked)} />
                {s.name} ({s.code})
              </label>
            ))}
          </div>
        </div>
        <div className="diag-form-full"><Button variant="primary" onClick={() => void create()}>Create package</Button></div>
      </div>
    </div>
  );
}

type TemplatesEditorProps = {
  templates: ReportTemplate[];
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onChanged: () => void;
};

function TemplatesEditor({ templates, setNotice, onChanged }: TemplatesEditorProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [reportType, setReportType] = useState("LAB");
  const [layout, setLayout] = useState("structured");

  const create = async () => {
    if (!code.trim() || !name.trim()) {
      setNotice({ type: "warning", message: "Code and name are required." });
      return;
    }
    try {
      await apiFetch(`/api/diag/report-templates`, { method: "POST", body: JSON.stringify({ code, name, report_type: reportType, layout }) });
      setNotice({ type: "success", message: `Template ${name} added.` });
      setCode(""); setName("");
      onChanged();
    } catch (err: any) {
      reportError(setNotice, err, "Could not create template.");
    }
  };

  return (
    <div>
      <table className="diag-data-table">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Layout</th></tr></thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id}><td>{t.code}</td><td>{t.name}</td><td>{t.report_type}</td><td>{t.layout}</td></tr>
          ))}
          {templates.length === 0 && <tr><td colSpan={4} className="diag-empty">No templates yet.</td></tr>}
        </tbody>
      </table>
      <div className="diag-form-grid" style={{ marginTop: "1rem" }}>
        <div><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label>Report type</Label>
          <Select value={reportType} onChange={(e) => setReportType(e.target.value)}>
            <option value="LAB">Laboratory</option>
            <option value="IMAGING">Imaging</option>
          </Select>
        </div>
        <div><Label>Layout</Label>
          <Select value={layout} onChange={(e) => setLayout(e.target.value)}>
            <option value="structured">Structured (parameters/results)</option>
            <option value="narrative">Narrative (findings/impression)</option>
          </Select>
        </div>
        <div className="diag-form-full"><Button variant="primary" onClick={() => void create()}>Add template</Button></div>
      </div>
    </div>
  );
}
