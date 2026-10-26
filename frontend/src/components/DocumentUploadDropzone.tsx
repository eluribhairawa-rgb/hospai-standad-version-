import { useId, useRef, useState } from "react";
import { Button, Input } from "./ui";

type Props = {
  accept: string;
  file?: File;
  helperText?: string;
  disabled?: boolean;
  onFileSelect: (file: File | null) => void;
};

export default function DocumentUploadDropzone({ accept, file, helperText, disabled = false, onFileSelect }: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const pickFile = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    setIsDragOver(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) onFileSelect(dropped);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  return (
    <div className="upload-widget">
      <Input
        id={inputId}
        ref={inputRef}
        className="upload-input-hidden"
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => onFileSelect(event.target.files?.[0] || null)}
      />

      <div
        className={`upload-dropzone${isDragOver ? " is-dragover" : ""}${disabled ? " is-disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={pickFile}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pickFile();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <p className="upload-title">Drop file here or click to browse</p>
        {file ? <p className="upload-file-name">{file.name}</p> : <p className="upload-placeholder">No file selected</p>}
        {helperText && <p className="upload-helper">{helperText}</p>}
      </div>

      <div className="upload-actions">
        <Button variant="secondary" type="button" onClick={pickFile} disabled={disabled}>
          Choose File
        </Button>
        <Button variant="ghost" type="button" onClick={() => onFileSelect(null)} disabled={disabled || !file}>
          Remove
        </Button>
      </div>
    </div>
  );
}
