import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { ArcCard } from "../components/ArcCard";
import { useSymlinksStore } from "../stores/symlinks";

const filterChips = [
  { key: "all", label: "All" },
  { key: "ok", label: "OK" },
  { key: "broken", label: "Broken" },
  { key: "not_linked", label: "Not Linked" },
] as const;

const statusStyles: Record<string, { border: string; bg: string; text: string; label: string }> = {
  ok: { border: "border-success/30", bg: "bg-success/[0.06]", text: "text-success", label: "OK" },
  broken: { border: "border-destructive/30", bg: "bg-destructive/[0.06]", text: "text-destructive", label: "BROKEN" },
  not_linked: { border: "border-warning/30", bg: "bg-warning/[0.06]", text: "text-warning", label: "NOT LINKED" },
  missing_target: { border: "border-border", bg: "bg-muted/[0.06]", text: "text-muted-foreground", label: "MISSING" },
};

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  if (parts.length <= 4) return path;
  // Keep first 2 and last 2 segments
  return `${parts.slice(0, 3).join("/")}/.../${parts.slice(-2).join("/")}`;
}

const btnCls = "rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer";

export function Symlinks() {
  const { mappings, stats, loading, filter, fetch, fixAll, setFilter } = useSymlinksStore();

  useEffect(() => { fetch(); }, []);

  const filtered = filter === "all"
    ? mappings
    : mappings.filter(m => m.status === filter);

  const hasBroken = stats.broken > 0 || stats.notLinked > 0;

  return (
    <Layout title="Symlinks" subtitle="FILESYSTEM MAPPING">
      {/* Stats Cards */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-5 sm:grid-cols-4 sm:gap-3">
        <ArcCard
          label="Total Mappings"
          value={String(stats.total)}
          sub={`${mappings.filter(m => m.type === "dir").length} DIR · ${mappings.filter(m => m.type === "file").length} FILE`}
          color="default"
        />
        <ArcCard
          label="OK"
          value={String(stats.ok)}
          sub="LINKED CORRECTLY"
          color="success"
        />
        <ArcCard
          label="Broken"
          value={String(stats.broken)}
          sub="WRONG TARGET"
          color={stats.broken > 0 ? "destructive" : "default"}
        />
        <ArcCard
          label="Not Linked"
          value={String(stats.notLinked)}
          sub="SYMLINK MISSING"
          color={stats.notLinked > 0 ? "warning" : "default"}
        />
      </div>

      {/* Filter + Actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2 sm:mb-4">
        {filterChips.map(chip => (
          <button
            key={chip.key}
            onClick={() => setFilter(chip.key)}
            className={`rounded-md border px-3 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors cursor-pointer ${
              filter === chip.key
                ? "border-foreground/30 bg-accent text-foreground"
                : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {chip.label}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          {hasBroken && (
            <button className={btnCls} onClick={fixAll} disabled={loading}>
              {loading ? "Fixing..." : "Fix All"}
            </button>
          )}
          <button className={btnCls} onClick={fetch} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Mappings Table */}
      <HudPanel title="Symlink Mappings" maxHeight={600}>
        {filtered.length === 0 ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">
            {loading ? "LOADING..." : "NO SYMLINK MAPPINGS"}
          </div>
        ) : (
          <div>
            {/* Header */}
            <div className="hidden grid-cols-[1fr_1fr_60px_90px] gap-2.5 border-b border-border px-4 py-2 sm:grid">
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">SOURCE</span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">TARGET</span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">TYPE</span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">STATUS</span>
            </div>
            {/* Rows */}
            {filtered.map((m, i) => {
              const style = statusStyles[m.status] ?? statusStyles.missing_target;
              return (
                <div
                  key={i}
                  className="grid grid-cols-1 gap-1 px-4 py-2.5 transition-colors hover:bg-accent/30 sm:grid-cols-[1fr_1fr_60px_90px] sm:items-center sm:gap-2.5"
                >
                  <span
                    className="break-all font-mono text-xs text-foreground"
                    title={m.source}
                  >
                    {truncatePath(m.source)}
                  </span>
                  <span
                    className="break-all font-mono text-[10px] text-muted-foreground"
                    title={m.target}
                  >
                    {truncatePath(m.target)}
                  </span>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">
                    {m.type}
                  </span>
                  <span className={`inline-block w-fit shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide sm:px-2 ${style.border} ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                </div>
              );
            })}
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
