import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IconType } from "react-icons";
import { FaHospitalAlt, FaTruck, FaUserAlt, FaHome } from "react-icons/fa";
import type { Notice } from "../types";
import type { ServiceType } from "../components/lab/LabCheckout";
import LabOrderWorkspace from "./LabOrderWorkspace";
import LabOrderHistoryPage from "./LabOrderHistoryPage";
import { PendingVendorQueue, VisitBoard } from "./LabHomeVisitsPage";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

const TYPES: { key: ServiceType; label: string; hint: string; icon: IconType }[] = [
  { key: "IN_HOUSE", label: "In-house", hint: "Registered patients with UHID", icon: FaHospitalAlt },
  { key: "EXTERNAL", label: "External", hint: "Walk-in patients without UHID", icon: FaUserAlt },
  { key: "OUTSOURCING", label: "Outsourcing", hint: "Tests sent to external labs", icon: FaTruck },
  { key: "HOME_VISIT", label: "Home Visits", hint: "Sample collection at home", icon: FaHome },
];

// Orders & Billing: pick how the order starts (four cards), build it on the shared order
// screen (patient, services, bill, invoice, payment), and see every order in Order History.
export default function LabDiagnosticsSalesPage({ setNotice, onNavigate }: Props) {
  const [type, setType] = useState<ServiceType>("IN_HOUSE");
  const [homeView, setHomeView] = useState<"book" | "board" | "pending">("book");
  const [refreshKey, setRefreshKey] = useState(0);
  const [preset, setPreset] = useState<{ query: string; nonce: number } | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const viewHistory = (query: string) => {
    setPreset({ query, nonce: Date.now() });
    historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="lab-ob-page">
      <div className="lab-ob-types" role="tablist" aria-label="Order type">
        {TYPES.map(({ key, label, hint, icon: Icon }) => (
          <button key={key} type="button" role="tab" aria-selected={type === key} className={`lab-ob-type ${type === key ? "active" : ""}`}
            onClick={() => { setType(key); setHomeView("book"); }}>
            <Icon className="lab-ob-type-icon" aria-hidden />
            <span><strong>{label}</strong><small>{hint}</small></span>
          </button>
        ))}
      </div>

      {type === "HOME_VISIT" && (
        <div className="lab-ob-segment" style={{ marginBottom: "1rem" }}>
          <button type="button" className={homeView === "book" ? "active" : ""} onClick={() => setHomeView("book")}>Book a visit</button>
          <button type="button" className={homeView === "board" ? "active" : ""} onClick={() => setHomeView("board")}>Visit board</button>
          <button type="button" className={homeView === "pending" ? "active" : ""} onClick={() => setHomeView("pending")}>Needs partner lab</button>
        </div>
      )}

      {type === "HOME_VISIT" && homeView === "board" && <VisitBoard setNotice={setNotice} onRouted={() => setRefreshKey((k) => k + 1)} />}
      {type === "HOME_VISIT" && homeView === "pending" && <PendingVendorQueue setNotice={setNotice} onChange={() => setRefreshKey((k) => k + 1)} />}
      {(type !== "HOME_VISIT" || homeView === "book") && (
        <LabOrderWorkspace key={type} serviceType={type} setNotice={setNotice}
          onOrderSaved={() => setRefreshKey((k) => k + 1)} onViewHistory={viewHistory} />
      )}

      <LabOrderHistoryPage ref={historyRef} setNotice={setNotice} onNavigate={onNavigate} refreshKey={refreshKey} preset={preset} />
    </div>
  );
}
