/**
 * Job titles offered in Employee Management, grouped by department.
 *
 * The title chooses which role dashboard an employee sees (backend role_dashboard.py maps
 * it by keyword), but never grants access on its own: module access is still assigned
 * separately, and a role's dashboard widgets need that module. Existing values (Doctor,
 * Nurse, Admin, Receptionist, Technician, Other) are unchanged, so saved employees keep theirs.
 */
export const JOB_TITLE_GROUPS: { label: string; titles: string[] }[] = [
  { label: "Clinical", titles: ["Doctor", "Nurse", "Head Nurse", "Nursing Supervisor"] },
  { label: "Front Office", titles: ["Receptionist", "Front Office Executive"] },
  { label: "Pharmacy", titles: ["Pharmacist"] },
  { label: "Lab & Diagnostics", titles: ["Lab Technician", "Radiology Technician", "Phlebotomist"] },
  { label: "Billing & Accounts", titles: ["Billing Executive", "Cashier", "Accountant", "Insurance Executive"] },
  { label: "General", titles: ["Admin", "Technician", "Other"] },
];

export const JOB_TITLES: string[] = JOB_TITLE_GROUPS.flatMap((g) => g.titles);
