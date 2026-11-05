import type { User } from "../types";

/**
 * Doctor whose patients this login is limited to, or null when unrestricted.
 * Mirrors security.scoped_doctor_name on the backend (which is what actually enforces it):
 * only non-admin employees with job title Doctor and a linked doctor profile are scoped.
 */
export function getScopedDoctor(user: User | null | undefined): string | null {
  if (!user || user.user_type === "admin" || user.user_type === "super_admin") return null;
  if ((user.job_role || "").trim().toLowerCase() !== "doctor") return null;
  const name = (user.doctor_name || "").trim();
  return name || null;
}

/**
 * Hospital-wide executive figures (all revenue, collections, beds, every patient's activity).
 * Mirrors deps.can_view_hospital_overview on the backend, which enforces it:
 * Admin and Super Admin only; no module grant unlocks it.
 */
export function canViewHospitalOverview(user: User | null | undefined): boolean {
  return !!user && (user.user_type === "admin" || user.user_type === "super_admin");
}
