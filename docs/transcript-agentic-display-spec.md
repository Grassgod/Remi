# Transcript Agentic Display Spec

Display support for agentic features in the task transcript (web dialog + Feishu card):
Workflow steps, Claude subagent nesting, and Codex collab (subagent) delegation steps.

Status: **approved design, pending build**. Batches ship independently in order
P1 → P1.5 → P2. Each batch has its own acceptance gate; a later batch never
blocks deploying an earlier one.

---

## 1. Background — verified data facts (2026-08-03)

| Feature | What actually arrives downstream today | Verified how |
|---|---|---|
| Plan | Fully supported (daemon `type:"plan"` + dialog Plan section) | shipped |
| Workflow (Claude) | TS Agent SDK ≥0.3.149 has the `Workflow` tool; fleet bridge bundles SDK **0.3.202**, so it can occur. Renders today as a generic wrench card with raw JSON. | SDK docs + `~/.remi/acp/node_modules` on cn-10-37-66-8 |
| Claude subagent | `Agent` tool_call forwarded; the subagent's **inner tool calls arrive flat and unattributed** in the top-level stream; subagent prose dropped by the bridge. SDK itself emits `parent_tool_use_id` but claude-agent-acp does not forward it. | fixture `agent-spawn-notifications-*.json` + bridge dist |
| Codex subagent | codex-cli 0.145.0 (subagents GA 2026-03). codex-acp 1.1.0 **forwards** `collabAgentToolCall` as ACP tool_call: `kind:"other"`, `title` = collab tool name, `rawInput = { prompt, senderThreadId, receiverThreadIds, agentsStates, status }`. It **drops** `subAgentActivity` (subagent inner activity) entirely. | codex-acp dist on cn-10-37-66-8 |
| Agent team (Claude) | Experimental, env-gated (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), not an SDK capability. Will not occur on the fleet. | official docs |

Consequences the design accepts (see §7 Non-goals):
- Subagent *inner prose* (Claude) and *inner activity* (Codex) are unrecoverable
  without upstream bridge changes.
- Claude inner tool calls can only be attributed heuristically (daemon-side);
  Codex delegation calls carry real topology (`receiverThreadIds`).

## 2. Scope

**In:** P1 (Workflow card + Agent report rendering), P1.5 (Codex collab fixture
+ delegation card), P2 (Claude subagent nesting). Web dialog and Feishu card
formatters both.

**Out (follow-ups, not this build):** per-subagent swimlanes grouped by
`receiverThreadId` (C2); upstream issues asking claude-agent-acp to forward
`parent_tool_use_id` and codex-acp to forward `subAgentActivity` (C3/P3);
agent-team display; virtualization.

No DB schema change in any batch — `meta` JSON column (Batch 2 of
transcript-enrichment) carries everything new.

---

## 3. Batch P1 — Workflow step card + Agent report rendering

Frontend + Feishu formatters only. No daemon change, no version bump.

### 3.1 Workflow formatter (web)

`frontend/packages/views/common/task-transcript/tool-summaries.ts`:

- `ICONS["Workflow"] = Workflow` (lucide icon of that name).
- `FORMATTERS["Workflow"]`: summary is, in priority order:
  1. `str(input.name)` (named workflow invocation),
  2. the workflow name parsed from `input.script` via
     `/export\s+const\s+meta\s*=\s*{[^}]*?name:\s*['"]([^'"]+)['"]/` (regex on
     the first ~2KB only; scripts can be 500KB),
  3. basename of `str(input.scriptPath)`,
  4. `"workflow"`.
  Prefix the summary with nothing (icon already disambiguates); truncate at MAX.

### 3.2 Workflow detail view (web)

In `agent-transcript-dialog.tsx` step detail: when `tool === "Workflow"` and
`input.script` is a string, render the script as a monospace code block
(`whitespace-pre-wrap`, same styling family as the existing diff/output panes)
instead of embedding it in the raw-JSON `<pre>`. Remaining input keys
(`args`, `resumeFromRunId`, …) keep the JSON rendering below the script block.
A running Workflow step must show live elapsed time — verify the existing
running-step elapsed display applies (workflow runs are minutes-long; a bare
spinner reads as hung). Fix only if it doesn't apply; do not rebuild it.

### 3.3 Agent step report rendering (web)

Agent steps' `output` is the subagent's final report (often Markdown). In the
step detail pane, when `tool === "Agent"` (or legacy `"Task"`), render `output`
through the existing Markdown component (introduced in transcript B1) instead
of plain text. Other tools keep plain/pre rendering.

### 3.4 Feishu parity

`packages/connectors/src/feishu/tool-formatters.ts`: add `Workflow` to
`TOOL_ICONS` + a one-line summary formatter with the same priority chain as
§3.1 (shared regex logic may be duplicated — the two files are already
intentionally parallel; keep the comment noting the duplication, as the file
header already does).

### 3.5 Acceptance (P1)

- Unit tests for the summary priority chain (name / script-meta / scriptPath /
  fallback) in both the views test and `tests/unit/connectors/feishu-tool-formatters.test.ts`.
- Four-locale parity for any new UI strings (`locales/parity.test.ts`).
- `bun run tests/replay-coverage.ts` no regression.
- Deploy: web rebuild only (+ server restart to pick up Feishu formatter
  whenever the next server deploy happens; not urgent on its own).

---

## 4. Batch P1.5 — Codex collab: fixture first, then the delegation card

### 4.1 C0 — capture a real collab fixture (gate for C1 merge)

Owner: orchestrator (not Opus). Procedure:

1. On a fleet machine, confirm whether codex-cli 0.145.0 needs a config flag to
   enable subagents/collab (check `codex config` docs / `~/.codex/config.toml`
   feature flags). Record the answer in this spec (§4.4).
2. Dispatch a task to a codex agent that instructs it to delegate to ≥2
   subagents in parallel.
3. Capture the ACP notification frames into
   `tests/fixtures/acp/codex-collab-notifications-<ts>.json` (same format as
   the existing `bash-exec-notifications-*.json`).
4. Record in §4.4: the actual `title` values of collab tool calls (spawn /
   send / wait verbs), whether `agentsStates` updates stream during the run,
   and what the terminal frame carries.

C1 formatter must key off the **observed** names, not guessed ones. If collab
cannot be triggered through the app-server path at all, C1 is dropped and this
spec is amended — do not ship an untestable formatter.

### 4.2 C1 — delegation step card (web + Feishu)

Known from the adapter (verified): `resolveToolName` normalizes `spawn_agent`
→ `Agent`, so spawn steps reuse the Agent icon/semantics. Other collab verbs
(names TBD by C0) pass through raw and today hit the generic fallback — which
picks the first short string field, i.e. a bare `senderThreadId`. That is the
main bug this batch fixes.

- `tool-summaries.ts` + Feishu `tool-formatters.ts`:
  - Detect a collab input by shape (`prompt` + `receiverThreadIds` present) —
    robust across verb names; per-verb naming refined after C0.
  - Summary: `→ N agents · "<first line of prompt>"` for delegation verbs;
    for wait/status verbs summarize `agentsStates` as counts
    (e.g. `2 running · 1 done`).
  - Never emit thread ids in the one-line summary.
- Web detail pane: `prompt` rendered as Markdown; `agentsStates` rendered as
  status chips (state → existing status-color tokens); receiver thread ids in
  a muted monospace list at the bottom.
- The card states the ceiling explicitly: a muted caption line ("内部过程不可
  见" / localized) when the step is a collab delegation — do not pretend the
  transcript is complete.

### 4.3 Acceptance (P1.5)

- Replay of the C0 fixture renders delegation cards (manual visual check via
  `bun run tests/manual/replay-fixture.ts codex-collab-…` for the Feishu side;
  vitest snapshot/behavior tests for the web side).
- Unit tests: collab shape detection, summary for delegation + wait verbs,
  thread-id never in summary. Locale parity for the caption strings.
- Deploy: same as P1 (web rebuild + server restart).

### 4.4 C0 findings (captured 2026-08-06, cn-10-37-66-8)

Fixture: `tests/fixtures/acp/codex-collab-notifications-1786010059380.json`
(87 frames; 2× spawnAgent + 2× wait, prompt "two subagents, one haiku each").

- **Config gating: yes.** Collab requires `multi_agent = true` under
  `[features]` in `~/.codex/config.toml` (default off — the fleet currently
  has it OFF, which is why production has never emitted collab events).
  Enabling it fleet-wide is a separate rollout decision, not part of C1.
- **The bridge runs its bundled codex 0.142.5** (daemon never sets
  `CODEX_PATH`), which post-dates the subagents GA (~0.133) — capability
  confirmed live on the production bridge path.
- **Observed tool titles:** `spawnAgent` and `wait` (camelCase). The adapter's
  `titleToToolName("spawnAgent")` normalizes to **`Agent`**; `wait` passes
  through as raw `wait`. Send/close verbs did not occur in this run — the
  shape check below covers them anyway.
- **Shape discriminator:** every collab rawInput carries `senderThreadId`
  (string) + `receiverThreadIds` (array). `prompt` is `null` on `wait`, so do
  NOT use prompt presence for detection — use
  `senderThreadId + Array.isArray(receiverThreadIds)`.
- **Lifecycle:** `spawnAgent` completes immediately (fire-and-forget): initial
  frame has empty `receiverThreadIds`/`agentsStates`; its terminal frame
  carries the new thread id + `{status: "pendingInit"}`. Results come back on
  `wait`: the terminal `wait` frame's `agentsStates[threadId].message` holds
  the **subagent's final answer verbatim**. A single `wait` may complete with
  a subset of receivers (codex re-waits per agent).
- **agentsStates.status values observed:** `pendingInit`, `completed` (treat
  unknown values as a generic in-progress chip). `rawInput.status` is
  camelCase (`inProgress`/`completed`) — distinct from the ACP frame `status`.
- **No rawOutput/content on any collab frame** ⇒ the daemon maps everything
  into the step's `input` (merge semantics), and `output` stays empty. C1 must
  render results from `input.agentsStates[*].message`, not from `output`.
- **No subagent inner activity arrived** — confirms `subAgentActivity` is
  dropped by the bridge in a live run, not just in code reading.

C1 amendments implied by the above: detection by `senderThreadId` shape;
`wait` steps render agentsStates messages as the result body (Markdown per
message, one block per thread); `spawnAgent` steps reuse the Agent icon with
the prompt summary (already works via `FORMATTERS.Agent` reading `prompt`);
`wait` gets its own icon + count summary.

### 4.5 Production verification addenda (2026-08-06, v0.2.22)

- **Third collab verb observed live: `closeAgent`** (not in the C0 fixture).
  Same rawInput shape, and its terminal frame repeats the closed agent's
  final `message` — the shape-based detection covers it with no code change.
- **Pre-existing fleet blocker found and fixed (v0.2.22, b3a722e6):** every
  codex session died at startup with `-32602` because
  `resolveAvailableAcpPermissionMode` passed claude-flavored mode ids
  (`bypassPermissions`) to `session/set_mode`, which codex-acp validates
  against its advertised modes (`read-only`/`agent`/`agent-full-access`).
  The resolver now maps to the closest advertised mode and skips the call
  when nothing matches. Unrelated to this spec's batches, but it gated every
  codex smoke.
- **Coverage is path-dependent (MUL-23, multi_agent enabled fleet-wide):** when
  codex spawns subagents one-per-call, spawns surface as `collabAgentToolCall`
  and the cards render (MUL-20). When it batch-spawns in one shot, the spawn
  events ride `subAgentActivity` — which the bridge drops — and the transcript
  shows only an empty `wait` card while the answers still reach the final
  reply. Raises the priority of the upstream codex-acp issue (§7).
- End-to-end confirmed on the fleet: `wait`/`closeAgent` tool_results carry
  `input.agentsStates` with verbatim subagent answers (P2.5 path), and claude
  subagent steps carry `meta.parent_tool_call_id` (P2 path).

---

## 5. Batch P2 — Claude subagent nesting

Daemon change ⇒ **version bump + fleet reinstall**. Frontend degrades cleanly
for old rows (no `meta.parent_tool_call_id` → flat, exactly today's display).

### 5.1 Daemon attribution (`packages/server/src/worker/daemon.ts`)

In `createEventMapper` / `mapToolEvent` (the per-session stateful mapper):

- `ToolCallState` gains `parentToolCallId?: string`, decided **once, at state
  creation** (first event for a given toolCallId) and immutable after:
  - Candidate parents: entries in `tools` whose `name` is `"Agent"` or
    `"Task"` (legacy) and whose `status` is non-terminal
    (`!TERMINAL_TOOL_STATUS.has(status)`), excluding the new call's own id.
  - Attribute **only when exactly one** candidate is open. Zero or ≥2 open
    Agents (parallel/background subagents) → no attribution. Wrong nesting is
    worse than no nesting.
  - Calls whose own resolved name is `Agent`/`Task` are never attributed
    (nested agent spawns stay top-level).
- Every emission for an attributed call (both the `tool_use` and the
  `tool_result`) carries `meta.parent_tool_call_id = state.parentToolCallId`.
- No other behavior changes; the Bash placeholder/merge logic (v0.2.20) is
  adjacent — the guard tests in
  `tests/unit/multiremi/multiremi-task-message-mapper.test.ts` must stay green
  untouched.

Known accepted error mode: while an Agent runs in the foreground, the claude
bridge cannot interleave parent-originated tool calls, so the time-window rule
holds on the main path (fixture-verified); `run_in_background` subagents
violate the "exactly one open" precondition and correctly fall back to flat.

### 5.2 Frontend nesting (`build-timeline.ts` + dialog)

- `TranscriptEntry` step variant gains `children?: TranscriptEntry[]`.
- New pure function `nestEntries(entries)`: a step whose
  `meta.parent_tool_call_id` matches another step's `toolCallId` moves into
  that step's `children` (chronological order preserved). Unknown parent id →
  stays top-level (fail open). Applied after `buildEntries`.
- Dialog rendering: Agent steps with children render a collapsible group —
  header keeps the current Agent card (description summary, status, duration)
  plus a `N steps` count badge; expanded body indents children one level with
  a left rail, then the Agent report (§3.3 Markdown) at the bottom.
  Collapsed by default; auto-expand while the Agent step is running and the
  dialog is in live-follow mode.
- Timeline color-bar navigation and the filter/copy-all features must count
  children inside the parent's segment (verify both; the copy-all output keeps
  chronological flat order with indentation).

### 5.3 Acceptance (P2)

- Mapper unit tests (same file as the Bash guards): single open Agent →
  attributed on use **and** result; two open Agents → none; after Agent
  terminal → none; Agent-named call never attributed; attribution decided at
  first event only.
- `nestEntries` unit tests incl. unknown-parent fail-open and ordering.
- Replay `agent-spawn-notifications-1777954686821.json` end-to-end: the
  subagent's Glob nests under the Agent step.
- Real dispatch on the fleet after reinstall: one claude task that spawns a
  subagent; verify nesting in the web dialog live view and after completion.
- Deploy: bump root `package.json` (next patch), `chore(release): vX.Y.Z`,
  `bun run build:multiremi`, reinstall Linux agents (Mac if tunnel up), server
  restart + web rebuild per the runbook.

---

## 6. Cross-cutting rules

- **Redaction**: `meta` is already redacted recursively in `buildTimeline`
  (`redactValue`) — new meta keys and collab prompts inherit it. No bypass.
- **i18n**: every new user-visible string lands in all four locales in the same
  PR (`locales/parity.test.ts` enforces).
- **Enum/shape drift**: all new frontend reads are optional-chained with
  fallbacks (`parseWithFallback` doctrine); a malformed `agentsStates` or a
  missing `meta` renders the generic card, never crashes.
- **Old data**: no backfill anywhere. Rows predating each batch render exactly
  as they do today.
- **Comments**: English only (repo rule), and only where the code can't say it.

## 7. Non-goals / known ceilings (state these in UI where §4.2 says so)

- Claude subagent inner prose and Codex `subAgentActivity` never reach us —
  nesting shows tool steps (Claude) or delegation+states (Codex), not the
  subagent's full narrative. Fix path is upstream (C3/P3), out of scope.
- Parallel / background subagents are not nested (deliberate).
- Agent-team events have no dedicated rendering (cannot occur on the fleet).

## 8. File ownership

| File | Batch | Change |
|---|---|---|
| `frontend/packages/views/common/task-transcript/tool-summaries.ts` | P1, C1 | icons + formatters |
| `frontend/packages/views/common/task-transcript/agent-transcript-dialog.tsx` | P1, C1, P2 | script block, Agent/collab detail, nested group rendering |
| `frontend/packages/views/common/task-transcript/build-timeline.ts` | P2 | `children` + `nestEntries` |
| `frontend/packages/views/locales/*` | all | new strings ×4 |
| `packages/connectors/src/feishu/tool-formatters.ts` | P1, C1 | icons + summaries |
| `packages/server/src/worker/daemon.ts` | P2 | attribution in mapper |
| `tests/unit/multiremi/multiremi-task-message-mapper.test.ts` | P2 | attribution guards |
| `tests/unit/connectors/feishu-tool-formatters.test.ts` | P1, C1 | formatter guards |
| `tests/fixtures/acp/codex-collab-notifications-*.json` | C0 | new fixture |
