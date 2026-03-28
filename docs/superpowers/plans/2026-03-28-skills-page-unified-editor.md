# Skills Page + Unified Markdown Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Skills page to the dashboard, extract a shared MarkdownFileViewer component, and add edit capability to Wiki — all on the `dashboard-redesign` worktree.

**Architecture:** Extract the Edit/Preview/Save pattern from Memory into a shared `<MarkdownFileViewer />` component. Build a new Skills page (backend handler + data layer + frontend) and enhance Wiki with write support. Memory page refactors its three editor components to use the shared one.

**Tech Stack:** React 19, Hono, Bun, ReactMarkdown + remarkGfm, Zustand, shadcn/ui components, gray-matter (frontmatter parsing), smol-toml (config reading)

**Worktree:** `/data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/`
**Test server:** `http://10.37.66.8:5199`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/frontend/src/components/MarkdownFileViewer.tsx` | Shared Edit/Preview/Save component |
| Create | `web/handlers/skills.ts` | Skills API endpoints |
| Create | `web/frontend/src/pages/Skills.tsx` | Skills page UI |
| Modify | `web/remi-data.ts:989` (before closing `}`) | Add skill data methods |
| Modify | `web/server.ts:37` | Import + register skills handler |
| Modify | `web/frontend/src/api/types.ts:414` | Add SkillInfo type |
| Modify | `web/frontend/src/api/client.ts:198` | Add skills API functions |
| Modify | `web/frontend/src/components/Sidebar.tsx:3-4,17` | Add Skills nav item |
| Modify | `web/frontend/src/App.tsx:11,46` | Add Skills route |
| Modify | `web/frontend/src/pages/Wiki.tsx:130-136` | Replace ReactMarkdown with MarkdownFileViewer |
| Modify | `web/handlers/wiki.ts:129` | Add PUT /api/v1/wiki/file |
| Modify | `web/frontend/src/pages/Memory.tsx:276-322,324-419,421-492` | Replace 3 inline editors with MarkdownFileViewer |

---

### Task 1: Shared MarkdownFileViewer Component

**Files:**
- Create: `web/frontend/src/components/MarkdownFileViewer.tsx`

- [ ] **Step 1: Create the MarkdownFileViewer component**

```tsx
// web/frontend/src/components/MarkdownFileViewer.tsx
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownFileViewerProps {
  content: string;
  onSave?: (content: string) => Promise<void>;
  readOnly?: boolean;
  className?: string;
}

export function MarkdownFileViewer({ content, onSave, readOnly, className }: MarkdownFileViewerProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(content); setEditing(false); }, [content]);

  const canEdit = !!onSave && !readOnly;

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch { /* caller handles */ }
    setSaving(false);
    setEditing(false);
  };

  return (
    <div className={className}>
      {canEdit && (
        <div className="mb-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)} className="h-7 text-xs">
            {editing ? "Preview" : "Edit"}
          </Button>
          {editing && (
            <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      )}
      {editing ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          className="min-h-[400px] w-full resize-y rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
          spellCheck={false}
        />
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/30 p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "(empty)"}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the component builds**

Run: `cd web/frontend && npx vite build --mode development 2>&1 | tail -5`
Expected: Build succeeds (component is not yet imported anywhere, so just verifying syntax)

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/MarkdownFileViewer.tsx
git commit -m "feat(dashboard): add shared MarkdownFileViewer component"
```

---

### Task 2: Skills Backend — Data Layer

**Files:**
- Modify: `web/remi-data.ts` (add methods before the closing `}` at line 1004)

- [ ] **Step 1: Add SkillInfo type and skill methods to RemiData**

Add these imports at the top of `remi-data.ts` (they already exist, just noting for reference: `readFileSync`, `readdirSync`, `existsSync`, `statSync`, `writeFileSync` from `node:fs`, `join`, `basename` from `node:path`, `homedir` from `node:os`, `matter` from `gray-matter`).

Insert before the `private _backup` method (line 990):

```typescript
  // ── Skills ──────��───────────────────────────────────────

  private get skillsDir(): string {
    return join(homedir(), ".remi", ".claude", "skills");
  }

  listSkills(): Array<{
    name: string; description: string; hasSchedule: boolean;
    cron?: string; outputDir?: string; reportCount?: number; lastReportDate?: string;
  }> {
    const dir = this.skillsDir;
    if (!existsSync(dir)) return [];

    // Build cron lookup: skillName → { cron, outputDir }
    const cronJobs = this._loadCronJobs();
    const cronMap = new Map<string, { cron?: string; outputDir?: string }>();
    for (const job of cronJobs) {
      if (job.handler === "skill:run" && job.handlerConfig?.skillName) {
        cronMap.set(job.handlerConfig.skillName as string, {
          cron: job.cron,
          outputDir: job.handlerConfig.outputDir as string | undefined,
        });
      }
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => {
        const name = e.name;
        const skillMd = join(dir, name, "SKILL.md");
        let description = "";
        if (existsSync(skillMd)) {
          try {
            const { data } = matter(readFileSync(skillMd, "utf-8"));
            description = (data.description as string) ?? "";
          } catch {}
        }

        const cronInfo = cronMap.get(name);
        let reportCount = 0;
        let lastReportDate: string | undefined;
        if (cronInfo?.outputDir && existsSync(cronInfo.outputDir)) {
          const reports = readdirSync(cronInfo.outputDir)
            .filter(f => f.endsWith(".md"))
            .sort()
            .reverse();
          reportCount = reports.length;
          if (reports[0]) lastReportDate = reports[0].replace(".md", "");
        }

        return {
          name,
          description,
          hasSchedule: cronMap.has(name),
          cron: cronInfo?.cron,
          outputDir: cronInfo?.outputDir,
          reportCount,
          lastReportDate,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readSkillFile(name: string, path = "SKILL.md"): string | null {
    // Validate: no path traversal
    if (path.includes("..") || path.startsWith("/")) return null;
    const filePath = join(this.skillsDir, name, path);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    return readFileSync(filePath, "utf-8");
  }

  writeSkillFile(name: string, content: string, path = "SKILL.md"): boolean {
    if (path.includes("..") || path.startsWith("/")) return false;
    const filePath = join(this.skillsDir, name, path);
    if (!existsSync(filePath)) return false;
    this._backup(filePath);
    writeFileSync(filePath, content, "utf-8");
    return true;
  }

  listSkillReports(name: string): string[] {
    const skills = this.listSkills();
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir || !existsSync(skill.outputDir)) return [];
    return readdirSync(skill.outputDir)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""))
      .sort()
      .reverse();
  }

  readSkillReport(name: string, date: string): string | null {
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const skills = this.listSkills();
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir) return null;
    const filePath = join(skill.outputDir, `${date}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && npx tsc --noEmit web/remi-data.ts 2>&1 | head -20`

If tsc is not set up for standalone checking, just verify no syntax errors:
Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build web/remi-data.ts --target=bun --outdir=/tmp/remi-check 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add web/remi-data.ts
git commit -m "feat(dashboard): add skills data methods to RemiData"
```

---

### Task 3: Skills Backend — API Handler

**Files:**
- Create: `web/handlers/skills.ts`
- Modify: `web/server.ts:37,85` (import + register)

- [ ] **Step 1: Create the skills handler**

```typescript
// web/handlers/skills.ts
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerSkillsHandlers(app: Hono, data: RemiData) {
  // List all skills
  app.get("/api/v1/skills", (c) => {
    return c.json(data.listSkills());
  });

  // Read a skill file (default: SKILL.md)
  app.get("/api/v1/skills/:name/file", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const path = c.req.query("path") ?? "SKILL.md";
    const content = data.readSkillFile(name, path);
    if (content === null) return c.json({ error: "File not found" }, 404);
    return c.json({ content });
  });

  // Write a skill file
  app.put("/api/v1/skills/:name/file", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const path = c.req.query("path") ?? "SKILL.md";
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content required" }, 400);
    }
    const ok = data.writeSkillFile(name, body.content, path);
    if (!ok) return c.json({ error: "Write failed" }, 404);
    return c.json({ ok: true });
  });

  // List report dates for a skill
  app.get("/api/v1/skills/:name/reports", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const dates = data.listSkillReports(name);
    return c.json(dates);
  });

  // Read a specific report
  app.get("/api/v1/skills/:name/reports/:date", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const date = c.req.param("date");
    const content = data.readSkillReport(name, date);
    if (content === null) return c.json({ error: "Report not found" }, 404);
    return c.json({ content });
  });
}
```

- [ ] **Step 2: Register in server.ts**

In `web/server.ts`, add import after line 37 (`import { registerWikiHandlers }...`):

```typescript
import { registerSkillsHandlers } from "./handlers/skills.js";
```

Add registration after line 85 (`registerWikiHandlers(app, data);`):

```typescript
registerSkillsHandlers(app, data);
```

- [ ] **Step 3: Verify server starts**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && timeout 5 bun run web/server.ts --dev 2>&1 || true`
Expected: `[remi-web] Dashboard started on port ...`

- [ ] **Step 4: Commit**

```bash
git add web/handlers/skills.ts web/server.ts
git commit -m "feat(dashboard): add skills API handler"
```

---

### Task 4: Skills Frontend — Types + API Client

**Files:**
- Modify: `web/frontend/src/api/types.ts:414` (append)
- Modify: `web/frontend/src/api/client.ts:198` (append)

- [ ] **Step 1: Add SkillInfo type**

Append to `web/frontend/src/api/types.ts` after line 414:

```typescript

// Skills
export interface SkillInfo {
  name: string;
  description: string;
  hasSchedule: boolean;
  cron?: string;
  outputDir?: string;
  reportCount?: number;
  lastReportDate?: string;
}
```

- [ ] **Step 2: Add skills API functions**

Append to `web/frontend/src/api/client.ts` after line 202:

```typescript

// Skills
export const getSkills = () =>
  request<import("./types").SkillInfo[]>("/api/v1/skills");
export const getSkillFile = (name: string, path = "SKILL.md") =>
  request<{ content: string }>(`/api/v1/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`);
export const putSkillFile = (name: string, content: string, path = "SKILL.md") =>
  request(`/api/v1/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const getSkillReports = (name: string) =>
  request<string[]>(`/api/v1/skills/${encodeURIComponent(name)}/reports`);
export const getSkillReport = (name: string, date: string) =>
  request<{ content: string }>(`/api/v1/skills/${encodeURIComponent(name)}/reports/${date}`);
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat(dashboard): add skills types and API client"
```

---

### Task 5: Skills Frontend — Page Component

**Files:**
- Create: `web/frontend/src/pages/Skills.tsx`

- [ ] **Step 1: Create the Skills page**

```tsx
// web/frontend/src/pages/Skills.tsx
import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Zap, FileText, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import * as api from "../api/client";
import type { SkillInfo } from "../api/types";

type Tab = "skill" | "reports";

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("skill");
  const [skillContent, setSkillContent] = useState("");
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSkills().then(data => {
      setSkills(data);
      if (data.length > 0) setSelected(data[0].name);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setTab("skill");
    api.getSkillFile(selected).then(d => setSkillContent(d.content)).catch(() => setSkillContent(""));
    const skill = skills.find(s => s.name === selected);
    if (skill?.hasSchedule) {
      api.getSkillReports(selected).then(setReportDates).catch(() => setReportDates([]));
    } else {
      setReportDates([]);
    }
    setSelectedDate(null);
    setReportContent("");
  }, [selected]);

  useEffect(() => {
    if (!selected || !selectedDate) return;
    api.getSkillReport(selected, selectedDate).then(d => setReportContent(d.content)).catch(() => setReportContent(""));
  }, [selectedDate]);

  const handleSaveSkill = async (content: string) => {
    if (!selected) return;
    await api.putSkillFile(selected, content);
    setSkillContent(content);
  };

  const currentSkill = skills.find(s => s.name === selected);

  return (
    <Layout title="Skills" subtitle="Skill Definitions & Reports">
      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
      ) : skills.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Zap className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">No skills found</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Skills are loaded from ~/.remi/.claude/skills/
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[220px_1fr]">
          {/* Skill List */}
          <Card className="lg:sticky lg:top-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-muted-foreground" />
                Skills
                <Badge variant="secondary" className="ml-auto text-[10px]">{skills.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[600px] px-2 pb-2">
                {skills.map(skill => (
                  <div
                    key={skill.name}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs transition-colors",
                      selected === skill.name
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                    onClick={() => setSelected(skill.name)}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                    {skill.hasSchedule && (
                      <Clock className="h-3 w-3 shrink-0 text-green-500" />
                    )}
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Content */}
          <div className="flex flex-col gap-3">
            {currentSkill && (
              <>
                {/* Header */}
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                      Skills / <span className="text-foreground font-medium">{currentSkill.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">{currentSkill.name}</CardTitle>
                      {currentSkill.hasSchedule && (
                        <>
                          <Badge variant="outline" className="border-green-500/30 text-green-500 bg-green-500/5 text-[10px]">
                            Scheduled
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{currentSkill.cron}</span>
                        </>
                      )}
                    </div>
                    {currentSkill.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{currentSkill.description}</p>
                    )}
                  </CardHeader>
                </Card>

                {/* Tabs */}
                <div className="flex gap-1">
                  <Button
                    variant={tab === "skill" ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setTab("skill")}
                  >
                    SKILL.md
                  </Button>
                  {reportDates.length > 0 && (
                    <Button
                      variant={tab === "reports" ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setTab("reports");
                        if (!selectedDate && reportDates.length > 0) setSelectedDate(reportDates[0]);
                      }}
                    >
                      Reports ({reportDates.length})
                    </Button>
                  )}
                </div>

                {/* SKILL.md Tab */}
                {tab === "skill" && (
                  <Card>
                    <CardContent className="pt-4">
                      <MarkdownFileViewer content={skillContent} onSave={handleSaveSkill} />
                    </CardContent>
                  </Card>
                )}

                {/* Reports Tab */}
                {tab === "reports" && (
                  <Card>
                    <CardContent className="pt-4">
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {reportDates.slice(0, 14).map(date => (
                          <Button
                            key={date}
                            variant={selectedDate === date ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSelectedDate(date)}
                          >
                            {date.slice(5)}
                          </Button>
                        ))}
                      </div>
                      {selectedDate && reportContent && (
                        <MarkdownFileViewer content={reportContent} readOnly />
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/pages/Skills.tsx
git commit -m "feat(dashboard): add Skills page component"
```

---

### Task 6: Skills Navigation + Route

**Files:**
- Modify: `web/frontend/src/components/Sidebar.tsx:3-4,17`
- Modify: `web/frontend/src/App.tsx:11,46`

- [ ] **Step 1: Add Skills to Sidebar navigation**

In `web/frontend/src/components/Sidebar.tsx`:

1. Add `Zap` to the icon import on line 3:
```typescript
import {
  LayoutDashboard, MessageSquare, KanbanSquare, Brain, BookOpen,
  BarChart3, Activity, FileText, Clock, FolderOpen, Menu, Zap,
} from "lucide-react";
```

2. Add Skills item to the "Workspace" group, after Wiki (line 17):
```typescript
  { group: "Workspace", items: [
    { path: "/conversations", label: "Conversations", icon: MessageSquare },
    { path: "/missions", label: "Missions", icon: KanbanSquare },
    { path: "/memory", label: "Memory", icon: Brain },
    { path: "/wiki", label: "Wiki", icon: BookOpen },
    { path: "/skills", label: "Skills", icon: Zap },
  ]},
```

- [ ] **Step 2: Add Skills route to App.tsx**

In `web/frontend/src/App.tsx`:

1. Add import after line 10 (`import { Wiki }...`):
```typescript
import { Skills } from "./pages/Skills";
```

2. Add route after line 46 (`<Route path="/wiki" component={Wiki} />`):
```typescript
        <Route path="/skills" component={Skills} />
```

- [ ] **Step 3: Build and verify**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/Sidebar.tsx web/frontend/src/App.tsx
git commit -m "feat(dashboard): add Skills to sidebar navigation and router"
```

---

### Task 7: Wiki Enhancement — Add Write Support

**Files:**
- Modify: `web/handlers/wiki.ts` (add PUT endpoint after the GET /api/v1/wiki/file handler, around line 233)
- Modify: `web/frontend/src/api/client.ts` (add putWikiFile)
- Modify: `web/frontend/src/pages/Wiki.tsx:1-14,110-137` (import + use MarkdownFileViewer)

- [ ] **Step 1: Add PUT endpoint to wiki handler**

In `web/handlers/wiki.ts`, add after the existing `GET /api/v1/wiki/file` handler (after line 233, before the `GET /api/v1/wiki/history` route):

```typescript
  // PUT /api/v1/wiki/file — write file content
  app.put("/api/v1/wiki/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content required" }, 400);
    }

    const fsPath = resolveFilePath(path);
    if (!fsPath) return c.json({ error: "Invalid path" }, 400);
    if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fsPath, body.content, "utf-8");
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Write failed" }, 500);
    }
  });
```

Note: `writeFileSync` needs to be imported. Check line 1 of wiki.ts — it already imports `{ existsSync, readdirSync, readFileSync, statSync }` from `"node:fs"`. Add `writeFileSync` to that import:

```typescript
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: Add putWikiFile to API client**

In `web/frontend/src/api/client.ts`, add after the existing wiki functions (after `getWikiDiff` at line 197):

```typescript
export const putWikiFile = (path: string, content: string) =>
  request(`/api/v1/wiki/file?path=${encodeURIComponent(path)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
```

- [ ] **Step 3: Update Wiki.tsx to use MarkdownFileViewer**

In `web/frontend/src/pages/Wiki.tsx`:

1. Add import at the top (after line 11 `import ReactMarkdown...` or replace it):
```typescript
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
```

2. Replace the content area (lines 130-136) that currently has:
```tsx
                  <CardContent>
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {fileContent.content}
                      </ReactMarkdown>
                    </div>
                  </CardContent>
```

With:
```tsx
                  <CardContent>
                    <MarkdownFileViewer
                      content={fileContent.content}
                      onSave={async (content) => {
                        if (!selectedPath) return;
                        await api.putWikiFile(selectedPath, content);
                        setFileContent({ ...fileContent, content });
                      }}
                    />
                  </CardContent>
```

You can remove the `ReactMarkdown` and `remarkGfm` imports from Wiki.tsx if they are no longer used directly (they're now used via MarkdownFileViewer).

- [ ] **Step 4: Build and verify**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add web/handlers/wiki.ts web/frontend/src/api/client.ts web/frontend/src/pages/Wiki.tsx
git commit -m "feat(dashboard): add edit support to Wiki page"
```

---

### Task 8: Memory Refactor — Use Shared MarkdownFileViewer

**Files:**
- Modify: `web/frontend/src/pages/Memory.tsx`

This is a refactor of three inline editor patterns to use the shared component. No new APIs needed.

- [ ] **Step 1: Add MarkdownFileViewer import**

In `web/frontend/src/pages/Memory.tsx`, add import (after line 11 or alongside existing imports):

```typescript
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
```

- [ ] **Step 2: Refactor MemoryEditor (lines 276-322)**

Replace the `MemoryEditor` function body. Current code uses internal `editing`, `text`, `saving` state + textarea/ReactMarkdown. Replace with:

```tsx
function MemoryEditor() {
  const { globalMemory, saveGlobalMemory } = useMemoryStore();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Soul.md</CardTitle>
      </CardHeader>
      <CardContent>
        <MarkdownFileViewer content={globalMemory} onSave={saveGlobalMemory} />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Refactor EntityDetailInline (lines 324-419)**

Replace the textarea/ReactMarkdown section (lines 403-415) while keeping the entity metadata above. The edit/preview toggle buttons in the header (lines 363-372) should be removed since MarkdownFileViewer provides its own.

Replace the full function with:

```tsx
function EntityDetailInline({ entity, onBack, onBackToType, onDelete }: {
  entity: import("../api/types").EntityDetail;
  onBack: () => void;
  onBackToType: () => void;
  onDelete: () => void;
}) {
  const handleSave = async (content: string) => {
    const api = await import("../api/client");
    await api.updateEntity(entity.type, entity.name, content);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <button onClick={onBack} className="hover:text-foreground transition-colors">Memory</button>
            <span>/</span>
            <button onClick={onBackToType} className="hover:text-foreground transition-colors capitalize">{entity.type}s</button>
            <span>/</span>
            <span className="text-foreground font-medium">{entity.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={cn("text-[10px] uppercase", entityBadgeClass(entity.type))}>
              {entity.type}
            </Badge>
            <CardTitle className="text-lg">{entity.name}</CardTitle>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete} className="h-7 text-xs text-destructive hover:text-destructive">
          Delete
        </Button>
      </CardHeader>
      <CardContent>
        {/* Metadata */}
        <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          {entity.createdAt && (
            <div><span className="text-muted-foreground">Created</span><div className="font-medium">{entity.createdAt.slice(0, 10)}</div></div>
          )}
          {entity.updatedAt && (
            <div><span className="text-muted-foreground">Updated</span><div className="font-medium">{entity.updatedAt.slice(0, 10)}</div></div>
          )}
          {entity.summary && (
            <div className="col-span-2"><span className="text-muted-foreground">Summary</span><div className="font-medium">{entity.summary}</div></div>
          )}
        </div>
        {(entity.aliases?.length > 0 || entity.tags?.length > 0) && (
          <div className="mb-4 flex flex-wrap gap-3 border-t border-border pt-3 text-xs">
            {entity.aliases?.length > 0 && (
              <div>
                <span className="mr-1 text-[10px] uppercase text-muted-foreground">Aliases:</span>
                {entity.aliases.map(a => <Badge key={a} variant="secondary" className="mr-1 text-[10px]">{a}</Badge>)}
              </div>
            )}
            {entity.tags?.length > 0 && (
              <div>
                <span className="mr-1 text-[10px] uppercase text-muted-foreground">Tags:</span>
                {entity.tags.map(t => <Badge key={t} variant="outline" className="mr-1 text-[10px]">{t}</Badge>)}
              </div>
            )}
          </div>
        )}
        <MarkdownFileViewer content={entity.body || entity.content || ""} onSave={handleSave} />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Refactor ProjectFileViewer (lines 421-492)**

Replace the full function:

```tsx
function ProjectFileViewer({ activeView, content, projectMemories }: {
  activeView: string;
  content: string;
  projectMemories: import("../api/types").ProjectMemory[];
}) {
  const rest = activeView.replace("project-file:", "");
  const colonIdx = rest.indexOf(":");
  const projectId = rest.slice(0, colonIdx);
  const filePath = rest.slice(colonIdx + 1);
  const pm = projectMemories.find(p => p.projectId === projectId);
  const projectName = pm?.projectName || projectId;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Memory</span>
            <span>/</span>
            <span>{projectName}</span>
            <span>/</span>
            <span className="text-foreground font-medium">{filePath}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="text-[10px] uppercase border-green-500/30 text-green-500 bg-green-500/5">
              Project Memory
            </Badge>
            <CardTitle className="text-lg">{filePath}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <MarkdownFileViewer content={content} readOnly />
      </CardContent>
    </Card>
  );
}
```

Note: ProjectFileViewer's save was a TODO (`// TODO: implement save API for project memory files`), so we keep it read-only for now — same as before but cleaner.

- [ ] **Step 5: Clean up unused imports**

In `Memory.tsx`, after the refactor, the standalone `ReactMarkdown` and `remarkGfm` imports may no longer be needed if they're only used inside the replaced editors. Check and remove if unused:

```typescript
// Remove these if no longer used directly in Memory.tsx:
// import ReactMarkdown from "react-markdown";
// import remarkGfm from "remark-gfm";
```

However, `ReactMarkdown` is still used in the Daily Logs section (line 221) and Search Results. So **keep the import** — only the editors changed.

- [ ] **Step 6: Build and verify**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/pages/Memory.tsx
git commit -m "refactor(dashboard): Memory page uses shared MarkdownFileViewer"
```

---

### Task 9: Build + Manual Verification

- [ ] **Step 1: Full frontend build**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend && npx vite build 2>&1 | tail -10`
Expected: Build succeeds with no errors

- [ ] **Step 2: Verify Skills page loads**

Open `http://10.37.66.8:5199/#/skills` in browser. Check:
- Left sidebar lists 15 skills
- Selecting a skill shows SKILL.md content
- Scheduled skills show clock icon + "Scheduled" badge + cron expression
- Edit button works, Save persists changes
- Reports tab shows date chips for skills with reports (ai-daily-briefing, feishu-insight, etc.)

- [ ] **Step 3: Verify Wiki edit works**

Open `http://10.37.66.8:5199/#/wiki`. Check:
- Select any file → Edit button appears
- Click Edit → textarea with content
- Save persists changes
- Git history panel still visible below

- [ ] **Step 4: Verify Memory page unchanged**

Open `http://10.37.66.8:5199/#/memory`. Check:
- Soul.md: Edit/Preview/Save works
- Entity detail: Edit/Preview/Save works
- Project files: displays read-only (same as before)
- Search, daily logs, recall debug: all unchanged

- [ ] **Step 5: Verify Sidebar navigation**

Check Skills appears in "Workspace" group between Wiki and the Observability section.

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(dashboard): address verification issues"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-03-28-skills-page-unified-editor.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?