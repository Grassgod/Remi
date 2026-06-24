import { useEffect } from "react";
import { ChevronDown, ChevronRight, Link2, Wrench, RefreshCw, Home, FolderOpen } from "lucide-react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { ArcCard } from "../components/ArcCard";
import { useSymlinksStore, displayPath, type ProjectGroup } from "../stores/symlinks";
import type { SymlinkMapping } from "../api/types";

const statusStyles: Record<string, { dot: string; text: string; label: string }> = {
  ok:             { dot: "bg-success",          text: "text-success",          label: "OK" },
  broken:         { dot: "bg-destructive",      text: "text-destructive",      label: "BROKEN" },
  not_linked:     { dot: "bg-warning",          text: "text-warning",          label: "NOT LINKED" },
  missing_target: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "MISSING" },
};

const btnCls =
  "rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer";

function FlowRow({ mapping }: { mapping: SymlinkMapping }) {
  const style = statusStyles[mapping.status] ?? statusStyles.missing_target;

  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded-md transition-colors hover:bg-accent/20">
      <div className="flex-1 min-w-0 rounded-md border border-blue-500/20 bg-blue-500/[0.05] px-3 py-1.5">
        <span className="block break-all font-mono text-[11px] leading-snug text-blue-400">
          {displayPath(mapping.source)}
        </span>
      </div>
      <span className="shrink-0 font-mono text-sm text-muted-foreground/50">→</span>
      <div className="flex-1 min-w-0 rounded-md border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-1.5">
        <span className="block break-all font-mono text-[11px] leading-snug text-emerald-400">
          {displayPath(mapping.target)}
        </span>
      </div>
      <div className="shrink-0 flex items-center gap-1.5 min-w-[60px]">
        <div className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`font-mono text-[9px] uppercase tracking-wide ${style.text}`}>{style.label}</span>
      </div>
    </div>
  );
}

function SubRow({ mapping, label, isLast }: { mapping: SymlinkMapping; label: string; isLast: boolean }) {
  const style = statusStyles[mapping.status] ?? statusStyles.missing_target;
  const connector = isLast ? "└─" : "├─";

  return (
    <div className="flex items-center gap-2 py-0.5 pl-6">
      <span className="shrink-0 font-mono text-xs text-muted-foreground/40 w-4">{connector}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground w-14">{label}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">→</span>
      <span className="min-w-0 break-all font-mono text-[10px] text-emerald-400/80">
        {displayPath(mapping.target)}
      </span>
      <div className="shrink-0 flex items-center gap-1 ml-auto">
        <div className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`font-mono text-[8px] uppercase ${style.text}`}>{style.label}</span>
      </div>
    </div>
  );
}

function SectionHeader({
  icon, title, subtitle, expanded, onToggle,
}: {
  icon: React.ReactNode; title: string; subtitle?: string; expanded: boolean; onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/30 cursor-pointer"
    >
      {expanded
        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      {icon}
      <span className="text-sm font-medium text-foreground">{title}</span>
      {subtitle && <span className="font-mono text-[10px] text-muted-foreground">{subtitle}</span>}
    </button>
  );
}

function ProjectRow({ project, expanded, onToggle }: { project: ProjectGroup; expanded: boolean; onToggle: () => void }) {
  const allOk = [project.dirMapping, project.memoryMapping, project.wikiMapping].every(
    (m) => !m || m.status === "ok"
  );
  const subCount = [project.memoryMapping, project.wikiMapping].filter(Boolean).length;

  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/20 cursor-pointer"
      >
        {subCount > 0
          ? expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />
          : <span className="w-3" />}
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="text-[13px] font-medium text-foreground">{project.alias}</span>
        <span className="font-mono text-[8px] uppercase text-muted-foreground/50 border border-border/30 rounded px-1">DIR</span>
        <span className={`ml-auto font-mono text-[9px] ${allOk ? "text-success" : "text-destructive"}`}>
          {allOk ? "● OK" : "● Issues"}
        </span>
      </button>

      {expanded && (
        <div className="ml-2 border-l border-border/30 pl-2">
          <div className="py-0.5 pl-4">
            <span className="font-mono text-[10px] text-muted-foreground">
              {displayPath(project.dirMapping.source)}
              <span className="text-muted-foreground/50"> → </span>
              <span className="text-emerald-400/80">{displayPath(project.dirMapping.target)}</span>
            </span>
          </div>
          {project.memoryMapping && (
            <SubRow mapping={project.memoryMapping} label="memory" isLast={!project.wikiMapping} />
          )}
          {project.wikiMapping && (
            <SubRow mapping={project.wikiMapping} label="wiki" isLast={true} />
          )}
          {!project.memoryMapping && !project.wikiMapping && (
            <div className="py-0.5 pl-6 font-mono text-[9px] text-muted-foreground/40 italic">no memory, no wiki</div>
          )}
        </div>
      )}
    </div>
  );
}

export function Symlinks() {
  const {
    stats, grouped, loading,
    expandedSections, expandedProjects,
    fetch, fixAll, toggleSection, toggleProject,
  } = useSymlinksStore();

  useEffect(() => { fetch(); }, []);

  const hasBroken = stats.broken > 0 || stats.notLinked > 0;

  return (
    <Layout title="Symlinks" subtitle="FILESYSTEM MAPPING">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-5 sm:grid-cols-4 sm:gap-3">
        <ArcCard label="Total" value={String(stats.total)} sub="MAPPINGS" color="default" />
        <ArcCard label="OK" value={String(stats.ok)} sub="LINKED" color="success" />
        <ArcCard label="Broken" value={String(stats.broken)} sub="WRONG TARGET" color={stats.broken > 0 ? "destructive" : "default"} />
        <ArcCard label="Not Linked" value={String(stats.notLinked)} sub="MISSING" color={stats.notLinked > 0 ? "warning" : "default"} />
      </div>

      <div className="mb-3 flex items-center gap-2 sm:mb-4">
        <div className="ml-auto flex gap-2">
          {hasBroken && (
            <button className={btnCls} onClick={fixAll} disabled={loading}>
              <span className="inline-flex items-center gap-1"><Wrench className="h-3 w-3" />{loading ? "Fixing…" : "Fix All"}</span>
            </button>
          )}
          <button className={btnCls} onClick={fetch} disabled={loading}>
            <span className="inline-flex items-center gap-1"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />{loading ? "Loading…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      <HudPanel title="Symlink Mappings" icon={<Link2 className="h-4 w-4" />}>
        {loading && !grouped.soul ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">LOADING…</div>
        ) : (
          <div className="p-3 space-y-2">
            {/* Soul */}
            {grouped.soul && (
              <div className="mb-3">
                <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Soul</div>
                <FlowRow mapping={grouped.soul} />
              </div>
            )}

            {/* Global (Home) */}
            {grouped.global.dirMapping && (
              <div className="mb-2">
                <SectionHeader
                  icon={<Home className="h-3.5 w-3.5 text-muted-foreground/60" />}
                  title="Global (Home)"
                  subtitle="CLAUDE.md (agents.md) · sessions · memory · wiki"
                  expanded={expandedSections.has("global")}
                  onToggle={() => toggleSection("global")}
                />
                {expandedSections.has("global") && (
                  <div className="ml-2 border-l border-border/50 pl-3 space-y-0.5">
                    <FlowRow mapping={grouped.global.dirMapping} />
                    {grouped.global.memoryMapping && (
                      <SubRow mapping={grouped.global.memoryMapping} label="memory" isLast={!grouped.global.wikiMapping} />
                    )}
                    {grouped.global.wikiMapping && (
                      <SubRow mapping={grouped.global.wikiMapping} label="wiki" isLast={true} />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Projects */}
            {grouped.projects.length > 0 && (
              <div>
                <SectionHeader
                  icon={<FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />}
                  title={`Projects (${grouped.projects.length})`}
                  expanded={expandedSections.has("projects")}
                  onToggle={() => toggleSection("projects")}
                />
                {expandedSections.has("projects") && (
                  <div className="ml-2 border-l border-border/50 pl-3">
                    {grouped.projects.map((p) => (
                      <ProjectRow
                        key={p.hash}
                        project={p}
                        expanded={expandedProjects.has(p.alias)}
                        onToggle={() => toggleProject(p.alias)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
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
