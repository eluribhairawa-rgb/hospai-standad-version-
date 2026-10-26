import { PRINT_BRAND_HEADER_DATA_URI } from "./printBrand";

/**
 * printViaIframe – shared print utility
 *
 * Uses a Blob URL loaded into a hidden <iframe> so that:
 *  - No popup blocker can interfere (no window.open)
 *  - Large base64 images (logo) are preserved in full (doc.write truncates them)
 *  - The browser's native print dialog is triggered reliably via iframe.contentWindow.print()
 */
function escapeSharedPrintText(value: string): string {
  return String(value || "Medical Document")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractSharedPrintTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return titleMatch[1].replace(/<[^>]+>/g, "").trim();
  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return headingMatch?.[1]?.replace(/<[^>]+>/g, "").trim() || "Medical Document";
}

const FOOTER_TEXT_BOX = `
  margin-top: 6mm;
  padding-top: 3.2mm;
  border-top: 0.45mm solid #000;
  vertical-align: top;
  font: italic 400 7.5pt Arial, Helvetica, sans-serif;
  color: #000;`;

/**
 * The approved HospAI footer (rule - logo - rule, "Thank you for choosing HospAI.",
 * "Page X of Y"), matching the backend PDF footer. Drawn in the @page bottom
 * margin boxes, so it is pinned to the bottom of every printed page and can
 * never overlap the content. The logo is `content` (not a background image)
 * so it prints even with "Background graphics" unchecked. !important keeps a
 * document's own smaller @page margin from squeezing the footer out.
 */
export const HOSPAI_PRINT_FOOTER_CSS = `
  @page {
    margin-bottom: 22mm !important;
    @bottom-left { content: "Thank you for choosing HospAI."; text-align: left; ${FOOTER_TEXT_BOX} }
    @bottom-center { content: image-set(url("${PRINT_BRAND_HEADER_DATA_URI}") 20x); width: 16mm; margin-top: 1.5mm; vertical-align: top; text-align: center; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); text-align: right; ${FOOTER_TEXT_BOX} }
  }`;

function appendSharedHospaiPrintFooter(html: string): string {
  if (html.includes("data-hospai-print-footer-style")) return html;
  // Appended last so it wins over any @page rule the document declares itself.
  const style = `<style data-hospai-print-footer-style>${HOSPAI_PRINT_FOOTER_CSS}</style>`;
  const bodyEnd = html.lastIndexOf("</body>");
  return bodyEnd >= 0 ? `${html.slice(0, bodyEnd)}${style}${html.slice(bodyEnd)}` : `${html}${style}`;
}

function applySharedHospaiPrintFrame(html: string): string {
  if (!html) return html;

  const title = escapeSharedPrintText(extractSharedPrintTitle(html));
  const now = new Date();
  const printDate = now.toLocaleDateString("en-GB");
  const printTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });

  // A physical specimen/medicine/wristband label declares its own narrow
  // body width (it's sized for a small sticker, not an A4 page). The full
  // letterhead below needs ~75mm just for its meta-info column, so forcing
  // it into a ~74mm-wide label collapses the grid and overlaps every line.
  // Those get a compact, single-line mark instead of the full letterhead.
  const bodyWidthMatch = html.match(/<body[^>]*style="[^"]*width:\s*(\d+)px/i);
  const isNarrowLabel = !!bodyWidthMatch && Number(bodyWidthMatch[1]) < 400;

  // Sticker labels are too small for the page footer as well.
  if (isNarrowLabel) {
    if (html.includes("data-hospai-shared-print-shell")) return html;
    const compactCss = `
      <style data-hospai-shared-print-style>
        @page { margin: 4mm; }
        .hospai-shared-label-mark { font-family: Arial, Helvetica, sans-serif; margin-bottom: 2mm; }
        .hospai-shared-label-mark .brand { font-size: 8.5pt; font-weight: 800; color: #062f56; }
        .hospai-shared-label-mark .meta { font-size: 6.5pt; color: #475569; margin-top: 0.5mm; }
        .hospai-shared-label-mark .rule { border-top: 0.4mm solid #000; margin-top: 1.5mm; }
      </style>`;
    const compactHeader = `
      <div class="hospai-shared-label-mark" data-hospai-shared-print-shell>
        <div class="brand">HospAI</div>
        <div class="meta">${title} &middot; ${printDate} ${printTime}</div>
        <div class="rule"></div>
      </div>`;

    let compactOutput = html;
    compactOutput = compactOutput.includes("</head>") ? compactOutput.replace("</head>", `${compactCss}</head>`) : `${compactCss}${compactOutput}`;
    compactOutput = compactOutput.includes("<body")
      ? compactOutput.replace(/<body([^>]*)>/i, `<body$1>${compactHeader}`)
      : `${compactHeader}${compactOutput}`;
    return compactOutput;
  }

  // Documents that bring their own letterhead still get the shared page footer.
  if (html.includes("data-hospai-shared-print-shell")) {
    return appendSharedHospaiPrintFooter(html);
  }

  const sharedCss = `
    <style data-hospai-shared-print-style>
      @page { size: A4 portrait; margin: 9mm 10mm 21mm; }
      * { box-sizing: border-box; }
      html { background: #fff !important; }
      body { margin: 0 !important; color: #000 !important; background: transparent !important; position: relative; z-index: 0; }
      .hospai-shared-watermark {
        display: none !important;
      }
      .hospai-shared-print-shell {
        width: 100%;
        margin: 0 0 7mm;
        color: #000;
        font-family: Arial, Helvetica, sans-serif;
        break-inside: avoid;
      }
      .hospai-shared-brand-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        min-height: 32mm;
      }
      .hospai-shared-brand-logo {
        width: 86mm;
        max-width: 100%;
        height: 27mm;
        object-fit: contain;
        object-position: left top;
        display: block;
      }
      .hospai-shared-header-divider {
        width: 100%;
        margin: 1.5mm 0 4mm;
        border-top: 0.65mm solid #000;
      }
      .hospai-shared-report-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 67mm;
        align-items: start;
        gap: 8mm;
      }
      .hospai-shared-report-title h1 {
        margin: 0 0 1.3mm;
        font-size: 15pt;
        line-height: 1.15;
        font-weight: 800;
        color: #000;
        text-decoration: none;
      }
      .hospai-shared-report-title p {
        margin: 0;
        font-size: 9.8pt;
        line-height: 1.3;
        color: #333;
      }
      .hospai-shared-report-meta {
        width: 100%;
        border-collapse: collapse;
        font-size: 8.5pt;
      }
      .hospai-shared-report-meta td { padding: 0 0 1.5mm; border: 0 !important; background: transparent !important; vertical-align: top; }
      .hospai-shared-report-meta td:first-child { width: 30mm; white-space: nowrap; }
      .hospai-shared-report-meta td:nth-child(2) { width: 5mm; text-align: center; padding: 0 1mm; }
      .hospai-shared-report-meta td:last-child { font-weight: 600; text-align: right; }
      body > .print-header,
      main > .print-header,
      .journey-print-header,
      .journey-print-topline,
      .report-header,
      .pdf > .print-header { display: none !important; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
      @media print {
        .hospai-shared-print-shell { display: block; }
      }
    </style>`;

  const header = `
    <header class="hospai-shared-print-shell" data-hospai-shared-print-shell>
      <div class="hospai-shared-brand-row">
        <img class="hospai-shared-brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI, Pharmacy and Diagnostic" />
      </div>
      <div class="hospai-shared-header-divider"></div>
      <div class="hospai-shared-report-row">
        <div class="hospai-shared-report-title"><h1>${title}</h1><p>HospAI | Pharmacy | Diagnostic</p></div>
        <table class="hospai-shared-report-meta" aria-label="Print information"><tbody>
          <tr><td>Print Date</td><td>:</td><td>${printDate}</td></tr>
          <tr><td>Generated By</td><td>:</td><td>HospAI System</td></tr>
          <tr><td>Generated Time</td><td>:</td><td>${printTime}</td></tr>
        </tbody></table>
      </div>
    </header>`;

  let output = html;
  output = output.includes("</head>") ? output.replace("</head>", `${sharedCss}</head>`) : `${sharedCss}${output}`;
  output = output.includes("<body")
    ? output.replace(/<body([^>]*)>/i, `<body$1>${header}`)
    : `${header}${output}`;
  return appendSharedHospaiPrintFooter(output);
}

export function printViaIframe(html: string, frameId = "__hospai_print_frame__"): void {
  const existing = document.getElementById(frameId);
  if (existing) existing.remove();

  const iframe = document.createElement("iframe");
  iframe.id = frameId;
  iframe.setAttribute(
    "style",
    "position:fixed;right:100%;bottom:100%;width:1000px;height:1000px;border:none;opacity:0;pointer-events:none;"
  );
  document.body.appendChild(iframe);

  const standardizedHtml = applySharedHospaiPrintFrame(html);
  const blob = new Blob([standardizedHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  iframe.onload = () => {
    // Small delay lets fonts/images inside the blob document fully paint
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        // Clean up after the user closes/submits the print dialog
        setTimeout(() => {
          try {
            iframe.remove();
            URL.revokeObjectURL(url);
          } catch {
            /* already removed */
          }
        }, 4000);
      }
    }, 400);
  };

  iframe.src = url;
}
