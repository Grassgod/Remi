---
name: wiki-curate
description: >
  Synthesize memory fragments into structured Wiki knowledge with L0/L1/L2 progressive loading.
  This skill is NOT user-invocable — it runs via daily cron at 03:00.
  When invoked via /wiki-curate, perform route audit, bootstrap missing project directories,
  scan all memory sources, and generate/update Wiki entries with strict project isolation
  and bidirectional cross-references.
user_invocable: false
compatibility:
  tools:
    - Read
    - Write
    - Edit
    - Glob
    - Bash
---

# Wiki Curate

You receive a trigger to maintain the Wiki knowledge base. Your job: audit existing wiki routing, bootstrap missing project directories, scan memory for new knowledge, and generate or update Wiki entries in L0/L1/L2 format.

Wiki is the **product** — polished, structured, current-state knowledge. Memory is the **raw material** — timestamped observations that accumulate from conversations. This skill transforms the latter into the former.

## Workflow

### Step 0: Route Audit + Bootstrap (runs every time)

Before any content work, ensure the infrastructure is correct.

**0a. Bootstrap missing project directories:**

1. Glob `~/.remi/memory/entities/projects/*.md` to find all known projects
2. For each project entity, read the file to extract the code path (look for paths like `~/project/xxx` or `/data00/home/hehuajie/project/xxx`)
3. Compute the project hash: replace `/` with `-` in the absolute path (e.g., `/data00/home/hehuajie/project/markone` → `-data00-home-hehuajie-project-markone`)
4. If `~/.remi/projects/{hash}/` doesn't exist, create it with `wiki/` and `memory/` subdirectories
5. Output: `[BOOTSTRAP] {hash} — created project directory for {project-name}`

This ensures every known project has a wiki destination. Without it, project-specific knowledge gets stranded in the home wiki because there's nowhere to route it.

**0b. Route audit:**

1. Glob all `~/.remi/projects/*/wiki/*/overview.md`
2. For each entry, check routing against the rules in "Where Knowledge Goes" below
   - Project-specific topic in home wiki → **MIGRATE** to correct project wiki (or **DELETE** if already there)
   - Cross-project topic in project wiki → **MIGRATE** to home wiki
3. Delete empty README.md files (0 bytes)
4. Clean up legacy files (standalone `.md` in wiki root that aren't README.md, old `wiki.md` files)
5. After migrations, update README.md in both source and destination

Output: `[AUDIT:MIGRATE]`, `[AUDIT:DELETE]`, `[AUDIT:CLEANUP]` per action.

### Step 1: Scan Memory Sources

Glob scan `~/.remi/projects/` for all project directories. For each, check:
- `memory/entities/` — entity files
- `memory/from_*.md` — daily extraction files
- `memory/MEMORY.md` — summary file

Also scan personal memory at `~/.remi/memory/entities/` for cross-project entities (people, organizations, etc.).

### Step 2: Route, Analyze, and Plan

For each entity found:

1. **Route** — apply the rules from "Where Knowledge Goes" to pick the target wiki
2. **Dedup** — if routing to home wiki, verify the entity isn't already in a project wiki
3. **Count observations** — bullet points or distinct facts in the entity file
4. **Decide operation:**
   - ≥5 observations + no wiki entry → **CREATE**
   - Existing wiki with newer observations → **UPDATE** / **APPEND** / **DELETE** / **NOOP**
   - <5 observations → **NOOP** (not enough data yet)

### Step 3: Execute Operations

For each operation, verify claims by reading actual source files before writing (see "Code Facts First" below).

**CREATE:**
1. Create `wiki/{topic}/` directory
2. Write `overview.md` (L1) — verify against code, cite sources
3. Write `details.md` (L2) — full documentation with source citations
4. Update `README.md` (L0) — add one-line entry (create README.md only if this is the first entry)
5. Add `## Related` section with bidirectional cross-references to genuinely related wiki entries (dependency, migration, collaboration — not just shared tech stack). Update referenced entries to link back.

**UPDATE:**
1. Read current wiki content
2. Identify changes from new observations
3. Verify against code, remove stale content
4. Edit affected files
5. Update L0 if the one-liner needs adjustment
6. Check cross-references — add links for newly emerged relationships

**APPEND:** Add new verified content to `details.md`; check if `overview.md` needs updating.

**DELETE:** Remove stale content. If entire topic is obsolete, remove directory and L0 entry.

### Step 4: Legacy Cleanup

Scan for files outside L0/L1/L2 structure:
- Standalone `.md` files in wiki root (not README.md)
- Empty README.md files

Migrate valuable content to `{topic}/overview.md` + `{topic}/details.md`, delete the rest.

Exception: `directory-architecture.md` and similar design docs referenced by other systems may stay as standalone files.

### Step 5: Backlinks 章节维护（Obsidian 式）

对 `~/.remi/memory/entities/` 和 `~/.remi/projects/*/memory/entities/` 下每个 entity markdown 文件：

1. 调用 `mcp__remi-memory__backlinks({entity: "实体名"})`
2. 如果返回空（"暂无反向链接"）：
   - 若该文件已有 `## Backlinks` 章节 → 删除
   - 否则跳过
3. 如果返回入链列表：
   - 在文件末尾找 `## Backlinks`，有则完整替换内容，没有则在文件末追加一个新章节
   - 格式：
     ```markdown
     ## Backlinks
     - [[source-entity]] — "上下文片段..."
     - [[another-source]] — "另一段上下文..."
     ```
   - 按 source 字母序（稳定顺序便于 git diff）

每次操作输出 `[BACKLINKS] entity-name — N incoming links` 或 `[BACKLINKS:CLEAR] entity-name — removed stale section`。

**注意**：
- 只改动 `## Backlinks` 章节，不动文件其他部分
- Backlinks 章节始终放在文件最末尾
- Wiki 文件（wiki/ 下的 overview.md/details.md）暂不自动加 backlinks — 它们用 "## Related" 章节手动维护

### Step 6: Reference Check

Read `~/.remi/projects/-data00-home-hehuajie/wiki/directory-architecture.md` for canonical directory layout conventions.

---

## Where Knowledge Goes

Getting routing wrong causes duplication and confusion. These rules determine the target wiki for each piece of knowledge.

**Project wiki** (`~/.remi/projects/{project-hash}/wiki/`):
- That project's architecture, modules, tech stack, versions
- Project-specific decisions and conventions
- Project-specific collaboration roles

**Home wiki** (`~/.remi/projects/-data00-home-hehuajie/wiki/`):
- About Jack (preferences, habits, work style)
- Cross-project architectural decisions (e.g., directory-architecture)
- Knowledge that genuinely belongs to no single project

| Entity type | Wiki location | Why |
|---|---|---|
| person, organization, device, platform | Home wiki | Cross-project by nature |
| project, software | Corresponding project wiki | Project-specific |
| decision | Depends on scope | Project decision → project wiki; cross-project → home wiki |

**Example — correct vs wrong:**
```
# WRONG: project knowledge in home wiki
home/wiki/README.md: - **larkparser**: Python SDK...

# CORRECT: project knowledge in project wiki
-project-larkparser/wiki/README.md: - **larkparser**: Python SDK...
home/wiki/README.md: - **jack**: Remi creator...  (cross-project, about a person)
```

---

## L0/L1/L2 Structure

Each wiki topic has three layers of progressive detail:

| Layer | File | Size | Loaded |
|---|---|---|---|
| L0 | `README.md` | ~20 tokens/entry | Always (via CLAUDE.md symlink) |
| L1 | `{topic}/overview.md` | ~500 tokens | On demand |
| L2 | `{topic}/details.md` | Unlimited | On demand |

### L0 (README.md)

```markdown
# Project Wiki

- **remi**: Hub-and-spoke AI orchestrator, TypeScript/Bun, routes messages between connectors and providers.
- **larkparser**: Python SDK for converting Lark documents to Markdown, published on PyPI.
```

Each line: `- **{topic}**: {one-sentence, ~20 tokens}`

Only create README.md when there's at least one entry. Never create empty README.md files.

### L1 (overview.md)

Under ~500 tokens. Standard structure:

```markdown
# {Topic}

**What**: One-line description
**Stack**: Key technologies
**Status**: Active / Maintenance / Archived

## Architecture
Brief structural description.

## Key Components
- Component A — role
- Component B — role

## Related
- [related-topic](../related-topic/overview.md) — relationship description

## Sources
- `path/to/main/file`
- `entity/EntityName`
```

### L2 (details.md)

No size limit. Include detailed architecture with file paths, configuration, decision history (with dates and sources), integration points, known issues.

---

## Core Quality Rules

### Code Facts First

Memory observations are hints, not truth. Before writing any wiki claim about architecture, file paths, tech stack, or behavior, read the actual source files to verify.

Memory accumulates from conversations days or weeks old. Code changes faster than memory gets cleaned. Wiki that echoes stale memory is harmful because readers trust it.

### Traceable

Every knowledge claim cites its source in a `## Sources` section:
```
- Source: /data00/home/hehuajie/project/remi/src/core.ts
- Source: entity/Remi
- Source: from_2026_03_04.md
```

### Delete When Stale

Outdated wiki is worse than no wiki. When updating, actively check whether existing content is still valid. Remove invalid sections rather than appending corrections alongside them. Contradictory content in the same document destroys trust.

### Cross-References

Wiki entries don't exist in isolation. When creating or updating entries, add a `## Related` section with bidirectional links to genuinely related topics:

```markdown
## Related
- [lark-parser-ts](../lark-parser-ts/overview.md) — TS version, migrated from this project
- [knowledge-gateway](../knowledge-gateway/overview.md) — backend gateway, consumes this SDK
```

Only link real relationships: dependency, migration, collaboration, or architectural connection. Shared tech stack alone doesn't count. If A links to B, B should link back to A.

Use entity `related` fields in frontmatter as hints, but verify actual relationships.

---

## What Wiki Is NOT

- **Not an event stream** — "Deployed v2.0.3 on March 5" belongs in Memory. Wiki says "Current version: 2.0.3"
- **Not an implementation plan** — "Next steps: add caching" belongs in a plan file
- **Not a TODO list** — "Need to fix OAuth callback" belongs in issues/tasks
- **Wiki describes current state**: "The system uses JWT authentication" — not "We decided to switch to JWT"

---

## Output Format

After completing all operations, output a structured summary **followed by a natural-language daily report**.

The structured log lines come first (for machine parsing and audit trails), then a `--- 汇报 ---` marker, then 2-4 lines of plain Chinese summary for Jack to skim in Feishu.

```
## Wiki Curate Summary

[BOOTSTRAP] -data00-home-hehuajie-project-markone — created project directory for markone
[AUDIT:MIGRATE] home/larkparser → -project-larkparser/larkparser (project knowledge)
[AUDIT:DELETE] home/larkparser/ (duplicate after migration)
[AUDIT:CLEANUP] -project-foo/wiki/wiki.md (legacy, empty)
[CREATE] -project-remi/memory-v3 — L0+L1+L2 created, 3 cross-references added
[UPDATE] -project-larkparser/larkparser/overview.md — added v2.0.3 milestone, new collaborator
[APPEND] -project-remi/architecture/details.md — added agent framework section
[DELETE] home/old-topic — superseded by project wiki entry
[NOOP] 字节跳动 (3 observations) — below threshold
[NOOP] 45 other entities — below 5-observation threshold

--- 汇报 ---

今日 Wiki 维护：为 markone 新建了项目目录；larkparser 知识从 home 迁移到项目 wiki 并去重。
在 remi 下创建了 memory-v3 专题（L0+L1+L2），与 architecture 互相建立了引用。
larkparser 项目 overview 更新了 v2.0.3 发布节点和新协作者信息。
45 个实体 observations 不足 5 条，本轮跳过。
```

**汇报段写作规范**：
- 2-4 行中文，每行一个要点
- 重点：新建/迁移/删除/合并了什么，为什么（如果非显然）
- 不包含 [NOOP] 类的常规跳过统计（那些在日志段已有）
- 如果当天没有任何改动，汇报段写 "今日无新 entity 达到阈值，Wiki 保持稳定。"
- **必须保留 `--- 汇报 ---` 分隔符**，cron bridge 会扫描此标记并把后面的内容推送到 Feishu

If nothing needed:
```
[NOOP] — All Wiki entries are current, no new entities meet the threshold.

--- 汇报 ---

今日无新 entity 达到阈值，Wiki 保持稳定。
```
