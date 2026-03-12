import * as React from "react";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "destructive";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-emerald-600 text-white",
  secondary: "bg-slate-100 text-slate-800",
  destructive: "bg-red-600 text-white",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
