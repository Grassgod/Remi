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
      className="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/50"
      style={{ animation: "fade-in 0.3s ease-out both" }}
    >
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold leading-none tracking-tight ${colorMap[color]}`}>
        {value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
        {sub}
      </div>
    </div>
  );
}

// Backward-compatible alias
export { StatCard as ArcCard };
