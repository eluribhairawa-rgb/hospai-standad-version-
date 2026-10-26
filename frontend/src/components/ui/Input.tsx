import * as React from "react";
import { cn } from "../../lib/cn";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => {
    return <input ref={ref} type={type} className={cn("ui-input", className)} {...props} />;
  }
);

Input.displayName = "Input";

export default Input;
