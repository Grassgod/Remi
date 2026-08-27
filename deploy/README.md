# Platform deployment

The API records lifecycle operations. A host-owned `remi-platform-updater`
service executes them through one deployment driver. The API container never
receives the Docker socket and cannot invoke `systemctl`.

## Release pipeline

Push a formal SemVer tag only after the tag commit's `Release build check` run
on `main` succeeds. The tag-triggered `Release` workflow publishes the daemon
CLI GitHub Release first, then calls the reusable `Platform release` workflow
to publish the API/Web images and attach the platform manifest and systemd
archive to the same release.

```bash
git tag v0.2.45
git push origin v0.2.45
```

`Platform release` keeps a manual dispatch entry for recovery. Images carry
both the version tag and a `sha-<commit>` tag. A retry reuses an existing image
only when both tags resolve to the same digest; a conflicting or incomplete
tag pair fails closed.

## Host updater

1. Install the repository at a stable updater path.
2. Create `/etc/multiremi/platform-updater.env` from the systemd example with
   mode `0600`. Use a token distinct from `MULTIREMI_TOKEN`.
3. Install and enable `deploy/systemd/remi-platform-updater.service`.
4. Add the same `MULTIREMI_PLATFORM_UPDATER_TOKEN` to the API secret env file.

The transitional `systemd_release` driver builds a verified release archive in
a new directory, atomically switches the `current` symlink, restarts API/Web,
and restores the old symlink if health checks fail.

## Docker Compose control plane

Keep `platform.env` and `api.env` outside Git with mode `0600`. Set API and Web
images to immutable GHCR digests from `platform-release.json`, then run:

```bash
docker compose --env-file /etc/multiremi/platform.env \
  -f deploy/docker/compose.platform.yml up -d
```

Set the host updater driver to `docker_compose` and provide the compose file,
env file, and state directory. Existing PostgreSQL and OpenViking data must be
backed up and mounted into the configured volumes before the first cutover.

## Existing data-service migration

When PostgreSQL and OpenViking already run in Docker, use
`compose.application.yml` first. It owns only API/Web and joins the existing
data-service networks; it never creates, replaces, or deletes data containers.

1. Back up PostgreSQL, OpenViking, uploads, session archives, and SSH Mesh state.
2. Create an API env file outside Git. Change the database hostname to the
   existing network alias (`postgres` by default). Do not copy secrets into the
   Compose env file. Create a separate control-plane env file whose database
   URL uses the host-published PostgreSQL address (`127.0.0.1` by default).
3. Create a persistent service home owned by the runtime user and bind it with
   `REMI_HOME_DIR`. Bind the existing uploads, session archives, and SSH Mesh
   directories beneath it with `REMI_UPLOAD_DIR`, `REMI_SESSION_ARCHIVE_ROOT`,
   and `REMI_SSH_MESH_ROOT`. Set `REMI_RUNTIME_UID` and `REMI_RUNTIME_GID` to
   their owner. SSH Mesh rejects a root-owned service home. Bind the host
   account's `.ssh` directory with `REMI_SSH_HOME_DIR` and set its login name in
   `REMI_SSH_USER`.
4. Start on the staging ports (`16120` and `13000`) with
   `REMI_BACKGROUND_JOBS=0` and `REMI_SSH_MESH_CONTROL_PLANE=0`. Verify API,
   Web, login, database-backed counts, OpenViking readiness, attachments, and
   WebSockets without running a second scheduler or SCM poller.
5. Stop the host API/Web, set `REMI_BACKGROUND_JOBS=1` and
   `REMI_SSH_MESH_CONTROL_PLANE=1`, start the app stack, verify SSH Mesh
   ownership, then switch the reverse proxy to the new ports. Keep the host
   units installed but stopped for rollback.

The API container never owns the SSH Mesh control-plane lease. Compose runs a
dedicated `ssh-mesh-control-plane` sidecar with host networking so it observes
the host sshd, network addresses, and host keys without starting a Runtime or
task worker. The sidecar mounts `/etc/ssh` read-only and writes only the managed
blocks in the configured host account's `.ssh` directory.

The updater may use this Compose file after cutover. Set
`MULTIREMI_PLATFORM_POSTGRES_CONTAINER` and
`MULTIREMI_PLATFORM_OPENVIKING_CONTAINER` so externally managed dependencies
still appear in the service status panel.

Feishu message ingestion uses an operator-owned endpoint registry instead of
accepting arbitrary URLs from users or agents. See
[`docs/feishu-message-ingestion.md`](../docs/feishu-message-ingestion.md) for
the fail-closed environment contract and a review-only Compose sidecar example.

## Direct Session Archive uploads (MUL-144)

Session Archive content is a potentially large binary PUT. It must enter the
API directly instead of passing through the Web container's Next.js
`/api/:path*` compatibility rewrite. Keep that rewrite for normal API traffic
and installations that have not enabled the direct path; do not use it for
large archive bodies.

The API and daemon recognize these settings:

- `MULTIREMI_DAEMON_DIRECT_BASE_URL` (API): public API origin advertised in the
  archive init response, for example `https://remi.example.com`. It must be an
  `http(s)` origin with no credentials, path, query, or fragment. When unset,
  init keeps returning the legacy relative upload URL.
- `MULTIREMI_ARCHIVE_UPLOAD_BASE_URL` (daemon): operator-trusted API origin that
  overrides the advertised origin for archive content only. Use it as a
  temporary escape hatch or when the direct API uses a different hostname.
- `MULTIREMI_ARCHIVE_PROXY_MAX_BYTES` (daemon): maximum archive size allowed
  through a relative control-plane/Next.js fallback. The default is 8 MiB.
  Larger archives fail before PUT and persist an actionable `last_error` that
  names the direct-upload settings; smaller archives remain backward
  compatible.
- `MULTIREMI_ARCHIVE_DIRECT_PROBE_TTL_MS` (daemon): TTL for positive and
  negative direct-route HEAD attestations. The default is 5 minutes.
- `MULTIREMI_ARCHIVE_DIRECT_PROBE_TIMEOUT_MS` (daemon): maximum HEAD
  attestation duration. The default is 10 seconds; a failure or missing marker
  is treated as an unconfigured direct route.
- `MULTIREMI_ARCHIVE_UPLOAD_TIMEOUT_MS` (daemon): total timeout for one archive
  PUT. The default is 15 minutes, matching the Nginx sample. Increase it for
  exceptionally slow links rather than removing the bound.
- `MULTIREMI_ARCHIVE_FAILURE_REPORT_TIMEOUT_MS` (daemon): timeout for the
  best-effort `last_error` callback after a failed upload. The default is 10
  seconds.

An absolute URL advertised by the authenticated API is accepted without daemon
configuration only when its hostname matches `MULTIREMI_SERVER_URL`; a daemon
override explicitly trusts a different hostname. HTTPS control-plane URLs
cannot be downgraded by the server response. In all cases the daemon verifies
the exact archive pathname and attempt query, rejects credentials/fragments,
and refuses redirects before attaching its Bearer token. An absolute URL is
only a direct-route candidate: before PUT, the daemon sends an authenticated
HEAD request to the same content URL. Only a `204` response carrying
`X-Remi-Archive-Direct: 1` proves that Nginx selected the direct API location.
The direct Nginx location injects `X-Remi-Archive-Direct-Route: 1` into the
upstream request. The API emits the response marker only when that route proof
is present and the request `Host` authority (including a non-default port)
matches `MULTIREMI_DAEMON_DIRECT_BASE_URL`. The Next.js compatibility rewrite
does not inject the route proof, so it cannot attest itself even if it preserves
the public `Host`; response-header passthrough therefore cannot create a false
positive. Results are cached by target origin for the configured finite TTL.

The route proof is only as trustworthy as the edge that injects it. Nginx must
also clear a client-supplied `X-Remi-Archive-Direct-Route` on every other path,
otherwise a caller can send the header itself and reach the API through the
Next.js rewrite. The authority check does not cover this on its own: it compares
the request `Host` to `MULTIREMI_DAEMON_DIRECT_BASE_URL`, so it is a no-op
whenever the direct route shares the public host and port, which is the topology
the sample configuration describes. Add
`proxy_set_header X-Remi-Archive-Direct-Route "";` to the enclosing server block
so only the direct location supplies the proof.

The 8 MiB fallback is deliberately fail-closed and is a compatibility change.
Production history includes one 8.912 MiB archive that previously succeeded,
while the smallest observed failed archive was 10.051 MiB. Therefore an
unconfigured deployment now explicitly rejects some archives in the 8-10 MiB
range instead of risking a truncated upload. Operators may raise
`MULTIREMI_ARCHIVE_PROXY_MAX_BYTES`, but doing so moves the limit toward a
known failure size and is not recommended as a substitute for the direct route.

Use [`nginx/session-archive-direct.conf`](nginx/session-archive-direct.conf) in
the public server block. It disables request/response buffering, allows bodies
up to 1 GiB, gives a streaming upload 15 minutes, preserves the public `Host`,
and injects the direct-route proof consumed by the API. Replace its sample
`16120` upstream port with the host's effective `REMI_API_BIND_PORT`, and add the
server-level `proxy_set_header X-Remi-Archive-Direct-Route "";` documented in the
file header. Keep the API container bound to loopback; Nginx is the external
network path.

Audit the complete effective configuration with `nginx -T`. Ordinary prefix
location order does not decide this match. A broader regex declared earlier can
win, and a covering `^~` prefix such as `^~ /api/` prevents regex locations from
being evaluated at all. Place this regex before broader matching regexes and
remove or narrow any covering `^~` prefix. QA read-only inspection found that
the current production-209 topology (ordinary Web catch-all, three API
WebSocket prefixes, and `^~ /api/webhooks/scm/`) permits this location to match;
the location itself was not installed by this change.

For the production host `n37-117-209`, an authorized operator must perform the
following steps. This repository change does not perform them:

1. Read the deployment's Compose env and confirm the effective host API port;
   do not assume the sample port.
2. Inspect `nginx -T` for earlier matching regexes and covering `^~` prefixes,
   then add the direct location, run `nginx -t`, and reload Nginx. Its position
   relative to an ordinary Web catch-all is irrelevant.
3. Add `MULTIREMI_DAEMON_DIRECT_BASE_URL=https://n37-117-209.byted.org` to the
   API secret env file and redeploy through the normal release/updater flow.
4. Upgrade Runtime daemon CLIs through their normal release flow to obtain
   streaming uploads, URL validation, the proxy-size guard, and durable upload
   failure reporting. Platform deployment does not upgrade Runtime CLIs.
5. Initialize a disposable archive attempt and send an authenticated HEAD to
   its exact `upload_url`. Confirm a `204` response with
   `X-Remi-Archive-Direct: 1`; a missing marker means the route is not active.
   Keep daemon tokens out of shell history and logs.
6. Retry failed archives, then verify API access logs receive the content PUTs,
   Web/Next.js logs do not, and each archive becomes `ready` with its declared
   size and SHA-256. Check Web process memory/event-loop health during the run.

`remi issue archive retry <issue> <archive-id>` (the compatibility alias of
`remi session archive retry`) also accepts an exhausted failed archive. It
resets the attempt count, error, backoff timestamp, and exhaustion timestamp,
returning the row to `pending` with `retry_state=eligible`. Run it once per
failed archive only after the direct route and API setting pass the HEAD check;
the daemon will claim and upload the recovered attempt on its next archive run.

Do not expose the API container port directly to the network and do not place
daemon tokens in Nginx configuration or logs.

## Drain-protected updates (MUL-74)

Update and rollback operations drain the platform before touching containers
or services; `check_updates` and `restart` do not drain.

Sequence: the updater pulls/stages the release first, then calls
`POST /api/platform-updater/drain/begin` and polls `drain/renew` (which also
renews the lease and returns aggregated progress). Daemons learn about the
drain through their next heartbeat ack, stop claiming new tasks, keep running
tasks and heartbeats alive, and report the acknowledged drain generation plus
their active task count. Only when every online runtime acked the current
generation AND the server counts zero in-flight tasks does the updater run the
container/service switch. The drain is released on success, failure, failed
health checks, automatic rollback, operator cancellation, and — as a safety
net — whenever a terminal operation status is reported.

- The drain state lives in the database (`multiremi_platform_maintenance`),
  so an API restart mid-update does not lose it.
- The drain lease has a TTL (default 120 s, renewed every poll). If the
  updater crashes, the API lazily flips back to `normal` on the next read and
  daemons resume claiming — the platform can never stay stuck draining.
- If the wait exceeds `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS` (default 15 min),
  the switch is NOT executed, the operation fails with a drain-timeout error,
  and scheduling resumes. There is no automatic force-update; resolve or
  cancel the long-running tasks and retry the update manually.
- Operators can cancel an update from the 版本与服务 page until the switch
  phase begins (`queued/preparing/pulling/draining`).
- Old daemons that do not report a drain ack keep the gate closed until the
  timeout: upgrade or retire them first.

Daemon-side report outbox: every task-scoped report (messages, prompt,
progress, session pin, usage, workspace, complete/fail) is written to a
durable per-daemon SQLite queue under `~/.multiremi/outbox/` and delivered in
per-task order with bounded exponential backoff. A brief API outage (for
example the update window itself) therefore never terminates a running agent
or strands a task in `running`; permanent auth errors (401/403/410) park the
queue in a `blocked` state with diagnostics instead of retrying forever.
Inspect it via the daemon's local `/health` endpoint (`outbox` block). Size
cap: `MULTIREMI_OUTBOX_MAX_BYTES` (default 256 MB) — oldest non-terminal
records are dropped over the cap; terminal complete/fail events are never
dropped.
