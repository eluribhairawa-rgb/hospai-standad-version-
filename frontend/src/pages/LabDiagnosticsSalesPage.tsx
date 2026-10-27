import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Tabs, TabsTrigger } from "../components/ui";
import type { Notice } from "../types";
import LabDiagnosticsOrdersPage from "./LabDiagnosticsOrdersPage";
import LabDiagnosticsExternalSalePage from "./LabDiagnosticsExternalSalePage";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  onNavigate?: (pageId: string) => void;
};

// Orders & Billing: Internal Sale is the existing UHID-linked workflow, External Sale is the walk-in workflow.
export default function LabDiagnosticsSalesPage({ setNotice, onNavigate }: Props) {
  const [saleType, setSaleType] = useState<"internal" | "external">("internal");
  return (
    <div>
      <Tabs>
        <TabsTrigger active={saleType === "internal"} onClick={() => setSaleType("internal")}>Internal Sale</TabsTrigger>
        <TabsTrigger active={saleType === "external"} onClick={() => setSaleType("external")}>External Sale</TabsTrigger>
      </Tabs>
      {saleType === "internal"
        ? <LabDiagnosticsOrdersPage setNotice={setNotice} onNavigate={onNavigate} />
        : <LabDiagnosticsExternalSalePage setNotice={setNotice} />}
    </div>
  );
}
