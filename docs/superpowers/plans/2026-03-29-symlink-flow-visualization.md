# Symlink 三层同步 + 流向图可视化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 3-layer symlink centralization (project dirs → memory → wiki) and a tree-based flow diagram dashboard page.

**Architecture:** Extend symlink-manager.ts with wiki/memory centralization + hashToAlias. Extend API with category/projectAlias metadata. Rewrite Symlinks.tsx as 2-level tree (Global + Projects, each with memory/wiki sub-mappings).

**Tech Stack:** TypeScript (Bun), React, Zustand, Tailwind CSS, Hono API

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/infra/symlink-manager.ts` | Major rewrite | Add wiki centralization, project memory centralization, hashToAlias, fix _collectKnownMappings |
| `web/handlers/symlinks.ts` | Minor update | Pass config to status endpoint |
| `web/frontend/src/api/types.ts` | Update | Add category, projectAlias, parentHash fields |
| `web/frontend/src/stores/symlinks.ts` | Rewrite | Tree-based grouping with 2-level collapse |
| `web/frontend/src/pages/Symlinks.tsx` | Rewrite | Tree flow diagram UI |

---

### Task 1: Clean Up Broken Symlinks

**Files:** None (filesystem only)

- [ ] **Step 1: Delete all broken wiki.md self-referential symlinks**

```bash
cd /home/hehuajie/.remi/projects
find . -maxdepth 3 -name "wiki.md" -type l ! -exec test -e {} \; -delete
```

- [ ] **Step 2: Delete broken agent-browser symlink**

```bash
rm -f /home/hehuajie/.remi/.claude/skills/agent-browser
```

- [ ] **Step 3: Verify no broken symlinks remain**

```bash
find /home/hehuajie/.remi/ -maxdepth 4 -type l ! -exec test -e {} \; -print
```

Expected: empty output

- [ ] **Step 4: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add -A
git commit -m "chore: clean up broken wiki.md and agent-browser symlinks"
```

---

### Task 2: Backend — hashToAlias + Wiki/Memory Centralization

**Files:**
- Rewrite: `src/infra/symlink-manager.ts`

- [ ] **Step 1: Add constants and hashToAlias method**

At the top of symlink-manager.ts, after the existing constants, add:

```typescript
const REMI_WIKI = join(REMI_HOME, "wiki");
```

Add method to SymlinkManager class:

```typescript
  /**
   * Convert a hash like "-data00-home-hehuajie-project-remi" to a readable alias.
   * Priority: remi.toml alias > path-derived name > raw hash.
   */
  private _projects: Record<string, string> = {};

  setProjects(projects: Record<string, string>): void {
    this._projects = projects;
  }

  hashToAlias(hash: string): string | null {
    // Check remi.toml registered projects first
    for (const [alias, path] of Object.entries(this._projects)) {
      if (this.pathToHash(path) === hash) return alias;
    }
    // Derive from hash: extract after "-project-"
    const projectMatch = hash.match(/-project-(.+)$/);
    if (projectMatch) return projectMatch[1];
    // Home hashes
    if (HOME_HASHES.has(hash)) return null; // null = home, not a project
    // Tasks etc: extract after "-tasks-"
    const tasksMatch = hash.match(/-tasks-(.+)$/);
    if (tasksMatch) return tasksMatch[1];
    return hash; // fallback: raw hash
  }
```

- [ ] **Step 2: Add ensureWikiCentralization method**

Replace the existing `ensureWikiLinks` method with:

```typescript
  /**
   * Ensure wiki centralization:
   *   - ~/.remi/wiki/ as central root
   *   - Home wiki content lives at ~/.remi/wiki/ root
   *   - Project wiki content lives at ~/.remi/wiki/projects/{alias}/
   *   - Each project's wiki/ dir is a symlink to the central location
   */
  ensureWikiCentralization(): void {
    // Ensure central wiki dir exists
    mkdirSync(REMI_WIKI, { recursive: true });
    mkdirSync(join(REMI_WIKI, "projects"), { recursive: true });

    if (!existsSync(REMI_PROJECTS)) return;

    for (const name of readdirSync(REMI_PROJECTS)) {
      const projectDir = join(REMI_PROJECTS, name);
      try {
        const stat = lstatSync(projectDir);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch { continue; }

      const wikiDir = join(projectDir, "wiki");
      const isHome = HOME_HASHES.has(name);
      const alias = this.hashToAlias(name);

      // Determine target: home → wiki root, project → wiki/projects/{alias}
      const centralTarget = isHome
        ? REMI_WIKI
        : alias ? join(REMI_WIKI, "projects", alias) : null;

      if (!centralTarget) continue;

      // Already correct symlink → skip
      if (this._isSymlink(wikiDir)) {
        const current = readlinkSync(wikiDir);
        if (current === centralTarget) continue;
        // Wrong target → fix
        unlinkSync(wikiDir);
      }

      // Real directory → migrate content to central, then symlink
      if (existsSync(wikiDir) && !this._isSymlink(wikiDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          for (const item of readdirSync(wikiDir)) {
            if (item === "wiki.md") continue; // skip broken wiki.md
            const src = join(wikiDir, item);
            const dst = join(centralTarget, item);
            if (!existsSync(dst)) {
              cpSync(src, dst, { recursive: true });
            }
          }
          rmSync(wikiDir, { recursive: true, force: true });
        } catch (e) {
          log.warn(`failed to migrate wiki ${name}: ${e}`);
          continue;
        }
      }

      // No wiki dir yet → just create the symlink
      if (!existsSync(wikiDir)) {
        mkdirSync(centralTarget, { recursive: true });
      }

      try {
        symlinkSync(centralTarget, wikiDir);
        log.info(`wiki linked: ${name}/wiki/ → ${centralTarget}`);
      } catch (e) {
        log.warn(`failed to link wiki ${name}: ${e}`);
      }
    }
  }
```

- [ ] **Step 3: Add ensureProjectMemoryLinks method**

```typescript
  /**
   * Ensure project memory centralization:
   *   - Home memory already done by _ensureHomeMemoryLinks()
   *   - Project memory: projects/{hash}/memory → ~/.remi/memory/projects/{alias}
   */
  ensureProjectMemoryLinks(): void {
    mkdirSync(join(REMI_MEMORY, "projects"), { recursive: true });

    if (!existsSync(REMI_PROJECTS)) return;

    for (const name of readdirSync(REMI_PROJECTS)) {
      // Skip home hashes (handled by _ensureHomeMemoryLinks)
      if (HOME_HASHES.has(name)) continue;

      const projectDir = join(REMI_PROJECTS, name);
      try {
        const stat = lstatSync(projectDir);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch { continue; }

      const memDir = join(projectDir, "memory");
      const alias = this.hashToAlias(name);
      if (!alias) continue;

      const centralTarget = join(REMI_MEMORY, "projects", alias);

      // Already correct symlink → skip
      if (this._isSymlink(memDir)) {
        const current = readlinkSync(memDir);
        if (current === centralTarget) continue;
        // Home memory symlink or wrong target → skip if it's a home symlink
        const currentResolved = readlinkSync(memDir);
        if (currentResolved === REMI_MEMORY || currentResolved === "../../memory") continue;
        unlinkSync(memDir);
      }

      // Real directory → migrate content to central, then symlink
      if (existsSync(memDir) && !this._isSymlink(memDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          for (const item of readdirSync(memDir)) {
            const src = join(memDir, item);
            const dst = join(centralTarget, item);
            if (!existsSync(dst)) {
              cpSync(src, dst, { recursive: true });
            }
          }
          rmSync(memDir, { recursive: true, force: true });
        } catch (e) {
          log.warn(`failed to migrate memory ${name}: ${e}`);
          continue;
        }
      }

      // Create symlink if doesn't exist
      if (!existsSync(memDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          symlinkSync(centralTarget, memDir);
          log.info(`memory linked: ${name}/memory/ → ${centralTarget}`);
        } catch (e) {
          log.warn(`failed to link memory ${name}: ${e}`);
        }
      }
    }
  }
```

- [ ] **Step 4: Rewrite _collectKnownMappings with category + projectAlias**

Replace the entire `_collectKnownMappings` method and update `MappingStatus`:

```typescript
interface MappingStatus {
  source: string;
  target: string;
  type: "dir" | "file";
  status: LinkStatus;
  category: "soul" | "global" | "memory" | "wiki" | "project";
  projectAlias: string | null;
  parentHash: string | null;
}
```

```typescript
  private _collectKnownMappings(): Array<{
    source: string; target: string; type: "dir" | "file";
    category: "soul" | "global" | "memory" | "wiki" | "project";
    projectAlias: string | null;
    parentHash: string | null;
  }> {
    const pairs: Array<{
      source: string; target: string; type: "dir" | "file";
      category: "soul" | "global" | "memory" | "wiki" | "project";
      projectAlias: string | null;
      parentHash: string | null;
    }> = [];

    // Soul: CLAUDE.md → soul.md
    pairs.push({
      source: join(CLAUDE_HOME, "CLAUDE.md"),
      target: join(REMI_HOME, "soul.md"),
      type: "file",
      category: "soul",
      projectAlias: null,
      parentHash: null,
    });

    // Project dirs + internal links
    if (existsSync(REMI_PROJECTS)) {
      for (const name of readdirSync(REMI_PROJECTS)) {
        const isHome = HOME_HASHES.has(name);
        const alias = this.hashToAlias(name);

        // Project dir symlink
        pairs.push({
          source: join(CLAUDE_PROJECTS, name),
          target: join(REMI_PROJECTS, name),
          type: "dir",
          category: isHome ? "global" : "project",
          projectAlias: isHome ? "~ (home)" : alias,
          parentHash: null,
        });

        // Memory symlink
        const memDir = join(REMI_PROJECTS, name, "memory");
        if (existsSync(memDir) || this._isSymlink(memDir)) {
          const memTarget = isHome
            ? REMI_MEMORY
            : alias ? join(REMI_MEMORY, "projects", alias) : null;
          if (memTarget) {
            pairs.push({
              source: memDir,
              target: memTarget,
              type: "dir",
              category: "memory",
              projectAlias: isHome ? "~ (home)" : alias,
              parentHash: name,
            });
          }
        }

        // Wiki symlink
        const wikiDir = join(REMI_PROJECTS, name, "wiki");
        if (existsSync(wikiDir) || this._isSymlink(wikiDir)) {
          const wikiTarget = isHome
            ? REMI_WIKI
            : alias ? join(REMI_WIKI, "projects", alias) : null;
          if (wikiTarget) {
            pairs.push({
              source: wikiDir,
              target: wikiTarget,
              type: "dir",
              category: "wiki",
              projectAlias: isHome ? "~ (home)" : alias,
              parentHash: name,
            });
          }
        }
      }
    }

    return pairs;
  }
```

- [ ] **Step 5: Update getStatus to include new fields**

Update the `getStatus` method to pass through the new fields:

```typescript
  getStatus(): {
    mappings: MappingStatus[];
    stats: { total: number; ok: number; broken: number; notLinked: number };
  } {
    const mappings: MappingStatus[] = [];
    const pairs = this._collectKnownMappings();

    for (const pair of pairs) {
      const status = this._checkStatus(pair.source, pair.target);
      mappings.push({
        source: pair.source,
        target: pair.target,
        type: pair.type,
        status,
        category: pair.category,
        projectAlias: pair.projectAlias,
        parentHash: pair.parentHash,
      });
    }

    const stats = {
      total: mappings.length,
      ok: mappings.filter((m) => m.status === "ok").length,
      broken: mappings.filter((m) => m.status === "broken").length,
      notLinked: mappings.filter((m) => m.status === "not_linked" || m.status === "missing_target").length,
    };

    return { mappings, stats };
  }
```

- [ ] **Step 6: Update daemon startup in core.ts**

In `src/core.ts`, replace the startup sequence (around line 956-960):

```typescript
    const { symlinkManager } = require("./infra/symlink-manager");
    remi._symlinkManager = symlinkManager;
    symlinkManager.setProjects(config.projects);
    symlinkManager.ensureAllProjects();
    symlinkManager.ensureGlobals();
    symlinkManager.ensureProjectMemoryLinks();
    symlinkManager.ensureWikiCentralization();
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bunx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 8: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add src/infra/symlink-manager.ts src/core.ts
git commit -m "feat: 3-layer symlink centralization (memory + wiki)"
```

---

### Task 3: Frontend — Types + Store

**Files:**
- Modify: `web/frontend/src/api/types.ts`
- Rewrite: `web/frontend/src/stores/symlinks.ts`

- [ ] **Step 1: Update SymlinkMapping type**

In `web/frontend/src/api/types.ts`, replace the SymlinkMapping interface:

```typescript
export interface SymlinkMapping {
  source: string;
  target: string;
  type: "dir" | "file";
  status: "ok" | "broken" | "not_linked" | "missing_target";
  category: "soul" | "global" | "memory" | "wiki" | "project";
  projectAlias: string | null;
  parentHash: string | null;
}
```

- [ ] **Step 2: Rewrite symlinks store**

Replace the full contents of `web/frontend/src/stores/symlinks.ts`:

```typescript
import { create } from "zustand";
import type { SymlinkMapping, SymlinksStatus } from "../api/types";
import * as api from "../api/client";

/** Replace /home/<user>/ with ~/ */
export function displayPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/");
}

/** Group structure for the tree view */
export interface ProjectGroup {
  alias: string;
  hash: string;
  dirMapping: SymlinkMapping;
  memoryMapping: SymlinkMapping | null;
  wikiMapping: SymlinkMapping | null;
}

export interface GroupedMappings {
  soul: SymlinkMapping | null;
  global: {
    dirMapping: SymlinkMapping | null;
    memoryMapping: SymlinkMapping | null;
    wikiMapping: SymlinkMapping | null;
  };
  projects: ProjectGroup[];
}

function buildGroups(mappings: SymlinkMapping[]): GroupedMappings {
  const result: GroupedMappings = {
    soul: null,
    global: { dirMapping: null, memoryMapping: null, wikiMapping: null },
    projects: [],
  };

  // Index by parentHash for sub-mappings
  const projectDirs = new Map<string, SymlinkMapping>();
  const projectMemory = new Map<string, SymlinkMapping>();
  const projectWiki = new Map<string, SymlinkMapping>();

  for (const m of mappings) {
    switch (m.category) {
      case "soul":
        result.soul = m;
        break;
      case "global":
        result.global.dirMapping = m;
        break;
      case "memory":
        if (m.parentHash && m.projectAlias === "~ (home)") {
          result.global.memoryMapping = m;
        } else if (m.parentHash) {
          projectMemory.set(m.parentHash, m);
        }
        break;
      case "wiki":
        if (m.parentHash && m.projectAlias === "~ (home)") {
          result.global.wikiMapping = m;
        } else if (m.parentHash) {
          projectWiki.set(m.parentHash, m);
        }
        break;
      case "project":
        // Extract hash from source path (last segment)
        const hash = m.source.split("/").pop() || "";
        projectDirs.set(hash, m);
        break;
    }
  }

  // Build project groups
  for (const [hash, dirMapping] of projectDirs) {
    result.projects.push({
      alias: dirMapping.projectAlias || hash,
      hash,
      dirMapping,
      memoryMapping: projectMemory.get(hash) || null,
      wikiMapping: projectWiki.get(hash) || null,
    });
  }

  // Sort projects alphabetically
  result.projects.sort((a, b) => a.alias.localeCompare(b.alias));

  return result;
}

interface SymlinksState {
  mappings: SymlinkMapping[];
  stats: SymlinksStatus["stats"];
  grouped: GroupedMappings;
  loading: boolean;
  error: string | null;
  expandedSections: Set<string>; // "global", "projects"
  expandedProjects: Set<string>; // project aliases

  fetch: () => Promise<void>;
  fixAll: () => Promise<void>;
  toggleSection: (section: string) => void;
  toggleProject: (alias: string) => void;
}

export const useSymlinksStore = create<SymlinksState>((set, get) => ({
  mappings: [],
  stats: { total: 0, ok: 0, broken: 0, notLinked: 0 },
  grouped: { soul: null, global: { dirMapping: null, memoryMapping: null, wikiMapping: null }, projects: [] },
  loading: false,
  error: null,
  expandedSections: new Set(["global", "projects"]),
  expandedProjects: new Set<string>(),

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.getSymlinksStatus();
      const grouped = buildGroups(data.mappings);
      // Auto-expand projects with broken links
      const expanded = new Set(get().expandedProjects);
      for (const p of grouped.projects) {
        const hasBroken = [p.dirMapping, p.memoryMapping, p.wikiMapping].some(
          (m) => m && m.status !== "ok"
        );
        if (hasBroken) expanded.add(p.alias);
      }
      set({ mappings: data.mappings, stats: data.stats, grouped, loading: false, expandedProjects: expanded });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fixAll: async () => {
    set({ loading: true, error: null });
    try {
      await api.fixAllSymlinks();
      await get().fetch();
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  toggleSection: (section: string) => {
    const next = new Set(get().expandedSections);
    next.has(section) ? next.delete(section) : next.add(section);
    set({ expandedSections: next });
  },

  toggleProject: (alias: string) => {
    const next = new Set(get().expandedProjects);
    next.has(alias) ? next.delete(alias) : next.add(alias);
    set({ expandedProjects: next });
  },
}));
```

- [ ] **Step 3: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add web/frontend/src/api/types.ts web/frontend/src/stores/symlinks.ts
git commit -m "feat(dashboard): symlinks store with tree-based grouping"
```

---

### Task 4: Frontend — Rewrite Symlinks Page

**Files:**
- Rewrite: `web/frontend/src/pages/Symlinks.tsx`

- [ ] **Step 1: Replace Symlinks.tsx with tree flow diagram**

Replace the full contents of `web/frontend/src/pages/Symlinks.tsx`:

```tsx
import { useEffect } from "react";
import { ChevronDown, ChevronRight, Link2, Wrench, RefreshCw, Home, FolderOpen } from "lucide-react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { ArcCard } from "../components/ArcCard";
import { useSymlinksStore, displayPath, type ProjectGroup } from "../stores/symlinks";
import type { SymlinkMapping } from "../api/types";

const statusStyles: Record<string, { dot: string; text: string; label: string }> = {
  ok:             { dot: "bg-success",            text: "text-success",            label: "OK" },
  broken:         { dot: "bg-destructive",        text: "text-destructive",        label: "BROKEN" },
  not_linked:     { dot: "bg-warning",            text: "text-warning",            label: "NOT LINKED" },
  missing_target: { dot: "bg-muted-foreground",   text: "text-muted-foreground",   label: "MISSING" },
};

const btnCls =
  "rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer";

/** Single mapping row: source → target with status */
function FlowRow({ mapping, indent = 0 }: { mapping: SymlinkMapping; indent?: number }) {
  const style = statusStyles[mapping.status] ?? statusStyles.missing_target;
  const ml = indent > 0 ? `ml-${indent * 4}` : "";

  return (
    <div className={`flex items-center gap-2 py-1 px-2 rounded-md transition-colors hover:bg-accent/20 ${ml}`}>
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
      {mapping.type === "dir" && (
        <span className="shrink-0 font-mono text-[8px] uppercase text-muted-foreground/50 border border-border/30 rounded px-1">DIR</span>
      )}
      {mapping.type === "file" && (
        <span className="shrink-0 font-mono text-[8px] uppercase text-muted-foreground/50 border border-border/30 rounded px-1">FILE</span>
      )}
    </div>
  );
}

/** Sub-mapping row with tree connector (├─ or └─) */
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

/** Collapsible section header */
function SectionHeader({
  icon,
  title,
  subtitle,
  expanded,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/30 cursor-pointer"
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {icon}
      <span className="text-sm font-medium text-foreground">{title}</span>
      {subtitle && (
        <span className="font-mono text-[10px] text-muted-foreground">{subtitle}</span>
      )}
    </button>
  );
}

/** Single project in the Projects group */
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
        {subCount > 0 ? (
          expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />
        ) : (
          <span className="w-3" />
        )}
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="text-[13px] font-medium text-foreground">{project.alias}</span>
        <span className="font-mono text-[9px] uppercase text-muted-foreground/50 border border-border/30 rounded px-1">DIR</span>
        <span className={`ml-auto font-mono text-[9px] ${allOk ? "text-success" : "text-destructive"}`}>
          {allOk ? "● OK" : "● Issues"}
        </span>
      </button>

      {expanded && (
        <div className="ml-2 border-l border-border/30 pl-2">
          {/* Project dir mapping */}
          <div className="py-0.5 pl-4">
            <span className="font-mono text-[10px] text-muted-foreground">
              {displayPath(project.dirMapping.source)}
              <span className="text-muted-foreground/50"> → </span>
              <span className="text-emerald-400/80">{displayPath(project.dirMapping.target)}</span>
            </span>
          </div>
          {/* Memory sub-mapping */}
          {project.memoryMapping && (
            <SubRow
              mapping={project.memoryMapping}
              label="memory"
              isLast={!project.wikiMapping}
            />
          )}
          {/* Wiki sub-mapping */}
          {project.wikiMapping && (
            <SubRow mapping={project.wikiMapping} label="wiki" isLast={true} />
          )}
          {!project.memoryMapping && !project.wikiMapping && (
            <div className="py-0.5 pl-6 font-mono text-[9px] text-muted-foreground/40 italic">
              no memory, no wiki
            </div>
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
  const globalHasSubs = !!(grouped.global.memoryMapping || grouped.global.wikiMapping);

  return (
    <Layout title="Symlinks" subtitle="FILESYSTEM MAPPING">
      {/* Stats Cards */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-5 sm:grid-cols-4 sm:gap-3">
        <ArcCard label="Total" value={String(stats.total)} sub="MAPPINGS" color="default" />
        <ArcCard label="OK" value={String(stats.ok)} sub="LINKED" color="success" />
        <ArcCard label="Broken" value={String(stats.broken)} sub="WRONG TARGET" color={stats.broken > 0 ? "destructive" : "default"} />
        <ArcCard label="Not Linked" value={String(stats.notLinked)} sub="MISSING" color={stats.notLinked > 0 ? "warning" : "default"} />
      </div>

      {/* Actions */}
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
```

- [ ] **Step 2: Build and verify**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend && npx vite build 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add web/frontend/src/pages/Symlinks.tsx
git commit -m "feat(dashboard): tree-based symlink flow visualization"
```

---

### Task 5: Integration Test

- [ ] **Step 1: Run the migration manually to test**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
bun run src/infra/symlink-manager.ts 2>&1 | head -20
```

Or test via API after daemon restart.

- [ ] **Step 2: Verify filesystem state**

```bash
ls -la ~/.remi/wiki/
ls -la ~/.remi/wiki/projects/
ls -la ~/.remi/memory/projects/
# Check a project symlink
ls -la ~/.remi/projects/-data00-home-hehuajie-project-remi/memory
ls -la ~/.remi/projects/-data00-home-hehuajie-project-remi/wiki
```

- [ ] **Step 3: Verify API response**

```bash
curl -s http://127.0.0.1:5199/api/v1/symlinks/status | python3 -c "
import json,sys
data = json.load(sys.stdin)
for m in data['mappings']:
    print(f\"{m['category']:8} {m.get('projectAlias',''):20} {m['status']:10} {m['source']}\")
"
```

- [ ] **Step 4: Access dashboard and verify visual**

Open: `http://10.37.66.8:5199/#/symlinks`

Expected:
- Soul section with CLAUDE.md → soul.md
- Global (Home) with dir mapping + memory + wiki sub-rows
- Projects list with each project expandable to show memory + wiki

- [ ] **Step 5: Final commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add -A
git commit -m "feat: complete 3-layer symlink system with dashboard visualization"
```
