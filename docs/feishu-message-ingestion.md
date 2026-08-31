# Feishu message ingestion

Feishu is one channel of the Messaging Core. The Core owns scheduling,
deduplication, cursors, retention, and outcomes; a Provider owns everything
channel-specific. `LarkCliMessageProvider` is the Provider for Feishu, and it
reaches Feishu by running `lark-cli` with argv — no shell, no HTTP service, no
long-lived credential in Remi's own storage.

A workspace wires a channel in two objects:

- a **Connection** names a Provider and holds its configuration. For lark-cli
  the configuration is which executable to run and how long to wait; the
  credential belongs to lark-cli, not to the Connection.
- a **Source** binds a Connection to a set of conversations, plus the allowlist,
  poll interval, and retention.

```bash
remi messaging connection add --provider lark_cli --name "Feishu (personal)"
remi messaging source add --connection <connection> --name "Team chats"
```

The older `remi feishu ...` commands and the `/feishu` API still work: they are
the same workflow bound to one channel and the legacy id space, kept for shipped
clients.

## Deployment

There is no ingestion service, port, or endpoint registry. `lark-cli` is baked
into the API image at a pinned version whose archive digest is verified during
the build (`LARK_CLI_VERSION` and the two `LARK_CLI_SHA256_*` args in
`deploy/docker/Dockerfile.api`), and the API server spawns it in its own
container. `LARK_CLI_MINIMUM_VERSION` in the Provider is the floor the image
must stay at or above; a lower version reports the Connection as
`incompatible` rather than failing at some later call.

Authorize it once, inside the API container:

```bash
docker compose exec api lark-cli login
```

lark-cli writes its credential under `$HOME`, which in the API container is the
`REMI_HOME_DIR` bind mount. It therefore survives image upgrades, stays under
the operator's control, and never appears in Compose, an env file, a log line,
or Git. No Remi component reads or writes that file.

The Connection reports what it finds, so each failure mode is a visible status
rather than a silent stall:

| Situation | Connection status | Error code |
| --- | --- | --- |
| lark-cli not on PATH | `unavailable` | `provider_unavailable` |
| Not logged in, or the credential expired | `unauthenticated` | `unauthenticated` |
| Version below the Provider's floor | `incompatible` | `provider_incompatible` |
| Required subcommand missing | `incompatible` | `capability_unsupported` |
| Feishu throttled the call | `ready` | `rate_limited` (retried with backoff) |
| Command exceeded its timeout | `ready` | `timeout` (retried) |

`rate_limited` and `timeout` are retryable and never disable a Source; the
others need an operator and say which one.

## Production rollout runbook

Each step needs explicit per-session authorization from the platform owner.
Nothing here runs as part of ordinary development.

1. **Stage first.** Deploy the new API image to a non-production stack and run
   `docker compose exec api lark-cli --version`, then `lark-cli login`.
2. **Add the Connection and check it.** `remi messaging connection add
   --provider lark_cli`, then `remi messaging connection check <connection>`
   must report `ready`.
   Assert that no response body contains a credential path or a command line.
3. **Create the source disabled with an empty allowlist.** An empty allowlist
   ingests nothing, which is the intended state until the owner picks chats.
4. **Enable chats, then the source.** Confirm the activation watermark by
   checking that no message older than the enable time is stored, then verify
   ingestion, cursor advance, deduplication, and the Inbox/proposal paths on a
   low-traffic chat before adding busy ones.

### Upgrading from the retired sidecar

Installations before this release ran ingestion in a `feishu-sidecar` container
that shared the API container's network namespace. Nothing needs to be migrated
by hand:

- Existing sources, messages, outcomes, and cursors are carried over by the
  `20260831_messaging_core_v1` migration, which maps each legacy source to a
  Connection and re-keys messages by `(connection, external message id)`. It
  copies rather than moves, so history is not re-processed and nothing is lost
  if the release is rolled back.
- `DockerComposeDriver` removes the leftover sidecar container before it
  replaces the API container — Docker would otherwise refuse the switch, since
  the sidecar borrowed that namespace. Its named data volumes are left alone;
  deleting them is the operator's call.
- The pre-existing `personal-automation` deployment, if any, is untouched and
  needs no restoration step. It is no longer a runtime dependency.

### Rollback

1. Disable the source in the control panel. Ingestion stops immediately; stored
   messages and outcomes are retained.
2. Roll the API image back through the platform updater. Legacy rows were copied,
   not moved, so the previous release finds its own data where it left it.
3. To stop ingestion without a rollback, delete the Connection. The Sources bound
   to it stop polling and their stored messages stay readable.

## Processing guarantees

- An empty allowlist means zero ingestion in both the scheduler and storage
  layer.
- Enabling a chat records an activation watermark rounded conservatively to the
  next whole minute. Messages in that minute can be skipped, by at most about 60
  seconds, so no message from before authorization is retained.
- `processed_at` on each message is the processing source of truth. Unresolved
  messages are retried after 15 minutes by default. After three retries, the
  system records a terminal `dismissed` outcome with reason
  `unprocessed_timeout`.
- `notify` and `draft-reply` use the dedicated `feishu_messages` notification
  preference group and create Inbox items only. Ingestion never sends a Feishu
  message; a draft still requires a separate human-approved send path. When the
  recipient explicitly mutes this group, the system records a terminal
  `dismissed` outcome with reason `recipient_muted` instead of retrying and
  eventually reporting an unrelated processing timeout.
- `propose-issue` creates a non-blocking Inbox proposal and audited
  `issue_proposed` outcome. Only a human workspace admin can approve or reject
  it; approval creates the Issue and `issue_created` outcome atomically and
  idempotently, while rejection records `dismissed/proposal_rejected`.
- Configure the Feishu watcher agent with
  `remi agent update <agent> --issue-creation-requires-proposal`. This
  human-managed, default-off policy blocks that task identity from every direct
  and Autopilot-mediated Issue creation path while leaving ordinary collaboration
  agents unchanged. The caller-specific CLI capability response also marks
  `issue.create` and `issue.quick-create` unavailable for the restricted agent.
- The direct `create-issue` command is human-only. Task tokens cannot approve,
  reject, or bypass the proposal flow.
- Source status exposes the most recent successful ingestion, last sanitized
  error code, connection lag, consecutive failures, unresolved backlog, and
  timeout count, muted-delivery count, and pending Issue proposal count through
  `remi feishu source status <source>`.
- After three consecutive connection failures, the workspace owner receives a
  deduplicated Inbox alert in the `system_notifications` group, independently
  from Feishu message reminder preferences. Further failures do not create more
  alerts until a successful poll resets the failure episode.
