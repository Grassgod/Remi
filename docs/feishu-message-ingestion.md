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
cannot be reached at `http://feishu-sidecar:8042`. The recommended topology runs
it as a sibling service that shares the API service's network namespace. Both
processes then see the same loopback interface, while no sidecar port is
published on the host or bridge network. The following is a proposal for
operator review; it is not part of the production Compose file and must not be
applied without deployment authorization.

```yaml
services:
  api:
    environment:
      MULTIREMI_FEISHU_SIDECAR_ENDPOINTS: personal=http://127.0.0.1:8042

  feishu-sidecar:
    image: ${REMI_FEISHU_SIDECAR_IMAGE:?set REMI_FEISHU_SIDECAR_IMAGE}
    restart: unless-stopped
    network_mode: service:api
    depends_on:
      api:
        condition: service_started
    env_file:
      - ${REMI_FEISHU_SIDECAR_ENV_FILE:?set REMI_FEISHU_SIDECAR_ENV_FILE}
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8042/healthz"]
      interval: 10s
      timeout: 5s
      retries: 12
```

The source is then created with `--endpoint-name personal`; the URL remains an
API deployment secret. The sidecar must not define `ports`, `expose`, or a
separate `networks` entry when using this shared-namespace topology. Because the
network namespace belongs to the API container, deployment automation must
recreate the sidecar whenever it replaces the API container.

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
- `create-issue` creates the Issue and its audited `issue_created` outcome in
  one transaction. Replaying the command returns the same Issue instead of
  creating a duplicate.
- Source status exposes the most recent successful ingestion, last sanitized
  error code, connection lag, consecutive failures, unresolved backlog, and
  timeout count, and muted-delivery count through
  `remi feishu source status <source>`.
- After three consecutive connection failures, the workspace owner receives a
  deduplicated Inbox alert in the `system_notifications` group, independently
  from Feishu message reminder preferences. Further failures do not create more
  alerts until a successful poll resets the failure episode.
