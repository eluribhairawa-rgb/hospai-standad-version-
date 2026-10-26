import { API_BASE } from "./constants";

export type ShareExportOptions = {
  blob: Blob;
  filename: string;
  title: string;
  text?: string;
};

export type ShareExportResult = "shared" | "downloaded" | "cancelled";

export function downloadExportBlob(blob: Blob, filename: string) {
  console.log(`[Dashboard PDF Export] downloadExportBlob called. Filename: ${filename}, Input Blob size: ${blob.size} bytes, type: ${blob.type}`);
  if (!blob || blob.size === 0) {
    console.error(`[Dashboard PDF Export] Invalid or empty blob passed to downloadExportBlob.`);
    return;
  }
  const mimeType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : (blob.type || "application/octet-stream");
  const pdfBlob = new Blob([blob], { type: mimeType });
  console.log(`[Dashboard PDF Export] Created Blob with MIME type: ${mimeType}, Size: ${pdfBlob.size} bytes`);
  
  let url = "";
  try {
    url = window.URL.createObjectURL(pdfBlob);
    console.log(`[Dashboard PDF Export] Created Object URL: ${url}`);
    
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    
    console.log(`[Dashboard PDF Export] Triggering download via anchor.click() for: ${filename}`);
    anchor.click();
    
    document.body.removeChild(anchor);
    console.log(`[Dashboard PDF Export] Anchor element clean-up complete`);
  } catch (error) {
    console.error(`[Dashboard PDF Export] Object URL creation/download execution failed:`, error);
    throw error;
  }

  if (url) {
    console.log(`[Dashboard PDF Export] Scheduling Object URL revocation in 15 seconds for: ${url}`);
    // Delay revocation to ensure browser successfully downloads file
    setTimeout(() => {
      try {
        window.URL.revokeObjectURL(url);
        console.log(`[Dashboard PDF Export] Revoked Object URL: ${url}`);
      } catch (revError) {
        console.error(`[Dashboard PDF Export] Failed to revoke Object URL: ${url}`, revError);
      }
    }, 15000);
  }
}

export function filenameFromContentDisposition(headerValue: string | null, fallback: string) {
  if (!headerValue) return fallback;

  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/['"]/g, "")).trim() || fallback;
    } catch {
      return utf8Match[1].replace(/['"]/g, "").trim() || fallback;
    }
  }

  const filenameMatch = headerValue.match(/filename="?([^";]+)"?/i);
  return filenameMatch?.[1]?.trim() || fallback;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function shareOrDownloadExport({ blob, filename, title, text }: ShareExportOptions): Promise<ShareExportResult> {
  const mimeType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : (blob.type || "application/octet-stream");
  const file = new File([blob], filename, { type: mimeType });
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData & { files?: File[] }) => boolean;
    share?: (data: ShareData & { files?: File[] }) => Promise<void>;
  };

  console.log(`[Dashboard PDF Export] shareOrDownloadExport initiated. Filename: ${filename}, Blob size: ${blob.size} bytes, MIME type: ${mimeType}`);
  const hasNativeShare = typeof nav.share === "function";
  
  let canShareFile = false;
  if (hasNativeShare && typeof nav.canShare === "function") {
    try {
      canShareFile = nav.canShare({ files: [file] });
    } catch (err) {
      console.error(`[Dashboard PDF Export] navigator.canShare check failed:`, err);
    }
  }
  console.log(`[Dashboard PDF Export] Web Share API availability - hasNativeShare: ${hasNativeShare}, canShareFile: ${canShareFile}`);

  // 1. Try native Web Share API for files (primarily mobile/compatible platforms)
  if (canShareFile) {
    try {
      console.log(`[Dashboard PDF Export] Attempting navigator.share with file: ${filename}`);
      await nav.share({ title, text, files: [file] });
      console.log(`[Dashboard PDF Export] Native share completed successfully`);
      return "shared";
    } catch (error) {
      console.error(`[Dashboard PDF Export] Native share failed:`, error);
      if (isAbortError(error)) {
        console.log(`[Dashboard PDF Export] Share aborted by user`);
        return "cancelled";
      }
      // Fallback if native share fails
    }
  }

  // 2. Web Share API not supported or failed: automatically fall back to downloading
  console.log(`[Dashboard PDF Export] File sharing unsupported or failed. Falling back to direct download.`);
  downloadExportBlob(blob, filename);
  return "downloaded";
}

declare global {
  interface Window {
    __hospai_share__?: (options: {
      blob: Blob;
      filename: string;
      title: string;
      text?: string;
      shareUrl: string;
    }) => void;
  }
}
