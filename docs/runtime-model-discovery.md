# Runtime Model Capabilities

For workspace Codex relays, two gateway endpoints serve different purposes:
`<base_url>/models` supplies available IDs and labels, while
`<origin>/backend-api/codex/models` supplies the native model catalog, including
per-model reasoning options and defaults. The server stores only the compact
capability snapshot. Codex entries explicitly hidden or unsupported by the API
are excluded from the selectable inventory. It retains the existing public-host check, response size
limit, timeout and configuration-revision fence.

The daemon separately downloads the complete native catalog into its isolated
probe/session `CODEX_HOME/model-catalog.json` with mode 0600. It injects the
absolute `model_catalog_json` path at the top level of `config.toml`. Provider
fragments and inherited host settings cannot supply this path. On download or
write failure the pointer is omitted, Codex uses its bundled catalog, and the
failure is reported in task progress and model capabilities. Custom Runtime
connections retain their own ACP capability discovery; they are not assumed to
implement the workspace relay's Codex endpoint.

Codex app-server reads this file at startup. ACP exposes its model capabilities
through the `thought_level` selector; Remi probes each model and reports the
supported values and the model default. On bridges supporting recommended config
values, that metadata is authoritative: model switches can otherwise retain a
previous effort, so `currentValue` is not always the model default. User settings
are not changed by this independent probe. Before a real Codex prompt, unavailable
explicit models and unacknowledged model/effort changes produce an error; the
Codex bridge cannot silently keep a different model or effort. Claude keeps its
existing SDK model alias and 1M context negotiation.
The startup override follows the [official Codex configuration mechanism](https://developers.openai.com/zh-Hans/docs/config-file/config-advanced).

`GET /api/models` and `remi runtime model catalog --agent <agent-id> --json`
return `thinking.supported_levels`, `thinking.default_level`, and
`thinking.status` (`supported`, `unsupported`, `unknown`, or `error`). An empty
explicit declaration means unsupported; absent metadata means unknown; malformed
metadata or a failed load means error. Unknown/error states never make stale
levels selectable. The UI displays these states separately and labels the model
default as informational: an empty saved override still follows runtime settings.

Server validation, task eligibility, and the UI use the same capability catalog.
Authoritative per-model gateway metadata takes priority over runtime declarations,
except an execution runtime's load failure blocks its levels. Missing metadata
can use an exact runtime model match; it cannot borrow another provider model's
levels. Claude retains exact-model and existing unambiguous Claude-family
capabilities, without a provider-wide guess for unrelated models.

Production daemons discover capabilities at startup and refresh every 15 minutes.
Manual model-list requests use the same single-flight probe without blocking the
heartbeat loop. The probe runs as a separate `remi runtime-model-probe` process.
It receives options over stdin, not command arguments, and sends no AI prompt.
The supervisor limits runtime/output size, rejects malformed results and terminates
the process group on failure, cancellation, timeout, or completion. Provider
errors are not copied verbatim into daemon logs because they can contain secrets.

The control plane and daemon both require this update. Existing running provider
processes are not restarted. `model_catalog_json` replaces the entire Codex
bundled catalog; it changes model defaults and system templates as well as model
availability. See [MUL-330 verification](mul-330-gateway-reasoning-verification.md)
for the isolated execution evidence and observed GPT differences. Do not describe
this as a merge of catalog entries or as an already deployed change.

Disabled plugin bindings remain readable after switching engine and are excluded
before computing task snapshots. Creating/enabling bindings still validates engine
compatibility, and cross-workspace bindings remain invalid.
