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
      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="SEARCH MEMORY..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{
            width: "100%", padding: "10px 16px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border-glow)",
            borderRadius: 4, color: "var(--text-bright)",
            fontFamily: "var(--font-mono)", fontSize: 11,
            letterSpacing: 1, outline: "none",
            transition: "border-color 0.2s",
          }}
          onFocus={e => { e.target.style.borderColor = "var(--border-bright)"; }}
          onBlur={e => { e.target.style.borderColor = "var(--border-glow)"; }}
        />
      </div>

      {/* Search Results */}
      {query && searchResults.length > 0 && (
        <HudPanel title="Search Results" delay={0}>
          {searchResults.map((r, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", padding: "8px 16px",
              gap: 10, cursor: "pointer", transition: "background 0.15s",
            }} onClick={() => { if (r.source !== "daily") setLocation(`/memory/entity/${r.source}/${encodeURIComponent(r.name)}`); }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
              <span className={`entity-badge-${r.source}`} style={{
                fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 0.8,
                textTransform: "uppercase", padding: "2px 7px", borderRadius: 2,
                minWidth: 56, textAlign: "center",
              }}>{r.source}</span>
              <span style={{
                fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 500,
                color: "var(--text-bright)", flex: 1,
              }}>{r.name}</span>
            </div>
          ))}
        </HudPanel>
      )}

      {/* Tabs */}
      {!query && (
        <>
          <div style={{
            display: "flex", gap: 8, marginBottom: 16,
          }}>
            {(["entities", "global", "daily"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1.5,
                textTransform: "uppercase", padding: "6px 16px",
                borderRadius: 3, cursor: "pointer", transition: "all 0.2s",
                border: `1px solid ${tab === t ? "rgba(var(--glow-primary-rgb), 0.4)" : "var(--border-glow)"}`,
                background: tab === t ? "rgba(var(--glow-primary-rgb), 0.08)" : "transparent",
                color: tab === t ? "var(--glow-primary)" : "var(--text-muted)",
              }}>{t === "entities" ? "Entities" : t === "global" ? "MEMORY.md" : "Daily Logs"}</button>
            ))}
          </div>

          {/* Entity List */}
          {tab === "entities" && (
            <HudPanel title="Entities" action={{ label: "Refresh", onClick: fetchEntities }} delay={0}>
              {entities.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  NO ENTITIES FOUND
                </div>
              ) : (
                entities.map((e, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", padding: "10px 16px",
                    gap: 12, cursor: "pointer", transition: "background 0.15s",
                  }} onClick={() => setLocation(`/memory/entity/${e.type}/${encodeURIComponent(e.name)}`)}
                  onMouseEnter={ev => { ev.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; }}>
                    <span className={`entity-badge-${e.type}`} style={{
                      fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 0.8,
                      textTransform: "uppercase", padding: "2px 7px", borderRadius: 2,
                      minWidth: 56, textAlign: "center",
                    }}>{e.type}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: "var(--font-body)", fontSize: 14, fontWeight: 500,
                        color: "var(--text-bright)", letterSpacing: 0.3,
                      }}>{e.name}</div>
                      {e.summary && (
                        <div style={{
                          fontFamily: "var(--font-body)", fontSize: 11,
                          color: "var(--text-muted)", marginTop: 2,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>{e.summary}</div>
                      )}
                    </div>
                    {e.tags?.length > 0 && (
                      <div style={{ display: "flex", gap: 4 }}>
                        {e.tags.slice(0, 3).map(tag => (
                          <span key={tag} style={{
                            fontFamily: "var(--font-mono)", fontSize: 8,
                            padding: "1px 5px", borderRadius: 2,
                            border: "1px solid var(--border-glow)",
                            color: "var(--text-dim)",
                          }}>{tag}</span>
                        ))}
                      </div>
                    )}
                    <span style={{
                      fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)",
                    }}>{e.updatedAt?.slice(5, 10)}</span>
                  </div>
                ))
              )}
            </HudPanel>
          )}

          {/* Global Memory */}
          {tab === "global" && <MemoryEditor />}

          {/* Daily Logs */}
          {tab === "daily" && (
            <HudPanel title="Daily Logs" delay={0}>
              {dailyDates.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  NO DAILY LOGS
                </div>
              ) : (
                dailyDates.map(entry => (
                  <div key={entry.date} style={{
                    padding: "10px 16px", cursor: "pointer",
                    transition: "background 0.15s", display: "flex", alignItems: "center", gap: 10,
                  }} onClick={() => setLocation(`/memory/daily/${entry.date}`)}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                    <span style={{
                      fontFamily: "var(--font-mono)", fontSize: 12,
                      color: "var(--glow-primary)", letterSpacing: 1,
                    }}>{entry.date}</span>
                    <span style={{
                      fontFamily: "var(--font-body)", fontSize: 11,
                      color: "var(--text-dim)",
                    }}>{dayOfWeek(entry.date)}</span>
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
  const { globalMemory, fetchGlobalMemory, saveGlobalMemory } = useMemoryStore();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(globalMemory);
  }, [globalMemory]);

  const handleSave = async () => {
    setSaving(true);
    await saveGlobalMemory(text);
    setSaving(false);
  };

  return (
    <HudPanel
      title="MEMORY.md"
      action={{ label: saving ? "Saving..." : "Save", onClick: handleSave }}
      maxHeight={600}
      delay={0}
    >
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        style={{
          width: "100%", minHeight: 400, padding: 16,
          background: "transparent", border: "none", outline: "none",
          color: "var(--text-primary)", fontFamily: "var(--font-mono)",
          fontSize: 12, lineHeight: 1.6, resize: "vertical",
        }}
        spellCheck={false}
      />
    </HudPanel>
  );
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
}
