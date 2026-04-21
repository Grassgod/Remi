---
name: memory-audit
description: >
  Unified nightly memory maintenance agent. Runs at 03:00 daily.
  Extracts missed facts from yesterday's daily notes, audits entity quality,
  compresses old logs, prunes MEMORY.md index, cleans up old files,
  and generates an operations report for Jack.
  This skill is NOT user-invocable — it is triggered by a daily cron job.
---

# Memory Audit Agent (Unified)

You are running as the unified memory maintenance agent at 03:00 nightly.
This agent consolidates ALL memory maintenance into one pass:
- Fact extraction from daily notes (formerly compaction)
- Entity quality audit (merge, delete, fill, score)
- Log compression and file cleanup (formerly cleanup builtin)
- MEMORY.md index pruning
- Operations report

## Tools Available

- **MCP memory tools**: `mcp__remi-memory__recall`, `mcp__remi-memory__remember`
- **File tools**: `Read`, `Write`, `Edit`, `Glob`, `Grep`

## Scan Scope

Audit these locations in order:

1. `~/.remi/memory/daily/` — daily journal logs (start here for SUPPLEMENT)
2. `~/.remi/memory/entities/` — all personal entity files
3. `~/.remi/memory/MEMORY.md` — global memory index
4. `~/.remi/projects/*/memory/` — per-project auto-memory

Before starting, read `~/.remi/projects/-data00-home-hehuajie/wiki/directory-architecture.md` to understand the full directory design.

## Phase 1: SUPPLEMENT — Extract missed facts from yesterday

This phase replaces the old `builtin:compaction` handler. The goal is to catch facts that `memory-extract` (the real-time agent) missed.

1. Compute yesterday's date
2. Read `~/.remi/memory/daily/{YYYY-MM-DD}.md`
3. If file is missing or under 50 chars, skip to Phase 2
4. Scan ALL entity files via `Glob ~/.remi/memory/entities/**/*.md`
5. Compare daily notes against existing entities — identify NEW facts not yet captured:
   - Decisions made
   - People information learned
   - Status changes on projects
   - New tools/software encountered
6. For each new fact:
   - If an entity exists for the subject → append observation via `Edit`
   - If no entity exists → create via `Write` with proper YAML frontmatter
7. **Do NOT append `## From {date}` sections to MEMORY.md** — this caused the bloat problem
8. Append a one-line summary to `~/.remi/memory/.conversation_summary.md`:
   ```
   ## YYYY-MM-DD
   Brief 1-line summary of key events
   ```

Output: `[SUPPLEMENT] entity-name — extracted: "observation"`

## Phase 2: MERGE — Deduplicate observations

Scan entity files for observations that describe the same underlying fact using different words or from different dates. Merge them into a single, cleaner observation. Remove the duplicates.

**Judgment criteria**: Two observations are duplicates if removing either one would not lose any information. If they contain complementary details, combine them into one richer observation rather than picking a winner.

Output: `[MERGE] entity-name — merged N observations about X`

## Phase 3: DELETE — Remove expired or superseded facts

Identify facts that are no longer true (e.g., a version number that has since been bumped, a decision that was reversed, a temporary state that has passed). **Before deleting anything**, back up the affected file to a `.versions/` directory alongside the original. If you are uncertain whether a fact is still valid, do NOT delete it — instead emit `[REVIEW]` and move on.

Output: `[DELETE] entity-name — field — reason (backed up to .versions/)`

## Phase 4: FILL_SUMMARY — Generate missing summaries

Find entity files whose YAML frontmatter has an empty or missing `summary` field. Read the entity's observations and generate a concise one-line summary (under 120 characters) that captures what this entity is and why it matters.

Output: `[FILL_SUMMARY] entity-name — "the generated summary"`

## Phase 5: UPDATE_IMPORTANCE — Score entities

For each entity, assign an `importance` score between 0.0 and 1.0 based on:
- **Content significance**: Is this a core project, key person, or critical decision? (higher)
- **Access frequency**: Has this entity been referenced or updated recently? (higher)
- **Staleness**: Has this entity not been touched in weeks? (lower)

Emit a log line only when the score changes.

Output: `[UPDATE_IMPORTANCE] entity-name — 0.3 → 0.7`

## Phase 6: COMPRESS — Compact old daily logs

For daily logs in `~/.remi/memory/daily/`:
- Files **8-30 days old**: merge into weekly summary files (`weekly-YYYY-WNN.md`). Each weekly summary preserves key events and decisions but removes routine noise. Move originals to `.versions/`.
- Weekly files **>30 days old**: move to `daily/archive/` directory (create if needed).

Output: `[COMPRESS] daily/2026-02-01.md..2026-02-07.md → daily/weekly-2026-W05.md`

## Phase 7: PRUNE_INDEX — Keep MEMORY.md under 200 lines

This phase solves the MEMORY.md bloat problem (currently 683 lines, target <200).

1. Read `~/.remi/memory/MEMORY.md`
2. Count total lines
3. If under 200 lines, skip this phase
4. Identify all `## From` sections (e.g., `## From 2026-03-03`, `## From Claude Code (...)`)
5. Sort by date, oldest first
6. Starting from oldest, for each section older than 7 days:
   a. Extract section content (from `##` header to next `##` or EOF)
   b. Archive to `~/.remi/memory/compaction-archive/YYYY-MM.md` (create if needed, append)
   c. Remove the section from MEMORY.md
   d. Stop when MEMORY.md is under 200 lines
7. After pruning, ensure this line exists at the bottom of core content:
   `> 历史提取记录已归档至 compaction-archive/ 目录`

Output: `[PRUNE] MEMORY.md — archived N sections (XXX → YYY lines)`

## Phase 8: CLEANUP — Remove old files

1. **Daily logs**: List files in `~/.remi/memory/daily/` — delete `.md` files whose date is >30 days ago (already compressed in Phase 6). Skip `weekly-*` and `archive/`.
2. **Version backups**: List files in `~/.remi/memory/.versions/` — sort by modification time, keep newest 50, delete the rest.

Output: `[CLEANUP] removed N dailies, M versions`

## Phase 9: UNLINKED_MENTIONS — Detect and fix missing wikilinks (Obsidian-style)

Many entity files contain plain-text references to other entities that should be `[[wikilinks]]`. This phase scans for them and fixes high-confidence cases, reports ambiguous ones.

### Detection algorithm

1. Build a lookup table from the in-memory index:
   - For each entity: `{ name, aliases }` → `canonicalName`
   - Only include entities with name length ≥ 3 (avoid false positives on short names like "X")
2. For each markdown file in `~/.remi/memory/entities/**/*.md`, `~/.remi/memory/daily/*.md`, and `~/.remi/memory/MEMORY.md`:
   a. Read content
   b. Remove code blocks (\`\`\`...\`\`\` and indented code)
   c. Remove YAML frontmatter (between `---` markers)
   d. Remove content already inside `[[...]]`
   e. Scan remaining text for word-boundary matches of entity names/aliases
3. For each match, check:
   - Is the match inside a URL (http://, file://)? → skip
   - Is the match in a heading? → skip (don't edit headings)
   - Is the match in the `## Backlinks` section? → skip (that section is managed by wiki-curate)

### Auto-fix rules (high confidence only)

Replace plain-text occurrence with `[[canonical-name]]` when ALL of these hold:
- ✅ The matched string is the **exact canonical name** (not an alias)
- ✅ The match is NOT in a URL, heading, or code
- ✅ The entity name is unambiguous (not a common word like "Remi" when "remi" could also mean the agent/tool context)

**Do NOT auto-fix** (report as `[UNLINKED]`) when:
- ❌ Match is an alias (might refer to a different entity)
- ❌ Entity name also matches a common word in context
- ❌ Match is in a Chinese sentence where segmentation is ambiguous

### Output

- `[LINK_FIX] file-path — auto-linked N mentions of "entity-name"` — high confidence replacements done
- `[UNLINKED] file-path:Line — "plain-text" could link to [[entity-name]] (reason: ambiguous alias / CJK context)` — manual review needed

### Constraints

- **Idempotent**: running twice should produce zero new fixes on the second run
- **Do not touch wiki/ directory** — that's wiki-curate's responsibility
- **Do not modify `## Backlinks` sections** — also wiki-curate's territory
- **Batch by file**: one pass per file, write back once

## Phase 10: REPORT — Summarize yesterday's operations

1. Use `Glob` to find all log files in `~/.remi/agents/*/runs/` from yesterday
2. Also check `~/.remi/cron/runs/*.jsonl` for yesterday's cron job logs
3. Read each log file to understand what happened
4. Synthesize a natural language narrative that:
   - Jack can read and understand in ~10 seconds
   - Narrates context and causality, not just statistics
   - Mentions which agents ran, what they accomplished, any errors or notable events
   - Includes approximate total duration

## Output Format

Emit all actions first, then the report:

```
[SUPPLEMENT] entity-name — extracted: "observation"
[MERGE] entity-name — merged N observations about X
[DELETE] entity-name — field — reason (backed up to .versions/)
[FILL_SUMMARY] entity-name — "the generated summary"
[UPDATE_IMPORTANCE] entity-name — 0.3 → 0.7
[COMPRESS] daily/2026-02-01.md..2026-02-07.md → daily/weekly-2026-W05.md
[PRUNE] MEMORY.md — archived N sections (683 → 180 lines)
[CLEANUP] removed N dailies, M versions
[LINK_FIX] entities/people/Alice-Chen.md — auto-linked 3 mentions of "Remi"
[UNLINKED] daily/2026-04-18.md:12 — "Alice" could link to [[Alice-Chen]] (ambiguous alias)
[REVIEW] entity-name — uncertain: reason

--- 汇报 ---

（Natural language summary of yesterday's agent operations, written for Jack to skim in 10 seconds）
```

## Constraints

- **Never delete without backup.** Every DELETE and COMPRESS must write to `.versions/` first.
- **When uncertain, mark for review.** Use `[REVIEW]` instead of `[DELETE]`.
- **Be conservative with MERGE.** Only merge when you are confident no information is lost.
- **Idempotent.** Running the audit twice should not produce duplicate actions.
- **No user interaction.** This runs unattended. Do not ask questions — make your best judgment or mark for review.
- **No MEMORY.md append.** Never add `## From` sections to MEMORY.md. Entity files are the canonical store.
