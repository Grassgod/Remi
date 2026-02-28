import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { IconTrash } from "../components/icons";
import { useAppStore } from "../stores/app";

export function Sessions() {
  const { sessions, fetchSessions, clearSession, clearAllSessions } = useAppStore();

  useEffect(() => {
    fetchSessions();
  }, []);

  return (
    <Layout title="Sessions" subtitle="CONVERSATION MANAGEMENT">
      <HudPanel
        title="Active Sessions"
        action={sessions.length > 0 ? {
          label: "Clear All",
          onClick: () => { if (confirm("Clear all sessions?")) clearAllSessions(); },
        } : undefined}
        maxHeight={600}
        delay={0}
      >
        {sessions.length === 0 ? (
          <div style={{
            padding: 40, textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
          }}>NO ACTIVE SESSIONS</div>
        ) : (
          <div>
            {/* Header */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr auto",
              padding: "8px 16px", gap: 10,
              borderBottom: "1px solid var(--border-glow)",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text-dim)" }}>KEY</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text-dim)" }}>SESSION ID</span>
              <span style={{ width: 28 }} />
            </div>
            {/* Rows */}
            {sessions.map((s, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "1fr 1fr auto",
                padding: "10px 16px", gap: 10, alignItems: "center",
                transition: "background 0.15s",
              }} onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11,
                  color: "var(--text-bright)", wordBreak: "break-all",
                }}>{s.key}</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 10,
                  color: "var(--text-muted)", wordBreak: "break-all",
                }}>{s.sessionId}</span>
                <button
                  onClick={() => { if (confirm(`Clear session "${s.key}"?`)) clearSession(s.key); }}
                  style={{
                    background: "transparent", border: "1px solid rgba(var(--glow-red-rgb), 0.2)",
                    borderRadius: 3, padding: "4px 6px", cursor: "pointer",
                    color: "var(--text-dim)", transition: "all 0.2s",
                    display: "flex", alignItems: "center",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = "rgba(var(--glow-red-rgb), 0.5)";
                    e.currentTarget.style.color = "var(--glow-red)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = "rgba(var(--glow-red-rgb), 0.2)";
                    e.currentTarget.style.color = "var(--text-dim)";
                  }}
                ><IconTrash /></button>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      <style>{`
        @media (max-width: 768px) {
          .main-content { padding-bottom: calc(var(--bottom-nav-height) + var(--safe-bottom) + 14px) !important; }
        }
      `}</style>
    </Layout>
  );
}
