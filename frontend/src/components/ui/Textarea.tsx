import * as React from "react";
import { cn } from "../../lib/cn";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return <textarea ref={ref} className={cn("ui-textarea", className)} {...props} />;
  }
);

Textarea.displayName = "Textarea";

export default Textarea;
