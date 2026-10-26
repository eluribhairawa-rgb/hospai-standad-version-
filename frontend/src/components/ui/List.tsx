import * as React from "react";
import { cn } from "../../lib/cn";

function List({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("ui-list", className)} {...props} />;
}

function ListItem({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) {
  return <li className={cn("ui-list-item", className)} {...props} />;
}

function ListItemContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-list-item-content", className)} {...props} />;
}

function ListItemActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-list-item-actions", className)} {...props} />;
}

export { List, ListItem, ListItemContent, ListItemActions };
