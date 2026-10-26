import { Label, Modal, Select } from "./ui";

type Props = {
  open: boolean;
  onClose: () => void;
  languages: Record<string, string>;
  ocrLanguage: string;
  onOcrLanguageChange: (value: string) => void;
};

export default function SettingsModal({
  open,
  onClose,
  languages,
  ocrLanguage,
  onOcrLanguageChange,
}: Props) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" description="OCR preferences." className="ui-modal-compact">
      <div className="settings-modal-grid">
        <div>
          <h4>OCR Preferences</h4>
          <Label htmlFor="modal-ocr-language">
            OCR Language
            <Select id="modal-ocr-language" value={ocrLanguage} onChange={(event) => onOcrLanguageChange(event.target.value)}>
              {Object.entries(languages).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </Label>
        </div>
      </div>
    </Modal>
  );
}
