# Claude Context Windows

Claude gateway models use the standard context window by default. Remi has no
built-in list of 1M models and performs no automatic support probes. An
administrator enables **1M context** for each model in Settings > Model gateway.
Claude Code does not validate whether a custom model supports 1M; confirm
support at the gateway before enabling it.

## Configuration and Delivery

The declaration is stored per workspace, engine and model in
`multiremi_gateway_model_context`, separately from model discovery snapshots
and reasoning-level declarations. A row means enabled; disabling deletes it.
Re-probing the gateway does not clear the setting. There are no preconfigured
models or migration presets.

`GET /api/workspaces/:id/relay-config/:engine/reasoning-levels` includes
`context_window: { one_million: true, updated_by, updated_at } | null` on each
model row. A declaration remains visible if the model disappears from the
gateway inventory. Only workspace administrators may write the setting:

```bash
remi workspace relay context-window update claude --model claude-opus-5-5 --one-million
remi workspace relay context-window update claude --model claude-opus-5-5 --clear
remi workspace relay reasoning-levels get claude --json
```

The corresponding PUT is
`/api/workspaces/:id/relay-config/claude/context-window` with body
`{ "model": "<id>", "one_million": true | false }`. Other engines are rejected.
Declaring context does not declare reasoning levels or make a missing model
executable.

The model IDs travel as `relay.claude.one_million_models` on daemon registration,
heartbeat acknowledgments and workspace repository refreshes. A normal online
daemon receives changes on its next heartbeat (normally within 10 seconds).
Running tasks keep their existing process. Subsequent tasks use the latest
received list; the setting does not enter the task execution fingerprint.
Runtime-specific Claude connection profiles replace the workspace relay and
are outside this setting's scope.

## Session Selection

For a declared model, new and resumed sessions start with the original model
in `_meta.claudeCode.options.model`. The session's CLI environment receives
`ANTHROPIC_CUSTOM_MODEL_OPTION=<model>[1m]` through
`_meta.claudeCode.options.env`, independently of SDK settings. This creates an
exact custom row even for older models absent from the current Claude Code menu.
Warm `session/load` receives the same metadata and session environment; otherwise
the bridge rebuilds from the archived model and loses the custom row.

Remi then selects `<model>[1m]` with `session/set_config_option`. Selection
succeeds when the chosen value ends in `[1m]`, or when the chosen custom row's
description includes the injected ID. The latter handles Fable's normalized
row, whose value can omit the suffix. This is acknowledgment of the configured
row, not proof of the gateway's actual capacity.

If configuration fails, or the bridge chooses a standard row, Remi logs
`[acp_model_context_fallback]` with the original model, selection and reason,
attempts the ordinary model, and reads back the actual selection. A missing
ordinary row is skipped with a warning, as for other standard model selections;
if the requested standard model is not confirmed, the fallback warning names
the actual model instead of claiming a standard context window. The task
continues. If the process died, its error is propagated. Attempts are cached
separately from the actual model, so another turn in the same pooled session
does not repeat the 1M request or warning. Resuming or loading
a different session applies the declaration once again. Model selection can
reset effort; Remi reads the current effort before applying the requested level.

Every pool entry has its own bridge process. The injected model ID participates
in its staleness check: switching to another declared model, or changing the
declaration, recreates the process with the correct environment.

An Agent model explicitly ending in `[1m]` is passed through unchanged,
including aliases such as `opus[1m]`. It stays strict: rejection or a non-1M
selection fails before any prompt, with no fallback or custom-option injection.
The former environment opt-out for automatic selection has been removed.

## Pinned Bridge Evidence

Senior's session-only probes on 2026-09-28 used Claude Code 2.1.283 and
`claude-agent-acp` 0.81.2:

| Startup model | Custom option | Selection | Observed row |
| --- | --- | --- | --- |
| `claude-opus-5-5` | none | `claude-opus-5-5[1m]` | `opus[1m]` |
| `claude-opus-5` | `claude-opus-5[1m]` | same | exact custom 1M row |
| `claude-opus-4-7` | none | `claude-opus-4-7[1m]` | Invalid value |
| `claude-fable-5-1` | `claude-fable-5-1[1m]` | same | normalized value, custom description retains suffix |
| `claude-haiku-4-5-20251001` | none | suffixed ID | `haiku`, standard row |
| `claude-haiku-4-5-20251001` | suffixed ID | same | accepted without support validation |

Selecting a synthesized startup row may trigger a network confirmation; a
failed confirmation can surface as JSON-RPC `-32603`. Removing unsolicited
1M selection avoids that path for undeclared models. Historical timing alone
does not prove the cause of each of the four Fable failures.
Ordinary model selection can also require confirmation. Session-only diagnostics
on the pinned bridge reported `opus[1m]` immediately after a fresh Fable startup,
then the requested Fable row after an explicit ordinary-model selection. A
different current row is not evidence that this selection can be safely skipped.

The new provider was also smoke-tested with these pinned versions, without
sending prompts: Opus 5.5 enabled selected `claude-opus-5-5[1m]`, disabled
selected `claude-opus-5-5`, and enabled Opus 5 selected `claude-opus-5[1m]`.
All three completed without a fallback warning. These results establish menu
selection, not the >200k acceptance criterion.

## Rollout and Verification

1. Deploy the platform and upgrade the daemon separately. Standard model IDs
   remain on the standard window until an administrator enables the declaration.
2. Enable the intended model through the setting or CLI. Wait for the online
   daemon's heartbeat before starting a new task.
3. Verify native `usage_update.size` is 1,000,000, input exceeds 200k without
   compaction, and logs contain no fallback warning.
4. Observe Fable on its undeclared standard model for 24 hours and record any
   `-32603` failures. Menu smoke tests do not replace this observation.

The task card uses SDK `usage_update.used` and `usage_update.size`; there is no
display override. Existing cards are unchanged. Billing is determined by the
model and gateway; larger context can increase token use.

The wrapper checks the actual Claude Code executable (minimum 2.1.259).
Explicit `REMI_CLAUDE_CODE_EXECUTABLE` / `CLAUDE_CODE_EXECUTABLE` paths take
precedence over bundled or installed fallback runtimes. This change does not
install or upgrade a machine's Claude CLI.

References:
- [Architecture decision](adr/0010-claude-1m-context-admin-declaration.md)
- [Gateway model discovery](runtime-model-discovery.md)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
