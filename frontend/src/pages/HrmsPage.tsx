import { useEffect, useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Button, Input, Select, Table, TableCell, TableHead, TableRow, Tabs, TabsContent, TabsTrigger } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

type Department = {
  id: number;
  department_name?: string;
  mapped_head_employee_id?: string;
};

type Attendance = {
  id: number;
  employee_id?: string;
  attendance_date?: string;
  status?: string;
  in_time?: string;
  out_time?: string;
};

type Payroll = {
  id: number;
  employee_id?: string;
  payroll_month?: string;
  net_salary?: number;
  paid_status?: string;
  paid_date?: string;
};

type LeaveRequest = {
  id: number;
  employee_id?: string;
  leave_type?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  decided_by?: string;
};

type HrmsData = {
  departments: Department[];
  attendance: Attendance[];
  payroll: Payroll[];
  leaves: LeaveRequest[];
};

const EMPTY_DATA: HrmsData = {
  departments: [],
  attendance: [],
  payroll: [],
  leaves: [],
};

type AttendanceForm = {
  id: string;
  employee_id: string;
  attendance_date: string;
  status: "present" | "absent" | "leave";
  in_time: string;
  out_time: string;
};

type PayrollForm = {
  id: string;
  employee_id: string;
  payroll_month: string;
  basic_salary: string;
  allowances: string;
  deductions: string;
  paid_status: "pending" | "paid";
  paid_date: string;
};

type LeaveForm = {
  id: string;
  employee_id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  reason: string;
};

type DepartmentForm = {
  id: string;
  department_name: string;
  mapped_head_employee_id: string;
};

type HrmsFilters = {
  employee_id: string;
  leave_status: string;
};

const DEFAULT_ATTENDANCE_FORM: AttendanceForm = {
  id: "",
  employee_id: "",
  attendance_date: "",
  status: "present",
  in_time: "",
  out_time: "",
};

const DEFAULT_PAYROLL_FORM: PayrollForm = {
  id: "",
  employee_id: "",
  payroll_month: "",
  basic_salary: "0",
  allowances: "0",
  deductions: "0",
  paid_status: "pending",
  paid_date: "",
};

const DEFAULT_LEAVE_FORM: LeaveForm = {
  id: "",
  employee_id: "",
  leave_type: "sick",
  start_date: "",
  end_date: "",
  reason: "",
};

const DEFAULT_DEPARTMENT_FORM: DepartmentForm = {
  id: "",
  department_name: "",
  mapped_head_employee_id: "",
};

const DEFAULT_HRMS_FILTERS: HrmsFilters = {
  employee_id: "",
  leave_status: "",
};

function formatCurrency(amount?: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

export default function HrmsPage({ setNotice }: Props) {
  const [data, setData] = useState<HrmsData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tab, setTab] = useState("attendance");
  const [attendanceForm, setAttendanceForm] = useState<AttendanceForm>(DEFAULT_ATTENDANCE_FORM);
  const [payrollForm, setPayrollForm] = useState<PayrollForm>(DEFAULT_PAYROLL_FORM);
  const [leaveForm, setLeaveForm] = useState<LeaveForm>(DEFAULT_LEAVE_FORM);
  const [departmentForm, setDepartmentForm] = useState<DepartmentForm>(DEFAULT_DEPARTMENT_FORM);
  const [filters, setFilters] = useState<HrmsFilters>(DEFAULT_HRMS_FILTERS);
  const [savingAttendance, setSavingAttendance] = useState(false);
  const [savingPayroll, setSavingPayroll] = useState(false);
  const [savingLeave, setSavingLeave] = useState(false);
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [updatingLeaveId, setUpdatingLeaveId] = useState<number | null>(null);

  const buildEmployeePath = (path: string, employeeId: string) => {
    const value = employeeId.trim();
    if (!value) return path;
    const params = new URLSearchParams({ employee_id: value });
    return `${path}?${params.toString()}`;
  };

  const loadHrms = async (nextFilters: HrmsFilters = filters) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [departmentsRes, attendanceRes, payrollRes, leavesRes] = await Promise.all([
        apiFetch<{ departments?: Department[] }>("/api/hr/departments"),
        apiFetch<{ attendance?: Attendance[] }>(buildEmployeePath("/api/hr/attendance", nextFilters.employee_id)),
        apiFetch<{ payroll?: Payroll[] }>(buildEmployeePath("/api/hr/payroll", nextFilters.employee_id)),
        apiFetch<{ leaves?: LeaveRequest[] }>(buildEmployeePath("/api/hr/leaves", nextFilters.employee_id)),
      ]);

      setData({
        departments: departmentsRes.departments || [],
        attendance: attendanceRes.attendance || [],
        payroll: payrollRes.payroll || [],
        leaves: leavesRes.leaves || [],
      });
    } catch (error) {
      const typedError = error as { message?: string; status?: number };
      setErrorMessage(typedError.message || "Unable to load HRMS data.");
      reportError(setNotice, typedError, "Unable to load HRMS data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHrms();
  }, []);

  const visibleLeaves = useMemo(() => {
    if (!filters.leave_status) return data.leaves;
    return data.leaves.filter((leave) => (leave.status || "pending") === filters.leave_status);
  }, [data.leaves, filters.leave_status]);

  const handleFilterSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await loadHrms(filters);
  };

  const clearFilters = async () => {
    setFilters({ ...DEFAULT_HRMS_FILTERS });
    await loadHrms({ ...DEFAULT_HRMS_FILTERS });
  };

  const handleAttendanceSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!attendanceForm.employee_id.trim() || !attendanceForm.attendance_date) {
      setNotice({ type: "error", message: "Employee ID and attendance date are required." });
      return;
    }
    setSavingAttendance(true);
    try {
      const attendanceId = Number(attendanceForm.id);
      const path = attendanceId ? `/api/hr/attendance/${attendanceId}` : "/api/hr/attendance";
      await apiFetch(path, {
        method: attendanceId ? "PUT" : "POST",
        body: JSON.stringify({
          employee_id: attendanceForm.employee_id.trim(),
          attendance_date: attendanceForm.attendance_date,
          status: attendanceForm.status,
          in_time: attendanceForm.in_time || undefined,
          out_time: attendanceForm.out_time || undefined,
        }),
      });
      setAttendanceForm({ ...DEFAULT_ATTENDANCE_FORM });
      setNotice({ type: "success", message: attendanceId ? "Attendance record updated." : "Attendance record created." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create attendance record.");
    } finally {
      setSavingAttendance(false);
    }
  };

  const handlePayrollSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const basicSalary = Number(payrollForm.basic_salary) || 0;
    if (!payrollForm.employee_id.trim() || !payrollForm.payroll_month || basicSalary <= 0) {
      setNotice({ type: "error", message: "Employee ID, payroll month, and basic salary are required." });
      return;
    }
    setSavingPayroll(true);
    try {
      const payrollId = Number(payrollForm.id);
      const path = payrollId ? `/api/hr/payroll/${payrollId}` : "/api/hr/payroll";
      await apiFetch(path, {
        method: payrollId ? "PUT" : "POST",
        body: JSON.stringify({
          employee_id: payrollForm.employee_id.trim(),
          payroll_month: payrollForm.payroll_month,
          basic_salary: basicSalary,
          allowances: Number(payrollForm.allowances) || 0,
          deductions: Number(payrollForm.deductions) || 0,
          paid_status: payrollForm.paid_status,
          paid_date: payrollForm.paid_date || undefined,
        }),
      });
      setPayrollForm({ ...DEFAULT_PAYROLL_FORM });
      setNotice({ type: "success", message: payrollId ? "Payroll record updated." : "Payroll record created." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create payroll record.");
    } finally {
      setSavingPayroll(false);
    }
  };

  const handleLeaveSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!leaveForm.employee_id.trim() || !leaveForm.start_date || !leaveForm.end_date) {
      setNotice({ type: "error", message: "Employee ID, start date, and end date are required." });
      return;
    }
    setSavingLeave(true);
    try {
      const leaveId = Number(leaveForm.id);
      const path = leaveId ? `/api/hr/leaves/${leaveId}/status` : "/api/hr/leaves";
      const body = leaveId
        ? { status: leaveForm.reason.trim() === "rejected" ? "rejected" : "approved" }
        : {
            employee_id: leaveForm.employee_id.trim(),
            leave_type: leaveForm.leave_type,
            start_date: leaveForm.start_date,
            end_date: leaveForm.end_date,
            reason: leaveForm.reason.trim() || undefined,
          };
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (leaveId) {
        setLeaveForm({ ...DEFAULT_LEAVE_FORM });
        setNotice({ type: "success", message: "Leave request updated." });
      } else {
        setLeaveForm({ ...DEFAULT_LEAVE_FORM });
        setNotice({ type: "success", message: "Leave request submitted." });
      }
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create leave request.");
    } finally {
      setSavingLeave(false);
    }
  };

  const handleDepartmentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const departmentName = departmentForm.department_name.trim();
    if (!departmentName) {
      setNotice({ type: "error", message: "Department name is required." });
      return;
    }
    setSavingDepartment(true);
    try {
      const departmentId = Number(departmentForm.id);
      const path = departmentId ? `/api/hr/departments/${departmentId}` : "/api/hr/departments";
      await apiFetch(path, {
        method: departmentId ? "PUT" : "POST",
        body: JSON.stringify({
          department_name: departmentName,
          mapped_head_employee_id: departmentForm.mapped_head_employee_id.trim() || undefined,
        }),
      });
      setDepartmentForm({ ...DEFAULT_DEPARTMENT_FORM });
      setNotice({ type: "success", message: departmentId ? "Department updated." : "Department created." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to create department.");
    } finally {
      setSavingDepartment(false);
    }
  };

  const handleEditAttendance = (record: Attendance) => {
    setAttendanceForm({
      id: String(record.id),
      employee_id: record.employee_id || "",
      attendance_date: record.attendance_date || "",
      status: (record.status as "present" | "absent" | "leave") || "present",
      in_time: record.in_time || "",
      out_time: record.out_time || "",
    });
  };

  const handleDeleteAttendance = async (record: Attendance) => {
    if (!window.confirm(`Delete attendance record #${record.id}?`)) return;
    try {
      await apiFetch(`/api/hr/attendance/${record.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Attendance record deleted." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete attendance record.");
    }
  };

  const handleEditPayroll = (record: Payroll) => {
    setPayrollForm({
      id: String(record.id),
      employee_id: record.employee_id || "",
      payroll_month: record.payroll_month || "",
      basic_salary: String(record.net_salary || 0),
      allowances: "0",
      deductions: "0",
      paid_status: (record.paid_status as "pending" | "paid") || "pending",
      paid_date: record.paid_date || "",
    });
  };

  const handleDeletePayroll = async (record: Payroll) => {
    if (!window.confirm(`Delete payroll record #${record.id}?`)) return;
    try {
      await apiFetch(`/api/hr/payroll/${record.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Payroll record deleted." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete payroll record.");
    }
  };

  const handleEditLeave = (record: LeaveRequest) => {
    setLeaveForm({
      id: String(record.id),
      employee_id: record.employee_id || "",
      leave_type: record.leave_type || "sick",
      start_date: record.start_date || "",
      end_date: record.end_date || "",
      reason: record.status || "approved",
    });
  };

  const handleDeleteLeave = async (record: LeaveRequest) => {
    if (!window.confirm(`Delete leave request #${record.id}?`)) return;
    try {
      await apiFetch(`/api/hr/leaves/${record.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Leave request deleted." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete leave request.");
    }
  };

  const handleEditDepartment = (record: Department) => {
    setDepartmentForm({
      id: String(record.id),
      department_name: record.department_name || "",
      mapped_head_employee_id: record.mapped_head_employee_id || "",
    });
  };

  const handleDeleteDepartment = async (record: Department) => {
    if (!window.confirm(`Delete department ${record.department_name || record.id}?`)) return;
    try {
      await apiFetch(`/api/hr/departments/${record.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Department deleted." });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete department.");
    }
  };

  const handleLeaveStatusUpdate = async (leaveId: number, status: "approved" | "rejected") => {
    setUpdatingLeaveId(leaveId);
    try {
      await apiFetch(`/api/hr/leaves/${leaveId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      setNotice({ type: "success", message: `Leave request ${status}.` });
      await loadHrms(filters);
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to update leave status.");
    } finally {
      setUpdatingLeaveId(null);
    }
  };

  const stats = useMemo(() => {
    const pendingLeaves = data.leaves.filter((leave) => (leave.status || "pending") === "pending").length;
    return {
      departments: data.departments.length,
      attendance: data.attendance.length,
      payrollRuns: data.payroll.length,
      pendingLeaves,
    };
  }, [data]);

  return (
    <section className="module-page">
      <div className="stat-grid module-stat-grid">
        <StatCard label="Departments" value={stats.departments} />
        <StatCard label="Attendance Logs" value={stats.attendance} />
        <StatCard label="Payroll Runs" value={stats.payrollRuns} />
        <StatCard label="Pending Leaves" value={stats.pendingLeaves} />
      </div>

      <div className="panel">
        <div className="module-panel-head">
          <h3>HR Operations</h3>
        </div>

        <form className="module-form-grid module-filter-grid" onSubmit={handleFilterSubmit}>
          <Input
            value={filters.employee_id}
            onChange={(event) => setFilters((current) => ({ ...current, employee_id: event.target.value }))}
            placeholder="Filter by employee ID"
            aria-label="HR filter employee"
          />
          <Select
            value={filters.leave_status}
            onChange={(event) => setFilters((current) => ({ ...current, leave_status: event.target.value }))}
            aria-label="HR filter leave status"
          >
            <option value="">All Leave Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          <div className="module-inline-actions">
            <Button type="submit">Apply</Button>
            <Button type="button" variant="ghost" onClick={() => void clearFilters()}>Clear</Button>
          </div>
        </form>

        {loading ? <p className="muted">Loading HRMS records...</p> : null}
        {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

        {!loading && !errorMessage ? (
          <>
            <Tabs>
              <TabsTrigger active={tab === "attendance"} onClick={() => setTab("attendance")}>Attendance</TabsTrigger>
              <TabsTrigger active={tab === "payroll"} onClick={() => setTab("payroll")}>Payroll</TabsTrigger>
              <TabsTrigger active={tab === "leaves"} onClick={() => setTab("leaves")}>Leaves</TabsTrigger>
              <TabsTrigger active={tab === "departments"} onClick={() => setTab("departments")}>Departments</TabsTrigger>
            </Tabs>

            <TabsContent>
              {tab === "attendance" && (
                <div className="module-tab-panel">
                  <form className="module-form-grid module-sales-grid" onSubmit={handleAttendanceSubmit}>
                    <Input
                      value={attendanceForm.employee_id}
                      onChange={(event) => setAttendanceForm((current) => ({ ...current, employee_id: event.target.value }))}
                      placeholder="Employee ID"
                      aria-label="HR attendance employee"
                    />
                    <Input
                      type="date"
                      value={attendanceForm.attendance_date}
                      onChange={(event) => setAttendanceForm((current) => ({ ...current, attendance_date: event.target.value }))}
                      aria-label="HR attendance date"
                    />
                    <Select
                      value={attendanceForm.status}
                      onChange={(event) =>
                        setAttendanceForm((current) => ({ ...current, status: event.target.value as "present" | "absent" | "leave" }))
                      }
                      aria-label="HR attendance status"
                    >
                      <option value="present">Present</option>
                      <option value="absent">Absent</option>
                      <option value="leave">Leave</option>
                    </Select>
                    <Input
                      type="time"
                      value={attendanceForm.in_time}
                      onChange={(event) => setAttendanceForm((current) => ({ ...current, in_time: event.target.value }))}
                      aria-label="HR attendance in time"
                    />
                    <Input
                      type="time"
                      value={attendanceForm.out_time}
                      onChange={(event) => setAttendanceForm((current) => ({ ...current, out_time: event.target.value }))}
                      aria-label="HR attendance out time"
                    />
                    <Button type="submit" disabled={savingAttendance}>{savingAttendance ? "Saving..." : "Add Attendance"}</Button>
                    {attendanceForm.id ? (
                      <Button type="button" variant="ghost" onClick={() => setAttendanceForm({ ...DEFAULT_ATTENDANCE_FORM })}>Cancel Edit</Button>
                    ) : null}
                  </form>
                  {data.attendance.length === 0 ? <p className="muted">No attendance records available.</p> : null}
                  {data.attendance.length > 0 ? (
                    <>
                      <Table className="module-table module-table-hr" role="table" aria-label="HR attendance table">
                        <TableHead>
                          <TableCell>Employee</TableCell>
                          <TableCell>Date</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>In Time</TableCell>
                          <TableCell>Out Time</TableCell>
                          <TableCell>Actions</TableCell>
                        </TableHead>
                        {data.attendance.slice(0, 12).map((record) => (
                          <TableRow key={record.id}>
                            <TableCell>{record.employee_id || "-"}</TableCell>
                            <TableCell>{formatDate(record.attendance_date)}</TableCell>
                            <TableCell>{record.status || "-"}</TableCell>
                            <TableCell>{record.in_time || "-"}</TableCell>
                            <TableCell>{record.out_time || "-"}</TableCell>
                            <TableCell>
                              <div className="module-inline-actions">
                                <Button type="button" size="sm" onClick={() => handleEditAttendance(record)}>Edit</Button>
                                <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteAttendance(record)}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </Table>
                      <div className="module-mobile-list" aria-label="HR attendance cards">
                        {data.attendance.slice(0, 12).map((record) => (
                          <article className="module-mobile-card" key={`attendance-mobile-${record.id}`}>
                            <h4>{record.employee_id || "Employee"}</h4>
                            <p><strong>Date:</strong> {formatDate(record.attendance_date)}</p>
                            <p><strong>Status:</strong> {record.status || "-"}</p>
                            <p><strong>In:</strong> {record.in_time || "-"}</p>
                            <p><strong>Out:</strong> {record.out_time || "-"}</p>
                            <div className="module-card-actions">
                              <Button type="button" size="sm" onClick={() => handleEditAttendance(record)}>Edit</Button>
                              <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteAttendance(record)}>Delete</Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {tab === "payroll" && (
                <div className="module-tab-panel">
                  <form className="module-form-grid module-sales-grid" onSubmit={handlePayrollSubmit}>
                    <Input
                      value={payrollForm.employee_id}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, employee_id: event.target.value }))}
                      placeholder="Employee ID"
                      aria-label="HR payroll employee"
                    />
                    <Input
                      type="month"
                      value={payrollForm.payroll_month}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, payroll_month: event.target.value }))}
                      aria-label="HR payroll month"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={payrollForm.basic_salary}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, basic_salary: event.target.value }))}
                      placeholder="Basic salary"
                      aria-label="HR payroll basic"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={payrollForm.allowances}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, allowances: event.target.value }))}
                      placeholder="Allowances"
                      aria-label="HR payroll allowances"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={payrollForm.deductions}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, deductions: event.target.value }))}
                      placeholder="Deductions"
                      aria-label="HR payroll deductions"
                    />
                    <Select
                      value={payrollForm.paid_status}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, paid_status: event.target.value as "pending" | "paid" }))}
                      aria-label="HR payroll paid status"
                    >
                      <option value="pending">Pending</option>
                      <option value="paid">Paid</option>
                    </Select>
                    <Input
                      type="date"
                      value={payrollForm.paid_date}
                      onChange={(event) => setPayrollForm((current) => ({ ...current, paid_date: event.target.value }))}
                      aria-label="HR payroll paid date"
                    />
                    <Button type="submit" disabled={savingPayroll}>{savingPayroll ? "Saving..." : "Add Payroll"}</Button>
                    {payrollForm.id ? (
                      <Button type="button" variant="ghost" onClick={() => setPayrollForm({ ...DEFAULT_PAYROLL_FORM })}>Cancel Edit</Button>
                    ) : null}
                  </form>
                  {data.payroll.length === 0 ? <p className="muted">No payroll records available.</p> : null}
                  {data.payroll.length > 0 ? (
                    <>
                      <Table className="module-table module-table-hr" role="table" aria-label="HR payroll table">
                        <TableHead>
                          <TableCell>Employee</TableCell>
                          <TableCell>Month</TableCell>
                          <TableCell>Net Salary</TableCell>
                          <TableCell>Paid Status</TableCell>
                          <TableCell>Paid Date</TableCell>
                          <TableCell>Actions</TableCell>
                        </TableHead>
                        {data.payroll.slice(0, 12).map((record) => (
                          <TableRow key={record.id}>
                            <TableCell>{record.employee_id || "-"}</TableCell>
                            <TableCell>{record.payroll_month || "-"}</TableCell>
                            <TableCell>{formatCurrency(record.net_salary)}</TableCell>
                            <TableCell>{record.paid_status || "pending"}</TableCell>
                            <TableCell>{formatDate(record.paid_date)}</TableCell>
                            <TableCell>
                              <div className="module-inline-actions">
                                <Button type="button" size="sm" onClick={() => handleEditPayroll(record)}>Edit</Button>
                                <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeletePayroll(record)}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </Table>
                      <div className="module-mobile-list" aria-label="HR payroll cards">
                        {data.payroll.slice(0, 12).map((record) => (
                          <article className="module-mobile-card" key={`payroll-mobile-${record.id}`}>
                            <h4>{record.employee_id || "Employee"}</h4>
                            <p><strong>Month:</strong> {record.payroll_month || "-"}</p>
                            <p><strong>Net Salary:</strong> {formatCurrency(record.net_salary)}</p>
                            <p><strong>Paid Status:</strong> {record.paid_status || "pending"}</p>
                            <p><strong>Paid Date:</strong> {formatDate(record.paid_date)}</p>
                            <div className="module-card-actions">
                              <Button type="button" size="sm" onClick={() => handleEditPayroll(record)}>Edit</Button>
                              <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeletePayroll(record)}>Delete</Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {tab === "leaves" && (
                <div className="module-tab-panel">
                  <form className="module-form-grid module-sales-grid" onSubmit={handleLeaveSubmit}>
                    <Input
                      value={leaveForm.employee_id}
                      onChange={(event) => setLeaveForm((current) => ({ ...current, employee_id: event.target.value }))}
                      placeholder="Employee ID"
                      aria-label="HR leave employee"
                    />
                    <Select
                      value={leaveForm.leave_type}
                      onChange={(event) => setLeaveForm((current) => ({ ...current, leave_type: event.target.value }))}
                      aria-label="HR leave type"
                    >
                      <option value="sick">Sick</option>
                      <option value="casual">Casual</option>
                      <option value="annual">Annual</option>
                      <option value="emergency">Emergency</option>
                    </Select>
                    <Input
                      type="date"
                      value={leaveForm.start_date}
                      onChange={(event) => setLeaveForm((current) => ({ ...current, start_date: event.target.value }))}
                      aria-label="HR leave start"
                    />
                    <Input
                      type="date"
                      value={leaveForm.end_date}
                      onChange={(event) => setLeaveForm((current) => ({ ...current, end_date: event.target.value }))}
                      aria-label="HR leave end"
                    />
                    <Input
                      value={leaveForm.reason}
                      onChange={(event) => setLeaveForm((current) => ({ ...current, reason: event.target.value }))}
                      placeholder="Reason"
                      aria-label="HR leave reason"
                    />
                    <Button type="submit" disabled={savingLeave}>{savingLeave ? "Saving..." : "Request Leave"}</Button>
                    {leaveForm.id ? (
                      <Button type="button" variant="ghost" onClick={() => setLeaveForm({ ...DEFAULT_LEAVE_FORM })}>Cancel Edit</Button>
                    ) : null}
                  </form>
                  {visibleLeaves.length === 0 ? <p className="muted">No leave requests available for this filter.</p> : null}
                  {visibleLeaves.length > 0 ? (
                    <>
                      <Table className="module-table module-table-hr" role="table" aria-label="HR leaves table">
                        <TableHead>
                          <TableCell>Employee</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell>Start</TableCell>
                          <TableCell>End</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Actions</TableCell>
                        </TableHead>
                        {visibleLeaves.slice(0, 12).map((record) => (
                          <TableRow key={record.id}>
                            <TableCell>{record.employee_id || "-"}</TableCell>
                            <TableCell>{record.leave_type || "-"}</TableCell>
                            <TableCell>{formatDate(record.start_date)}</TableCell>
                            <TableCell>{formatDate(record.end_date)}</TableCell>
                            <TableCell>{record.status || "pending"}</TableCell>
                            <TableCell>
                              {(record.status || "pending") === "pending" ? (
                                <div className="module-inline-actions">
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => void handleLeaveStatusUpdate(record.id, "approved")}
                                    disabled={updatingLeaveId === record.id}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => void handleLeaveStatusUpdate(record.id, "rejected")}
                                    disabled={updatingLeaveId === record.id}
                                  >
                                    Reject
                                  </Button>
                                </div>
                              ) : (
                                <div className="module-inline-actions">
                                  <Button type="button" size="sm" onClick={() => handleEditLeave(record)}>Edit</Button>
                                  <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteLeave(record)}>Delete</Button>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </Table>
                      <div className="module-mobile-list" aria-label="HR leaves cards">
                        {visibleLeaves.slice(0, 12).map((record) => (
                          <article className="module-mobile-card" key={`leave-mobile-${record.id}`}>
                            <h4>{record.employee_id || "Employee"}</h4>
                            <p><strong>Type:</strong> {record.leave_type || "-"}</p>
                            <p><strong>Start:</strong> {formatDate(record.start_date)}</p>
                            <p><strong>End:</strong> {formatDate(record.end_date)}</p>
                            <p><strong>Status:</strong> {record.status || "pending"}</p>
                            <p><strong>Decision By:</strong> {record.decided_by || "-"}</p>
                            <div className="module-card-actions">
                              {(record.status || "pending") === "pending" ? (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => void handleLeaveStatusUpdate(record.id, "approved")}
                                    disabled={updatingLeaveId === record.id}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => void handleLeaveStatusUpdate(record.id, "rejected")}
                                    disabled={updatingLeaveId === record.id}
                                  >
                                    Reject
                                  </Button>
                                </>
                              ) : null}
                              <Button type="button" size="sm" onClick={() => handleEditLeave(record)}>Edit</Button>
                              <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteLeave(record)}>Delete</Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {tab === "departments" && (
                <div className="module-tab-panel">
                  <form className="module-form-grid" onSubmit={handleDepartmentSubmit}>
                    <Input
                      value={departmentForm.department_name}
                      onChange={(event) => setDepartmentForm((current) => ({ ...current, department_name: event.target.value }))}
                      placeholder="Department name"
                      aria-label="HR department name"
                    />
                    <Input
                      value={departmentForm.mapped_head_employee_id}
                      onChange={(event) => setDepartmentForm((current) => ({ ...current, mapped_head_employee_id: event.target.value }))}
                      placeholder="Head employee ID"
                      aria-label="HR department head"
                    />
                    <Button type="submit" disabled={savingDepartment}>{savingDepartment ? "Saving..." : "Add Department"}</Button>
                    {departmentForm.id ? (
                      <Button type="button" variant="ghost" onClick={() => setDepartmentForm({ ...DEFAULT_DEPARTMENT_FORM })}>Cancel Edit</Button>
                    ) : null}
                  </form>
                  {data.departments.length === 0 ? <p className="muted">No department records available.</p> : null}
                  {data.departments.length > 0 ? (
                    <>
                      <Table className="module-table module-table-hr" role="table" aria-label="HR departments table">
                        <TableHead>
                          <TableCell>Department</TableCell>
                          <TableCell>Head Employee</TableCell>
                          <TableCell>Actions</TableCell>
                          <TableCell />
                          <TableCell />
                          <TableCell />
                        </TableHead>
                        {data.departments.slice(0, 12).map((department) => (
                          <TableRow key={department.id}>
                            <TableCell>{department.department_name || "-"}</TableCell>
                            <TableCell>{department.mapped_head_employee_id || "-"}</TableCell>
                            <TableCell>
                              <div className="module-inline-actions">
                                <Button type="button" size="sm" onClick={() => handleEditDepartment(department)}>Edit</Button>
                                <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteDepartment(department)}>Delete</Button>
                              </div>
                            </TableCell>
                            <TableCell />
                            <TableCell />
                            <TableCell />
                          </TableRow>
                        ))}
                      </Table>
                      <div className="module-mobile-list" aria-label="HR department cards">
                        {data.departments.slice(0, 12).map((department) => (
                          <article className="module-mobile-card" key={`department-mobile-${department.id}`}>
                            <h4>{department.department_name || "Department"}</h4>
                            <p><strong>Head Employee:</strong> {department.mapped_head_employee_id || "-"}</p>
                            <div className="module-card-actions">
                              <Button type="button" size="sm" onClick={() => handleEditDepartment(department)}>Edit</Button>
                              <Button type="button" size="sm" variant="destructive" onClick={() => void handleDeleteDepartment(department)}>Delete</Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </TabsContent>
          </>
        ) : null}
      </div>
    </section>
  );
}
