import * as React from "react";
import { cn } from "../../lib/cn";
import { filterDecimal, preventNonNumericDiscountKeys } from "../../lib/format";

export function isDiscountInput(props: React.InputHTMLAttributes<HTMLInputElement>): boolean {
  const check = (val?: string | null) => Boolean(val && /discount/i.test(val));
  return Boolean(
    check(props.name) ||
    check(props.id) ||
    check(props.placeholder) ||
    check(props["aria-label"]) ||
    check(props.className) ||
    (props as any)["data-field"] === "discount" ||
    (props as any)["data-is-discount"]
  );
}

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", onKeyDown, onChange, onPaste, ...props }, ref) => {
    const isDiscount = isDiscountInput({ className, ...props });

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isDiscount) {
        preventNonNumericDiscountKeys(e);
      }
      onKeyDown?.(e);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isDiscount) {
        const original = e.target.value;
        const sanitized = filterDecimal(original);
        if (sanitized !== original) {
          e.target.value = sanitized;
        }
      }
      onChange?.(e);
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (isDiscount) {
        const text = e.clipboardData.getData("text");
        if (/[^0-9.]/.test(text)) {
          e.preventDefault();
          const sanitized = filterDecimal(text);
          document.execCommand("insertText", false, sanitized);
          return;
        }
      }
      onPaste?.(e);
    };

    return (
      <input
        ref={ref}
        type={type}
        className={cn("ui-input", className)}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        onPaste={handlePaste}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export default Input;
