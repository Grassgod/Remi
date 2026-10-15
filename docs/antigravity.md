# Antigravity Runtime

Remi runs Antigravity as the `antigravity` provider on Google's official ACP server (`antigravity-acp`), authenticated through the server's gateway mode and pointed at a loopback gateway shim in the daemon. The retired `agy -p` integration and personal-account `agy` logins no longer work.

> **Status (PR 4, Task A).** Provisioning, the access config, the provider behaviour and the trace mapping are in place. The daemon's gateway shim and its wiring (session home, shim channel, model probes, remote reinstall) land in Task C; until then the daemon cannot start an Antigravity task, which fails with `antigravity_home_required` or `antigravity_gateway_unconfigured` before any model call. Windows is not supported.

## Upgrade notes

1. `agy -p` and personal-account `agy` logins no longer work; an Agent `executable` that points at `agy` is rejected ("points at the retired agy CLI; clear it").
2. Configure *Settings > Model gateway > Antigravity* with the gateway base URL and API key ([contract](runtime-model-discovery.md#antigravity-gateway-engine)).
3. On each machine run `remi runtime prepare --provider antigravity --accept-antigravity-terms`. It downloads about 110 MB on macOS (about 400 MB on disk) or about 330 MB on Linux (about 1.1 GB on disk).
4. Reselect the model of every Antigravity Agent and clear its thinking level: stale ids fail with `acp_model_unsupported`, and an explicit effort fails with `acp_effort_unsupported`.
5. Restart the daemon.

## Install and terms

The server is proprietary, with no redistribution grant. Remi never bundles, mirrors or commits it: [antigravity-install.ts](../packages/acp/src/antigravity-install.ts) downloads the archive pinned in [runtime-versions.json](../packages/acp/src/runtime-versions.json) from `dl.google.com`, checks its size and sha256 while streaming, extracts it into a stage (`ditto` on macOS, `unzip` or `bsdtar` on Linux) and renames it into `${REMI_HOME:-~/.remi}/acp/antigravity/<version>-<platform>/`, next to an `install.json` manifest. A failure leaves the working install untouched; one previous copy is kept.

Antigravity is opt-in. The first download requires accepting [Google's terms](https://antigravity.google/terms) with `--accept-antigravity-terms` or `REMI_ACCEPT_ANTIGRAVITY_TERMS=1`; the acceptance time is recorded and carried across pin bumps. Whether this use is covered by those terms is a business and legal decision (PR 4 risk R2). Downloads happen only in `remi runtime prepare --provider antigravity`, in `remi setup` / `remi daemon start` when Antigravity is the explicit or configured provider, and in the default `remi runtime prepare` (the installer) when some Antigravity install already exists. Task execution never downloads, and auto-detection only considers the pinned install, never `agy` on `PATH`.

The daemon-start health check spawns nothing: the manifest must match the pin, both binaries must be executable, and no machine policy file (`/Library/Application Support/Antigravity/admin_settings.json`, `/etc/antigravity/admin_settings.json`) may exist, because its admin tier overrides Remi's gateway routing. `remi runtime prepare` also runs the full check (`verifyAntigravityRuntime` in [runtime-verify.ts](../packages/acp/src/runtime-verify.ts)): `initialize` must report `antigravity-acp` at the pinned version with `loadSession`, and `session/new` against a fake upstream must list the upstream's single model and send Bearer auth. It needs no credentials and sends no prompt.

## Access config

[access/antigravity.ts](../packages/acp/src/access/antigravity.ts) declares what the provider does differently; nothing in the provider branches on the agent name:

- **Launch:** `<install>/agy_acp_server.par`, with `--uid=` on Linux. An Agent `executable` override still wins (and keeps its custom args); custom args without one are ignored with a warning.
- **Environment:** `GEMINI_HOME` is the session's provider home; gateway auth is enabled with `AGY_LLM_GATEWAY_URL` set to the shim and the placeholder key `remi-shim`; file storage instead of the keychain; `BROWSER=/usr/bin/false`; loopback merged into `NO_PROXY` / `no_proxy`; every inherited Google, gateway and OAuth variable blanked. The real gateway key never enters the server process.
- **Home files:** `antigravity-acp/settings.json` selects `auth.type = gateway`; `trusted_workspaces.json` marks the task directories untrusted, so repository hooks stay off.
- **Session:** `session/new` (or `session/resume`) with `_meta.antigravity.systemPrompt.append` carrying Remi's system prompt and the runtime-context `AGENTS.md`; then `set_mode` (`yolo` / `auto_edit` / `default`), then a strict `set_config_option` for the model: without one the server silently runs the gateway's first model, so a missing model fails with `antigravity_model_required`. The gateway path has no effort selector.
- **Prompts:** questions the model asks through `ask_user` arrive as `session/request_permission` and are answered through the elicitation handler (single choice); the workspace-trust prompt is answered `deny`; gateway errors streamed as `Agent execution error: …` text become typed session failures.
- **Usage:** the server's `usage_update.used` double-counts the cache and is never billed. Billing and context come from the shim's per-response `usageMetadata` ([gemini-request-usage.ts](../packages/acp/src/gemini-request-usage.ts)), one request-identity unit per response; the shim interfaces are in [gateway-shim-types.ts](../packages/acp/src/access/gateway-shim-types.ts).

Agent Plugins are not supported; `allowedTools` is ignored with a warning; extra directories have no effect; the server sends no plan updates and only single-choice questions.

## Validation

Run `bun test tests/unit/acp/antigravity-install.test.ts tests/unit/acp/antigravity-access.test.ts tests/unit/acp/gemini-request-usage.test.ts tests/unit/acp/providers.test.ts tests/unit/acp/trace-vendor.test.ts tests/unit/daemon/trace-translator.test.ts`. They use fake archives, a fake ACP agent and a fake shim, so they prove neither Google authentication nor real model execution. The daemon integration test and the opt-in live probe arrive with Task C.
