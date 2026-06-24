import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub: string;
  color?: "default" | "success" | "warning" | "destructive";
}

const colorMap = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function StatCard({ label, value, sub, color = "default" }: StatCardProps) {
  return (
    <div
      className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/50 sm:p-4"
      style={{ animation: "fade-in 0.3s ease-out both" }}
    >
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground sm:text-[10px]">
        {label}
      </div>
      <div className={`mt-1.5 text-lg font-bold leading-none tracking-tight sm:mt-2 sm:text-2xl ${colorMap[color]}`}>
        {value}
      </div>
      <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground sm:mt-1.5 sm:text-[10px]">
        {sub}
      </div>
    </div>
  );
}

// Backward-compatible alias
export { StatCard as ArcCard };
