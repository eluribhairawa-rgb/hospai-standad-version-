import { useEffect, useState } from "react";
import { apiFetch, reportError } from "../lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Table,
  TableCell,
  TableHead,
  TableRow,
} from "../components/ui";
import type { Notice } from "../types";

type ConsultationRecord = {
  id: number;
  patient_id: string;
  patient_name: string;
  visit_type: string;
  department: string;
  doctor_name: string;
  appointment_date: string;
  notes: string;
  status: string;
  registered_patient_name?: string;
  appointment_kind?: string;
};

type DepartmentRecord = {
  id: number;
  department_name: string;
};

type Props = {
  setNotice: (notice: Notice | null) => void;
  onOpenPatient: (patientId: string) => void;
};

export default function DoctorsHistoryPage({ setNotice, onOpenPatient }: Props) {
  // Filter states: empty by default (Don't add any default values)
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState("");

  // Options states
  const [doctorsList, setDoctorsList] = useState<string[]>([]);
  const [departmentsList, setDepartmentsList] = useState<DepartmentRecord[]>([]);
  const [doctorDeptMap, setDoctorDeptMap] = useState<Record<string, string>>({});

  // Query/Data states
  const [consultations, setConsultations] = useState<ConsultationRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 5; // Displays 5 entries per page as in the screenshot

  const loadFilterOptions = async () => {
    try {
      const [deptRes, scheduleRes] = await Promise.all([
        apiFetch<{ departments?: DepartmentRecord[] }>("/api/registration/departments").catch(() => ({ departments: [] })),
        // Fetch all schedules (no date filter) to get the complete set of
        // doctor names for the filter dropdown. We intentionally do NOT filter
        // by status='available' here — we want to show all doctors who have
        // ever had a schedule so that historical records can be looked up.
        apiFetch<{ schedules?: { doctor_name?: string | null; department?: string | null }[] }>("/api/op/doctor-schedules").catch(() => ({ schedules: [] })),
      ]);

      setDepartmentsList(deptRes.departments || []);

      const names = new Set<string>();
      const deptMap: Record<string, string> = {};
      (scheduleRes.schedules || []).forEach((row) => {
        if (row.doctor_name) {
          const docName = row.doctor_name.trim();
          names.add(docName);
          if (row.department) {
            deptMap[docName] = row.department.trim();
          }
        }
      });

      setDoctorsList(Array.from(names).sort((a, b) => a.localeCompare(b)));
      setDoctorDeptMap(deptMap);
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to load page filters.");
    }
  };

  const fetchConsultationHistoryWithParams = async (
    docName: string,
    fromD: string,
    toD: string,
    dept: string
  ) => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams();
      if (docName) queryParams.set("doctor_name", docName);
      if (fromD) queryParams.set("from_date", fromD);
      if (toD) queryParams.set("to_date", toD);
      if (dept) queryParams.set("department", dept);

      const res = await apiFetch<{ history?: ConsultationRecord[] }>(
        `/api/doctors-history?${queryParams.toString()}`
      );
      setConsultations(res.history || []);
      setCurrentPage(1); // Reset to page 1 on new query
    } catch (err) {
      reportError(setNotice, err as { message?: string; status?: number }, "Unable to fetch consultation history.");
    } finally {
      setLoading(false);
    }
  };

  const fetchConsultationHistory = async () => {
    return fetchConsultationHistoryWithParams(selectedDoctor, fromDate, toDate, selectedDepartment);
  };

  const handleDoctorChange = (doctorName: string) => {
    setSelectedDoctor(doctorName);
    let deptVal = selectedDepartment;
    if (doctorName && doctorDeptMap[doctorName]) {
      deptVal = doctorDeptMap[doctorName];
      setSelectedDepartment(deptVal);
    }
    void fetchConsultationHistoryWithParams(doctorName, fromDate, toDate, deptVal);
  };

  const handleDepartmentChange = (deptName: string) => {
    setSelectedDepartment(deptName);
    void fetchConsultationHistoryWithParams(selectedDoctor, fromDate, toDate, deptName);
  };

  useEffect(() => {
    void loadFilterOptions();
    void fetchConsultationHistory();
  }, []);

  const handleShow = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchConsultationHistory();
  };

  const handleReset = () => {
    setSelectedDoctor("");
    setFromDate("");
    setToDate("");
    setSelectedDepartment("");
    // Clear page filters and refresh list with no filters
    setTimeout(() => {
      setLoading(true);
      apiFetch<{ history?: ConsultationRecord[] }>("/api/doctors-history")
        .then((res) => {
          setConsultations(res.history || []);
          setCurrentPage(1);
        })
        .catch((err) => {
          reportError(setNotice, err as { message?: string; status?: number }, "Unable to reset consultation history.");
        })
        .finally(() => {
          setLoading(false);
        });
    }, 0);
  };

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(consultations.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedRecords = consultations.slice((safePage - 1) * pageSize, safePage * pageSize);

  const getStatusBadgeClass = (status: string) => {
    const s = (status || "").toLowerCase();
    if (s === "completed") return "badge-completed"; // green
    if (s === "cancelled" || s === "canceled") return "badge-cancelled"; // red
    return "badge-pending"; // default/blue/yellow
  };

  const formatVisitType = (record: ConsultationRecord) => {
    const kind = (record.appointment_kind || "").toLowerCase();
    if (kind === "new") return "New Patient";
    if (kind === "follow_up") return "Follow Up";
    // Fallback/direct status formatting if needed
    if (record.visit_type) return record.visit_type;
    return "New Patient";
  };

  const formatAppointmentDate = (dateStr: string) => {
    if (!dateStr) return "-";
    try {
      const dt = new Date(dateStr);
      if (isNaN(dt.getTime())) return dateStr;
      
      const day = String(dt.getDate()).padStart(2, "0");
      const month = String(dt.getMonth() + 1).padStart(2, "0");
      const year = dt.getFullYear();
      
      let hours = dt.getHours();
      const minutes = String(dt.getMinutes()).padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
      const formattedHours = String(hours).padStart(2, "0");

      return (
        <div>
          <b className="block-date">{`${day}/${month}/${year}`}</b>
          <span className="block-time muted">{`${formattedHours}:${minutes} ${ampm}`}</span>
        </div>
      );
    } catch {
      return dateStr;
    }
  };

  return (
    <section className="module-page">
      <Card className="panel doctors-history-filter-card">
        <CardHeader>
          <CardTitle>Doctor's History</CardTitle>
          <CardDescription>View consultation history of doctors</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="doctors-history-filters-form" onSubmit={handleShow}>
            <div className="filter-group-grid">
              <div className="filter-input-wrapper">
                <label className="filter-label">Doctor</label>
                <Select
                  value={selectedDoctor}
                  onChange={(e) => handleDoctorChange(e.target.value)}
                  aria-label="Doctor filter"
                >
                  <option value="">Select Doctor</option>
                  {doctorsList.map((doc) => (
                    <option key={doc} value={doc}>
                      {doc}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="filter-input-wrapper">
                <label className="filter-label">From Date</label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  aria-label="From date"
                />
              </div>

              <div className="filter-input-wrapper">
                <label className="filter-label">To Date</label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  aria-label="To date"
                />
              </div>

              <div className="filter-input-wrapper">
                <label className="filter-label">Department</label>
                <Select
                  value={selectedDepartment}
                  onChange={(e) => handleDepartmentChange(e.target.value)}
                  aria-label="Department filter"
                >
                  <option value="">All</option>
                  {departmentsList.map((dept) => (
                    <option key={dept.id} value={dept.department_name}>
                      {dept.department_name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="filter-actions-wrapper">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleReset}
                  className="filter-reset-btn"
                >
                  Reset
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  className="filter-show-btn"
                >
                  Show
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel doctors-history-table-card">
        <CardHeader>
          <CardTitle>Consultation History</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="muted loading-text">Loading consultation history...</p>
          ) : (
            <Table className="module-table module-table-doctors-history" aria-label="Doctors history table">
              <TableHead>
                <TableCell>Date & Time</TableCell>
                <TableCell>Patient Name</TableCell>
                <TableCell>Patient ID</TableCell>
                <TableCell>Visit Type</TableCell>
                <TableCell>Chief Complaint</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Action</TableCell>
              </TableHead>

              {pagedRecords.length > 0 ? (
                pagedRecords.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>{formatAppointmentDate(record.appointment_date)}</TableCell>
                    <TableCell>{record.registered_patient_name || record.patient_name}</TableCell>
                    <TableCell>
                      <b className="patient-id-chip">{record.patient_id || "-"}</b>
                    </TableCell>
                    <TableCell>{formatVisitType(record)}</TableCell>
                    <TableCell className="chief-complaint-cell">{record.notes || "-"}</TableCell>
                    <TableCell>
                      <span className={`status-pill ${getStatusBadgeClass(record.status)}`}>
                        {record.status === "cancelled" || record.status === "canceled" ? "Canceled" : "Completed"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="view-patient-btn"
                        onClick={() => {
                          if (record.patient_id) {
                            onOpenPatient(record.patient_id);
                          }
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="empty-row-cell" style={{ gridColumn: "span 7", textAlign: "center", padding: "2rem", color: "var(--text-muted)", display: "block", width: "100%" }}>
                    No consultation records found matching filters.
                  </TableCell>
                </TableRow>
              )}
            </Table>
          )}

          <div className="queue-pagination doctors-history-pagination">
            <span>
              Showing {consultations.length ? (safePage - 1) * pageSize + 1 : 0} to{" "}
              {Math.min(safePage * pageSize, consultations.length)} of {consultations.length} entries
            </span>
            <div>
              <button
                type="button"
                disabled={safePage === 1 || loading}
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, index) => index + 1)
                .slice(0, 5)
                .map((page) => (
                  <button
                    key={page}
                    type="button"
                    className={safePage === page ? "active" : ""}
                    disabled={loading}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                ))}
              <button
                type="button"
                disabled={safePage === totalPages || loading}
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              >
                ›
              </button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
