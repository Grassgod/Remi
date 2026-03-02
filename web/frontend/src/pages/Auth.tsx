import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useAppStore } from "../stores/app";

export function Auth() {
  const { tokens, fetchTokens } = useAppStore();

  useEffect(() => {
    fetchTokens();
    const id = setInterval(fetchTokens, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <Layout title="Auth" subtitle="TOKEN STATUS">
      <HudPanel title="Authentication Tokens" action={{ label: "Refresh", onClick: fetchTokens }} maxHeight={600}>
        {tokens.length === 0 ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO TOKENS CONFIGURED</div>
        ) : (
          tokens.map((t, i) => (
            <div key={i} className={`px-4 py-3.5 transition-colors hover:bg-accent/30 ${i < tokens.length - 1 ? "border-b border-border" : ""}`}>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold text-foreground">{t.service}</span>
                  <span className="ml-2.5 font-mono text-[10px] text-muted-foreground">{t.type}</span>
                </div>
                <span className={`rounded-sm border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-wide
                  ${t.valid
                    ? "border-success/30 bg-success/[0.06] text-success"
                    : "border-destructive/30 bg-destructive/[0.06] text-destructive"
                  }`}>
                  {t.valid ? "VALID" : "EXPIRED"}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${t.valid ? "bg-success" : "bg-destructive"}`}
                    style={{ width: t.valid ? "60%" : "0%" }}
                  />
                </div>
                <span className={`min-w-[60px] text-right font-mono text-xs ${t.valid ? "text-success" : "text-destructive"}`}>
                  {t.expiresIn}
                </span>
              </div>

              <div className="mt-1.5 font-mono text-[9px] text-muted-foreground">
                EXPIRES: {t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "—"}
              </div>
            </div>
          ))
        )}
      </HudPanel>
    </Layout>
  );
}
