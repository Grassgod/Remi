# Skills Page + Unified Markdown Editor

**Date:** 2026-03-28
**Branch:** dashboard-redesign
**Scope:** New Skills page + Wiki edit enhancement + shared MarkdownFileViewer component

## Summary

Add a Skills page to the Remi Dashboard that displays all 15 skills with directory browsing, Markdown preview, and editing. Extract a shared `<MarkdownFileViewer />` component from Memory's existing edit pattern, and apply it to Wiki (currently read-only) and Skills.

## Shared Component: MarkdownFileViewer

Extract from Memory's repeated pattern (MemoryEditor, EntityDetailInline, ProjectFileViewer).

```tsx
interface MarkdownFileViewerProps {
  content: string;
  onSave?: (content: string) => Promise<void>;  // omit = read-only
  readOnly?: boolean;
  className?: string;
}
```

**Behavior:**
- Default: Markdown preview via ReactMarkdown + remarkGfm
- Edit button toggles to monospace textarea
- Save button appears in edit mode, calls `onSave`, then switches back to preview
- Saving state with disabled button + "Saving..." text
- When `onSave` is undefined or `readOnly=true`, no Edit button shown

**File:** `web/frontend/src/components/MarkdownFileViewer.tsx`

## Skills Page

### Data Sources

| Source | Path | Content |
|--------|------|---------|
| Skill definitions | `~/.remi/.claude/skills/{name}/SKILL.md` | Skill prompt/instructions |
| Skill subdirectories | `~/.remi/.claude/skills/{name}/**` | Supporting files |
| Reports | `~/task/{name}/YYYY-MM-DD.md` | Generated output (4 skills) |
| Cron config | `remi.toml` `[[cron.jobs]]` | Schedule + delivery info |

**15 skills total**, 4 with scheduled reports:
- ai-daily-briefing → `~/task/briefing/`
- feishu-insight → `~/task/feishu-insights/`
- memory-research → `~/task/memory-research/`
- repo-update → `~/task/repo-updates/`

### Frontend Layout (Skills.tsx)

**Left sidebar (220px):** Skill list
- Each skill: name + optional "Scheduled" badge
- Click to select, highlights active

**Right content area:**
- **Header card:** Skill name, description (from SKILL.md frontmatter), cron schedule badge (if scheduled), Edit/Save buttons
- **Tabs:** "SKILL.md" | "Reports (N)" (Reports tab only for skills with outputDir)
- **SKILL.md tab:** MarkdownFileViewer with edit capability
- **Reports tab:** Date selector (button chips, newest first) + MarkdownFileViewer (read-only for reports, or editable if desired)

### Backend API (web/handlers/skills.ts)

```
GET  /api/v1/skills                    → list all skills with metadata
GET  /api/v1/skills/:name/file?path=   → read a file (default: SKILL.md)
PUT  /api/v1/skills/:name/file?path=   → write a file
GET  /api/v1/skills/:name/reports      → list report dates
GET  /api/v1/skills/:name/reports/:date → read a specific report
```

### Data Layer (remi-data.ts additions)

```typescript
listSkills(): SkillInfo[]
// Scans ~/.remi/.claude/skills/, merges cron config from remi.toml
// Returns: { name, description, hasSchedule, cron?, outputDir?, lastReport? }

readSkillFile(name: string, path?: string): string | null
// Default path = "SKILL.md"

writeSkillFile(name: string, content: string, path?: string): boolean
// Default path = "SKILL.md"

listSkillReports(name: string): string[]
// Reads outputDir from cron config, returns sorted date list (newest first)

readSkillReport(name: string, date: string): string | null
// Reads {outputDir}/{date}.md
```

## Wiki Enhancement

### Current State
- Read-only: GET tree, GET file, GET history, GET diff
- No write capability

### Changes

**Backend:** Add write endpoint to `web/handlers/wiki.ts`:
```
PUT /api/v1/wiki/file?path=<path>   → write file content
```

Restricted to files within known wiki directories (personal wiki, project wikis, agents, project config). Validates path does not escape allowed roots.

**Frontend:** Replace the inline `<ReactMarkdown>` content area in Wiki.tsx with `<MarkdownFileViewer>` component, passing an `onSave` handler that calls the new PUT API. Git history panel remains unchanged below.

**Data layer:** Add `writeWikiFile(path: string, content: string): boolean` to remi-data.ts.

## Memory Refactor

Replace the textarea + ReactMarkdown pattern in three places:

1. **MemoryEditor** (global memory / soul.md) → use `<MarkdownFileViewer content={globalMemory} onSave={saveGlobalMemory} />`
2. **EntityDetailInline** → use `<MarkdownFileViewer content={entity.body} onSave={...} />`, keep entity metadata/breadcrumbs above
3. **ProjectFileViewer** → use `<MarkdownFileViewer content={content} onSave={...} />`

No new APIs needed — existing PUT endpoints are already in place.

## Navigation

Add "Skills" to the Sidebar navigation under the "Workspace" group (alongside Conversations, Missions):
- Icon: `Wand2` or `Zap` from lucide-react
- Route: `/skills`

## API Types (api/types.ts additions)

```typescript
interface SkillInfo {
  name: string;
  description: string;
  hasSchedule: boolean;
  cron?: string;
  outputDir?: string;
  reportCount?: number;
  lastReportDate?: string;
}
```

## Error Handling

- File not found → 404 with message
- Write failure → 500 with message
- Path traversal attempt → 400 with "invalid path"
- All write operations validate path stays within allowed roots

## Testing

- Manual: verify on http://10.37.66.8:5199
- Skills: browse all 15, view SKILL.md, edit + save, view reports with date switching
- Wiki: existing read flow unchanged, new edit + save works
- Memory: existing edit behavior unchanged after refactor
