# Zadig PPE deployment

This deployment runs Zadig on a single-node k3s cluster beside the production
Multiremi Docker stacks. It does not build, release, update, or restart the
production platform.

## Boundaries

- Runtime data is rooted at `/data00/multiremi/zadig`.
- k3s uses `172.28.0.0/16` for Pods and `172.29.0.0/16` for Services. These
  ranges do not overlap the production Docker networks.
- Traefik and ServiceLB are disabled. Zadig keeps NodePort `32080` as its
  internal edge. Host Nginx exposes the stable public URL
  `http://n37-117-209.byted.org:410`; `/ci` redirects to that URL.
- Six pre-created namespaces (`multiremi-ppe-1` through
  `multiremi-ppe-6`) are the complete PPE capacity pool. Workflows atomically
  assign an empty slot to an `ISSUE_KEY`; agents never choose slots manually.
- A successful deployment renews its lease for 24 hours. A collector runs every
  five minutes and removes expired workloads, volumes, secrets, and leases.
  Normal QA completion releases its lease immediately; TTL is the fallback.
- Each slot has a ResourceQuota of 6 requested CPUs/8 GiB requested memory and
  12 CPU/16 GiB limits. The quotas keep PPE workloads from starving production.
- Zadig's workflow execution and workflow task concurrency are both `3`. The
  bootstrap script applies this through Zadig's authenticated API; this is a
  Zadig setting rather than a Multiremi server gate.
- A local, PPE-only OCI registry is exposed on NodePort `32050`. Its persistent
  data stays under the k3s data root on `/data00`; it is not a production image
  source.
- `configure-ppe.sh` creates the `multiremi-ppe` project, registers six fixed
  environment records, installs one lifecycle workflow, and grants the
  `multiremi-qa` identity only enough project permissions to inspect and run it.

## Install or upgrade

Run the read-only preflight first, then the idempotent installer:

```bash
bash deploy/zadig/preflight.sh
sudo bash deploy/zadig/install.sh
```

The installer pins k3s, Helm, and Zadig versions in `versions.env`, verifies
download checksums, preserves the Zadig encryption key in a mode-0600 file, and
finishes with the same checks as `verify.sh`. To upgrade, update the pinned
versions and checksums in one reviewed change, then rerun the installer.

The installer calls `bootstrap.sh` to initialize the administrator, generate an
isolated non-admin `multiremi-qa` account, and set both concurrency values to
three. It never prints credentials. Read the initial administrator password
only on the host when it is needed:

```bash
sudo cat /data00/multiremi/zadig/secrets/admin-password
```

The administrator and API token can also be initialized or repaired separately:

```bash
sudo bash deploy/zadig/bootstrap.sh
sudo bash deploy/zadig/configure-ppe.sh
sudo bash deploy/zadig/configure-edge.sh
```

Explicitly rotate the QA API token after suspected disclosure or credential
expiry, then update the existing QA Agent's Custom Env with the new value:

```bash
sudo env ROTATE_ZADIG_QA_TOKEN=1 bash deploy/zadig/bootstrap.sh
```

The QA account is deliberately created without a system role. After creating
the Multiremi PPE project in Zadig, grant it a project-scoped role only. Do not
give it system-admin or production environment permissions. The Zadig
user-management UI remains the source of truth for account lifecycle and role
bindings.

This account is a credential identity for the existing Multiremi `QA小姐姐`
Agent, not another Agent. Inject `ZADIG_HOST`, `ZADIG_API_TOKEN`, and the pinned
`ZADIG_CLI_PACKAGE` into that Agent's Custom Env. The accompanying Skill supports
both control-plane-only (`platform`) and isolated control-plane-plus-daemon
(`platform-daemon`) verification. Neither mode may touch production daemons.

The workflow accepts an Issue key and exact 40-character Git commit, atomically
allocates an empty PPE, and builds API/Web images inside it. Re-running the same
Issue reuses its lease. Images already present for that exact Commit
are reused. `platform-daemon` also starts an isolated daemon from the same API
image with a deterministic fake ACP bridge and an ephemeral, non-secret Codex
test identity. This proves runtime registration and transport without copying a
real Codex/Claude credential into PPE. The control plane and daemon both use the
version from the target Commit's `package.json`, including when reusing existing
images, because the server rejects daemons below `DAEMON_MIN_CLI_VERSION`.
After changing `ppe/workflow.sh`, rerun `configure-ppe.sh` as root on 209 so Zadig
loads the updated workflow definition. The workflow emits a structured
`PPE_RESULT` containing its slot, lease ID, URL, state, and expiry. Browser URLs
are `http://10.37.117.209:32101` through `:32106`; PPE intentionally has no
Feishu SSO, needs no custom Header, and must never receive a production Web token.

The all-role API uses `Recreate` so the old single hub owner exits before its
replacement starts. Its state, config, migration reports, uploads and Session
Archives have explicit paths under `/srv/multiremi`, mounted from the slot's
`multiremi-data` PVC. Setting `HOME` alone does not establish the OS home path
used by Bun. Pod replacement preserves the original migration reports beside
the retained PostgreSQL database; missing reports still fail the migration
gate and require restoration. Never recreate reports or alter migration markers
to bypass that failure.

Each deploy generates an isolated random Feishu credential encryption key in
the namespace's `ppe-secrets` Secret and supplies it to the API through a Secret
reference. This key survives Pod replacement and supports synthetic presenter
configuration without importing a production key. A workflow `deploy` resets
the managed workloads and PVCs even when it reuses the Issue's lease; `release`
or TTL collection also removes them. These are disposable PPE data, while a
normal Pod restart retains the current deploy's data and Secret.

## Verify

```bash
sudo bash deploy/zadig/verify.sh
```

The check covers the k3s node, Helm release, Zadig Pods, NodePort, HTTP entry,
the PPE registry, the six PPE slots, the 24-hour collector, and the two
authenticated concurrency settings.

## Remove Zadig

Removal is deliberately explicit. It removes the Helm release and six PPE
namespaces, while retaining k3s and `/data00/multiremi/zadig` for diagnosis:

```bash
sudo env CONFIRM_REMOVE_ZADIG=remove-zadig-and-ppe \
  bash deploy/zadig/remove.sh
```
