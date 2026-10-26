import { useEffect, useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import StatCard from "../components/StatCard";
import { Button, Input, Select, Table, TableCell, TableHead, TableRow, Textarea } from "../components/ui";
import { apiFetch, reportError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { Notice, OtSummary } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

type OtTheatre = {
  id: number;
  theatre_code: string;
  theatre_name: string;
  equipment_notes?: string | null;
  status?: string | null;
  created_at?: string;
};

type OtSurgery = {
  id: number;
  theatre_id: number;
  patient_id?: string | null;
  procedure_name: string;
  surgeon_name: string;
  scheduled_start: string;
  estimated_duration_hours?: number | null;
  status?: string | null;
  equipment_required?: string | null;
  notes?: string | null;
  created_at?: string;
};

type TheatreForm = {
  id: string;
  theatre_code: string;
  theatre_name: string;
  status: string;
  equipment_notes: string;
};

type SurgeryForm = {
  id: string;
  theatre_id: string;
  patient_id: string;
  procedure_name: string;
  surgeon_name: string;
  scheduled_start: string;
  estimated_duration_hours: string;
  status: string;
  equipment_required: string;
  notes: string;
};

const EMPTY_SUMMARY: OtSummary = {
  theatre_count: 0,
  available_theatres: 0,
  scheduled_surgeries: 0,
  completed_surgeries: 0,
  scheduled_hours: 0,
  completed_hours: 0,
  theatre_utilization: [],
};

const DEFAULT_THEATRE_FORM: TheatreForm = {
  id: "",
  theatre_code: "",
  theatre_name: "",
  status: "",
  equipment_notes: "",
};

const DEFAULT_SURGERY_FORM: SurgeryForm = {
  id: "",
  theatre_id: "",
  patient_id: "",
  procedure_name: "",
  surgeon_name: "",
  scheduled_start: "",
  estimated_duration_hours: "",
  status: "",
  equipment_required: "",
  notes: "",
};

function toDateTimeLocalValue(value?: string | null) {
  if (!value) return "";
  const normalized = value.trim().replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    parsed.getFullYear(),
    "-",
    pad(parsed.getMonth() + 1),
    "-",
    pad(parsed.getDate()),
    "T",
    pad(parsed.getHours()),
    ":",
    pad(parsed.getMinutes()),
  ].join("");
}

export default function OtPage({ setNotice }: Props) {
  const [summary, setSummary] = useState<OtSummary>(EMPTY_SUMMARY);
  const [theatres, setTheatres] = useState<OtTheatre[]>([]);
  const [surgeries, setSurgeries] = useState<OtSurgery[]>([]);
  const [loading, setLoading] = useState(true);
  const [theatreForm, setTheatreForm] = useState<TheatreForm>(DEFAULT_THEATRE_FORM);
  const [surgeryForm, setSurgeryForm] = useState<SurgeryForm>(DEFAULT_SURGERY_FORM);
  const [savingTheatre, setSavingTheatre] = useState(false);
  const [savingSurgery, setSavingSurgery] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  const loadOt = async () => {
    setLoading(true);
    try {
      const [summaryData, theatreData, surgeryData] = await Promise.all([
        apiFetch<OtSummary>("/api/ot/summary"),
        apiFetch<{ theatres?: OtTheatre[] }>("/api/ot/theatres"),
        apiFetch<{ surgeries?: OtSurgery[] }>("/api/ot/surgeries"),
      ]);
      const fetchedTheatres = theatreData.theatres || [];
      const fetchedSurgeries = surgeryData.surgeries || [];
      setSummary({ ...EMPTY_SUMMARY, ...summaryData });
      setTheatres(fetchedTheatres);
      setSurgeries(fetchedSurgeries);
      setSurgeryForm((current) => {
        if (current.theatre_id) return current;
        return { ...current, theatre_id: fetchedTheatres[0] ? String(fetchedTheatres[0].id) : "" };
      });
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to load OT data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOt();
  }, []);

  const visibleSurgeries = useMemo(() => {
    if (!statusFilter) return surgeries;
    return surgeries.filter((item) => (item.status || "scheduled") === statusFilter);
  }, [surgeries, statusFilter]);

  const handleTheatreSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!theatreForm.theatre_code.trim() || !theatreForm.theatre_name.trim()) {
      setNotice({ type: "error", message: "Theatre code and theatre name are required." });
      return;
    }

    setSavingTheatre(true);
    try {
      const theatreId = Number(theatreForm.id);
      const path = theatreId ? `/api/ot/theatres/${theatreId}` : "/api/ot/theatres";
      await apiFetch(path, {
        method: theatreId ? "PUT" : "POST",
        body: JSON.stringify({
          theatre_code: theatreForm.theatre_code.trim(),
          theatre_name: theatreForm.theatre_name.trim(),
          status: theatreForm.status,
          equipment_notes: theatreForm.equipment_notes.trim() || undefined,
        }),
      });
      setTheatreForm({ ...DEFAULT_THEATRE_FORM });
      setNotice({
        type: "success",
        message: theatreId ? "OT theatre updated successfully." : "OT theatre created successfully.",
      });
      await loadOt();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save OT theatre.");
    } finally {
      setSavingTheatre(false);
    }
  };

  const handleSurgerySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const theatreId = Number(surgeryForm.theatre_id);
    if (!theatreId || !surgeryForm.procedure_name.trim() || !surgeryForm.surgeon_name.trim() || !surgeryForm.scheduled_start) {
      setNotice({ type: "error", message: "Theatre, procedure, surgeon, and schedule are required." });
      return;
    }

    setSavingSurgery(true);
    try {
      const surgeryId = Number(surgeryForm.id);
      const path = surgeryId ? `/api/ot/surgeries/${surgeryId}` : "/api/ot/surgeries";
      await apiFetch(path, {
        method: surgeryId ? "PUT" : "POST",
        body: JSON.stringify({
          theatre_id: theatreId,
          patient_id: surgeryForm.patient_id.trim() || undefined,
          procedure_name: surgeryForm.procedure_name.trim(),
          surgeon_name: surgeryForm.surgeon_name.trim(),
          scheduled_start: surgeryForm.scheduled_start,
          estimated_duration_hours: Number(surgeryForm.estimated_duration_hours) || 1,
          status: surgeryForm.status,
          equipment_required: surgeryForm.equipment_required.trim() || undefined,
          notes: surgeryForm.notes.trim() || undefined,
        }),
      });
      setSurgeryForm((current) => ({
        ...DEFAULT_SURGERY_FORM,
        theatre_id: current.theatre_id || (theatres[0] ? String(theatres[0].id) : ""),
      }));
      setNotice({
        type: "success",
        message: surgeryId ? "Surgery updated successfully." : "Surgery scheduled successfully.",
      });
      await loadOt();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to save surgery.");
    } finally {
      setSavingSurgery(false);
    }
  };

  const handleEditTheatre = (theatre: OtTheatre) => {
    setTheatreForm({
      id: String(theatre.id),
      theatre_code: theatre.theatre_code,
      theatre_name: theatre.theatre_name,
      status: theatre.status || "available",
      equipment_notes: theatre.equipment_notes || "",
    });
  };

  const handleDeleteTheatre = async (theatre: OtTheatre) => {
    if (!window.confirm(`Delete ${theatre.theatre_code}?`)) return;
    try {
      await apiFetch(`/api/ot/theatres/${theatre.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "OT theatre deleted." });
      await loadOt();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete OT theatre.");
    }
  };

  const handleEditSurgery = (surgery: OtSurgery) => {
    setSurgeryForm({
      id: String(surgery.id),
      theatre_id: String(surgery.theatre_id),
      patient_id: surgery.patient_id || "",
      procedure_name: surgery.procedure_name,
      surgeon_name: surgery.surgeon_name,
      scheduled_start: toDateTimeLocalValue(surgery.scheduled_start),
      estimated_duration_hours: String(surgery.estimated_duration_hours ?? 1),
      status: surgery.status || "scheduled",
      equipment_required: surgery.equipment_required || "",
      notes: surgery.notes || "",
    });
  };

  const handleDeleteSurgery = async (surgery: OtSurgery) => {
    if (!window.confirm(`Delete ${surgery.procedure_name}?`)) return;
    try {
      await apiFetch(`/api/ot/surgeries/${surgery.id}`, { method: "DELETE" });
      setNotice({ type: "success", message: "Surgery removed." });
      await loadOt();
    } catch (error) {
      reportError(setNotice, error as { message?: string; status?: number }, "Unable to delete surgery.");
    }
  };

  return (
    <section className="module-page">
      <div className="stat-grid module-stat-grid">
        <StatCard label="OT Rooms" value={summary.theatre_count} />
        <StatCard label="Available" value={summary.available_theatres} />
        <StatCard label="Scheduled" value={summary.scheduled_surgeries} />
        <StatCard label="Completed" value={summary.completed_surgeries} />
        <StatCard label="Scheduled Hrs" value={summary.scheduled_hours} />
        <StatCard label="Completed Hrs" value={summary.completed_hours} />
      </div>

      {loading ? <p className="muted">Loading OT operations...</p> : null}

      <div className="panel">
        <div className="module-panel-head">
          <h3>OT Utilization</h3>
        </div>
        {summary.theatre_utilization.length === 0 ? (
          <p className="muted">No OT utilisation data yet.</p>
        ) : (
          <div className="bar-chart">
            {summary.theatre_utilization.map((row) => (
              <div className="bar-row" key={row.label}>
                <span>{row.label}</span>
                <div className="bar">
                  <div
                    style={{
                      width: `${Math.max(
                        8,
                        (row.count / Math.max(...summary.theatre_utilization.map((item) => item.count || 0), 1)) * 100
                      )}%`,
                    }}
                  />
                </div>
                <span>{`${Number(row.count || 0)} hr`}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="split">
        <div className="panel">
          <div className="module-panel-head">
            <h3>Manage Theatres</h3>
          </div>
          <form className="module-form-grid" onSubmit={handleTheatreSubmit}>
            <Input
              value={theatreForm.theatre_code}
              onChange={(event) => setTheatreForm((current) => ({ ...current, theatre_code: event.target.value }))}
              placeholder="Theatre code"
              aria-label="OT theatre code"
            />
            <Input
              value={theatreForm.theatre_name}
              onChange={(event) => setTheatreForm((current) => ({ ...current, theatre_name: event.target.value }))}
              placeholder="Theatre name"
              aria-label="OT theatre name"
            />
            <Select
              value={theatreForm.status}
              onChange={(event) => setTheatreForm((current) => ({ ...current, status: event.target.value }))}
              aria-label="OT theatre status"
            >
              <option value="available">Available</option>
              <option value="occupied">Occupied</option>
              <option value="maintenance">Maintenance</option>
            </Select>
            <Button type="submit" variant="primary" disabled={savingTheatre}>
              {savingTheatre ? "Saving..." : theatreForm.id ? "Update Theatre" : "Add Theatre"}
            </Button>
            <Textarea
              value={theatreForm.equipment_notes}
              onChange={(event) => setTheatreForm((current) => ({ ...current, equipment_notes: event.target.value }))}
              placeholder="Equipment notes"
              aria-label="OT theatre equipment notes"
              rows={3}
            />
          </form>
        </div>

        <div className="panel">
          <div className="module-panel-head">
            <h3>Schedule Surgery</h3>
          </div>
          <form className="module-form-grid module-sales-grid" onSubmit={handleSurgerySubmit}>
            <Select
              value={surgeryForm.theatre_id}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, theatre_id: event.target.value }))}
              aria-label="OT surgery theatre"
            >
              <option value="">Select theatre</option>
              {theatres.map((theatre) => (
                <option key={theatre.id} value={theatre.id}>
                  {theatre.theatre_code} - {theatre.theatre_name}
                </option>
              ))}
            </Select>
            <Input
              value={surgeryForm.patient_id}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, patient_id: event.target.value }))}
              placeholder="Patient ID (optional)"
              aria-label="OT patient id"
            />
            <Input
              value={surgeryForm.procedure_name}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, procedure_name: event.target.value }))}
              placeholder="Procedure"
              aria-label="OT procedure"
            />
            <Input
              value={surgeryForm.surgeon_name}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, surgeon_name: event.target.value }))}
              placeholder="Surgeon"
              aria-label="OT surgeon"
            />
            <Input
              type="datetime-local"
              value={surgeryForm.scheduled_start}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, scheduled_start: event.target.value }))}
              aria-label="OT scheduled start"
            />
            <Input
              type="number"
              min={0.5}
              step={0.5}
              value={surgeryForm.estimated_duration_hours}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, estimated_duration_hours: event.target.value }))}
              placeholder="Duration (hours)"
              aria-label="OT duration"
            />
            <Select
              value={surgeryForm.status}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, status: event.target.value }))}
              aria-label="OT surgery status"
            >
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
            <Input
              value={surgeryForm.equipment_required}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, equipment_required: event.target.value }))}
              placeholder="Equipment required"
              aria-label="OT equipment required"
            />
            <Input
              value={surgeryForm.notes}
              onChange={(event) => setSurgeryForm((current) => ({ ...current, notes: event.target.value }))}
              placeholder="Notes"
              aria-label="OT surgery notes"
            />
            <Button type="submit" variant="primary" disabled={savingSurgery}>
              {savingSurgery ? "Saving..." : surgeryForm.id ? "Update Surgery" : "Schedule"}
            </Button>
          </form>
        </div>
      </div>

      <div className="panel">
        <div className="module-panel-head">
          <h3>OT Theatres</h3>
        </div>
        {theatres.length === 0 ? (
          <p className="muted">No OT theatres configured yet.</p>
        ) : (
          <Table className="module-table module-table-ot-theatres" aria-label="OT theatres table">
            <TableHead>
              <TableCell>Code</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Equipment</TableCell>
              <TableCell>Created</TableCell>
              <TableCell>Actions</TableCell>
            </TableHead>
            {theatres.map((theatre) => (
              <TableRow key={theatre.id}>
                <TableCell>{theatre.theatre_code}</TableCell>
                <TableCell>{theatre.theatre_name}</TableCell>
                <TableCell>{theatre.status || "available"}</TableCell>
                <TableCell>{theatre.equipment_notes || "-"}</TableCell>
                <TableCell>{formatDateTime(theatre.created_at)}</TableCell>
                <TableCell>
                  <div className="module-inline-actions">
                    <Button type="button" onClick={() => handleEditTheatre(theatre)}>
                      Edit
                    </Button>
                    <Button type="button" variant="destructive" onClick={() => handleDeleteTheatre(theatre)}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </div>

      <div className="panel">
        <div className="module-panel-head">
          <h3>Scheduled Surgeries</h3>
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="OT status filter">
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
        {visibleSurgeries.length === 0 ? (
          <p className="muted">No surgeries match the current filter.</p>
        ) : (
          <Table className="module-table module-table-ot-surgeries" aria-label="OT surgeries table">
            <TableHead>
              <TableCell>Procedure</TableCell>
              <TableCell>Surgeon</TableCell>
              <TableCell>Theatre</TableCell>
              <TableCell>Patient</TableCell>
              <TableCell>Schedule</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Actions</TableCell>
            </TableHead>
            {visibleSurgeries.map((surgery) => (
              <TableRow key={surgery.id}>
                <TableCell>{surgery.procedure_name}</TableCell>
                <TableCell>{surgery.surgeon_name}</TableCell>
                <TableCell>{theatres.find((item) => item.id === surgery.theatre_id)?.theatre_code || surgery.theatre_id}</TableCell>
                <TableCell>{surgery.patient_id || "-"}</TableCell>
                <TableCell>{formatDateTime(surgery.scheduled_start)}</TableCell>
                <TableCell>{surgery.status || "scheduled"}</TableCell>
                <TableCell>{`${Number(surgery.estimated_duration_hours || 0)} hr`}</TableCell>
                <TableCell>
                  <div className="module-inline-actions">
                    <Button type="button" onClick={() => handleEditSurgery(surgery)}>
                      Edit
                    </Button>
                    <Button type="button" variant="destructive" onClick={() => handleDeleteSurgery(surgery)}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </div>
    </section>
  );
}
