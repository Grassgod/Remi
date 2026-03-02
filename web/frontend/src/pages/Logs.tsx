import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useLogsStore } from "../stores/logs";

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: "var(--text-dim, #64748b)",
  INFO: "var(--glow-primary, #06b6d4)",
  WARN: "var(--glow-amber, #f59e0b)",
  ERROR: "var(--glow-red, #ef4444)",
};

export function Logs() {
  const {
    entries, total, hasMore, loading, error, modules,
    date, level, module, traceId,
    fetchLogs, fetchModules, setFilter, loadMore,
  } = useLogsStore();

  useEffect(() => {
    fetchLogs();
    fetchModules();
  }, []);

  const handleFilterChange = (key: "date" | "level" | "module" | "traceId", value: string | null) => {
    setFilter(key, value);
    // Need to refetch after state updates
    setTimeout(() => useLogsStore.getState().fetchLogs(), 0);
    if (key === "date") {
      setTimeout(() => useLogsStore.getState().fetchModules(), 0);
    }
  };

  return (
    <Layout title="Logs" subtitle="STRUCTURED LOGS">
      {/* Filter Bar */}
      <div style={{
        display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center",
      }}>
        <FilterInput type="date" value={date} onChange={v => handleFilterChange("date", v)} />

        <FilterSelect
          value={level ?? ""}
          onChange={v => handleFilterChange("level", v || null)}
          options={[
            { value: "", label: "All Levels" },
            { value: "DEBUG", label: "DEBUG" },
            { value: "INFO", label: "INFO" },
            { value: "WARN", label: "WARN" },
            { value: "ERROR", label: "ERROR" },
          ]}
        />

        <FilterSelect
          value={module ?? ""}
          onChange={v => handleFilterChange("module", v || null)}
          options={[
            { value: "", label: "All Modules" },
            ...modules.map(m => ({ value: m, label: m })),
          ]}
        />

        <FilterTextInput
          placeholder="Trace ID..."
          value={traceId ?? ""}
          onChange={v => handleFilterChange("traceId", v || null)}
        />

        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
          {total} entries
        </span>
      </div>

      {/* Logs Table */}
      <HudPanel
        title="Log Entries"
        icon={<IconLog />}
        action={{ label: loading ? "Loading..." : "Refresh", onClick: () => { fetchLogs(); fetchModules(); } }}
        maxHeight={600}
      >
        {error && (
          <div style={{ padding: "8px 16px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-red, #ef4444)" }}>
            {error}
          </div>
        )}
        {entries.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {loading ? "LOADING..." : "NO LOG ENTRIES"}
          </div>
        ) : (
          <div>
            {/* Header */}
            <div className="l-table-row" style={{
              display: "grid", padding: "8px 16px", gap: 6,
              borderBottom: "1px solid var(--border-glow)",
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
              textTransform: "uppercase", color: "var(--text-dim)",
            }}>
              <span>Time</span>
              <span>Level</span>
              <span>Module</span>
              <span>Message</span>
              <span>Trace</span>
            </div>

            {/* Rows */}
            {entries.map((entry, i) => (
              <div
                key={i}
                className="l-table-row"
                style={{
                  display: "grid", padding: "5px 16px", gap: 6,
                  transition: "background 0.15s",
                  borderLeft: `2px solid ${entry.level === "ERROR" ? "rgba(239,68,68,0.3)" : entry.level === "WARN" ? "rgba(245,158,11,0.2)" : "transparent"}`,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  {formatLogTime(entry.ts)}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1, fontWeight: 600,
                  color: LEVEL_COLORS[entry.level] ?? "var(--text-dim)",
                }}>
                  {entry.level}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {entry.module}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={entry.msg}>
                  {entry.msg}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--glow-primary, #06b6d4)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  cursor: entry.traceId ? "pointer" : "default",
                  opacity: entry.traceId ? 1 : 0.3,
                }} title={entry.traceId ?? ""} onClick={() => {
                  if (entry.traceId) {
                    window.location.hash = `#/traces?traceId=${entry.traceId}`;
                  }
                }}>
                  {entry.traceId ? entry.traceId.slice(0, 12) : "—"}
                </span>
              </div>
            ))}

            {/* Load More */}
            {hasMore && (
              <div
                onClick={loadMore}
                style={{
                  padding: "10px 16px", textAlign: "center", cursor: "pointer",
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-primary, #06b6d4)",
                  borderTop: "1px solid var(--border-glow)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(6,182,212,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                LOAD MORE ({total - entries.length} remaining)
              </div>
            )}
          </div>
        )}
      </HudPanel>

      <style>{`
        .l-table-row { grid-template-columns: 90px 50px 90px 1fr 100px; }
        @media (max-width: 768px) {
          .l-table-row { grid-template-columns: 75px 45px 80px 1fr !important; }
          .l-table-row > :nth-child(5) { display: none; }
        }
        @media (max-width: 480px) {
          .l-table-row { grid-template-columns: 65px 40px 1fr !important; }
          .l-table-row > :nth-child(3) { display: none; }
          .l-table-row > :nth-child(5) { display: none; }
        }
      `}</style>
    </Layout>
  );
}

// ── Sub-components ──

function FilterInput({ type, value, onChange }: { type: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: "var(--font-mono)", fontSize: 11,
        padding: "4px 8px", borderRadius: 4,
        border: "1px solid var(--border-glow, rgba(255,255,255,0.1))",
        background: "var(--bg-card, rgba(0,0,0,0.3))",
        color: "var(--text-primary, #e2e8f0)",
        outline: "none",
      }}
    />
  );
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: "var(--font-mono)", fontSize: 11,
        padding: "4px 8px", borderRadius: 4,
        border: "1px solid var(--border-glow, rgba(255,255,255,0.1))",
        background: "var(--bg-card, rgba(0,0,0,0.3))",
        color: "var(--text-primary, #e2e8f0)",
        outline: "none",
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function FilterTextInput({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: "var(--font-mono)", fontSize: 11,
        padding: "4px 8px", borderRadius: 4, width: 120,
        border: "1px solid var(--border-glow, rgba(255,255,255,0.1))",
        background: "var(--bg-card, rgba(0,0,0,0.3))",
        color: "var(--text-primary, #e2e8f0)",
        outline: "none",
      }}
    />
  );
}

function IconLog() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  );
}

function formatLogTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  } catch {
    return ts.slice(11, 23);
  }
}
