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
