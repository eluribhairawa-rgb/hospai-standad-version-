import { PRINT_BRAND_HEADER_DATA_URI } from "./printBrand";
import { brandSystemLabel, brandThanks, brandTitle, escapeBrandText, fitMm, getBranding } from "./branding";

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
export function buildHospaiPrintFooterCss(): string {
  const b = getBranding();
  const raw = b?.footer_text || brandThanks();
  // CSS string literal: escape backslash/quote and flatten newlines.
  const cssText = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  let centre = `@bottom-center { content: image-set(url("${PRINT_BRAND_HEADER_DATA_URI}") 20x); width: 16mm; margin-top: 1.5mm; vertical-align: top; text-align: center; }`;
  if (b?.footer?.data_uri) {
    // Custom footer image, scaled into its box with the aspect ratio kept.
    const [w, h] = fitMm(b.footer.width_px, b.footer.height_px, b.footer_box_mm[0] * 0.6, b.footer_box_mm[1], true);
    if (b.footer.mime === "image/svg+xml") {
      centre = `@bottom-center { content: ""; width: ${w.toFixed(1)}mm; height: ${h.toFixed(1)}mm; margin-top: 1.5mm; background: url("${b.footer.data_uri}") center / contain no-repeat; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
    } else {
      const dppx = (b.footer.width_px || 1) / (w * 3.7795);
      centre = `@bottom-center { content: image-set(url("${b.footer.data_uri}") ${dppx.toFixed(3)}x); width: ${w.toFixed(1)}mm; margin-top: 1.5mm; vertical-align: top; text-align: center; }`;
    }
  } else if (b && b.hospital_title) {
    centre = `@bottom-center { content: ""; }`;
  }
  return `
  @page {
    margin-bottom: 22mm !important;
    @bottom-left { content: "${cssText}"; text-align: left; ${FOOTER_TEXT_BOX} }
    ${centre}
    @bottom-right { content: "Page " counter(page) " of " counter(pages); text-align: right; ${FOOTER_TEXT_BOX} }
  }`;
}

/** Default footer (no custom branding) -- kept for existing imports. */
export const HOSPAI_PRINT_FOOTER_CSS = buildHospaiPrintFooterCss();

function appendSharedHospaiPrintFooter(html: string): string {
  if (html.includes("data-hospai-print-footer-style")) return html;
  // Appended last so it wins over any @page rule the document declares itself.
  const style = `<style data-hospai-print-footer-style>${buildHospaiPrintFooterCss()}</style>`;
  const bodyEnd = html.lastIndexOf("</body>");
  return bodyEnd >= 0 ? `${html.slice(0, bodyEnd)}${style}${html.slice(bodyEnd)}` : `${html}${style}`;
}

function getPrintTitleFontSizePt(title: string): number {
  const len = title.trim().length;
  if (len <= 20) return 18;
  if (len <= 32) return 15.5;
  if (len <= 48) return 13.5;
  if (len <= 65) return 11.5;
  return 10;
}

/** Letterhead row: the built-in HospAI logo by default, or the hospital's own logo/title
 * (alignment, offsets, auto-fit) from Branding & Templates. */
function buildBrandRowHtml(): string {
  const b = getBranding();
  if (!b || (!b.logo?.data_uri && !b.hospital_title)) {
    return `<div class="hospai-shared-brand-row" style="padding: 2.5mm 0;">
        <img class="hospai-shared-brand-logo" src="${PRINT_BRAND_HEADER_DATA_URI}" alt="HospAI, Pharmacy and Diagnostic" />
      </div>`;
  }
  const titleText = (b.hospital_title || "").trim();
  const lines = titleText.replace(/\\n/g, "\n").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const maxLineLen = lines.length ? Math.max(...lines.map((l) => l.length)) : 0;
  const customPt = b.title_font_size_pt ? Number(b.title_font_size_pt) : null;
  const fontSizePt = (customPt && customPt >= 6 && customPt <= 36)
    ? customPt
    : (maxLineLen <= 20 ? 18 : maxLineLen <= 32 ? 15.5 : maxLineLen <= 48 ? 13.5 : maxLineLen <= 65 ? 11.5 : 10);
  const titleContent = lines.length > 1
    ? lines.map((l, idx) => `<div style="font: ${idx === 0 ? 800 : 600} ${idx === 0 ? fontSizePt : Math.max(fontSizePt - 3, 9.5)}pt Arial, Helvetica, sans-serif; color: ${idx === 0 ? "#000" : "#334155"}; text-transform: uppercase; line-height: 1.25; letter-spacing: -0.2px;">${escapeBrandText(l)}</div>`).join("")
    : `<div style="font: 800 ${fontSizePt}pt Arial, Helvetica, sans-serif; color: #000; text-transform: uppercase; line-height: 1.25; letter-spacing: -0.2px;">${escapeBrandText(titleText)}</div>`;
  const titleHtml = `<div style="flex: 1; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1mm;">${titleContent}</div>`;

  if (!b.logo?.data_uri) {
    return `<div class="hospai-shared-brand-row" style="align-items: center; justify-content: center; min-height: auto; padding: 2.5mm 0;">
      ${titleHtml}
    </div>`;
  }

  const [w, h] = fitMm(b.logo.width_px, b.logo.height_px, b.logo_box_mm[0], b.logo_box_mm[1], b.auto_fit_scaling);
  // Prevent any negative Y offset from shifting the logo past the top boundary
  const safeOffsetY = Math.max(b.logo_offset_y_mm ?? 0, -2.5);
  const logoImg = `<img src="${b.logo.data_uri}" alt="${escapeBrandText(titleText || "Hospital logo")}" style="display: block; width: ${w.toFixed(2)}mm; height: ${h.toFixed(2)}mm; max-width: 100%; object-fit: contain; position: relative; left: ${b.logo_offset_x_mm}mm; top: ${safeOffsetY}mm;" />`;

  if (!titleText) {
    const justify = b.logo_alignment === "center" ? "center" : b.logo_alignment === "right" ? "flex-end" : "flex-start";
    return `<div class="hospai-shared-brand-row" style="justify-content: ${justify}; align-items: center; min-height: auto; padding: 2.5mm 0;">
      <div style="display: flex; align-items: center; justify-content: ${justify}; overflow: visible;">${logoImg}</div>
    </div>`;
  }

  if (b.logo_alignment === "center") {
    return `<div class="hospai-shared-brand-row" style="flex-direction: column; align-items: center; justify-content: center; min-height: auto; gap: 2.5mm; padding: 2.5mm 0;">
      <div style="display: flex; align-items: center; justify-content: center; overflow: visible;">${logoImg}</div>
      ${titleHtml}
    </div>`;
  }

  if (b.logo_alignment === "right") {
    return `<div class="hospai-shared-brand-row" style="align-items: center; justify-content: space-between; min-height: auto; gap: 3mm; padding: 2.5mm 0;">
      <div style="flex-shrink: 0; width: ${w.toFixed(2)}mm; visibility: hidden;" aria-hidden="true"></div>
      ${titleHtml}
      <div style="flex-shrink: 0; width: ${w.toFixed(2)}mm; display: flex; align-items: center; justify-content: flex-end; overflow: visible;">${logoImg}</div>
    </div>`;
  }

  // Default: left alignment
  return `<div class="hospai-shared-brand-row" style="align-items: center; justify-content: space-between; min-height: auto; gap: 3mm; padding: 2.5mm 0;">
    <div style="flex-shrink: 0; width: ${w.toFixed(2)}mm; display: flex; align-items: center; justify-content: flex-start; overflow: visible;">${logoImg}</div>
    ${titleHtml}
    <div style="flex-shrink: 0; width: ${w.toFixed(2)}mm; visibility: hidden;" aria-hidden="true"></div>
  </div>`;
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
        <div class="brand">${escapeBrandText(brandTitle())}</div>
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
      @page {
        size: A4 portrait;
        margin-top: 12mm !important;
        margin-bottom: 21mm !important;
        margin-left: 10mm !important;
        margin-right: 10mm !important;
      }
      * { box-sizing: border-box; }
      html { background: #fff !important; }
      body { margin: 0 !important; color: #000 !important; background: transparent !important; position: relative; z-index: 0; }
      .hospai-shared-watermark {
        display: none !important;
      }
      .hospai-shared-print-shell {
        width: 100%;
        margin: 0 0 6mm;
        padding-top: 2.5mm;
        color: #000;
        font-family: Arial, Helvetica, sans-serif;
        break-inside: avoid;
        overflow: visible;
      }
      .hospai-shared-brand-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-height: 28mm;
        padding: 2.5mm 0;
        overflow: visible;
        box-sizing: border-box;
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
        margin: 2mm 0 4mm;
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
      ${buildBrandRowHtml()}
      <div class="hospai-shared-header-divider"></div>
      <div class="hospai-shared-report-row">
        <div class="hospai-shared-report-title"><h1>${title}</h1><p>${escapeBrandText(brandTitle())} | Pharmacy | Diagnostic</p></div>
        <table class="hospai-shared-report-meta" aria-label="Print information"><tbody>
          <tr><td>Print Date</td><td>:</td><td>${printDate}</td></tr>
          <tr><td>Generated By</td><td>:</td><td>${brandSystemLabel()}</td></tr>
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
