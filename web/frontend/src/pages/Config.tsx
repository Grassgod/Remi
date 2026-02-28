import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import * as api from "../api/client";

export function Config() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const data = await api.getConfig();
      setConfig(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchConfig(); }, []);

  return (
    <Layout title="Config" subtitle="REMI.TOML">
      <HudPanel
        title="Configuration"
        action={{ label: "Reload", onClick: fetchConfig }}
        maxHeight={700}
        delay={0}
      >
        {loading ? (
          <div style={{
            padding: 40, textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
          }}>LOADING...</div>
        ) : config ? (
          <pre style={{
            padding: 16, margin: 0,
            fontFamily: "var(--font-mono)", fontSize: 11,
            lineHeight: 1.6, color: "var(--text-primary)",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>{JSON.stringify(config, null, 2)}</pre>
        ) : (
          <div style={{
            padding: 40, textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
          }}>NO CONFIG FILE FOUND</div>
        )}
      </HudPanel>
    </Layout>
  );
}
