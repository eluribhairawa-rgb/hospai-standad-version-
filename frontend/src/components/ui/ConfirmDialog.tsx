import Modal from "./Modal";
import Button from "./Button";

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
};

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading = false,
}: Props) {
  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} title={title} description={description} className="ui-modal-compact">
      <div className="ui-modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant="destructive" onClick={() => void onConfirm()} disabled={loading}>
          {loading ? "Please wait..." : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
