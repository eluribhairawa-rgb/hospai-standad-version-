import { API_BASE } from "./constants";
import { getHospitalCode } from "./api";
import { filenameFromContentDisposition } from "./exportShare";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { PRINT_BRAND_HEADER_DATA_URI } from "./printBrand";
import { brandSystemLabel, brandThanks, brandTitle, escapeBrandText, fitMm, getBranding } from "./branding";

export type StandardPdfSection = {
  title: string;
  headers: string[];
  rows: Array<Array<string | number | null | undefined>>;
};

export type StandardPdfPayload = {
  title: string;
  subtitle: string;
  filename: string;
  operator_name?: string;
  invoice_meta?: {
    invoice_number?: string;
    invoice_date?: string;
  };
  patient_info?: {
    patient_name?: string;
    patient_id?: string;
    age?: string | number;
    gender?: string;
    mobile?: string;
    email?: string;
    address?: string;
    consulting_doctor?: string;
  };
  totals?: {
    subtotal?: string | number;
    grand_total?: string | number;
    amount_received?: string | number;
    balance?: string | number;
  };
  payment_details?: {
    receipt_number?: string;
    payment_date?: string;
    payment_mode?: string;
    amount_paid?: string | number;
  };
  sections: StandardPdfSection[];
};

function datedFilename(base: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const normalized = String(base || "Hospital_Report")
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${normalized || "Hospital_Report"}_${date}.pdf`;
}

/** Patient documents are named after the patient: ("bhanu y", "PAT-20260928-0001") -> "Bhanu_Y_PAT-20260928-0001".
 * An optional suffix (e.g. an invoice number) keeps several documents of one patient apart. */
export function patientFilename(name: string | null | undefined, uhid: string | null | undefined, suffix?: string | null): string {
  const titleName = String(name || "").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return [titleName, uhid, suffix]
    .map((part) => String(part || "").trim().replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("_") || "Patient_Document";
}

// 1. Generate PDF Blob from standard report endpoint (POST)
// dated: false keeps the filename exactly as given (used for patient-named documents).
export async function generatePDFBlob(
  payload: Omit<StandardPdfPayload, "filename"> & { filename?: string },
  { dated = true }: { dated?: boolean } = {}
): Promise<{ blob: Blob; filename: string }> {
  const filename = dated ? datedFilename(payload.filename || payload.title) : `${String(payload.filename || payload.title).replace(/\.pdf$/i, "")}.pdf`;
  const response = await fetch(`${API_BASE}/api/reports/export/pdf`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Hospital-Code": getHospitalCode() },
    body: JSON.stringify({ ...payload, filename }),
  });

  if (!response.ok) {
    let message = "Unable to generate PDF report.";
    try {
      const data = await response.json();
      message = data?.error || data?.details || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error("The generated PDF is empty.");
  const resolvedFilename = filenameFromContentDisposition(response.headers.get("Content-Disposition"), filename) || filename;
  return { blob, filename: resolvedFilename };
}

// 2. Download PDF
export function downloadPDF(blob: Blob, filename: string): void {
  const mimeType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : (blob.type || "application/octet-stream");
  const pdfBlob = new Blob([blob], { type: mimeType });
  const url = window.URL.createObjectURL(pdfBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  
  // Revoke Object URL to prevent memory leaks
  setTimeout(() => {
    window.URL.revokeObjectURL(url);
  }, 15000);
}

// 3. Print PDF
export function printPDF(blob: Blob): void {
  const mimeType = blob.type || "application/pdf";
  const pdfBlob = new Blob([blob], { type: mimeType });
  const url = window.URL.createObjectURL(pdfBlob);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "100%";
  iframe.style.bottom = "100%";
  iframe.style.width = "1024px";
  iframe.style.height = "768px";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.src = url;
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (e) {
      console.warn("Iframe print preview blocked, opening PDF window:", e);
      const printWindow = window.open(url, "_blank");
      if (printWindow) {
        printWindow.focus();
      }
    }
    window.setTimeout(() => {
      iframe.remove();
      window.URL.revokeObjectURL(url);
    }, 60000);
  };
  document.body.appendChild(iframe);
}

// 4. Share PDF (handles Web Share API if supported)
export async function sharePDF(blob: Blob, filename: string, title: string, text?: string): Promise<boolean> {
  const mimeType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : (blob.type || "application/octet-stream");
  const file = new File([blob], filename, { type: mimeType });
  
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData & { files?: File[] }) => boolean;
    share?: (data: ShareData & { files?: File[] }) => Promise<void>;
  };

  const hasNativeShare = typeof nav.share === "function";
  let canShareFile = false;

  if (hasNativeShare && typeof nav.canShare === "function") {
    try {
      canShareFile = nav.canShare({ files: [file] });
    } catch (err) {
      console.error("navigator.canShare check failed:", err);
    }
  }

  if (canShareFile && nav.share) {
    try {
      await nav.share({
        title,
        text: text || title,
        files: [file]
      });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err; // Propagate abort so we don't trigger fallback
      }
      console.error("Native share failed:", err);
    }
  }
  return false;
}

// 5. Centralized Export PDF Flow (with native share check, fallback to global window handler)
export async function exportPDF(
  blob: Blob,
  filename: string,
  title: string,
  text?: string,
  setNotice?: (notice: { type: "success" | "error" | "info"; message: string } | null) => void,
  contact?: { phone?: string | null; phoneCountryCode?: string | null }
): Promise<void> {
  try {
    const shared = await sharePDF(blob, filename, title, text);
    if (shared) {
      if (setNotice) setNotice({ type: "success", message: `${title} shared successfully.` });
      return;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // User aborted native sharing, so do not fallback or alert.
      return;
    }
  }

  // Fallback to desktop/browser-specific share options dialog
  if (window.__hospai_export_share__) {
    window.__hospai_export_share__({
      blob,
      filename,
      title,
      text,
      phone: contact?.phone,
      phoneCountryCode: contact?.phoneCountryCode,
    });
  } else {
    // Ultimate fallback if no UI listener is registered
    downloadPDF(blob, filename);
    if (setNotice) {
      setNotice({
        type: "info",
        message: "Sharing is not supported on this browser. The report has been downloaded instead."
      });
    }
  }
}

declare global {
  interface Window {
    __hospai_export_share__?: (options: {
      blob: Blob;
      filename: string;
      title: string;
      text?: string;
      shareUrl?: string;
      phone?: string | null;
      phoneCountryCode?: string | null;
    }) => void;
  }
}

// --- PDF Header Configuration Constants ---
const PDF_LOGO_WIDTH = "380px";
const PDF_LOGO_HEIGHT = "auto";
const PDF_HEADER_SPACING = "20px";
const PDF_IMAGE_PADDING = "20px";

const MM = 72 / 25.4;
const PDF_FOOTER_HEIGHT_PT = 22 * MM;

/** Same footer as the backend PDFs (export_utils.py): rule - logo - rule,
 * "Thank you for choosing HospAI." and "Page X of Y", at the bottom of every page. */
function drawPdfFooter(pdf: jsPDF): void {
  const total = pdf.getNumberOfPages();
  const pageHeightMm = pdf.internal.pageSize.getHeight() / MM;
  const lineY = (pageHeightMm - 16.8) * MM;
  for (let page = 1; page <= total; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.45 * MM);
    pdf.line(15 * MM, lineY, 99 * MM, lineY);
    pdf.line(111 * MM, lineY, 195 * MM, lineY);
    const brand = getBranding();
    try {
      if (brand?.footer?.data_uri && brand.footer.mime === "image/png") {
        const [fw, fh] = fitMm(brand.footer.width_px, brand.footer.height_px, brand.footer_box_mm[0] * 0.6, 8, true);
        pdf.addImage(brand.footer.data_uri, "PNG", (105 - fw / 2) * MM, lineY - fh / 2 * MM, fw * MM, fh * MM, "brand-footer-image", "FAST");
      } else if (!brand?.hospital_title || brand.logo?.data_uri) {
        pdf.addImage(PRINT_BRAND_HEADER_DATA_URI, "PNG", 100.2 * MM, lineY - 4 * MM, 9.55 * MM, 8 * MM, "hospai-footer-logo", "FAST");
      }
    } catch {
      // logo is decorative; keep the rest of the footer
    }
    pdf.setFont("helvetica", "italic");
    pdf.setFontSize(7.5);
    pdf.setTextColor(0, 0, 0);
    const textY = (pageHeightMm - 9.5) * MM;
    pdf.text(brand?.footer_text || brandThanks(), 15 * MM, textY);
    pdf.text(`Page ${page} of ${total}`, 195 * MM, textY, { align: "right" });
  }
}

// 6. Client-Side PDF Generation (Dashboard, custom layouts)
export async function generateClientPdf(
  elementIdOrClass: string,
  baseFilename: string,
  title: string
): Promise<{ blob: Blob; filename: string }> {
  // Wait for React to finish rendering any pending states
  await new Promise((resolve) => setTimeout(resolve, 600));

  const element = document.querySelector(elementIdOrClass) as HTMLElement;
  if (!element) {
    console.error(`[PDF Export] Container ${elementIdOrClass} not found`);
    throw new Error(`Container ${elementIdOrClass} not found`);
  }

  try {
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.left = "-9999px";
    wrapper.style.top = "0";
    wrapper.style.width = "1200px"; 
    wrapper.style.backgroundColor = "#ffffff";
    wrapper.style.padding = "40px";
    wrapper.style.fontFamily = "Arial, sans-serif";
    
    const printDate = new Date().toLocaleDateString("en-GB");
    const printTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });

    wrapper.innerHTML = `
      <div style="position: relative; z-index: 1;">

        <!-- Header -->
        <div style="margin-bottom: ${PDF_HEADER_SPACING};">
          ${(() => {
            const b = getBranding();
            if (!b || (!b.logo?.data_uri && !b.hospital_title)) {
              return `<div style="display: flex; justify-content: flex-start; align-items: center;">
                <img src="${PRINT_BRAND_HEADER_DATA_URI}" style="width: ${PDF_LOGO_WIDTH}; height: ${PDF_LOGO_HEIGHT}; object-fit: contain;" alt="HospAI Logo" />
              </div>`;
            }
            const titleText = (b.hospital_title || "").trim();
            const lines = titleText.replace(/\\n/g, "\n").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const maxLineLen = lines.length ? Math.max(...lines.map(l => l.length)) : 0;
            const customPt = b.title_font_size_pt ? Number(b.title_font_size_pt) : null;
            const fontPx = (customPt && customPt >= 6 && customPt <= 36)
              ? Math.round(customPt * 1.333)
              : (maxLineLen <= 20 ? 24 : maxLineLen <= 32 ? 20 : maxLineLen <= 48 ? 17 : maxLineLen <= 65 ? 15 : 13);
            const titleContent = lines.length > 1
              ? lines.map((l, idx) => `<div style="font-size: ${idx === 0 ? fontPx : Math.max(fontPx - 4, 12)}px; font-weight: ${idx === 0 ? 800 : 600}; color: ${idx === 0 ? "#000" : "#334155"}; text-transform: uppercase; line-height: 1.25;">${escapeBrandText(l)}</div>`).join("")
              : `<div style="font-size: ${fontPx}px; font-weight: 800; color: #000; text-transform: uppercase; line-height: 1.25;">${escapeBrandText(titleText)}</div>`;
            const titleContainer = `<div style="flex: 1; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;">${titleContent}</div>`;

            if (!b.logo?.data_uri) {
              return `<div style="text-align: center; width: 100%;">${titleContent}</div>`;
            }

            const [w, h] = fitMm(b.logo.width_px, b.logo.height_px, b.logo_box_mm[0], b.logo_box_mm[1], b.auto_fit_scaling);
            const px = (mm: number) => Math.round(mm * 3.7795 * 1.6);
            const logoImg = `<img src="${b.logo.data_uri}" style="width: ${px(w)}px; height: ${px(h)}px; object-fit: contain;" alt="${escapeBrandText(titleText || "Logo")}" />`;

            if (!titleText) {
              const justify = b.logo_alignment === "center" ? "center" : b.logo_alignment === "right" ? "flex-end" : "flex-start";
              return `<div style="display: flex; justify-content: ${justify}; align-items: center;">${logoImg}</div>`;
            }

            if (b.logo_alignment === "center") {
              return `<div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
                <div>${logoImg}</div>
                ${titleContainer}
              </div>`;
            }

            if (b.logo_alignment === "right") {
              return `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                <div style="width: ${px(w)}px; flex-shrink: 0; visibility: hidden;"></div>
                ${titleContainer}
                <div style="width: ${px(w)}px; flex-shrink: 0; display: flex; justify-content: flex-end;">${logoImg}</div>
              </div>`;
            }

            return `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
              <div style="width: ${px(w)}px; flex-shrink: 0; display: flex; justify-content: flex-start;">${logoImg}</div>
              ${titleContainer}
              <div style="width: ${px(w)}px; flex-shrink: 0; visibility: hidden;"></div>
            </div>`;
          })()}
        </div>
        
        <div style="border-top: 2px solid #000; margin-bottom: ${PDF_HEADER_SPACING};"></div>
        
        <!-- Report Title Section -->
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px;">
          <div>
            <h1 style="margin: 0 0 5px; font-size: 24px; font-weight: 800; color: #000;">${title}</h1>
            <p style="margin: 0; font-size: 14px; color: #333;">${escapeBrandText(brandTitle())} | Pharmacy | Diagnostic</p>
          </div>
          <div style="text-align: right; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; width: 200px;"><span>Print Date:</span><strong>${printDate}</strong></div>
            <div style="display: flex; justify-content: space-between; width: 200px;"><span>Generated By:</span><strong>${brandSystemLabel()}</strong></div>
            <div style="display: flex; justify-content: space-between; width: 200px;"><span>Generated Time:</span><strong>${printTime}</strong></div>
          </div>
        </div>
        
        <div id="hospai-client-pdf-clone"></div>
        
      </div>
    `;

    document.body.appendChild(wrapper);

    // Clone and sanitize dashboard content
    const clone = element.cloneNode(true) as HTMLElement;
    
    // Remove interactive elements like headers or buttons
    const removeSelectors = ['.hosp-dashboard-top', '.hosp-view-all', 'button', '.no-print'];
    removeSelectors.forEach(sel => {
      const els = clone.querySelectorAll(sel);
      els.forEach(el => el.remove());
    });
    
    const cloneContainer = wrapper.querySelector("#hospai-client-pdf-clone");
    if (cloneContainer) cloneContainer.appendChild(clone);

    const canvas = await html2canvas(wrapper, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      allowTaint: false,
      logging: false,
      windowWidth: 1200,
    });

    document.body.removeChild(wrapper);

    const imgData = canvas.toDataURL("image/png", 1.0);
    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4",
      compress: true,
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    // Keep the bottom band free for the standard footer drawn below.
    const pdfHeight = pdf.internal.pageSize.getHeight() - PDF_FOOTER_HEIGHT_PT;
    
    const imgProps = pdf.getImageProperties(imgData);
    const margin = 0; 
    const availableWidth = pdfWidth - margin * 2;
    const imgWidth = availableWidth;
    const imgHeight = (imgProps.height * imgWidth) / imgProps.width;

    let finalWidth = imgWidth;
    let finalHeight = imgHeight;
    const availableHeight = pdfHeight - margin * 2;

    if (imgHeight > availableHeight) {
      finalHeight = availableHeight;
      finalWidth = (imgProps.width * finalHeight) / imgProps.height;
    }

    const xOffset = margin + (availableWidth - finalWidth) / 2;
    pdf.addImage(imgData, "PNG", xOffset, margin, finalWidth, finalHeight, undefined, "FAST");
    drawPdfFooter(pdf);

    const blob = pdf.output("blob");
    if (!blob.size) {
      console.error("[PDF Export] Blob generation failed (empty output).");
      throw new Error("PDF blob is empty");
    }
    
    return { blob, filename: datedFilename(baseFilename) };
  } catch (err) {
    console.error("[PDF Export] html2canvas or jsPDF failed:", err);
    throw new Error("Unable to generate PDF.");
  }
}
