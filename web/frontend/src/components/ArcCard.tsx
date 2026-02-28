import type { ReactNode } from "react";

interface ArcCardProps {
  label: string;
  value: ReactNode;
  sub: string;
  color?: "cyan" | "green" | "amber" | "red";
  delay?: number;
}

const colorMap = {
  cyan: { text: "var(--glow-primary)", glow: "arc-glow-cyan", shadow: "rgba(var(--glow-primary-rgb), 0.3)" },
  green: { text: "var(--glow-green)", glow: "arc-glow-green", shadow: "rgba(var(--glow-green-rgb), 0.3)" },
  amber: { text: "var(--glow-amber)", glow: "arc-glow-amber", shadow: "rgba(var(--glow-amber-rgb), 0.3)" },
  red: { text: "var(--glow-red)", glow: "arc-glow-red", shadow: "rgba(var(--glow-red-rgb), 0.3)" },
};

export function ArcCard({ label, value, sub, color = "cyan", delay = 0 }: ArcCardProps) {
  const c = colorMap[color];
  return (
    <div
      className={`${c.glow} arc-corner`}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-glow)",
        borderRadius: 6,
        padding: "16px 18px",
        position: "relative",
        overflow: "hidden",
        backdropFilter: "blur(10px)",
        animation: `hud-in 0.4s ease-out both`,
        animationDelay: `${delay}s`,
        transition: "border-color 0.3s, box-shadow 0.3s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = "var(--border-bright)";
        e.currentTarget.style.boxShadow = "0 0 20px rgba(var(--glow-primary-rgb), 0.05)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = "var(--border-glow)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2,
        textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 8,
      }}>{label}</div>
      <div style={{
        fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700,
        lineHeight: 1, marginBottom: 6, letterSpacing: 1,
        color: c.text, textShadow: `0 0 20px ${c.shadow}`,
      }}>{value}</div>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 10,
        color: "var(--text-dim)", letterSpacing: 0.5,
      }}>{sub}</div>
    </div>
  );
}
