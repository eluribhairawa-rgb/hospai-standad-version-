import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Tabs, TabsTrigger } from "../components/ui";
import type { Notice } from "../types";
import LabDiagnosticsOrdersPage from "./LabDiagnosticsOrdersPage";
import LabDiagnosticsExternalSalePage from "./LabDiagnosticsExternalSalePage";
import LabOutsourcingOrderPage from "./LabOutsourcingOrderPage";
import LabHomeVisitsPage from "./LabHomeVisitsPage";
import LabOrderHistoryPage from "./LabOrderHistoryPage";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

type SalesTab = "in_house" | "external" | "outsourcing" | "home_visit" | "history";

// Orders & Billing: four ways to start an order (In-house = UHID patients, External = walk-ins,
// Outsourcing = sent to a partner lab, Home Visit = collected at the patient's address), all billed
// through the same invoice/payment flow and listed together in Order History.
export default function LabDiagnosticsSalesPage({ setNotice, onNavigate }: Props) {
  const [tab, setTab] = useState<SalesTab>("in_house");
  return (
    <div>
      <Tabs>
        <TabsTrigger active={tab === "in_house"} onClick={() => setTab("in_house")}>In-house</TabsTrigger>
        <TabsTrigger active={tab === "external"} onClick={() => setTab("external")}>External</TabsTrigger>
        <TabsTrigger active={tab === "outsourcing"} onClick={() => setTab("outsourcing")}>Outsourcing</TabsTrigger>
        <TabsTrigger active={tab === "home_visit"} onClick={() => setTab("home_visit")}>Home Visits</TabsTrigger>
        <TabsTrigger active={tab === "history"} onClick={() => setTab("history")}>Order History</TabsTrigger>
      </Tabs>
      {tab === "in_house" && <LabDiagnosticsOrdersPage setNotice={setNotice} onNavigate={onNavigate} />}
      {tab === "external" && <LabDiagnosticsExternalSalePage setNotice={setNotice} />}
      {tab === "outsourcing" && <LabOutsourcingOrderPage setNotice={setNotice} />}
      {tab === "home_visit" && <LabHomeVisitsPage setNotice={setNotice} />}
      {tab === "history" && <LabOrderHistoryPage setNotice={setNotice} onNavigate={onNavigate} />}
    </div>
  );
}
