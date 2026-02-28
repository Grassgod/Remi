import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useAppStore } from "../stores/app";

export function Auth() {
  const { tokens, fetchTokens } = useAppStore();

  useEffect(() => {
    fetchTokens();
    // Refresh every 30s
    const id = setInterval(fetchTokens, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <Layout title="Auth" subtitle="TOKEN STATUS">
      <HudPanel
        title="Authentication Tokens"
        action={{ label: "Refresh", onClick: fetchTokens }}
        maxHeight={600}
        delay={0}
      >
        {tokens.length === 0 ? (
          <div style={{
            padding: 40, textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
          }}>NO TOKENS CONFIGURED</div>
        ) : (
          tokens.map((t, i) => (
            <div key={i} style={{
              padding: "14px 16px",
              borderBottom: i < tokens.length - 1 ? "1px solid var(--border-glow)" : "none",
              transition: "background 0.15s",
            }} onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <span style={{
                    fontFamily: "var(--font-body)", fontSize: 15, fontWeight: 600,
                    color: "var(--text-bright)", letterSpacing: 0.5,
                  }}>{t.service}</span>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    color: "var(--text-dim)", marginLeft: 10,
                  }}>{t.type}</span>
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
                  textTransform: "uppercase", padding: "3px 10px", borderRadius: 2,
                  border: `1px solid ${t.valid ? "rgba(var(--glow-green-rgb), 0.3)" : "rgba(var(--glow-red-rgb), 0.3)"}`,
                  color: t.valid ? "var(--glow-green)" : "var(--glow-red)",
                  background: t.valid ? "rgba(var(--glow-green-rgb), 0.06)" : "rgba(var(--glow-red-rgb), 0.06)",
                }}>{t.valid ? "VALID" : "EXPIRED"}</span>
              </div>

              {/* Progress bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  flex: 1, height: 3, background: "rgba(var(--glow-primary-rgb), 0.1)",
                  borderRadius: 2, overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%", borderRadius: 2,
                    background: t.valid ? "var(--glow-green)" : "var(--glow-red)",
                    boxShadow: t.valid
                      ? "0 0 8px rgba(var(--glow-green-rgb), 0.4)"
                      : "0 0 8px rgba(var(--glow-red-rgb), 0.4)",
                    width: t.valid ? "60%" : "0%",
                    transition: "width 0.5s ease",
                  }} />
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11,
                  color: t.valid ? "var(--glow-green)" : "var(--glow-red)",
                  textShadow: t.valid ? "0 0 8px rgba(var(--glow-green-rgb), 0.3)" : "none",
                  minWidth: 60, textAlign: "right",
                }}>{t.expiresIn}</span>
              </div>

              <div style={{
                marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9,
                color: "var(--text-dim)",
              }}>EXPIRES: {t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "—"}</div>
            </div>
          ))
        )}
      </HudPanel>
    </Layout>
  );
}
