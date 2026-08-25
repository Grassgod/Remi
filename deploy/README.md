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
