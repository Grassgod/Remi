# v0.2.82 Release Fixture

Source: [the published v0.2.82 release](https://github.com/Grassgod/Remi/releases/tag/v0.2.82).
Checksums below are GitHub's release-asset `digest` values, independently verified for the downloaded Linux x64 archive.
Do not rebuild this fixture from current source or execute `install-remi.sh`.

| Archive | SHA-256 |
| --- | --- |
| `remi-0.2.82-linux-x64.tar.gz` | `97f966b1978b0c091eb05efdc3089f2addf86eca688e5ba5cab541f61a19b836` |
| `remi-0.2.82-linux-arm64.tar.gz` | `fd133dce6822864e04841165065cfb441560331cf5d6f9a7fe429ae27e459d44` |
| `remi-0.2.82-darwin-x64.tar.gz` | `f7b5081f55967b662423cc0c129e9e3855fb760c7079ee5253c658ecc9098f2c` |
| `remi-0.2.82-darwin-arm64.tar.gz` | `0daf3545da5a1bf9376deb6221f70dcdd024ebb4d197e6b3b72b4f532adffbd2` |

Reproduce on Linux x64 (select the corresponding archive on other supported hosts):

```bash
mktemp -d /tmp/remi-v1-release.XXXXXX
# Use the returned directory for both commands, with existing gh authorization.
gh release download v0.2.82 --repo Grassgod/Remi \
  --pattern remi-0.2.82-linux-x64.tar.gz --dir /tmp/remi-v1-release.<suffix>
sha256sum /tmp/remi-v1-release.<suffix>/remi-0.2.82-linux-x64.tar.gz
bun tests/manual/probe-daemon-v1-release.ts /tmp/remi-v1-release.<suffix>/remi-0.2.82-linux-x64.tar.gz
```

[DaemonV1ReleaseHarness](../../fixtures/daemon-v1-release.ts) verifies the checksum before extraction,
checks the binary's version (`--version`: `0.2.82`; daemon health/registration: `v0.2.82`), and starts it with a new
HOME/state directory and explicitly supplied local fixture token. Extraction does not restore the CI archive's file owner.
It never inherits deployment tokens, service-manager identity or provider credentials. The server URL must be a literal
loopback address with an explicit port. The existing fake Antigravity provider is used, and a local inert installer
returns exit 42 so no release is installed or successor spawned. Tokens are not written to configuration or capture files.

The manual probe starts a fresh published v0.2.82 process twice, with empty and nonempty desired Plugin state.
It requires the real process to reach its first heartbeat and receive `pending_update` after the desired GET;
an early process exit or 15 seconds without heartbeat fails. The tag's default heartbeat period is 10 seconds,
with 5 seconds allowed for local startup scheduling. The nonempty Claude scenario requires an existing
`REMI_CLAUDE_AGENT_ACP_DIR` package path for the release binary's health check; only that path is passed
into the otherwise isolated child. The probe separately verifies claim-null, retired-report 426, runtime
`upgrade_pending`, and one pending update row. A nonempty desired set may trigger retired Plugin state
POSTs returning 426 before heartbeat; these do not block startup and are not restored.
Keep teardown ordered: daemon exit and output drain, server request drain, server stop, then Store close. A failed probe
does not relax a timeout or leave a daemon behind. The archive is caller-owned; the harness removes only its own extracted
temporary directory after the child exits.
