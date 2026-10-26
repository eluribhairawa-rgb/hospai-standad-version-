import { useState } from "react";
import { Modal, Button } from "./ui";
import { downloadPDF, printPDF } from "../lib/exportService";

type ExportShareModalProps = {
  open: boolean;
  onClose: () => void;
  options: {
    blob: Blob;
    filename: string;
    title: string;
    text?: string;
    shareUrl?: string;
  } | null;
};

export default function ExportShareModal({ open, onClose, options }: ExportShareModalProps) {
  const [copied, setCopied] = useState(false);

  if (!options) return null;
  const { blob, filename, title, shareUrl } = options;

  const handleDownload = () => {
    downloadPDF(blob, filename);
    onClose();
  };

  const handlePrint = () => {
    printPDF(blob);
    onClose();
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy share link:", err);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || "Share Report"}
      description="Choose an option to share or save the generated report."
      className="ui-modal-compact export-share-modal"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" }}>
        <Button
          type="button"
          variant="primary"
          onClick={handleDownload}
          style={{ width: "100%", justifyContent: "center" }}
        >
          Download PDF
        </Button>

        <Button
          type="button"
          variant="secondary"
          disabled={!shareUrl}
          onClick={handleCopy}
          style={{ width: "100%", justifyContent: "center", opacity: shareUrl ? 1 : 0.6 }}
        >
          {shareUrl ? (copied ? "Copied Link!" : "Copy Link") : "Copy Link (Not Applicable)"}
        </Button>

        <Button
          type="button"
          variant="secondary"
          onClick={handlePrint}
          style={{ width: "100%", justifyContent: "center" }}
        >
          Print
        </Button>

        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          style={{ width: "100%", justifyContent: "center" }}
        >
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
