import * as React from "react";
import { cn } from "../../lib/cn";

function Separator({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) {
  return <hr className={cn("ui-separator", className)} {...props} />;
}

export default Separator;
