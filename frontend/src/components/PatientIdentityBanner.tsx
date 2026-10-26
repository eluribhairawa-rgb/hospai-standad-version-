import type { Patient } from "../types";
import { formatDate, calculateAgeFromDob } from "../lib/format";

type Props = {
  patient: Patient;
  className?: string;
};

function AllergyBadge({ patient }: { patient: Patient }) {
  const status = patient.allergy_status || (patient.allergies ? "has_allergies" : "not_recorded");

  if (status === "confirmed_none") {
    return <span className="allergy-badge allergy-badge-safe">No Known Drug Allergies</span>;
  }
  if (status === "has_allergies") {
    return <span className="allergy-badge allergy-badge-warning">Allergy: {patient.allergies || "See record"}</span>;
  }
  return <span className="allergy-badge allergy-badge-info">Allergies not recorded</span>;
}

export default function PatientIdentityBanner({ patient, className }: Props) {
  const fullName = [patient.name, patient.middle_name, patient.last_name].filter(Boolean).join(" ");
  const age = patient.age ?? (patient.dob ? calculateAgeFromDob(patient.dob) : null);

  return (
    <div className={`patient-identity-banner${className ? ` ${className}` : ""}`}>
      <div className="patient-identity-main">
        <h3 className="patient-identity-name">{fullName || "Unnamed patient"}</h3>
        <div className="patient-identity-meta">
          <span>UHID: {patient.patient_id}</span>
          {(age !== null && age !== undefined && age !== "") && <span>Age {age}</span>}
          {patient.gender && <span>{patient.gender}</span>}
          {patient.dob && <span>DOB: {formatDate(patient.dob)}</span>}
          {patient.phone && <span>{patient.phone}</span>}
        </div>
        {patient.address && <div className="patient-identity-address">{patient.address}</div>}
      </div>
      <div className="patient-identity-side">
        <AllergyBadge patient={patient} />
      </div>
    </div>
  );
}
