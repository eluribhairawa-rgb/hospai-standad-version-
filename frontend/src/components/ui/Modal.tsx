import { useEffect } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import Button from "./Button";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export default function Modal({ open, onClose, title, description, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className={cn("ui-modal", className)} onClick={(event) => event.stopPropagation()}>
        <div className="ui-modal-header">
          <div>
            {title ? <h3 className="ui-modal-title">{title}</h3> : null}
            {description ? <p className="ui-modal-description">{description}</p> : null}
          </div>
          <Button variant="ghost" className="ui-modal-close" onClick={onClose} aria-label="Close modal">
            x
          </Button>
        </div>
        <div className="ui-modal-content">{children}</div>
      </div>
    </div>
  );
}
