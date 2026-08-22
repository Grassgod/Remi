# Platform deployment

The API records lifecycle operations. A host-owned `remi-platform-updater`
service executes them through one deployment driver. The API container never
receives the Docker socket and cannot invoke `systemctl`.

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
   Compose env file.
3. Copy the existing uploads, session archives, and SSH Mesh directories under
   `REMI_STATE_ROOT`, preserving ownership and mode. Set `REMI_RUNTIME_UID` and
   `REMI_RUNTIME_GID` to that owner.
4. Start on the staging ports (`16120` and `13000`) with
   `REMI_SSH_MESH_CONTROL_PLANE=0`. Verify API, Web, login, database-backed
   counts, OpenViking readiness, attachments, and WebSockets.
5. Stop the host API/Web, set `REMI_SSH_MESH_CONTROL_PLANE=1`, start the app
   stack, verify SSH Mesh ownership, then switch the reverse proxy to the new
   ports. Keep the host units installed but stopped for rollback.

The updater may use this Compose file after cutover. Set
`MULTIREMI_PLATFORM_POSTGRES_CONTAINER` and
`MULTIREMI_PLATFORM_OPENVIKING_CONTAINER` so externally managed dependencies
still appear in the service status panel.
