---
name: memory-extract
description: >
  Analyze conversation transcripts and extract facts worth remembering into Remi's memory system
  using Smart Write (ADD/UPDATE/DELETE/NOOP). This skill is NOT user-invocable — it is triggered
  by BunQueue worker after conversations end. Use this skill whenever processing a transcript
  for memory extraction, daily log summarization, or knowledge persistence.
compatibility:
  requires:
    - mcp__remi-memory__recall
    - mcp__remi-memory__remember
---

# Memory Extract

You receive a conversation transcript. Your job: identify facts worth long-term storage, check existing memory for duplicates/conflicts, then write changes using Smart Write operations.

## Workflow

1. **Read the transcript** — scan for decisions, people info, status changes, new entities, and explicit "remember this" requests.
2. **Recall existing memory** — use `mcp__remi-memory__recall` to check if extracted facts already exist or conflict with stored knowledge.
3. **Execute Smart Write** — for each fact, decide the operation:
   - **ADD**: New fact or entity not in memory. Use `mcp__remi-memory__remember` to create.
   - **UPDATE**: Existing entity has changed (status, preference, new detail). Use `mcp__remi-memory__remember` to append the new observation.
   - **DELETE**: Information is expired, superseded, or explicitly retracted. Log for manual cleanup (MCP has no delete — note it in output).
   - **NOOP**: Information exists and hasn't changed, or isn't worth remembering.
4. **Output a summary** of all operations performed.

## What to Record

These categories are worth persisting — they represent knowledge that future sessions need:

- **Decisions and architecture changes** — "We decided to use X instead of Y", "Migrated from A to B"
- **People info** — preferences, roles, relationships, birthdays, work locations, habits
- **Status changes** — travel plans, project milestones, phase transitions, launches
- **Explicit requests** — anything the user says "remember", "note this", "don't forget"
- **New entities** — tools, software, projects, organizations encountered for the first time with meaningful context
- **Preferences and workflows** — how the user likes things done, recurring patterns

## What NOT to Record

These are either too ephemeral, already captured elsewhere, or too granular:

- **Debugging details** — stack traces, error messages, temporary workarounds tried during a session
- **Code-level changes** — file edits, refactors, variable renames (CC auto-memory handles these per-project)
- **Already captured in real-time** — if a `mcp__remi-memory__remember` call was made during the conversation for the same fact, don't duplicate it
- **Pure Q&A** — "How do I use useState?" or "What's the syntax for X?" — these are reference lookups, not persistent knowledge
- **Transient context** — "I'm looking at file X right now", "Let me check this"

## Multi-Project Routing

Each fact needs the right scope. The rule is simple:

| Content | scope | cwd |
|---------|-------|-----|
| People, organizations, cross-project decisions | `personal` | not needed |
| Project-specific architecture, config, conventions | `project` | required — use the project's root path |

When the transcript involves a specific project (identifiable by cwd or explicit mention), route project-specific facts with `scope=project` and provide the cwd. When in doubt, prefer `personal` — it's always accessible.

Refer to `~/.remi/projects/-data00-home-hehuajie/wiki/directory-architecture.md` for the full directory layout:
- Personal entities → `~/.remi/memory/entities/{type}/`
- Project memory → `~/.remi/projects/{hash}/memory/`
- Home hash memory/ is a symlink → `~/.remi/memory/` (so personal and home are unified)

## Entity Naming

- Use consistent names: check existing entities via `recall` before creating new ones
- People: use their real name (e.g., "周昱萱", "贺华杰"), not aliases
- Projects/software: use the canonical name (e.g., "larkparser", "Remi"), lowercase for project names
- Avoid creating near-duplicate entities — if "LarkParser" exists, don't create "lark_parser"

## Output Format

After processing, output one line per operation:

```
[ADD] target (type) — content description
[UPDATE] target — content description
[DELETE] target — reason for removal
[NOOP] — reason skipped
```

If nothing in the transcript is worth remembering:

```
[SKIP] 本次对话无需记忆更新
```

## Quality Guidelines

- **Be selective** — a good extraction finds 0-5 facts per conversation. Most conversations don't produce memorable facts. Outputting `[SKIP]` is perfectly fine and expected for routine coding sessions.
- **Be precise** — record what was actually decided/said, not what was discussed. "Discussed switching to Postgres" is not memorable; "Decided to switch to Postgres, migration planned for next week" is.
- **Be concise** — observations should be one sentence. The memory system stores observations as append-only notes on entities; keep them scannable.
- **Deduplicate aggressively** — always `recall` before `remember`. If the fact is already stored in equivalent form, emit NOOP.
