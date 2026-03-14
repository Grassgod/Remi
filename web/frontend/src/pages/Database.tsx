import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { ArcCard } from "../components/ArcCard";
import { IconDatabase } from "../components/icons";
import { useDbStore } from "../stores/db";

export function Database() {
  const { stats, kvEntries, embeddings, fetchStats, fetchKv, fetchEmbeddings } = useDbStore();

  useEffect(() => {
    fetchStats();
    fetchKv();
    fetchEmbeddings();
  }, []);

  const dbSizeKB = stats ? (stats.dbSizeBytes / 1024).toFixed(1) : "—";

  return (
    <Layout title="Database" subtitle="SQLITE + SQLITE-VEC">
      {/* Stats Cards */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-5 sm:grid-cols-4 sm:gap-3">
        <ArcCard
          label="DB Size"
          value={`${dbSizeKB} KB`}
          sub={stats?.journalMode?.toUpperCase() ?? "—"}
          color="default"
        />
        <ArcCard
          label="KV Entries"
          value={String(stats?.tables.kv.count ?? 0)}
          sub="KEY-VALUE STORE"
          color="default"
        />
        <ArcCard
          label="Embeddings"
          value={String(stats?.tables.embeddings.count ?? 0)}
          sub="VECTOR STORE"
          color={stats && stats.tables.embeddings.count > 0 ? "success" : "default"}
        />
        <ArcCard
          label="Dimensions"
          value="1024"
          sub="VOYAGE-3.5-LITE"
          color="default"
        />
      </div>

      {/* Panels */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_1fr] sm:gap-3.5">
        {/* KV Entries */}
        <HudPanel
          title="KV Store"
          icon={<IconDatabase />}
          action={{ label: "Refresh", onClick: fetchKv }}
        >
          {kvEntries.length === 0 ? (
            <div className="p-5 text-center font-mono text-[10px] text-muted-foreground">
              NO KV ENTRIES
            </div>
          ) : (
            kvEntries.map((entry, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/30 sm:px-4 sm:py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-foreground">{entry.key}</div>
                </div>
                <div className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                  {entry.value.length > 60 ? entry.value.slice(0, 60) + "..." : entry.value}
                </div>
                <span className="hidden font-mono text-[9px] text-muted-foreground sm:inline">
                  {entry.updated_at?.slice(5, 16) ?? ""}
                </span>
              </div>
            ))
          )}
        </HudPanel>

        {/* Embeddings */}
        <HudPanel
          title="Vector Store"
          icon={<IconDatabase />}
          action={{ label: "Refresh", onClick: fetchEmbeddings }}
        >
          {embeddings.length === 0 ? (
            <div className="p-5 text-center font-mono text-[10px] text-muted-foreground">
              NO EMBEDDINGS
            </div>
          ) : (
            embeddings.map((entry, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/30 sm:px-4 sm:py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-foreground">{entry.id}</div>
                  {entry.metadata && (
                    <div className="truncate font-mono text-[9px] text-muted-foreground">
                      {Object.entries(entry.metadata).map(([k, v]) => `${k}:${v}`).join(" ")}
                    </div>
                  )}
                </div>
                <span className="hidden font-mono text-[9px] text-muted-foreground sm:inline">
                  {entry.content_hash}
                </span>
                <span className="shrink-0 rounded-sm border border-success/30 bg-success/[0.06] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-success">
                  VEC
                </span>
              </div>
            ))
          )}
        </HudPanel>
      </div>
    </Layout>
  );
}
