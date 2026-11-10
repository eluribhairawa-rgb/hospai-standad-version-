import { splitStoredPhone } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ALL_ASSIGNABLE_MODULES, MODULE_OPTIONS } from "../lib/constants";
import { apiFetch, reportError } from "../lib/api";
import { Badge, Button, Checkbox, Input, Label, Select, Table, TableCell, TableHead, TableRow } from "../components/ui";
import type { Employee, ModuleId, Notice, UserType } from "../types";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };

type AdminForm = {
  username: string;
  password: string;
  full_name: string;
  email: string;
  phone: string;
  phone_country_code: string;
  department: string;
  user_type: UserType;
  module_access: ModuleId[];
};

const EMPTY_FORM: AdminForm = {
  username: "", password: "", full_name: "", email: "", phone: "", phone_country_code: "+91", department: "",
  user_type: "normal", module_access: [],
};

export default function AdminPage({ setNotice }: Props) {
  const [form, setForm] = useState<AdminForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const resetEditor = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const [users, setUsers] = useState<Employee[]>([]);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const toggleModule = (moduleName: ModuleId) => {
    setForm((current) => {
      const selected = new Set(current.module_access || []);
      selected.has(moduleName) ? selected.delete(moduleName) : selected.add(moduleName);
      return { ...current, module_access: ALL_ASSIGNABLE_MODULES.filter((module) => selected.has(module)) };
    });
  };

  const loadUsers = async () => {
    try {
      const data = await apiFetch<{ users?: Employee[] }>("/api/admin/users");
      setUsers(data.users || []);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load users.");
    }
  };

  useEffect(() => { void loadUsers(); }, []);


  const handleSaveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        user_type: form.user_type,
        module_access: (form.user_type === "super_admin" || form.user_type === "admin") ? ALL_ASSIGNABLE_MODULES : form.module_access,
        job_role: form.user_type === "super_admin" ? "System Admin" : (form.user_type === "admin" ? "Staff Admin" : "Staff"),
        status: "active",
        // New users start blank; an edit leaves the stored address and emergency contact alone.
        ...(editingId ? {} : { address: "", emergency_contact: "" }),
      };
      const response = await apiFetch<{ success?: boolean; message?: string; employee_id?: string }>(
        editingId ? `/api/admin/users/${editingId}` : "/api/admin/users",
        { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) }
      );
      if (!response.success) throw new Error(response.message || "Unable to save user.");
      setNotice({ type: "success", message: editingId ? "User and module permissions updated." : "User created." });
      resetEditor();
      await loadUsers();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save user.");
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (user: Employee) => {
    setEditingId(user.employee_id);
    setForm({
      username: user.username || "",
      password: "",
      full_name: user.full_name || "",
      email: user.email || "",
      phone: splitStoredPhone(user.phone, user.phone_country_code).value,
      phone_country_code: splitStoredPhone(user.phone, user.phone_country_code).countryCode,
      department: user.department || "",
      user_type: user.user_type === "super_admin" ? "super_admin" : (user.user_type === "admin" ? "admin" : "normal"),
      module_access: (user.user_type === "super_admin" || user.user_type === "admin") ? [...ALL_ASSIGNABLE_MODULES] : (user.module_access || []),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePromoteToAdmin = async (employeeId: string) => {
    setPromotingId(employeeId);
    try {
      await apiFetch(`/api/admin/users/${employeeId}/promote`, { method: "POST" });
      setNotice({ type: "success", message: `${employeeId} promoted to admin.` });
      await loadUsers();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to promote user.");
    } finally {
      setPromotingId(null);
    }
  };

  return (
    <section className="panel admin-page">
      <div className="admin-page-header">
        <div><h3>Admin Management</h3><p className="muted">Create or edit users and control module-level access.</p></div>
      </div>

      <div className="panel admin-page-section">
        <h4>{editingId ? "Edit User" : "Create New User"}</h4>
        <form onSubmit={handleSaveUser}>
          <div className="admin-user-editor-grid">
            <div className="admin-user-details-panel">
              <h5>User Details</h5>
              <div className="grid-form">
                <Label>Username<Input value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} required disabled={!!editingId} /></Label>
                <Label>Password<Input type="password" value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} required={!editingId} disabled={!!editingId} placeholder={editingId ? "Password remains unchanged" : ""} /></Label>
                <Label>Full Name<Input value={form.full_name} onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))} required /></Label>
                <Label>Email<Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} required /></Label>
                <Label>Phone<PhoneInput required countryCode={form.phone_country_code} value={form.phone} onChange={({ countryCode, value }) => setForm((p) => ({ ...p, phone_country_code: countryCode, phone: value }))} /></Label>
                <Label>Department<Input value={form.department} onChange={(e) => setForm((p) => ({ ...p, department: e.target.value }))} required /></Label>
                <Label>User Type<Select value={form.user_type} onChange={(e) => setForm((p) => ({ ...p, user_type: e.target.value as UserType }))}><option value="normal">Normal</option><option value="admin">Admin</option><option value="super_admin">Super Admin</option></Select></Label>
              </div>
            </div>

            <div className="admin-module-access-panel">
              <div className="admin-module-access-head">
                <div><h5>Module Access Permissions</h5><p className="muted">Select the modules this user may open.</p></div>
                {(form.user_type === "admin" || form.user_type === "super_admin") && <Badge>Full Access</Badge>}
              </div>
              <div className="module-grid module-permissions-grid">
                {MODULE_OPTIONS.map((module) => {
                  const selected = form.user_type === "admin" || form.user_type === "super_admin" || form.module_access.includes(module.value);
                  return (
                    <label key={module.value} className="checkbox-line" title={module.description}>
                      <Checkbox checked={selected} disabled={form.user_type === "admin" || form.user_type === "super_admin"} onChange={() => toggleModule(module.value)} />
                      <span>{module.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="form-actions admin-user-save-actions">
            <Button variant="primary" type="submit" disabled={saving}>{saving ? "Saving..." : editingId ? "Update User" : "Create User"}</Button>
            <Button variant="secondary" type="button" onClick={resetEditor} disabled={saving}>{editingId ? "Cancel" : "Reset"}</Button>
          </div>
        </form>
      </div>

      <div className="panel admin-page-section">
        <h4>Existing Users</h4>
        <div className="admin-users-table">
          <Table>
            <TableHead><TableCell>Employee ID</TableCell><TableCell>Username</TableCell><TableCell>Name</TableCell><TableCell>Type</TableCell><TableCell>Modules</TableCell><TableCell>Status</TableCell><TableCell>Action</TableCell></TableHead>
            {users.map((user) => {
              const isSuperAdmin = user.user_type === "super_admin";
              const isAdminUser = user.user_type === "admin" || isSuperAdmin;
              return (
                <TableRow key={user.employee_id}>
                  <TableCell>{user.employee_id}</TableCell><TableCell>{user.username}</TableCell><TableCell>{user.full_name || "-"}</TableCell>
                  <TableCell><Badge variant={isSuperAdmin ? "default" : (isAdminUser ? "secondary" : "outline")}>{user.user_type || "normal"}</Badge></TableCell>
                  <TableCell>{isAdminUser ? "All" : (user.module_access?.length || 0)}</TableCell><TableCell>{user.status || "-"}</TableCell>
                  <TableCell>
                    <div className="form-actions">
                      <Button variant="secondary" type="button" onClick={() => beginEdit(user)}>Edit Access</Button>
                      <Button variant="secondary" type="button" onClick={() => void handlePromoteToAdmin(user.employee_id)} disabled={isSuperAdmin || promotingId === user.employee_id}>
                        {promotingId === user.employee_id ? "Promoting..." : isSuperAdmin ? "Is Super Admin" : "Make Super Admin"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      </div>
    </section>
  );
}
