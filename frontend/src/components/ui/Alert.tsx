import * as React from "react";
import { cn } from "../../lib/cn";

type AlertVariant = "default" | "success" | "warning" | "error";

const variantClassMap: Record<AlertVariant, string> = {
  default: "",
  success: "success",
  warning: "warning",
  error: "error",
};

type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: AlertVariant;
};

function Alert({ className, variant = "default", ...props }: AlertProps) {
  return <div role="alert" className={cn("notice", variantClassMap[variant], className)} {...props} />;
}

export default Alert;
