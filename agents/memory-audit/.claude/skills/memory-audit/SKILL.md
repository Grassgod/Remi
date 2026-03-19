---
name: memory-audit
description: >
  Periodically audit the entire Remi memory system for quality and generate a daily operations report.
  This skill is NOT user-invocable — it is triggered by a daily cron job at 03:30.
  When invoked, perform a full audit (merge, delete, fill, score, compress) across all memory directories,
  then summarize all agent operation logs from yesterday into a readable narrative report for Jack.
---

# Memory Audit

You are running as the memory-audit agent. Your job has two parts:
1. **Audit** — scan and maintain the health of the entire memory system
2. **Report** — read yesterday's agent logs and produce a 10-second natural language summary

## Tools Available

- **MCP memory tools**: `mcp__remi-memory__recall`, `mcp__remi-memory__remember`
- **File tools**: `Read`, `Write`, `Edit`, `Glob`

## Scan Scope

Audit these locations in order:

1. `~/.remi/memory/entities/` — all personal entity files
2. `~/.remi/memory/MEMORY.md` — global memory index
3. `~/.remi/memory/daily/` — daily journal logs
4. `~/.remi/projects/*/memory/` — per-project auto-memory

Before starting, read the directory architecture doc at `~/.remi/projects/-data00-home-hehuajie/wiki/directory-architecture.md` to understand the full directory design and any recent structural changes.

## Audit Operations

Perform each operation type in the order listed. For each action taken, emit a log line in the output format described below.

### 1. MERGE — Deduplicate observations

Scan entity files for observations that describe the same underlying fact using different words or from different dates. Merge them into a single, cleaner observation. Remove the duplicates.

**Judgment criteria**: Two observations are duplicates if removing either one would not lose any information. If they contain complementary details, combine them into one richer observation rather than picking a winner.

### 2. DELETE — Remove expired or superseded facts

Identify facts that are no longer true (e.g., a version number that has since been bumped, a decision that was reversed, a temporary state that has passed). **Before deleting anything**, back up the affected file to a `.versions/` directory alongside the original. If you are uncertain whether a fact is still valid, do NOT delete it — instead emit `[REVIEW] target — reason` and move on.

### 3. FILL_SUMMARY — Generate missing summaries

Find entity files whose YAML frontmatter has an empty or missing `summary` field. Read the entity's observations and generate a concise one-line summary (under 120 characters) that captures what this entity is and why it matters.

### 4. UPDATE_IMPORTANCE — Score entities

For each entity, assign an `importance` score between 0.0 and 1.0 based on:
- **Content significance**: Is this a core project, key person, or critical decision? (higher)
- **Access frequency**: Has this entity been referenced or updated recently? (higher)
- **Staleness**: Has this entity not been touched in weeks? (lower)

Emit a log line only when the score changes.

### 5. COMPRESS — Compact old daily logs

For daily logs older than 30 days, compress them into weekly summary files. Each weekly summary should preserve the key events and decisions from that week but remove routine noise. Name the output file by week range (e.g., `2026-W08.md`). The original daily files are moved to `.versions/` (not deleted outright).

## Agent Log Report

After completing all audit operations, generate the daily operations report:

1. Use `Glob` to find all log files in `~/.remi/agents/*/runs/` from yesterday
2. Read each log file to understand what each agent did
3. Synthesize a natural language narrative that:
   - Jack can read and understand in ~10 seconds
   - Narrates context and causality, not just statistics
   - Mentions which agents ran, what they accomplished, any errors or notable events
   - Includes approximate total token/cost if available in the logs

## Output Format

Emit all audit actions first, then the report, using this exact structure:

```
[MERGE] entity-name — merged N observations about X
[DELETE] entity-name — field — reason (backed up to .versions/)
[FILL_SUMMARY] entity-name — "the generated summary"
[UPDATE_IMPORTANCE] entity-name — 0.3 → 0.7
[COMPRESS] daily/2026-02-01.md..2026-02-07.md → daily/2026-W05.md
[REVIEW] entity-name — uncertain: reason

--- 汇报 ---

（Natural language summary of yesterday's agent operations, written for Jack to skim in 10 seconds）
```

## Constraints

- **Never delete without backup.** Every DELETE and COMPRESS must write to `.versions/` first.
- **When uncertain, mark for review.** Use `[REVIEW]` instead of `[DELETE]`.
- **Be conservative with MERGE.** Only merge when you are confident no information is lost.
- **Idempotent.** Running the audit twice should not produce duplicate actions.
- **No user interaction.** This runs unattended at 03:30. Do not ask questions — make your best judgment or mark for review.
