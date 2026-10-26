import * as React from "react";
import { cn } from "../../lib/cn";

type ContainerProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: "sm" | "md" | "lg" | "xl" | "full";
};

const sizeClassMap: Record<NonNullable<ContainerProps["size"]>, string> = {
  sm: "ui-container-sm",
  md: "ui-container-md",
  lg: "ui-container-lg",
  xl: "ui-container-xl",
  full: "ui-container-full",
};

function Container({ className, size = "xl", ...props }: ContainerProps) {
  return <div className={cn("ui-container", sizeClassMap[size], className)} {...props} />;
}

export default Container;
