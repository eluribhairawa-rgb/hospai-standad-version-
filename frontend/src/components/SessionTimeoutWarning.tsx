import Modal from "./ui/Modal";
import Button from "./ui/Button";

type Props = {
  open: boolean;
  secondsLeft: number;
  onContinue: () => void;
  onLogout: () => void;
};

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function SessionTimeoutWarning({ open, secondsLeft, onContinue, onLogout }: Props) {
  return (
    // Closing the dialog (Esc, overlay, x) is an interaction, so it continues the session.
    <Modal open={open} onClose={onContinue} title="Your session is about to expire" className="ui-modal-compact">
      <p className="session-timeout-message" data-testid="session-timeout-warning">
        You have been inactive for a while. For security you will be logged out in{" "}
        <strong data-testid="session-timeout-countdown">{formatCountdown(secondsLeft)}</strong>.
      </p>
      <div className="ui-modal-actions">
        <Button variant="secondary" onClick={onLogout}>
          Log out now
        </Button>
        <Button variant="primary" onClick={onContinue} autoFocus data-testid="session-timeout-continue">
          Continue session
        </Button>
      </div>
    </Modal>
  );
}
