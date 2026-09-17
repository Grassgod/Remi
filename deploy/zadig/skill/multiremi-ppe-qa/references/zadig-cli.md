# Zadig CLI reference

## Connection checks

```bash
runtime_home="${HOME:?}"
zadig_home="$(mktemp -d)"
chmod 700 "$zadig_home"
zadig_cli=(env HOME="$zadig_home" npm_config_cache="$runtime_home/.npm"
  npx --yes --registry=https://registry.npmjs.org
  "${ZADIG_CLI_PACKAGE:-@koderover/zadig-cli@0.1.6}")
"${zadig_cli[@]}" version
"${zadig_cli[@]}" auth status --output json
"${zadig_cli[@]}" doctor --output json
"${zadig_cli[@]}" doctor agent codex --output json
"${zadig_cli[@]}" doctor agent claude-code --output json
```

Use `zadig --help` and the relevant subcommand `--help` as the source of truth.
The CLI supports projects, services, environments, builds, workflows, workflow
tasks, tests, logs, users, permissions, dry runs, confirmations, and JSON output.

## Operating rules

- Prefer `--output json` for reads and parse exact IDs instead of display names.
- Preview writes with `--dry-run`; execute reviewed writes with `--yes`.
- Wait for workflow completion with the CLI rather than polling ad hoc HTTP
  endpoints.
- Fetch only the log section needed to diagnose a failure. Never copy tokens,
  credentials, cookies, environment dumps, or complete logs into an Issue.
- Treat non-zero exit codes and structured errors as failures. Do not infer
  success from an empty response.

## Test scopes

- `platform`: deploy and verify the control plane only.
- `platform-daemon`: deploy the control plane and an isolated daemon built from
  the same commit. Verify registration, heartbeat, dispatch, completion, log
  delivery, and teardown.

Never point the PPE daemon at production or point a production daemon at PPE.
Host-specific daemon tests may use only the dedicated target configured by the
workflow, with a unique state directory and runtime identity.

## Lifecycle workflow

The project key is `multiremi-ppe` and the workflow key is
`multiremi-ppe-deploy`. Read `workflow prepare` first. A deploy Run file has
this shape; replace the Issue, commit, and mode. Slot allocation must remain
automatic:

```json
{
  "parameters": [
    {"name":"PPE_ACTION","type":"choice","value":"deploy"},
    {"name":"PPE_SLOT","type":"choice","value":"auto"},
    {"name":"ISSUE_KEY","type":"string","value":"MUL-123"},
    {"name":"PPE_LEASE_ID","type":"string","value":""},
    {"name":"GIT_COMMIT","type":"string","value":"FULL_40_CHARACTER_SHA"},
    {"name":"PPE_MODE","type":"choice","value":"platform"}
  ],
  "inputs": [{
    "job_name":"ppe-lifecycle",
    "job_type":"freestyle",
    "parameters":{"kv":[],"repo_info":[],"services":[]}
  }],
  "notify_inputs": []
}
```

Run it with `workflow run ... --dry-run`, then `--yes --watch`. Parse the last
`PPE_RESULT` line from the task log and retain its `slot`, `lease_id`, `url`,
and `expires_at`. A `provisioning` result is emitted before builds start so a
failed deployment can still be released safely.

For `release` or `extend`, pass the original `ISSUE_KEY`, numeric `PPE_SLOT`,
and `PPE_LEASE_ID`; the workflow rejects a mismatched lease. `status` lists
current leases and does not require an Issue or lease ID. Deploying the same
Issue again reuses its slot and renews the 24-hour TTL. Normal QA completion
must call `release`; automatic TTL collection is the fallback. Do not delete
`ppe-1` through `ppe-6`, because they are permanent slot records.

## Multiremi handoff

Use the installed Remi CLI for Issue reads and comments. Zadig credentials are
valid only for Zadig and must never be passed to Remi commands.
