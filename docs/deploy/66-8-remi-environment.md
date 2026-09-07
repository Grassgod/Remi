# 66-8 Remi daemon environment

Use [`66-8-remi.env.example`](./66-8-remi.env.example) as the input for the
daemon's systemd `EnvironmentFile`. The committed file contains placeholders
only. Put the populated file under the service account, for example
`~/.config/remi/66-8-remi.env`, set mode `0600`, and reference it from the user
unit:

```ini
[Service]
EnvironmentFile=%h/.config/remi/66-8-remi.env
```

Run `systemd-analyze verify` on the completed unit before restarting it. Do not
paste the populated file into source control, logs, issues, or pull requests.

## Heartbeats and network recovery

Runtime availability is derived from control-plane heartbeats and the
[freshness window](../../packages/contracts/src/runtime-health.ts), not from SSH
connectivity or whether the machine is powered on. A ready local `/health`
response does not prove that the control plane is still receiving heartbeats.

The [daemon client](../../packages/server/src/worker/client.ts) applies a default
30-second deadline to control-plane JSON requests, including connection setup,
response headers, and body reads for both successful and error responses. This
bounds heartbeat, plugin configuration, and task claim requests that would
otherwise block subsequent polling. Archive content uploads retain their
separate timeout budget.

The running [poll loop](../../packages/server/src/worker/daemon.ts) logs transient
failures and retries at the polling interval (3 seconds by default). Timeout
errors identify the method, path, and deadline. The same daemon resumes polling
when the connection recovers; the HTTP client does not automatically replay
writes. Authority failures such as 401, 403, and 410 still enter terminal cleanup,
including when their response headers arrive but the error body times out or is
interrupted. `--once` still surfaces request failures to its caller.

Stopping the daemon cancels pending heartbeat and plugin configuration requests.
Cancelling the initial plugin query also finishes startup cleanly; workspace
ownership loss and other startup failures still propagate to the caller.
Task claims, execution, and durable reports keep their existing drain semantics.
These deadlines do not resolve operating-system network permissions, service
launch configuration, or synchronous event-loop blocking.

The [client tests](../../tests/unit/multiremi/multiremi-daemon-client.test.ts) and
[HTTP recovery tests](../../tests/integration/multiremi-daemon-heartbeat.test.ts)
cover connection loss/reopening, stalled headers and bodies, stalled plugin
queries and claims, 503 responses, and shutdown cancellation using isolated
databases and directories without contacting a production Runtime.

## Required settings

| Variable | Purpose | Missing or invalid behavior |
| --- | --- | --- |
| `MULTIREMI_SERVER_URL` | Multiremi control-plane base URL used for daemon registration and heartbeats. | The daemon cannot reach the intended control plane. |
| `MULTIREMI_TOKEN` | Daemon credential for the control plane. | Registration fails authentication. |
| `MULTIREMI_WORKSPACE_ID` | Workspace whose membership gates Feishu senders. | Feishu startup fails because an explicit workspace is required. |
| `MULTIREMI_BOT_AGENT_ID` | Agent row that supplies the bot provider, model, instructions, skills, tools, and MCP configuration. | A configured Feishu channel fails before starting. |
| `FEISHU_APP_ID` | Feishu application ID. | Bot startup reports `FEISHU_APP_ID` as missing. |
| `FEISHU_APP_SECRET` | Feishu application secret. | Bot startup reports `FEISHU_APP_SECRET` as missing. |

`FEISHU_APP_ID` and `FEISHU_APP_SECRET` are a pair. Supplying only one is a
configuration error. With neither and no `MULTIREMI_BOT_AGENT_ID`, the daemon
runs worker-only; setting `MULTIREMI_BOT_AGENT_ID` makes Feishu startup explicit
and therefore requires both credentials.

## Connector settings

| Variable | Default | Purpose / validation |
| --- | --- | --- |
| `FEISHU_VERIFICATION_TOKEN` | empty | Optional event verification token. |
| `FEISHU_ENCRYPT_KEY` | empty | Optional event payload encryption key. |
| `FEISHU_PORT` | `9000` | Connector port. A non-integer value aborts config loading. |
| `FEISHU_DOMAIN` | `feishu` | API domain selector: `feishu`, `lark`, or `bytedance`. Other values abort config loading. |
| `FEISHU_USER_ACCESS_TOKEN` | empty | Optional static user token for the Feishu auth adapter. Interactive `remi login` OAuth tokens continue to live in `~/.remi/auth/tokens.json`. |

## Optional runtime settings

| Variable | Default | Purpose / validation |
| --- | --- | --- |
| `GOOGLE_API_KEY` | unset | Optional Gemini integration key. `remi doctor` warns when it is absent. |
| `REMI_LOG_LEVEL` | `INFO` | Runtime log level. |
| `REMI_TOKEN_SYNC_RULES_JSON` | `[]` | JSON array passed to `AuthStore` as token synchronization rules. Invalid JSON aborts config loading. |
| `REMI_PLUGINS_DIR` | `~/.remi/plugins` | Directory scanned for external plugins. |
| `REMI_PLUGINS_ENABLED_JSON` | `[]` | JSON string array of explicitly enabled plugin IDs. Invalid JSON or non-string items abort config loading. |
| `REMI_PLUGINS_ALLOW_EXTERNAL` | `true` | Whether external plugins may load. Must be exactly `true` or `false`. |
| `REMI_PLUGIN_CONFIGS_JSON` | `{}` | JSON object keyed by plugin ID. Invalid JSON or a non-object value aborts config loading. |
| `MULTIREMI_GC_ENABLED` | `true` | Must remain enabled on 66-8. Topic workspaces return from closed Issues through the GC lifecycle sweep. |
| `MULTIREMI_GC_INTERVAL_MS` | `900000` (15 min) | Upper bound for closed-Issue topic return latency. Do not set it to an hour or more. |

Systemd `EnvironmentFile` parsing removes outer quotes. Keep structured values
single-quoted, as in the template, so their JSON double quotes reach Remi
unchanged.

## Before first W4 startup

The v2 startup migration creates a consistent
`remi.db.pre-remi-config-purge-v2.bak` and then removes the legacy
`remi_config` table in one transaction. If a legacy bot menu still needs to be
converted, run the read-only review and approved apply steps in
[`remi-bot-menu-to-workspace-settings.md`](../migrations/remi-bot-menu-to-workspace-settings.md)
before starting the W4 binary. The menu converter intentionally cannot recover
its source row from the live database after the table has been purged, but it
can read the v2 backup with `--backup`.

## Topic lifecycle GC

W7 uses the existing daemon GC sweep to observe terminal Issues and move their
workspaces back under `_topics`. Keep `MULTIREMI_GC_ENABLED=true` on 66-8 and
keep `MULTIREMI_GC_INTERVAL_MS` below one hour. The default 15-minute sweep has
roughly 288 times the safety margin of the 72-hour workspace TTL; disabling GC
or stretching the interval to hours removes that guarantee.
