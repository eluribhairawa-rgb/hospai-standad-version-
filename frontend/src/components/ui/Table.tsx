import * as React from "react";
import { cn } from "../../lib/cn";

function Table({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("table", className)} {...props} />;
}

function TableHead({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("table-head", className)} {...props} />;
}

function TableRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("table-row", className)} {...props} />;
}

function TableCell({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(className)} {...props} />;
}

export { Table, TableHead, TableRow, TableCell };
