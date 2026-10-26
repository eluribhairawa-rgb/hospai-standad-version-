import type { Notice } from "../../types";

type Props = {
  notice: Notice;
  onClose: () => void;
};

export default function Toast({ notice, onClose }: Props) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      <div className={`toast ${notice.type}`}>
        <p className="toast-message">{notice.message}</p>
        <button className="toast-close" type="button" onClick={onClose} aria-label="Close notification">
          x
        </button>
      </div>
    </div>
  );
}
