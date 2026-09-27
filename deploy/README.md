# Platform deployment

For two isolated environments on one development computer, use the
[local stable/dev guide](../docs/deploy/local-profiles.md). It runs separate
API/Web/PostgreSQL projects and does not use the host updater described below.

The API records lifecycle operations. A host-owned `remi-platform-updater`
service executes them through one deployment driver. The API container never
receives the Docker socket and cannot invoke `systemctl`.

## Release pipeline

Prepare every release, including nightly releases, with Bun 1.3.14:

```bash
git fetch origin --tags
bun run release:prepare --version <next-unused-version>
```

This resolves the latest stable ACP bridges, Claude SDK/CC and Codex from the
public npm registry, installs them in a disposable home, verifies executable
versions and ACP initialization, then updates `package.json` and the tracked
runtime snapshot. `--dry-run` performs the same checks without editing files.
Review and commit both files as the release change. Preparation failure leaves
both files unchanged. The command does not create commits, tags or releases.

Push a formal SemVer tag only after the tag commit's `Release build check` run
on `main` succeeds. The tag-triggered `Release` workflow publishes the daemon
CLI GitHub Release first, then calls the reusable `Platform release` workflow
to publish the API/Web images and attach the platform manifest and systemd
archive to the same release.

Select a new, unused SemVer version only for an explicitly requested release;
the package version, tag, and GitHub Release must agree. See [repository release
rules](../AGENTS.md).

CI rejects version bumps without a matching prepared runtime snapshot. The tag
workflow checks that snapshot and successful full CI on the exact main commit
before publishing the CLI; it does not resolve dependencies again after tagging.
See [daemon runtime upgrades](../docs/daemon-runtime-upgrades.md) for installation.

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

Keep `platform.env` and `api.env` outside Git with mode `0600`. Create `api.env`
from [`docker/api.env.example`](docker/api.env.example), replace every required
placeholder, and enable only the optional features the deployment uses. Never
commit the populated file. Set API and Web images to immutable GHCR digests from
`platform-release.json`, then run:

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
2. Copy `deploy/docker/api.env.example` to an API env file outside Git, replace
   its required placeholders, set mode `0600`, and change the database hostname
   to the existing network alias (`postgres` by default). Do not copy secrets
   into the Compose env file. Create a separate control-plane env file whose database
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

Message ingestion needs no service of its own. `lark-cli` is baked into the API
image at a pinned, checksum-verified version, and the API server runs it
directly, so there is no ingestion container, port, or endpoint registry to
configure. Enable it by logging in once inside the API container:

```bash
docker compose exec api lark-cli login
```

The credential lands in the container's home directory, which is the
`REMI_HOME_DIR` bind mount, so it survives image upgrades and never enters
Compose, an env file, or Git. An installation upgrading from the retired
`feishu-sidecar` needs no action: the updater removes that leftover container
before it replaces the API container, and leaves its named data volumes alone.
See [`docs/feishu-message-ingestion.md`](../docs/feishu-message-ingestion.md)
for the connection model, the rollout runbook, and rollback.

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

The default 8 MiB fallback rejects larger archives unless a direct route is
attested. Operators may configure `MULTIREMI_ARCHIVE_PROXY_MAX_BYTES`, but a
larger limit does not establish the capacity of their proxy. Validate the actual
deployment route and upload behavior before changing it.

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
remove or narrow any covering `^~` prefix. Inspect the target deployment's
effective configuration; a configuration checked on another host or release
does not establish the current route.

When enabling direct uploads on a deployment, perform these checks:

1. Read the deployment's Compose env and confirm the effective host API port;
   do not assume the sample port.
2. Inspect `nginx -T` for earlier matching regexes and covering `^~` prefixes,
   then add the direct location, run `nginx -t`, and reload Nginx. Its position
   relative to an ordinary Web catch-all is irrelevant.
3. Add `MULTIREMI_DAEMON_DIRECT_BASE_URL=https://<public-api-host>` to the
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

`remi session archive retry <issue> <archive-id>` also accepts an exhausted failed archive. It
resets the attempt count, error, backoff timestamp, and exhaustion timestamp,
returning the row to `pending` with `retry_state=eligible`. Run it once per
failed archive only after the direct route and API setting pass the HEAD check;
the daemon will claim and upload the recovered attempt on its next archive run.

Do not expose the API container port directly to the network and do not place
daemon tokens in Nginx configuration or logs.

## Split API roles

A deployment can run the browser surface and the daemon surface in two API
containers instead of one. The daemon surface carries 94% of the request volume
and is a separate process so its load cannot queue behind the browser surface.
`compose.application.yml` and `compose.platform.yml` ship the second service as
`api-runtime`, behind the `split` profile, so **the default stack is unchanged**:
without `--profile split` those files declare exactly the services they always
did, and with `REMI_API_ROLE` unset the `api` container answers both surfaces
with health payloads that are byte-for-byte what they are today.

The switch is an operator action, not a release action. The Compose file, the
Nginx configuration, and the updater binary are host files: the daily release
only replaces images, so merging the templates does not move a running
installation. It happens in **two stages**, and the split into stages is what
keeps the first rollback to a single file:

- **Stage A (route the traffic)** moves the daemon surface to `api-runtime` via
  Nginx. The `api` container keeps its default role, so nothing about the
  browser process changes yet. Its rollback is Nginx only.
- **Stage B (add the guard)** turns `api` into role `ui` so a misrouted daemon
  request is answered with `421 misdirected` instead of being served. This is an
  insurance policy, not the source of the performance win: the win comes from
  the routing in stage A. Its rollback first puts the role back, then rolls back
  stage A.

Both stages are outside the release path and only touch the Compose file, the
Compose env file, Nginx, the updater env file, and the `api-runtime` container.
Neither stage writes to the database.

### Where each variable lives

`REMI_API_ROLE` and `REMI_API_PEER_URL` are **Compose interpolation variables**.
They are read by `docker compose` itself to render `compose.application.yml`, so
they belong in the Compose env file (the file passed as `--env-file`, next to
`REMI_API_IMAGE`, or the `.env` in the Compose project directory) or in the
calling environment, **not** in the API `env_file`:

- The API `env_file` (for example `/etc/multiremi/api.env`) is passed to the
  container as-is and holds secrets such as `MULTIREMI_TOKEN`. Values set there
  are read by the API process only if the service's `environment` does not
  define the same key.
- The `api` and `api-runtime` services **do** define `MULTIREMI_API_ROLE` and
  `MULTIREMI_PEER_URL` in their `environment` block, and service-level
  `environment` wins over `env_file`. Writing `MULTIREMI_API_ROLE=ui` into the
  API `env_file` therefore has no effect at all: the container still receives
  the value Compose interpolated.

Confirm the rendered result before moving on. This prints what the containers
will actually get:

```bash
docker compose --env-file /etc/multiremi/application.env \
  -f /multiremi/platform/container/compose.application.yml \
  config | grep -A2 MULTIREMI_API_ROLE
```

`MULTIREMI_PEER_SECRET`, by contrast, **is** read by the API process and goes in
the API `env_file`; it defaults to `MULTIREMI_TOKEN` when unset.

### Stage A: route the traffic

Prerequisites:

- A release whose API image understands `MULTIREMI_API_ROLE`, `MULTIREMI_PEER_URL`
  and `MULTIREMI_PEER_SECRET` is already deployed, and `api_minute_summary` in
  the API logs carries a `pid`, so the two processes are distinguishable.
- Data-driven write paths are covered by the two-process integration test suite
  (MUL-463 stage 1: browser `comment:created` delivery 20/20, daemon
  `daemon:task_available` wake-up, claim is not duplicated). This runbook does
  **not** re-test them with writes on production.
- Prepare the rollback files up front, so rollback is a copy and not an edit.
  `<compose-dir>` is the directory holding the host Compose file; `<date>` is
  today:

  ```bash
  mkdir -p <compose-dir>/backups/<date>
  cp /etc/nginx/sites-enabled/remi <compose-dir>/backups/<date>/nginx-remi.conf.orig
  cp <compose-dir>/application.env   <compose-dir>/backups/<date>/application.env.orig
  cp /etc/multiremi/platform-updater.env \
     <compose-dir>/backups/<date>/platform-updater.env.orig
  ```

1. **Updater binary first.** This is the one step that cannot be undone by a
   reload. Build `apps/platform-updater/main.ts` from the release tag on a build
   host (Bun 1.3.14), replace `bin/multiremi-platform-updater` on the host, keep
   the previous file as `bin/pre-<tag>.<rand>/`, and restart
   `remi-platform-updater`. Leave `MULTIREMI_PLATFORM_CORE_SERVICES` unset at
   this point: unset is today's behaviour, including the pull list.
2. **Compose.** Merge the `api-runtime` service and the two `api` env lines into
   the host Compose file, keeping host-specific differences such as ports. In
   the Compose env file add `REMI_API_RUNTIME_BIND_PORT=16121` and
   `REMI_API_PEER_URL=http://api-runtime:6120`; **leave `REMI_API_ROLE` unset**,
   so `api` keeps its default role. Check the rendering with
   `docker compose config`.
3. **Start the runtime container.**
   `docker compose --profile split up -d --no-deps api-runtime`, then wait for
   healthy and confirm `curl -s 127.0.0.1:16121/readyz` reports
   `role: runtime`. Its logs must show background jobs disabled and no migration
   errors.
4. **Let `api` reach its peer.** Recreate `api` once
   (`docker compose up -d --no-deps api`, the same short outage as a normal
   release) and confirm `/internal/peer/health` answers on both containers
   (`6120` and `16121`).
5. **Nginx.** Two files, two contexts — the contexts are not interchangeable:
   - [`nginx/api-runtime-split-upstream.conf`](nginx/api-runtime-split-upstream.conf)
     defines `upstream multica_api_runtime`. It belongs in the **`http`**
     context, because `upstream` is only valid there. Include it from the
     `http` block of `nginx.conf`, or copy the `upstream` line into it.
   - [`nginx/api-runtime-split-locations.conf`](nginx/api-runtime-split-locations.conf)
     contains only `location` blocks. Include it in **each public `server`
     block** (the :80 and the :443 one), next to
     [`nginx/session-archive-direct.conf`](nginx/session-archive-direct.conf).
     Point that file's archive location at `multica_api_runtime` as well.

   Putting the `upstream` line inside a `server` block is the mistake this split
   exists to prevent: `nginx -t` fails with
   `"upstream" directive is not allowed here`. Both files explain why the daemon
   location must be an ordinary prefix and must keep its trailing slash. Keep a
   copy of the original configuration (see the prerequisites), then:

   ```bash
   nginx -t && systemctl reload nginx
   ```

   Daemon WebSockets that are already established stay on `api`; that is
   expected during the transition.
6. **Observe for 30 minutes, read-only.** No writes are needed, and none should
   be made on production for this step:
   - both processes' `/readyz` answer, and `api-runtime` reports
     `role: "runtime"`;
   - in `api_minute_summary`, both sides' `peer` counters (`sent`, `dropped`,
     `failed`) — `dropped` and `failed` must stay 0 — and the daemon routes
     appear under `api-runtime`'s `pid`;
   - under existing traffic, daemon heartbeats and claims keep succeeding, and
     the `api` container's `/api/daemon/*` counters fall towards zero (residual
     counts are WebSockets established before the reload, which age out).
7. **Updater list.** Set
   `MULTIREMI_PLATFORM_CORE_SERVICES=api,web,ssh-mesh-control-plane,api-runtime`,
   `MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS=http://127.0.0.1:16121/readyz`, and
   `COMPOSE_PROFILES=split` in the updater env file, then restart the updater.
   `COMPOSE_PROFILES=split` is explicit rather than conditional: it is what makes
   the updater's own `pull` and `up` see the profiled service on every Compose
   version, instead of relying on the version treating an explicitly named
   service as profile-enabling.

   Before starting the switch, verify what the updater actually resolved —
   **do not begin if the list is not the four services**:

   ```bash
   cd /multiremi/platform/container
   set -a; . /etc/multiremi/platform-updater.env; set +a
   echo "$MULTIREMI_PLATFORM_CORE_SERVICES" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sort
   # must print: api, api-runtime, ssh-mesh-control-plane, web  (one per line)
   docker compose --env-file application.env -f compose.application.yml \
     config --services | sort
   # must list api, api-runtime, ssh-mesh-control-plane, web (plus dependencies)
   ```

   Skipping this step leaves `api-runtime` untouched by the next release, so the
   two processes drift a release apart. The updater also logs a warning when the
   configured list is missing `api` or `web`.

### Stage B: add the guard

Run this only after stage A has been stable for the agreed observation window
and the `api` container's `/api/daemon/*` counters have reached zero (daemons
reconnect within 1-30 s). Nothing about the performance win depends on this
step; it exists so a misrouted daemon request is rejected loudly instead of
being served by the wrong process.

1. Add `REMI_API_ROLE=ui` to the **Compose** env file.
2. Recreate the container so it picks the value up:
   `docker compose up -d --no-deps api` (~30 s outage, the same as a release).
3. Confirm `curl -s 127.0.0.1:6120/readyz` now reports `role: "ui"`, and that a
   daemon request to `api` returns `421 misdirected` with the `X-Remi-Api-Role`
   header (Nginx sends real daemon traffic to `api-runtime`, so this only shows
   up on a direct probe).

### Rollback

The stage boundary is what makes the first rollback cheap, and the order inside
stage B is not interchangeable: rolling the routing back before the role would
leave `api` as `ui`, answering `421` to the daemon traffic Nginx just returned
to it.

**Stage A rollback**: Nginx only, **3 commands, no container recreated.**

```bash
cp <compose-dir>/backups/<date>/nginx-remi.conf.orig /etc/nginx/sites-enabled/remi
nginx -t
systemctl reload nginx
```

The `api-runtime` container and the updater list stay as they are, which is
harmless: with daemon traffic back on `api`, the runtime container keeps its peer
channel open and simply reports no traffic.

Measured in a local sandbox on nginx 1.22.1, with the snippets assembled as step
5 describes and the route difference verified end to end (daemon paths served by
`api-runtime` before, by `api` after): the three commands take about 0.02 s and
the change is visible in about 0.15 s across five runs. The one-minute budget is
therefore dominated by the operator, not by `nginx -t` or the reload. The full
host-level rehearsal and the formal timing are MUL-463 stage 2.

**Stage B rollback: 1 edit + 2 commands**, in this order.

```bash
# 1. Remove REMI_API_ROLE from the Compose env file (back to unset).
# 2. Recreate `api` so it drops the guard (~30 s outage, like a release):
docker compose -f <compose-dir>/compose.application.yml up -d --no-deps api
# 3. Health check, then optionally run the stage A rollback above:
curl -s 127.0.0.1:6120/readyz
```

**Full return to a single process**, on top of the two rollbacks above:
**3 edits + 3 commands**, plus health checks.

```bash
# 1. In the updater env file, remove api-runtime from
#    MULTIREMI_PLATFORM_CORE_SERVICES, remove
#    MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS, and remove COMPOSE_PROFILES=split.
docker compose --profile split stop api-runtime
systemctl --user restart remi-platform-updater
curl -s 127.0.0.1:6120/readyz && curl -s 127.0.0.1:3000/login
```

To restore the previous updater binary instead (only if the updater itself
misbehaves), copy the file back from `bin/pre-<tag>.<rand>/` and restart
`remi-platform-updater`; that is 2 commands and no edit. No database change is
involved at any layer, so no data layer needs rolling back.

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
- The task wait has no deadline by default: `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS=0`
  (or unset) waits until existing tasks finish or the operator cancels. New
  tasks remain queued throughout the wait. This does not disable the 120 s
  crash-recovery lease above. Human-blocked or stuck tasks still need operator
  attention; cancel the update to resume scheduling without interrupting them.
- Operators can opt into a finite wait with a positive
  `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS`. If it expires, the switch is NOT
  executed, the operation fails, and scheduling resumes. There is no automatic
  force-update. An existing positive override is still honored after upgrading.
- Operators can cancel an update from the 版本与服务 page until the switch
  phase begins (`queued/preparing/pulling/draining`).
- Old daemons that do not report a drain ack keep the gate closed: upgrade or
  retire them first, cancel the operation, or configure a finite wait.

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
