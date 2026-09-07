# Runtime Model Capabilities

The gateway supplies available model IDs. Each runtime supplies model-specific
reasoning options discovered from its installed ACP bridge. The server joins
these by model ID for `GET /api/models` (`remi runtime model catalog`). A missing
capability record means unknown, not that a model lacks reasoning.

Production daemons discover capabilities at startup and refresh every 15 minutes.
Manual model-list requests use the same single-flight probe without blocking the
heartbeat loop. Failed discovery retains the last successful catalog and retries
with bounded exponential backoff.

The probe runs as a separate `remi runtime-model-probe` process. It inherits a
daemon-owned isolated provider home and receives options over stdin, not command
arguments. It queries configuration selectors only, without sending an AI prompt.
The supervisor limits runtime and output size, rejects malformed results, and
terminates the process group on failure, cancellation, timeout, and completion.
Provider errors are not copied into daemon logs because they can contain secrets.
The old in-process probe remains available only to injected test providers.

After this change is deployed, the daemon must be upgraded too: upgrading only the
control plane does not restart capability discovery on an old daemon. A gateway-only
model stays unknown until the runtime's installed bridge advertises its capabilities;
do not fill in another model's reasoning levels as a substitute.

Disabled plugin bindings remain readable after switching engine and are excluded
before computing task snapshots. Creating/enabling bindings still validates engine
compatibility, and cross-workspace bindings remain invalid.
