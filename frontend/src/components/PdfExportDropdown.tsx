import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";
import { downloadPDF, exportPDF } from "../lib/exportService";

type PdfExportDropdownProps = {
  onGenerate: () => Promise<{ blob: Blob; filename: string; title: string; text?: string }>;
  setNotice?: (notice: { type: "success" | "error" | "info"; message: string } | null) => void;
  renderTrigger?: (onClick: () => void, loading: boolean) => React.ReactNode;
  buttonText?: string;
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  disabled?: boolean;
};

export default function PdfExportDropdown({
  onGenerate,
  setNotice,
  renderTrigger,
  buttonText = "Download PDF",
  variant = "secondary",
  disabled = false,
}: PdfExportDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const dropdownHeight = 85; // Approximate height of the dropdown
      
      let top: string | number = rect.bottom + 4;
      let bottom: string | number = "auto";
      
      // If there isn't enough space below, put it above
      if (rect.bottom + dropdownHeight > window.innerHeight && rect.top - dropdownHeight > 0) {
        top = "auto";
        bottom = window.innerHeight - rect.top + 4;
      }
      
      setDropdownStyle({
        position: "fixed",
        top: top,
        bottom: bottom,
        right: window.innerWidth - rect.right,
        minWidth: "160px",
        zIndex: 999999, // Ensure it's above absolutely everything
        backgroundColor: "var(--hosp-bg, #ffffff)",
        border: "1px solid var(--hosp-border, #e5e7eb)",
        borderRadius: "6px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true); // true to catch scrolling in any container
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        containerRef.current && !containerRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick); // Use mousedown for better portal support
      document.addEventListener("keydown", handleEscape);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const handleAction = async (action: "download" | "share") => {
    setIsOpen(false);
    setIsLoading(true);
    try {
      const { blob, filename, title, text } = await onGenerate();
      if (action === "download") {
        downloadPDF(blob, filename);
      } else if (action === "share") {
        await exportPDF(blob, filename, title, text, setNotice);
      }
    } catch (err) {
      console.error("[PdfExportDropdown] Error during export action:", err);
      window.alert(err instanceof Error ? err.message : "An error occurred while generating the PDF.");
    } finally {
      setIsLoading(false);
    }
  };

  const menu = (
    <div className="pdf-export-dropdown-menu" style={dropdownStyle} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => void handleAction("download")}
        style={{
          padding: "10px 16px",
          textAlign: "left",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--hosp-border, #e5e7eb)",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--hosp-text, #111827)",
          display: "flex",
          alignItems: "center",
          gap: "8px"
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--hosp-hover, #f3f4f6)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        📄 Download PDF
      </button>
      <button
        type="button"
        onClick={() => void handleAction("share")}
        style={{
          padding: "10px 16px",
          textAlign: "left",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--hosp-text, #111827)",
          display: "flex",
          alignItems: "center",
          gap: "8px"
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--hosp-hover, #f3f4f6)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        📤 Share
      </button>
    </div>
  );

  return (
    <div className="pdf-export-dropdown-container" style={{ display: "inline-block" }} ref={containerRef}>
      {renderTrigger ? (
        renderTrigger(() => setIsOpen(!isOpen), isLoading || disabled)
      ) : (
        <Button
          type="button"
          variant={variant}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
          disabled={isLoading || disabled}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          {isLoading ? "Preparing..." : buttonText}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </Button>
      )}

      {isOpen && createPortal(menu, document.body)}
    </div>
  );
}
