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
      <HudPanel title="Configuration" action={{ label: "Reload", onClick: fetchConfig }} maxHeight={700}>
        {loading ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
        ) : config ? (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
            {JSON.stringify(config, null, 2)}
          </pre>
        ) : (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO CONFIG FILE FOUND</div>
        )}
      </HudPanel>
    </Layout>
  );
}
