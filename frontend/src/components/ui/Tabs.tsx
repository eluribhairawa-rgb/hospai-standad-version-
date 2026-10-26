import * as React from "react";
import { cn } from "../../lib/cn";

function Tabs({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tabs", className)} {...props} />;
}

type TabsTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};

function TabsTrigger({ className, active, ...props }: TabsTriggerProps) {
  return <button className={cn("tab", active && "active", className)} {...props} />;
}

function TabsContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-tabs-content", className)} {...props} />;
}

export { Tabs, TabsTrigger, TabsContent };
