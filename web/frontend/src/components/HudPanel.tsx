import type { ReactNode } from "react";

interface HudPanelProps {
  title: string;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
  maxHeight?: number;
  delay?: number;
}

export function HudPanel({ title, icon, action, children, maxHeight = 360, delay = 0.24 }: HudPanelProps) {
  return (
    <div
      className="hud-panel-corners"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-glow)",
        borderRadius: 6,
        overflow: "hidden",
        backdropFilter: "blur(10px)",
        animation: `hud-in 0.5s ease-out both`,
        animationDelay: `${delay}s`,
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-glow)",
      }}>
        <div style={{
          fontFamily: "var(--font-display)", fontSize: 10, fontWeight: 600,
          letterSpacing: 2, textTransform: "uppercase",
          color: "var(--glow-secondary)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {icon}
          {title}
        </div>
        {action && (
          <button
            onClick={action.onClick}
            style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
              textTransform: "uppercase", color: "var(--glow-primary)",
              padding: "3px 10px", border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
              borderRadius: 3, background: "rgba(var(--glow-primary-rgb), 0.04)",
              cursor: "pointer", transition: "all 0.2s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.1)";
              e.currentTarget.style.borderColor = "rgba(var(--glow-primary-rgb), 0.4)";
              e.currentTarget.style.boxShadow = "0 0 10px rgba(var(--glow-primary-rgb), 0.15)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.04)";
              e.currentTarget.style.borderColor = "rgba(var(--glow-primary-rgb), 0.2)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >{action.label}</button>
        )}
      </div>
      <div style={{ maxHeight, overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}
