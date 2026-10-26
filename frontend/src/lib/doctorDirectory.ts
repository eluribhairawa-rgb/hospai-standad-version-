import { useEffect, useState } from "react";
import { apiFetch } from "./api";

// Departments and doctors as configured in the Doctor Scheduling module (OP Desk).
// Every page that lets staff pick a department or doctor should read from here,
// so newly added doctors/departments appear everywhere and nothing is hardcoded.

export type DirectoryDoctor = {
  doctor_name: string;
  department: string;
  consultation_fee: number;
  review_fee: number;
  status: string;
};

type DepartmentRow = { id: number; department_name: string };

export function useDoctorDirectory() {
  const [departments, setDepartments] = useState<string[]>([]);
  const [doctors, setDoctors] = useState<DirectoryDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ departments?: DepartmentRow[] }>("/api/registration/departments"),
      apiFetch<{ doctors?: Partial<DirectoryDoctor>[] }>("/api/op/doctors"),
    ])
      .then(([deptData, doctorData]) => {
        if (cancelled) return;
        const activeDoctors: DirectoryDoctor[] = (doctorData.doctors || [])
          // Same rule as the Doctor Scheduling page's own doctor list.
          .filter((d) => d.doctor_name && d.status !== "inactive" && d.status !== "leave")
          .map((d) => ({
            doctor_name: d.doctor_name as string,
            department: (d.department || "").trim(),
            consultation_fee: Number(d.consultation_fee) || 0,
            review_fee: Number(d.review_fee) || 0,
            status: d.status || "available",
          }))
          .sort((a, b) => a.doctor_name.localeCompare(b.doctor_name));
        const names = (deptData.departments || []).map((d) => (d.department_name || "").trim()).filter(Boolean);
        // A doctor scheduled under a department not (yet) in the master list must still be selectable.
        activeDoctors.forEach((d) => {
          if (d.department && !names.some((n) => n.toLowerCase() === d.department.toLowerCase())) names.push(d.department);
        });
        setDepartments(names.sort((a, b) => a.localeCompare(b)));
        setDoctors(activeDoctors);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { departments, doctors, loading, error };
}

export function doctorsInDepartment(doctors: DirectoryDoctor[], department: string): DirectoryDoctor[] {
  const dept = department.trim().toLowerCase();
  return dept ? doctors.filter((d) => d.department.toLowerCase() === dept) : [];
}
