import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useMemoryStore } from "../stores/memory";

export function Memory() {
  const {
    entities, globalMemory, dailyDates, searchResults,
    fetchEntities, fetchGlobalMemory, fetchDailyDates, search,
  } = useMemoryStore();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"entities" | "global" | "daily">("entities");

  useEffect(() => {
    fetchEntities();
    fetchGlobalMemory();
    fetchDailyDates();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <Layout title="Memory" subtitle="DATA MANAGEMENT">
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search memory..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full rounded-md border border-border bg-card px-4 py-2.5 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-input"
        />
      </div>

      {query && searchResults.length > 0 && (
        <HudPanel title="Search Results">
          {searchResults.map((r, i) => (
            <div
              key={i}
              className="flex cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors hover:bg-accent/30"
              onClick={() => { if (r.source !== "daily") setLocation(`/memory/entity/${r.source}/${encodeURIComponent(r.name)}`); }}
            >
              <span className={`entity-badge-${r.source} min-w-[56px] rounded-sm px-1.5 py-0.5 text-center font-mono text-[8px] uppercase tracking-wide`}>
                {r.source}
              </span>
              <span className="flex-1 text-sm font-medium text-foreground">{r.name}</span>
            </div>
          ))}
        </HudPanel>
      )}

      {!query && (
        <>
          <div className="mb-4 flex gap-2">
            {(["entities", "global", "daily"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors
                  ${tab === t
                    ? "border-foreground/20 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
              >
                {t === "entities" ? "Entities" : t === "global" ? "MEMORY.md" : "Daily Logs"}
              </button>
            ))}
          </div>

          {tab === "entities" && (
            <HudPanel title="Entities" action={{ label: "Refresh", onClick: fetchEntities }}>
              {entities.length === 0 ? (
                <div className="p-5 text-center font-mono text-[10px] text-muted-foreground">NO ENTITIES FOUND</div>
              ) : (
                entities.map((e, i) => (
                  <div
                    key={i}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30"
                    onClick={() => setLocation(`/memory/entity/${e.type}/${encodeURIComponent(e.name)}`)}
                  >
                    <span className={`entity-badge-${e.type} min-w-[56px] rounded-sm px-1.5 py-0.5 text-center font-mono text-[8px] uppercase tracking-wide`}>{e.type}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">{e.name}</div>
                      {e.summary && <div className="mt-0.5 truncate text-xs text-muted-foreground">{e.summary}</div>}
                    </div>
                    {e.tags?.length > 0 && (
                      <div className="flex gap-1">
                        {e.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="rounded-sm border border-border px-1 py-px font-mono text-[8px] text-muted-foreground">{tag}</span>
                        ))}
                      </div>
                    )}
                    <span className="font-mono text-[9px] text-muted-foreground">{e.updatedAt?.slice(5, 10)}</span>
                  </div>
                ))
              )}
            </HudPanel>
          )}

          {tab === "global" && <MemoryEditor />}

          {tab === "daily" && (
            <HudPanel title="Daily Logs">
              {dailyDates.length === 0 ? (
                <div className="p-5 text-center font-mono text-[10px] text-muted-foreground">NO DAILY LOGS</div>
              ) : (
                dailyDates.map(entry => (
                  <div
                    key={entry.date}
                    className="flex cursor-pointer items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/30"
                    onClick={() => setLocation(`/memory/daily/${entry.date}`)}
                  >
                    <span className="font-mono text-xs text-foreground">{entry.date}</span>
                    <span className="text-xs text-muted-foreground">{dayOfWeek(entry.date)}</span>
                  </div>
                ))
              )}
            </HudPanel>
          )}
        </>
      )}

      <style>{`
        @media (max-width: 768px) {
          .main-content { padding-bottom: calc(var(--bottom-nav-height) + var(--safe-bottom) + 14px) !important; }
        }
      `}</style>
    </Layout>
  );
}

function MemoryEditor() {
  const { globalMemory, saveGlobalMemory } = useMemoryStore();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(globalMemory); }, [globalMemory]);

  const handleSave = async () => {
    setSaving(true);
    await saveGlobalMemory(text);
    setSaving(false);
  };

  return (
    <HudPanel title="MEMORY.md" action={{ label: saving ? "Saving..." : "Save", onClick: handleSave }} maxHeight={600}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        className="min-h-[400px] w-full resize-y bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
        spellCheck={false}
      />
    </HudPanel>
  );
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
}
