import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { IconTrash } from "../components/icons";
import { useAppStore } from "../stores/app";

export function Sessions() {
  const { sessions, fetchSessions, clearSession, clearAllSessions } = useAppStore();

  useEffect(() => { fetchSessions(); }, []);

  return (
    <Layout title="Sessions" subtitle="CONVERSATION MANAGEMENT">
      <HudPanel
        title="Active Sessions"
        action={sessions.length > 0 ? {
          label: "Clear All",
          onClick: () => { if (confirm("Clear all sessions?")) clearAllSessions(); },
        } : undefined}
        maxHeight={600}
      >
        {sessions.length === 0 ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO ACTIVE SESSIONS</div>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2.5 border-b border-border px-4 py-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">KEY</span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">SESSION ID</span>
              <span className="w-7" />
            </div>
            {sessions.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/30">
                <span className="break-all font-mono text-xs text-foreground">{s.key}</span>
                <span className="break-all font-mono text-[10px] text-muted-foreground">{s.sessionId}</span>
                <button
                  onClick={() => { if (confirm(`Clear session "${s.key}"?`)) clearSession(s.key); }}
                  className="flex items-center rounded-md border border-destructive/20 bg-transparent p-1.5 text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
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
