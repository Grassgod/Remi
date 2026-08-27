# Feishu message ingestion

Feishu message sources reference an operator-configured endpoint by name. They
never store or accept a fetchable URL from a user or task. Configure one or more
entries on the API process:

```dotenv
MULTIREMI_FEISHU_SIDECAR_ENDPOINTS=personal=http://127.0.0.1:8042
```

Separate entries with commas or newlines. Names use lowercase letters, numbers,
`_`, and `-`. Values must be absolute HTTP or HTTPS URLs without credentials,
query strings, or fragments. When the variable is empty or absent, the API
starts normally but refuses to create or enable any Feishu source. This is a
fail-closed deployment state, not an instruction to discover a sidecar.

## Compose topology

`personal_automation` intentionally binds port 8042 to loopback and rejects a
non-loopback dashboard listener. A normal bridge-network sibling therefore
cannot be reached at `http://feishu-sidecar:8042`. `deploy/docker/compose.application.yml`
runs it as a sibling service that shares the API service's network namespace, so
both processes see the same loopback interface while no sidecar port is
published on the host or bridge network.

The service is behind the `feishu-sidecar` Compose profile and is inert until an
operator enables it. Enabling it is a controlled deployment change made in the
platform env file — never an API call, and never a URL submitted from a browser
or a task token:

```dotenv
COMPOSE_PROFILES=feishu-sidecar
REMI_FEISHU_SIDECAR_IMAGE=<registry>/personal-automation:<version>
REMI_FEISHU_SIDECAR_ENDPOINTS=personal=http://127.0.0.1:8042
```

`MULTIREMI_FEISHU_SIDECAR_ENDPOINTS` is set from Compose, so this value takes
precedence over the same key in the API env file. Leaving
`REMI_FEISHU_SIDECAR_ENDPOINTS` unset keeps the API fail-closed.

The source is then created with `--endpoint-name personal`; the URL remains an
API deployment secret. The sidecar must not define `ports`, `expose`, or a
separate `networks` entry under this shared-namespace topology — any published
port belongs to the `api` service, which owns the namespace. Because the
namespace belongs to the API container, `DockerComposeDriver` removes the
sidecar before it replaces the API container and recreates it after the health
check passes, on both the update and the rollback path. A sidecar that fails to
start never fails the platform release: the API stays up and the endpoint shows
as Unreachable.

The sidecar holds personal Feishu credentials in its own volumes and is set up
through its own first-run wizard. It never reads the API env file, and no Remi
component writes to it.

## Production rollout runbook

Each step needs explicit per-session authorization from the platform owner.
Nothing here runs as part of ordinary development.

1. **Stage first.** Enable the profile on a non-production stack, then confirm
   `docker compose ps feishu-sidecar` is healthy and, from inside the API
   container, that `GET /healthz` and `GET /api/agent/feishu` both answer on
   `127.0.0.1:8042`.
2. **Point the registry at the sidecar.** Add the three settings above to the
   platform env file, keeping mode `0600`. Do not copy them into Git or the API
   env file.
3. **Apply through the controlled path.** Re-run the application Compose stack
   (or a platform operation). The API container is never given the Docker
   socket, and no API route may reconfigure the sidecar.
4. **Verify the control plane.** In Settings → 飞书消息, the 接入服务 panel must
   report the endpoint as Ready with a version. `remi feishu endpoint list`
   returns names and health only; assert that no response body contains an
   internal host, port, or URL.
5. **Create the source disabled with an empty allowlist.** An empty allowlist
   ingests nothing, which is the intended state until the owner picks chats.
6. **Enable chats, then the source.** Confirm the activation watermark by
   checking that no message older than the enable time is stored, then verify
   ingestion, cursor advance, deduplication, and the Inbox/proposal paths on a
   low-traffic chat before adding busy ones.
7. **Leave the existing deployment in place.** The pre-existing
   `personal-automation.service` (or equivalent container) stays installed and
   running until the new path has been stable in production. Do not delete it as
   part of this rollout, and never attach a running deployment's volumes to the
   sidecar at the same time.

### Rollback

1. Disable the source in the control panel. Ingestion stops immediately; stored
   messages and outcomes are retained.
2. Remove `REMI_FEISHU_SIDECAR_ENDPOINTS` from the platform env file and apply.
   The API returns to the fail-closed state and refuses to create or enable any
   source; existing rows stay untouched.
3. Drop `feishu-sidecar` from `COMPOSE_PROFILES` and apply. The sidecar
   container is removed; API, Web, and the control plane are unaffected because
   the namespace belongs to the API container, not the sidecar.
4. The original `personal-automation` deployment is still running and needs no
   restoration step.

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
