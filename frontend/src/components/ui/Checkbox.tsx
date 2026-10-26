import * as React from "react";
import { cn } from "../../lib/cn";

const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return <input ref={ref} type="checkbox" className={cn("ui-checkbox", className)} {...props} />;
  }
);

Checkbox.displayName = "Checkbox";

export default Checkbox;
