import { apiFetch } from "./api";

// Shared types and pure helpers for Lab & Diagnostics reports (LAB + IMAGING),
// used by both the active Reports & Approval workflow and the read-only
// Reports History archive so their print/WhatsApp-share output stays
// identical and isn't duplicated between the two pages.

export type ReportRow = {
  id: number; order_item_id: number; report_type: string; version: number; status: string;
  service_name: string; department_type: string; order_no: string; patient_id: string; priority: string;
  patient_first_name?: string; patient_last_name?: string; has_open_critical?: boolean;
  tat_status?: "on_time" | "near_due" | "overdue" | null; elapsed_hours?: number; tat_target_hours?: number;
  released_at?: string; authorized_at?: string; created_at?: string;
};

export type ReportDetail = ReportRow & {
  content?: any; drafted_by?: string; authorized_by?: string; authorized_at?: string; released_at?: string;
  return_reason?: string; amendment_reason?: string;
  order_item: any;
  all_versions: { id: number; version: number; status: string }[];
};

// Hand-off key so "Go to report" elsewhere opens that exact report in Reports & Approval.
export const PENDING_REPORT_KEY = "selected_diag_report";

/** Resolves the order item's current report (creating version 1 only if none exists) and opens it in Reports & Approval. */
export async function openReportForItem(itemId: number, reportType: "LAB" | "IMAGING", onNavigate: (pageId: string) => void): Promise<void> {
  try {
    const report = await apiFetch<{ id: number }>(`/api/diag/items/${itemId}/report-draft`, { method: "POST", body: JSON.stringify({ report_type: reportType }) });
    try { localStorage.setItem(PENDING_REPORT_KEY, String(report.id)); } catch { /* still navigate to the worklist */ }
  } catch {
    // Fall back to the worklist; the report can still be found there.
  }
  onNavigate("diag-reports-approval");
}

export const IMAGING_FIELDS = ["clinical_indication", "comparison", "technique", "findings", "impression"];

export function patientName(first?: string, last?: string, fallback?: string): string {
  return [first, last].filter(Boolean).join(" ") || fallback || "";
}

export function buildPrintBody(report: ReportDetail, content: Record<string, string>): string {
  const orderItem = report.order_item || {};
  if (report.report_type !== "LAB") {
    return `<p><strong>Clinical indication:</strong> ${content.clinical_indication || orderItem.clinical_indication || "-"}</p>
      <p><strong>Technique:</strong> ${content.technique || "-"}</p>
      <p><strong>Findings:</strong> ${content.findings || "-"}</p>
      <p><strong>Impression:</strong> ${content.impression || "-"}</p>`;
  }
  const rows = (orderItem.results || [])
    .map((r: any) => `<tr><td>${r.parameter_name}</td><td>${r.value_numeric ?? r.value_text ?? "-"}</td><td>${r.unit || "-"}</td><td>${r.ref_range_text || `${r.ref_low ?? ""}-${r.ref_high ?? ""}`}</td><td>${r.flag || "-"}</td></tr>`)
    .join("");
  return `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;">
      <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference range</th><th>Flag</th></tr></thead>
      <tbody>${rows}</tbody>
    </table><p>${content.summary || ""}</p>`;
}

/** Builds the full print document (letterhead + body) for either a LAB or IMAGING report, any status. */
export function buildReportPrintHtml(report: ReportDetail, content: Record<string, string>): string {
  const orderItem = report.order_item || {};
  const patient = orderItem.patient || {};
  const isLab = report.report_type === "LAB";
  const statusLabel = report.status === "released" || report.status === "amended"
    ? "FINAL"
    : report.status === "authorized"
      ? "AUTHORIZED"
      : "DRAFT / PRELIMINARY";
  return `
    <html><head><title>${report.service_name} report</title></head><body style="font-family:sans-serif;padding:24px;">
    <h2>HospAI -- ${isLab ? "Laboratory" : "Imaging"} Report</h2>
    <p><strong>${statusLabel}</strong> -- Version ${report.version}</p>
    <p>Patient: ${patient.name || ""} ${patient.last_name || ""} &nbsp; UHID: ${report.patient_id} &nbsp; Age/Sex: ${patient.age ?? "-"}/${patient.gender ?? "-"}</p>
    <p>Order: ${report.order_no} &nbsp; Test: ${report.service_name}</p>
    ${buildPrintBody(report, content)}
    <p style="margin-top:2rem;">Authorized by: ${report.authorized_by || "-"} ${report.authorized_at ? "on " + new Date(report.authorized_at).toLocaleString() : ""}</p>
    </body></html>
  `;
}

// Builds the WhatsApp-ready clinical summary shared with a patient or referring
// doctor: flagged lab values (or imaging findings/impression) plus report metadata.
export function buildWhatsAppMessage(report: ReportDetail, content: Record<string, string>): string {
  const orderItem = report.order_item || {};
  const patient = orderItem.patient || {};
  const doctorName = report.authorized_by || orderItem.referring_clinician || "Consultant";

  let summary: string;
  if (report.report_type === "LAB") {
    const abnormalResults = (orderItem.results || []).filter((r: any) => r.flag);
    summary = abnormalResults.length > 0
      ? "Flagged Values: " + abnormalResults
          .map((r: any) => `${r.parameter_name}: ${r.value_numeric ?? r.value_text} ${r.unit || ""} [${r.flag}]`)
          .join("; ")
      : content.summary || "All evaluated clinical parameters are within normal biological limits.";
  } else {
    summary = [
      content.findings ? `Findings: ${content.findings}` : "",
      content.impression ? `Impression: ${content.impression}` : "",
    ].filter(Boolean).join("\n") || "Imaging evaluation completed.";
  }

  return [
    "*HospAI - Diagnostic Report Summary*",
    "━━━━━━━━━━━━━━━━━━━━",
    `*Patient:* ${patientName(patient.name, patient.last_name, report.patient_id)} (${report.patient_id})`,
    `*Investigation:* ${report.service_name} (Order #${report.order_no})`,
    `*Status:* ${report.status.toUpperCase()} (v${report.version})`,
    `*Date:* ${new Date().toLocaleDateString("en-GB")}`,
    "",
    "*Clinical Summary:*",
    summary,
    "",
    `*Authorized Specialist:* Dr. ${doctorName}`,
    "━━━━━━━━━━━━━━━━━━━━",
    "HospAI · Domalguda, Hyderabad · Ph: +91 9849237676",
  ].join("\n");
}
