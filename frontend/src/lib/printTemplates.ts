import { brandTitle, escapeBrandText } from "./branding";
const escapeHtml = (value: unknown) =>
  String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// printViaIframe() already injects the full HospAI letterhead
// (logo, address, title pulled from <title>/<h1>, print date/time) and the
// closing footer around whatever HTML is passed to it -- these templates
// supply only the body content, never a second header/footer of their own.
const BASE_STYLE = `
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #12344c; font-family: Arial, Helvetica, sans-serif; background: #fff; }
  .content { padding: 4px 2px 2px; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 10px 28px; margin-bottom: 16px; padding: 12px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
  .meta-item span { display: block; font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta-item strong { display: block; font-size: 13px; color: #0f172a; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; font-size: 12px; }
  th { background: #eff6ff; color: #1d4ed8; font-weight: 800; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.03em; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  .totals { margin-top: 14px; margin-left: auto; width: 280px; }
  .totals-row { display: flex; justify-content: space-between; padding: 6px 4px; font-size: 12.5px; color: #334155; }
  .totals-row.grand { border-top: 2px solid #1d4ed8; margin-top: 4px; padding-top: 10px; font-weight: 900; font-size: 15px; color: #0f172a; }
  .empty-note { padding: 20px; text-align: center; color: #94a3b8; font-size: 13px; }
`;

/** A tabular print document -- invoices, reports, any real data table.
 * Rendered under the shared HospAI letterhead that
 * printViaIframe() adds automatically. Never used for raw window.print()
 * of the live app UI. */
export function buildPrintDocumentHtml(opts: {
  title: string;
  subtitleLines: string[];
  meta?: { label: string; value: string }[];
  columns: string[];
  rows: (string | number)[][];
  totals?: { label: string; value: string; grand?: boolean }[];
  emptyMessage?: string;
}) {
  const metaHtml = opts.meta?.length
    ? `<div class="meta-row">${opts.meta.map((m) => `<div class="meta-item"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(m.value)}</strong></div>`).join("")}</div>`
    : "";
  const tableHtml = opts.rows.length
    ? `<table><thead><tr>${opts.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
       <tbody>${opts.rows.map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<div class="empty-note">${escapeHtml(opts.emptyMessage || "No records for this selection.")}</div>`;
  const totalsHtml = opts.totals?.length
    ? `<div class="totals">${opts.totals.map((t) => `<div class="totals-row${t.grand ? " grand" : ""}"><span>${escapeHtml(t.label)}</span><span>${escapeHtml(t.value)}</span></div>`).join("")}</div>`
    : "";
  const subtitle = opts.subtitleLines.filter(Boolean).join(" · ");

  return `
    <html><head><title>${opts.title}</title><style>${BASE_STYLE}</style></head>
    <body>
      <section class="content">
        ${subtitle ? `<p style="margin:0 0 14px;color:#60758a;font-size:12px;">${escapeHtml(subtitle)}</p>` : ""}
        ${metaHtml}
        ${tableHtml}
        ${totalsHtml}
      </section>
    </body></html>
  `;
}

/** A sheet of small dispensing labels, one per medicine line -- meant to be
 * printed and affixed to the medicine packet/pouch, not a billing document. */
export function buildPrintLabelsHtml(opts: {
  patientName: string;
  patientId: string;
  invoiceNo?: string;
  items: { medicineName: string; batchNo?: string; expiryDate?: string; quantity: number }[];
}) {
  const printedAt = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const labelStyle = `
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
    .label-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
    .label { border: 1.5px dashed #94a3b8; border-radius: 6px; padding: 10px 12px; }
    .label-hospital { font-size: 10px; font-weight: 800; color: #062f56; text-transform: uppercase; letter-spacing: 0.04em; }
    .label-medicine { font-size: 15px; font-weight: 800; margin: 4px 0; color: #0f172a; }
    .label-row { font-size: 11px; color: #334155; margin: 2px 0; }
    .label-row b { color: #0f172a; }
    .label-footer { margin-top: 6px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #64748b; display: flex; justify-content: space-between; }
  `;
  const labelsHtml = opts.items.map((it) => `
    <div class="label">
      <div class="label-hospital">${escapeBrandText(brandTitle())} &middot; Pharmacy</div>
      <div class="label-medicine">${escapeHtml(it.medicineName)}</div>
      <div class="label-row"><b>Patient:</b> ${escapeHtml(opts.patientName)} (${escapeHtml(opts.patientId)})</div>
      <div class="label-row"><b>Quantity:</b> ${escapeHtml(it.quantity)}</div>
      ${it.batchNo ? `<div class="label-row"><b>Batch:</b> ${escapeHtml(it.batchNo)}</div>` : ""}
      ${it.expiryDate ? `<div class="label-row"><b>Expiry:</b> ${escapeHtml(it.expiryDate)}</div>` : ""}
      <div class="label-footer"><span>${escapeHtml(opts.invoiceNo || "")}</span><span>${escapeHtml(printedAt)}</span></div>
    </div>
  `).join("");

  return `
    <html><head><title>Pharmacy Labels</title><style>${labelStyle}</style></head>
    <body><div class="label-grid">${labelsHtml || '<p style="padding:20px;color:#94a3b8;">No items to label.</p>'}</div></body>
    </html>
  `;
}
