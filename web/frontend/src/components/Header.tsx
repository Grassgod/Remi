import { useEffect, useState } from "react";

interface HeaderProps {
  title: string;
  subtitle?: string;
  daemonAlive?: boolean;
  tokensValid?: number;
  tokensTotal?: number;
}

export function Header({ title, subtitle, daemonAlive, tokensValid, tokensTotal }: HeaderProps) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setClock(
        `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())} — ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header style={{
      height: "var(--header-height)",
      display: "flex", alignItems: "center",
      padding: "0 24px",
      borderBottom: "1px solid var(--border-glow)",
      background: "var(--bg-surface)",
      backdropFilter: "blur(20px)",
      gap: 16, flexShrink: 0,
    }}>
      <span style={{
        fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13,
        color: "var(--text-bright)", letterSpacing: 2, textTransform: "uppercase",
      }}>{title}</span>
      {subtitle && (
        <>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>/</span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 10,
            color: "var(--text-dim)", letterSpacing: 1,
          }}>{subtitle}</span>
        </>
      )}
      <div style={{ flex: 1 }} />
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 11,
        color: "var(--glow-primary)", letterSpacing: 1.5,
        textShadow: "0 0 10px rgba(var(--glow-primary-rgb), 0.3)",
      }}>{clock}</span>
      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: daemonAlive ? "var(--glow-green)" : "var(--glow-red)",
          boxShadow: daemonAlive
            ? "0 0 6px rgba(var(--glow-green-rgb), 0.5)"
            : "0 0 6px rgba(var(--glow-red-rgb), 0.5)",
        }} title="Daemon" />
        {tokensTotal !== undefined && Array.from({ length: tokensTotal }).map((_, i) => (
          <div key={i} style={{
            width: 6, height: 6, borderRadius: "50%",
            background: i < (tokensValid ?? 0) ? "var(--glow-green)" : "var(--glow-amber)",
            boxShadow: i < (tokensValid ?? 0)
              ? "0 0 6px rgba(var(--glow-green-rgb), 0.5)"
              : "0 0 6px rgba(var(--glow-amber-rgb), 0.5)",
          }} title={`Token ${i + 1}`} />
        ))}
      </div>
    </header>
  );
}
