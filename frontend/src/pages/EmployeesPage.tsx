import { formatPhone, normalizeSearchQuery, splitStoredPhone } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Badge, Button, Checkbox, ConfirmDialog, Input, Label, Select, Table, TableCell, TableHead, TableRow, Tabs, TabsContent, TabsTrigger, Textarea } from "../components/ui";
import { ALL_ASSIGNABLE_MODULES, DEFAULT_MODULE_ACCESS, EMPTY_SIGNUP_FORM, MODULE_OPTIONS, NAV_ITEMS, USER_TYPE_LABELS, USER_TYPE_OPTIONS } from "../lib/constants";
import { apiFetch, reportError } from "../lib/api";
import { formatDate } from "../lib/format";
import { JOB_TITLE_GROUPS, JOB_TITLES } from "../lib/jobRoles";
import type { Employee, ModuleId, Notice, SignupForm } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  canWriteEmployees: boolean;
};

type EditForm = {
  full_name: string;
  email: string;
  phone: string;
  department: string;
  address: string;
  emergency_contact: string;
  status: string;
  job_role: string;
  doctor_name: string;
  user_type: SignupForm["user_type"];
  module_access: ModuleId[];
};


const GROUP_LABEL_MAP: Record<string, string> = {
  overview: "Overview Module",
  "patient-reach-ai": "Patient Reach AI",
  "op-management": "OP Management Module",
  emergency: "Emergency / Casualty",
  inpatient: "Inpatient (IPD) Module",
  pharmacy: "Pharmacy Module",
  "lab-diagnostics": "Lab & Diagnostics Department",
  billing: "Billing & Accounts Department",
  admin: "Administration",
};

const MODULE_GROUP_DEFINITIONS: Array<{ title: string; modules: ModuleId[] }> = (() => {
  const groupsMap: Record<string, ModuleId[]> = {};
  
  for (const item of NAV_ITEMS) {
    if (item.module && MODULE_OPTIONS.some((opt) => opt.value === item.module)) {
      const grp = item.group || "overview";
      if (!groupsMap[grp]) {
        groupsMap[grp] = [];
      }
      if (!groupsMap[grp].includes(item.module)) {
        groupsMap[grp].push(item.module);
      }
    }
  }
  
  const order = ["overview", "op-management", "emergency", "inpatient", "pharmacy", "lab-diagnostics", "billing", "admin"];
  for (const k of Object.keys(groupsMap)) {
    if (!order.includes(k)) order.push(k);
  }
  return order
    .filter((key) => groupsMap[key] && groupsMap[key].length > 0)
    .map((key) => ({
      title: GROUP_LABEL_MAP[key] || key,
      modules: groupsMap[key],
    }));
})();

type ModuleAccessPanelProps = {
  selectedModules: ModuleId[];
  onChange: (modules: ModuleId[]) => void;
};

function ModuleAccessPanel({ selectedModules, onChange }: ModuleAccessPanelProps) {
  const selected = new Set(selectedModules || []);
  const explicitlyGrouped = new Set(MODULE_GROUP_DEFINITIONS.flatMap((group) => group.modules));
  const groups = MODULE_GROUP_DEFINITIONS.map((group) => ({
    ...group,
    options: MODULE_OPTIONS.filter((module) => group.modules.includes(module.value)),
  }));
  const ungrouped = MODULE_OPTIONS.filter((module) => !explicitlyGrouped.has(module.value));
  if (ungrouped.length > 0) groups[groups.length - 1].options.push(...ungrouped);

  const toggle = (moduleName: ModuleId) => {
    const next = new Set(selected);
    if (next.has(moduleName)) next.delete(moduleName);
    else next.add(moduleName);
    onChange(ALL_ASSIGNABLE_MODULES.filter((module) => next.has(module)));
  };

  return (
    <section className="employee-module-access span-3" aria-labelledby="employee-module-access-title">
      <div className="employee-module-access-header">
        <div>
          <h5 id="employee-module-access-title">Module Access</h5>
          <p className="muted">Select the modules this employee can access.</p>
        </div>
        <div className="employee-module-access-actions" aria-label="Module permission actions">
          <button type="button" className="employee-module-access-action" onClick={() => onChange([...ALL_ASSIGNABLE_MODULES])}>Select All</button>
          <button type="button" className="employee-module-access-action" onClick={() => onChange([])}>Clear All</button>
        </div>
      </div>

      <div className="employee-module-groups">
        {groups.map((group) => (
          group.options.length > 0 && (
            <section key={group.title} className="employee-module-group" aria-label={group.title}>
              <h6>{group.title}</h6>
              <div className="employee-module-grid">
                {group.options.map((module) => {
                  const checkboxId = `employee-module-${module.value}`;
                  return (
                    <label key={module.value} htmlFor={checkboxId} className="employee-module-option">
                      <Checkbox
                        id={checkboxId}
                        checked={selected.has(module.value)}
                        onChange={() => toggle(module.value)}
                      />
                      <span>{module.label}</span>
                    </label>
                  );
                })}
              </div>
            </section>
          )
        ))}
      </div>
    </section>
  );
}

/** Staff phones are kept in the form as "+971 501234567" and split into number + country code when saved. */
function StaffPhoneInput({ value, onChange, required }: { value: string; onChange: (val: string) => void; required?: boolean }) {
  const parts = splitStoredPhone(value);
  return (
    <PhoneInput
      required={required}
      countryCode={parts.countryCode}
      value={parts.value}
      onChange={({ countryCode, value: digits }) => onChange(`${countryCode} ${digits}`)}
    />
  );
}

/** Form strings -> the API's phone / phone_country_code and emergency_contact / emergency_contact_country_code. */
function staffPhoneFields(phone?: string, emergency?: string) {
  const p = splitStoredPhone(phone);
  const e = splitStoredPhone(emergency);
  return {
    phone: p.value, phone_country_code: p.value ? p.countryCode : null,
    emergency_contact: e.value, emergency_contact_country_code: e.value ? e.countryCode : null,
  };
}

type DoctorOption = { doctor_name: string; department?: string };

/** Grouped job titles; a legacy free-text title already saved on an employee stays selectable. */
function JobTitleOptions({ current }: { current?: string }) {
  const legacy = (current || "").trim();
  return (
    <>
      {legacy && !JOB_TITLES.includes(legacy) && <option value={legacy}>{legacy}</option>}
      {JOB_TITLE_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.titles.map((title) => <option key={title} value={title}>{title}</option>)}
        </optgroup>
      ))}
    </>
  );
}

const isDoctorRole = (jobRole?: string) => (jobRole || "").trim().toLowerCase() === "doctor";

function DoctorNameField({ id, value, doctors, onChange }: { id: string; value: string; doctors: DoctorOption[]; onChange: (val: string) => void }) {
  const listId = `${id}-options`;
  return (
    <Label>
      Doctor Name
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={doctors.length ? "Start typing to pick a doctor" : "No doctors set up in OP schedules yet"}
        required
      />
      <datalist id={listId}>
        {doctors.map((d) => (
          <option key={d.doctor_name} value={d.doctor_name}>{d.department || ""}</option>
        ))}
      </datalist>
      <span className="muted" style={{ fontSize: "0.75rem" }}>This login will only see this doctor's patients.</span>
    </Label>
  );
}

export default function EmployeesPage({ setNotice, canWriteEmployees }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0 });
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<SignupForm>(EMPTY_SIGNUP_FORM);
  const [tab, setTab] = useState("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<EditForm>>({});
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
  const [deletingEmployee, setDeletingEmployee] = useState(false);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);

  const loadEmployees = async (search?: string) => {
    const path = search ? `/api/employees/search?q=${encodeURIComponent(search)}` : "/api/employees";
    const data = await apiFetch<{ employees?: Employee[] }>(path);
    setEmployees(data.employees || []);
  };

  const loadStats = async () => {
    const data = await apiFetch<{ total: number; active: number; inactive: number }>("/api/employees/stats");
    setStats(data);
  };

  useEffect(() => {
    void loadEmployees();
    void loadStats();
    apiFetch<{ doctors?: DoctorOption[] }>("/api/op/doctors")
      .then((data) => setDoctors(data.doctors || []))
      .catch(() => setDoctors([]));
  }, []);

  // Picking a doctor fills Full Name if it is still empty.
  const pickDoctorForAdd = (name: string) =>
    setForm((p) => ({ ...p, doctor_name: name, full_name: p.full_name || (doctors.some((d) => d.doctor_name === name) ? name : p.full_name) }));

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWriteEmployees) {
      setNotice({ type: "warning", message: "You do not have permission to add employees." });
      return;
    }
    try {
      const payload = { ...form, ...staffPhoneFields(form.phone, form.emergency_contact), doctor_name: isDoctorRole(form.job_role) ? form.doctor_name.trim() : "" };
      const res = await apiFetch<{ success: boolean; message: string }>("/api/employees", { method: "POST", body: JSON.stringify(payload) });
      if (res.success) {
        setNotice({ type: "success", message: res.message });
        setForm(EMPTY_SIGNUP_FORM);
        void loadEmployees();
        void loadStats();
        setTab("list");
      } else {
        setNotice({ type: "error", message: res.message });
      }
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number });
    }
  };

  const toggleStatus = async (employee: Employee) => {
    if (!canWriteEmployees) {
      setNotice({ type: "warning", message: "You do not have permission to update employee status." });
      return;
    }
    const path = employee.status === "active" ? "deactivate" : "activate";
    await apiFetch(`/api/employees/${employee.employee_id}/${path}`, { method: "POST" });
    void loadEmployees(query);
    void loadStats();
  };

  const handleDelete = async (employee: Employee) => {
    if (!canWriteEmployees) {
      setNotice({ type: "warning", message: "You do not have permission to delete employees." });
      return;
    }
    await apiFetch(`/api/employees/${employee.employee_id}`, { method: "DELETE" });
    void loadEmployees(query);
    void loadStats();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingEmployee(true);
    try {
      await handleDelete(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setDeletingEmployee(false);
    }
  };

  const startEdit = (employee: Employee) => {
    if (!canWriteEmployees) {
      setNotice({ type: "warning", message: "You do not have permission to edit employees." });
      return;
    }
    setEditingId(employee.employee_id);
    setEditForm({
      full_name: employee.full_name || "",
      email: employee.email || "",
      phone: formatPhone(employee.phone_country_code, employee.phone) || employee.phone || "",
      address: employee.address || "",
      emergency_contact: formatPhone(employee.emergency_contact_country_code, employee.emergency_contact) || employee.emergency_contact || "",
      status: employee.status || "active",
      job_role: employee.job_role || "",
      doctor_name: employee.doctor_name || "",
      user_type: employee.user_type || "normal",
      module_access: employee.module_access && employee.module_access.length > 0 ? employee.module_access.filter(mId => ALL_ASSIGNABLE_MODULES.includes(mId)) : DEFAULT_MODULE_ACCESS,
    });
  };

  const handleEditSave = async (employeeId: string) => {
    if (!canWriteEmployees) {
      setNotice({ type: "warning", message: "You do not have permission to edit employees." });
      return;
    }
    try {
      const payload = { ...editForm, ...staffPhoneFields(editForm.phone, editForm.emergency_contact), doctor_name: isDoctorRole(editForm.job_role) ? (editForm.doctor_name || "").trim() : "" };
      await apiFetch(`/api/employees/${employeeId}`, { method: "PUT", body: JSON.stringify(payload) });
      setNotice({ type: "success", message: "Employee updated successfully." });
      setEditingId(null);
      void loadEmployees(query);
      void loadStats();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number });
    }
  };

  const deptCounts = employees.reduce<Record<string, number>>((acc, emp) => {
    const key = emp.department || "Unassigned";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const statusCounts = employees.reduce<Record<string, number>>((acc, emp) => {
    const key = emp.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return (
    <section className="panel">
      <h3>Employee Management</h3>

      <Tabs>
        <TabsTrigger active={tab === "list"} onClick={() => setTab("list")}>All Employees</TabsTrigger>
        <TabsTrigger
          active={tab === "add"}
          onClick={() => setTab("add")}
          disabled={!canWriteEmployees}
          title={!canWriteEmployees ? "No permission to add employees." : ""}
        >
          Add New Employee
        </TabsTrigger>
        <TabsTrigger active={tab === "stats"} onClick={() => setTab("stats")}>Statistics</TabsTrigger>
      </Tabs>

      <TabsContent>
        {tab === "list" && (
          <>
            <div className="search-bar">
              <Input value={query} onChange={(e) => setQuery(normalizeSearchQuery(e.target.value, "+91"))} placeholder="Search by name, email, phone, or ID" />
              <Button variant="primary" onClick={() => void loadEmployees(query)}>Search</Button>
              <Button variant="secondary" onClick={() => void loadEmployees("")}>Clear</Button>
            </div>

            <div className="employee-list">
              {employees.length === 0 && <p className="muted">No employees found.</p>}
              {employees.map((emp) => (
                <details key={emp.employee_id} className="doc-item">
                  <summary>
                    <span className={`status-dot ${emp.status === "active" ? "success" : "danger"}`} />
                    {emp.full_name || emp.username} · {emp.employee_id}
                  </summary>
                  <div className="detail-grid">
                    <div>
                      <h4>Personal Information</h4>
                      <p>Username: {emp.username}</p>
                      <p>Full Name: {emp.full_name || "-"}</p>
                      <p>Email: {emp.email || "-"}</p>
                      <p>Phone: {formatPhone(emp.phone_country_code, emp.phone) || emp.phone || "-"}</p>
                      <p>Address: {emp.address || "-"}</p>
                    </div>
                    <div>
                      <h4>Employment Information</h4>
                      <p>Employee ID: {emp.employee_id}</p>
                      <p>User Type: {USER_TYPE_LABELS[emp.user_type || ""] || USER_TYPE_LABELS.normal}</p>
                      <p>Modules: {(emp.module_access || DEFAULT_MODULE_ACCESS).filter(mId => ALL_ASSIGNABLE_MODULES.includes(mId)).map(mId => NAV_ITEMS.find(n => n.module === mId)?.label || mId).join(", ")}</p>
                      <p>Job Title: {emp.job_role || "-"}</p>
                      {isDoctorRole(emp.job_role) && <p>Linked Doctor: {emp.doctor_name || "Not linked"}</p>}
                      <p>Department: {emp.department || "-"}</p>
                      <p>Status: <Badge variant={emp.status === "active" ? "default" : "destructive"}>{emp.status || "-"}</Badge></p>
                      <p>Date Joined: {formatDate(emp.date_joined)}</p>
                      <p>Emergency Contact: {formatPhone(emp.emergency_contact_country_code, emp.emergency_contact) || emp.emergency_contact || "-"}</p>
                    </div>
                  </div>

                  {editingId !== emp.employee_id ? (
                    <div className="form-actions">
                      <Button variant="secondary" onClick={() => startEdit(emp)}>Edit</Button>
                    </div>
                  ) : (
                    <div className="panel">
                      <h4>Edit Employee Details</h4>
                      <form className="grid-form employee-grid-form" onSubmit={(e) => e.preventDefault()}>
                        <Label>Full Name<Input value={editForm.full_name || ""} onChange={(e) => setEditForm((p) => ({ ...p, full_name: e.target.value }))} /></Label>
                        <Label>Email<Input type="email" value={editForm.email || ""} onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))} /></Label>
                        <Label>
                          Phone
                          <div>
                            <StaffPhoneInput 
                              value={editForm.phone || ""} 
                              onChange={(val) => setEditForm((p) => ({ ...p, phone: val }))} 
                            />
                          </div>
                        </Label>
                        <Label>
                          User Type
                          <Select value={editForm.user_type || "normal"} onChange={(e) => setEditForm((p) => ({ ...p, user_type: e.target.value as SignupForm["user_type"] }))}>
                            {USER_TYPE_OPTIONS.map((role) => (
                              <option key={role.value} value={role.value}>{role.label}</option>
                            ))}
                          </Select>
                        </Label>
                        <Label>
                          Job Title
                          <Select value={editForm.job_role || ""} onChange={(e) => setEditForm((p) => ({ ...p, job_role: e.target.value }))}>
                            <option value="">Select a role</option>
                            <JobTitleOptions current={editForm.job_role} />
                          </Select>
                        </Label>
                        {isDoctorRole(editForm.job_role) && (
                          <DoctorNameField
                            id={`edit-doctor-${emp.employee_id}`}
                            value={editForm.doctor_name || ""}
                            doctors={doctors}
                            onChange={(val) => setEditForm((p) => ({ ...p, doctor_name: val }))}
                          />
                        )}
                        <Label>
                          Status
                          <Select value={editForm.status || "active"} onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value }))}>
                            <option value="active">active</option>
                            <option value="inactive">inactive</option>
                          </Select>
                        </Label>
                        {(editForm.user_type || "normal") !== "admin" && (
                          <ModuleAccessPanel
                            selectedModules={editForm.module_access || []}
                            onChange={(modules) => setEditForm((p) => ({ ...p, module_access: modules }))}
                          />
                        )}
                        <Label className="span-3">Address<Textarea rows={2} value={editForm.address || ""} onChange={(e) => setEditForm((p) => ({ ...p, address: e.target.value }))} /></Label>
                        <Label className="span-3">
                          Emergency Contact
                          <div>
                            <StaffPhoneInput 
                              value={editForm.emergency_contact || ""} 
                              onChange={(val) => setEditForm((p) => ({ ...p, emergency_contact: val }))} 
                            />
                          </div>
                        </Label>
                        <div className="form-actions span-3">
                          <Button variant="primary" type="button" onClick={() => void handleEditSave(emp.employee_id)} disabled={!canWriteEmployees}>
                            Save Changes
                          </Button>
                          <Button variant="secondary" type="button" onClick={() => setEditingId(null)}>Cancel</Button>
                        </div>
                      </form>
                    </div>
                  )}

                  <div className="form-actions">
                    <Button variant="secondary" onClick={() => void toggleStatus(emp)} disabled={!canWriteEmployees}>
                      {emp.status === "active" ? "Deactivate" : "Activate"}
                    </Button>
                    <Button variant="destructive" onClick={() => setDeleteTarget(emp)} disabled={!canWriteEmployees}>
                      Delete
                    </Button>
                  </div>
                </details>
              ))}
            </div>
          </>
        )}

        {tab === "add" && (
          <div className="panel">
            <h4>Add New Employee</h4>
            <form className="grid-form employee-grid-form" onSubmit={handleAdd}>
              <Label>Username<Input value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} required /></Label>
              <Label>Password<Input type="password" value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} required /></Label>
              <Label>Full Name<Input value={form.full_name} onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))} required /></Label>
              <Label>Email<Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} /></Label>
              <Label>
                Phone
                <div>
                  <StaffPhoneInput 
                    value={form.phone} 
                    onChange={(val) => setForm((p) => ({ ...p, phone: val }))} 
                    required 
                  />
                </div>
              </Label>
              <Label>
                User Type
                <Select value={form.user_type} onChange={(e) => setForm((p) => ({ ...p, user_type: e.target.value as SignupForm["user_type"] }))} required>
                  {USER_TYPE_OPTIONS.map((role) => (
                    <option key={role.value} value={role.value}>{role.label}</option>
                  ))}
                </Select>
              </Label>
              <Label>
                Job Title
                <Select value={form.job_role} onChange={(e) => setForm((p) => ({ ...p, job_role: e.target.value }))} required>
                  <option value="">Select a role</option>
                  <JobTitleOptions current={form.job_role} />
                </Select>
              </Label>
              <Label>
                Department
                <Input value={form.department || ""} onChange={(e) => setForm((p) => ({ ...p, department: e.target.value }))} placeholder="e.g. Cardiology, Nursing, Front Desk" />
              </Label>
              {isDoctorRole(form.job_role) && (
                <DoctorNameField id="add-doctor" value={form.doctor_name} doctors={doctors} onChange={pickDoctorForAdd} />
              )}
              {form.user_type !== "admin" && (
                <ModuleAccessPanel
                  selectedModules={form.module_access}
                  onChange={(modules) => setForm((p) => ({ ...p, module_access: modules }))}
                />
              )}
              <Label className="span-3">Address<Textarea rows={2} value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} /></Label>
              <Label className="span-3">
                Emergency Contact
                <div>
                  <StaffPhoneInput 
                    value={form.emergency_contact} 
                    onChange={(val) => setForm((p) => ({ ...p, emergency_contact: val }))} 
                  />
                </div>
              </Label>
              <div className="form-actions span-3">
                <Button variant="primary" type="submit">Add Employee</Button>
                <Button variant="secondary" type="button" onClick={() => setForm(EMPTY_SIGNUP_FORM)}>Reset</Button>
              </div>
            </form>
          </div>
        )}

        {tab === "stats" && (
          <div>
            <div className="stat-grid">
              <StatCard label="Total Employees" value={stats.total} />
              <StatCard label="Active Employees" value={stats.active} />
              <StatCard label="Inactive Employees" value={stats.inactive} />
            </div>

            <div className="panel">
              <h4>Department Distribution</h4>
              <div className="bar-chart">
                {Object.entries(deptCounts).map(([dept, count]) => (
                  <div key={dept} className="bar-row">
                    <span>{dept}</span>
                    <div className="bar">
                      <div style={{ width: `${(count / Math.max(1, employees.length)) * 100}%` }} />
                    </div>
                    <span>{count}</span>
                  </div>
                ))}
              </div>

              <h4>Status Distribution</h4>
              <div className="bar-chart">
                {Object.entries(statusCounts).map(([status, count]) => (
                  <div key={status} className="bar-row">
                    <span>{status}</span>
                    <div className="bar">
                      <div style={{ width: `${(count / Math.max(1, employees.length)) * 100}%` }} />
                    </div>
                    <span>{count}</span>
                  </div>
                ))}
              </div>

              <h4>All Employees (Table View)</h4>
              <Table>
                <TableHead>
                  <TableCell>Employee ID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>User Type</TableCell>
                  <TableCell>Department</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Date Joined</TableCell>
                </TableHead>
                {employees.map((emp) => (
                  <TableRow key={`table-${emp.employee_id}`}>
                    <TableCell>{emp.employee_id}</TableCell>
                    <TableCell>{emp.full_name || emp.username}</TableCell>
                    <TableCell>{USER_TYPE_LABELS[emp.user_type || ""] || USER_TYPE_LABELS.normal}</TableCell>
                    <TableCell>{emp.department || "-"}</TableCell>
                    <TableCell>{emp.status || "-"}</TableCell>
                    <TableCell>{formatDate(emp.date_joined)}</TableCell>
                  </TableRow>
                ))}
              </Table>
            </div>
          </div>
        )}
      </TabsContent>
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        loading={deletingEmployee}
        title="Delete employee?"
        description={
          deleteTarget
            ? `This will permanently remove ${deleteTarget.full_name || deleteTarget.username} (${deleteTarget.employee_id}).`
            : "This action cannot be undone."
        }
        confirmLabel="Delete Employee"
      />
    </section>
  );
}
