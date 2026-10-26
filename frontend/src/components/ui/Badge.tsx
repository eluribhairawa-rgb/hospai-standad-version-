import * as React from "react";
import { cn } from "../../lib/cn";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

const variantClassMap: Record<BadgeVariant, string> = {
  default: "ui-badge-default",
  secondary: "ui-badge-secondary",
  outline: "ui-badge-outline",
  destructive: "ui-badge-destructive",
};

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return <span className={cn("ui-badge", variantClassMap[variant], className)} {...props} />;
}

export default Badge;
