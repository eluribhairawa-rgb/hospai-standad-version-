import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type ButtonVariant = "default" | "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variantClassMap: Record<ButtonVariant, string> = {
  default: "secondary",
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "destructive",
};

const sizeClassMap: Record<ButtonSize, string> = {
  default: "",
  sm: "ui-button-sm",
  lg: "ui-button-lg",
};

export default function Button({ children, variant = "secondary", size = "default", className, ...props }: Props) {
  return (
    <button
      {...props}
      className={cn(
        "ui-button",
        variantClassMap[variant],
        sizeClassMap[size],
        className,
      )}
    >
      {children}
    </button>
  );
}
