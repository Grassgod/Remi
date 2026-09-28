# ADR 0010: Claude 1M context is an administrator declaration per gateway model

## Status

Accepted on 2026-09-28 (MUL-479). Implemented with the MUL-479 PR.

## Context

`packages/acp/src/adapters/claude-code/model-context.ts` carried a hand-written
list of Claude model IDs that "support 1M" and appended `[1m]` to the session
startup model for those IDs. The list drifted as soon as it was written:

- `claude-opus-5-5` was not on it, so every Opus 5.5 Agent ran with a 200K
  window and compacted at ~167K (Remi-CC: 29 compactions, 70–90 s each).
- `claude-opus-5` was on it, but Claude Code 2.1.283 no longer offers an
  Opus 5 row; the bridge's version guard refuses the 5 → 5.5 fuzzy match.
- `claude-fable-5-1[1m]` was on it. Selecting a synthesized startup row makes
  the CLI confirm the model over the network at `setModel` time; when that
  round-trip fails the bridge answers JSON-RPC `-32603`. This reproduces a path
  consistent with Senior大哥's four failures between 9/26 and 9/28; their
  historical timing alone does not prove each failure's cause.

The user decided (9/28): no automatic probing of any kind. The platform keeps
no model list. An administrator turns 1M on or off per gateway model in
Settings → Model gateway, and the platform only executes that setting.

Live probe on 2026-09-28 against bridge `claude-agent-acp` 0.81.2 / Claude
Code 2.1.283 (sessions created, no prompt sent):

| Startup `--model` | Session env (`_meta.claudeCode.options.env`) | `set_config_option` value | Result |
|---|---|---|---|
| `claude-opus-5-5` | none | `claude-opus-5-5[1m]` | selects menu row `opus[1m]`, 12 ms, effort selector intact |
| `claude-opus-5` | `ANTHROPIC_CUSTOM_MODEL_OPTION=claude-opus-5[1m]` | `claude-opus-5[1m]` | custom row "Opus 5 (1M context)" appears and is selected, 7 ms, effort intact |
| `claude-opus-5-5` | `…=claude-opus-5-5[1m]` | `claude-opus-5-5[1m]` | duplicate custom row next to `opus[1m]`; the custom (pinned) row is selected, effort intact |
| `claude-fable-5-1` | none | `claude-fable-5-1[1m]` | fuzzy-matched to the 200K row `claude-fable-5-1`, 2.5 s (network confirm) |
| `claude-fable-5-1` | `…=claude-fable-5-1[1m]` | `claude-fable-5-1[1m]` | CLI normalizes the row to value `claude-fable-5-1`, description `Custom model (claude-fable-5-1[1m])`; selected, 1.9 s |
| `claude-haiku-4-5-20251001` | `…=claude-haiku-4-5-20251001[1m]` | same | accepted ("Haiku 4.5 (1M context)"); effort selector disappears. The CLI does not validate 1M support |
| `claude-opus-5[1m]` | none | `claude-opus-5[1m]` | CLI synthesizes a picker row for the startup model; selected after a 2.0 s network confirm |
| `claude-nonexistent-9[1m]` | none | same | session/new succeeds (no startup rejection); selection fails `-32603 Internal error` after 1.5 s |
| `claude-nonexistent-9` | `…=claude-nonexistent-9[1m]` | same | accepted in 6 ms with no validation at all |

Two premises in the original discussion are therefore false: Claude Code does
not reject an unknown startup model, and the custom-option row is not
validated against the gateway. Each Remi pool entry spawns its own bridge
process, and the bridge merges `_meta.claudeCode.options.env` into the CLI
subprocess environment, so "process-level env" is not a sharing problem here.

## Decision

1. **Storage: its own table.** `multiremi_gateway_model_context`
   (`workspace_id`, `engine`, `model_id`, `context_window` = `'1m'`,
   `updated_by`, `updated_at`; primary key workspace × engine × model). A row
   present means 1M on; clearing deletes the row. It is separate from the
   discovery snapshot (rewritten on every probe) and from
   `multiremi_gateway_model_reasoning`, whose invariant is "levels are never
   empty" and which cannot host a model that only needs a context flag.
2. **Delivery: the daemon relay wire.** `relay.claude.one_million_models`
   (sorted model IDs) rides on register, every 10 s heartbeat ack and the
   workspace-repos refresh. It is not part of the execution fingerprint: a
   running task keeps its process; the next task reads the current setting.
   Runtime connection profiles replace `relay.claude` wholesale and are out
   of scope.
3. **Selection: plain startup model, custom option row, one attempt.** The
   session `_meta` startup model stays the Agent's model. When the model is
   declared, the session env carries `ANTHROPIC_CUSTOM_MODEL_OPTION=<model>[1m]`
   (documented Claude Code feature, per session via
   `_meta.claudeCode.options.env`) and the provider sends
   `session/set_config_option(model, "<model>[1m]")` once per created,
   resumed or loaded session. Success means the selected value ends in
   `[1m]`, or the selected row's description contains the injected ID (the
   Fable normalization above). Any error, or a non-1M selection, logs one
   `[acp_model_context_fallback]` warning, re-selects the plain model and
   continues. A dead bridge process rethrows. The custom option value is part
   of the pool entry's staleness key, so a model change recreates the process.
4. **Explicit `[1m]` in the Agent model stays strict** (pass through, fail if
   the bridge does not land on a 1M lane). The former automatic-selection
   environment opt-out is removed: the declaration is the only switch.
5. **No gateway validation.** Claude Code accepts any custom row. The settings
   page states this next to the switch; a model that does not support 1M fails
   on its first prompt with the gateway's error, and the administrator turns
   the switch off.

## Rejected

- **Try `[1m]` first, fall back on rejection (the original MUL-479 plan).**
  User decision. Also technically weak: the only rejection signal is a
  network confirm that fails intermittently, which is the -32603 source.
- **Startup `--model <model>[1m]` with the synthesized row.** Undocumented CLI
  behaviour; costs a ~2 s network confirm per session; and for an off-menu
  model there is no plain row to fall back to, because only the startup value
  is synthesized.
- **`availableModels` via `_meta.claudeCode.options.settings`.** The bridge's
  allowlist filter reads only file-based settings from the session cwd, so a
  per-session settings object never reaches the picker.
- **Extend the reasoning-levels table with a column.** Breaks its "levels are
  non-empty or the row does not exist" invariant (MUL-338).
- **Prefer the native alias row (`opus[1m]`) when the model is on the menu.**
  Cannot be known before the process is spawned, and the alias floats to the
  next Opus on a Claude Code upgrade. The pinned custom row is the truthful
  reading of an Agent configured with `claude-opus-5-5`.

## Consequences

- After merge standard model IDs do not opt into 1M until an administrator
  declares a model. Explicit `[1m]` selections are unchanged. Ordinary Opus
  5.5 Agents stay at 200K until `claude-opus-5-5` is switched on.
- The picker shows a duplicate row for on-menu models (cosmetic).
- Prompts above 200K input are billed at the long-context rate; the usage
  pricing table does not model the surcharge (frontend `resolvePricing`).
- Bridge or CLI upgrades can change custom-row behaviour; the acceptance run
  (Opus 5.5 at >200K without compaction) must be repeated after
  `release:prepare` bumps `packages/acp/src/runtime-versions.json`.
