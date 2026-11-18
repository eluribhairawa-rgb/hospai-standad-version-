import { apiFetch } from "./api";
import { printViaIframe } from "./printViaIframe";
import { buildPrintDocumentHtml } from "./printTemplates";

export type CreditNote = {
  id: number;
  credit_note_no: string;
  patient_id?: string | null;
  patient_name?: string | null;
  invoice_no?: string | null;
  medicine_name: string;
  batch_no?: string | null;
  quantity: number;
  unit_price: number;
  refund_amount: number;
  payment_mode?: string | null;
  reason?: string | null;
  status?: string | null;
  created_by?: string | null;
  created_at?: string | null;
};

const money = (n: number) => `₹${(Number(n) || 0).toFixed(2)}`;

export function printCreditNote(note: CreditNote): void {
  const mode = note.payment_mode ? note.payment_mode.toUpperCase() : "CASH";
  const html = buildPrintDocumentHtml({
    title: `Credit Note ${note.credit_note_no}`,
    subtitleLines: ["HospAI · Pharmacy · Medicine Return Credit Note", note.created_at ? `Date: ${String(note.created_at).slice(0, 16).replace("T", " ")}` : ""],
    meta: [
      { label: "Credit Note No", value: note.credit_note_no },
      { label: "Patient", value: `${note.patient_name || "-"} (${note.patient_id || "-"})` },
      { label: "Original Invoice", value: note.invoice_no || "-" },
      { label: "Refund Mode", value: mode },
    ],
    columns: ["Medicine", "Batch", "Returned Qty", "Unit Price", "Refund Amount", "Reason"],
    rows: [[note.medicine_name, note.batch_no || "-", note.quantity, money(note.unit_price), money(note.refund_amount), note.reason || "-"]],
    totals: [{ label: "Total Refund", value: money(note.refund_amount), grand: true }],
  });
  printViaIframe(html, "__hospai_credit_note_frame__");
}

/** Loads a return's credit note from the server and prints it. */
export async function fetchAndPrintCreditNote(returnId: number): Promise<CreditNote> {
  const res = await apiFetch<{ credit_note: CreditNote }>(`/api/pharmacy/returns/${returnId}/credit-note`);
  printCreditNote(res.credit_note);
  return res.credit_note;
}
