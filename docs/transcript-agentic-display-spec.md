# Transcript Agentic Display Spec

Display support for agentic features in the task transcript (web dialog, Chat
steps, Feishu card): Claude subagent nesting and Codex collab (subagent)
delegation steps.

Status: **shipped, then rebuilt on turn + items traces (PR 2).** The fragment-era
implementation this spec planned (`tool-summaries.ts`, `build-timeline.ts`,
`nestEntries`, the daemon event mapper and its `meta.parent_tool_call_id`) is
gone. What stays here is the verified bridge behaviour that still bounds what
the display can show, and where the current code shows it.

---

## 1. Background — verified data facts (2026-08-03)

| Feature | What actually arrives downstream today | Verified how |
|---|---|---|
| Plan | Fully supported (daemon `type:"plan"` + dialog Plan section) | shipped |
| Workflow (Claude) | TS Agent SDK ≥0.3.149 has the `Workflow` tool; fleet bridge bundles SDK **0.3.202**, so it can occur. Renders today as a generic wrench card with raw JSON. | SDK docs + `~/.remi/acp/node_modules` on cn-10-37-66-8 |
| Claude subagent | `Agent` tool_call forwarded; the subagent's **inner tool calls arrive flat and unattributed** in the top-level stream; subagent prose dropped by the bridge. SDK itself emits `parent_tool_use_id` but claude-agent-acp does not forward it. | fixture `agent-spawn-notifications-*.json` + bridge dist |
| Codex subagent | codex-cli 0.145.0 (subagents GA 2026-03). codex-acp 1.1.0 **forwards** `collabAgentToolCall` as ACP tool_call: `kind:"other"`, `title` = collab tool name, `rawInput = { prompt, senderThreadId, receiverThreadIds, agentsStates, status }`. It **drops** `subAgentActivity` (subagent inner activity) entirely. | codex-acp dist on cn-10-37-66-8 |
| Agent team (Claude) | Experimental, env-gated (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), not an SDK capability. Will not occur on the fleet. | official docs |

Consequences the design accepts (see §4 Non-goals):
- Subagent *inner prose* (Claude) and *inner activity* (Codex) are unrecoverable
  without upstream bridge changes.
- Claude inner tool calls can only be attributed heuristically (daemon-side);
  Codex delegation calls carry real topology (`receiverThreadIds`).

## 2. Current display

- **Trace model.** A subagent call is a `subagent` item; the items it ran carry
  its id in `parent_id` ([trace contract](../packages/contracts/src/trace.ts)).
  The daemon translator stamps `parent_id` from Claude's `parentToolUseId`,
  with the Claude-only time-window fallback for unstamped frames; Codex collab
  calls become `subagent` items and stay flat (PR 2 spec §2.2–2.3).
- **Execution dialog.** [transcript-item-row.tsx](../frontend/packages/views/common/task-transcript/transcript-item-row.tsx)
  nests a subagent's items under its row (collapsed, with a step count; opened
  once while live-following a running subagent) and renders the subagent's
  report (`output`) and instructions (`prompt`) as Markdown. Items whose parent
  is not in the trace stay top level (fail open).
- **Chat steps.** A subagent is a breaker row in the steps fold; its detail
  shows the instructions, its own steps and its report
  ([turn-step-list.tsx](../frontend/packages/views/chat/components/turn-step-list.tsx)).
- **Other tools** (Claude `Workflow` included) render as generic `tool` items:
  the title when the bridge sends one, else a short field of the input.

## 3. Codex collab: captured behaviour

### 3.1 C0 findings (captured 2026-08-06, cn-10-37-66-8)

Fixture: `tests/fixtures/acp/codex-collab-notifications-1786010059380.json`
(87 frames; 2× spawnAgent + 2× wait, prompt "two subagents, one haiku each").

- **Config gating: yes.** Collab requires `multi_agent = true` under
  `[features]` in `~/.codex/config.toml` (default off — the fleet currently
  has it OFF, which is why production has never emitted collab events).
  Enabling it fleet-wide was a separate rollout decision.
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
- **No rawOutput/content on any collab frame**: a collab result exists only in
  `rawInput.agentsStates[*].message`; there is no output block.
- **No subagent inner activity arrived** — confirms `subAgentActivity` is
  dropped by the bridge in a live run, not just in code reading.

### 3.2 Production verification addenda (2026-08-06, v0.2.22)

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
  reply. Raises the priority of the upstream codex-acp issue (§4).

---

## 4. Non-goals / known ceilings

- Claude subagent inner prose and Codex `subAgentActivity` never reach us —
  nesting shows tool steps (Claude) or delegation+states (Codex), not the
  subagent's full narrative. Fix path is upstream (C3/P3), out of scope.
- Parallel / background subagents are not nested (deliberate).
- Agent-team events have no dedicated rendering (cannot occur on the fleet).
