# MUL-330: isolated gateway reasoning verification

Verified on 2026-09-18 using the existing gateway `https://ai.openremi.fun`,
Bun 1.3.14, the installed Remi bundle's `@agentclientprotocol/codex-acp` 1.12.0,
and its bundled `codex-cli` 0.155.0. The initial investigation used a different
binary (`codex-cli` 0.153.4); catalog membership below describes 0.155.0.

No shared gateway settings or running sessions were changed. Fresh private
`CODEX_HOME` directories contained 0600 catalog/config/auth files. Credentials
were read in-process, never printed or placed in argv; temporary auth copies
were removed after the checks. Only two runs of the DeepSeek max prompt described below were
forwarded upstream (the second after adding strict model/effort acknowledgments). GPT request comparisons terminated at a loopback HTTP
capture endpoint.

## Evidence: catalog → app-server → ACP → actual model request

The original `/backend-api/codex/models` response was written unchanged into the
isolated home and selected with the top-level `model_catalog_json` TOML key.
The fetched response contained 10 models, 394,730 characters, SHA-256
`65ef7c2624c0af69295543c46233eda6c6bac986280b7317e9521a602bf90b2e`.
The full response and instruction templates are intentionally not committed.

1. Start `codex app-server` in the isolated home, initialize JSON-RPC, and call
   `model/list`. `deepseek-flash` advertises `low`, `high`, `max`, default `high`.
2. Run the modified `AcpProvider.discoverModelCapabilities()` against the real
   ACP bridge and isolated home. It reports the same values, default and
   `status: supported`. Each of the other three DeepSeek models reports the
   same capability values from its own metadata.
3. Call `AcpProvider.send()` with `model: deepseek-flash`, `effort: max`, and the
   prompt `Reply only with OK. Do not call any tools.`. The provider applies
   the advertised ACP `thought_level` selector before prompting.
4. A loopback proxy forwards the engine's request to the real gateway and
   captures only selected non-secret body fields:

   ```json
   {
     "path": "/v1/responses",
     "model": "deepseek-flash",
     "reasoning": { "effort": "max", "summary": "auto" },
     "upstreamStatus": 200,
     "responseText": "OK"
   }
   ```

The actual request's `instructions` was 21,335 characters, SHA-256
`c2a980bc28af132eb89e0b4c68ae884043faae83a1afd3fd4889f7e8a1ada7b0`, exactly matching
that model's gateway `instructions_template`. This verifies a real engine
request and successful gateway response, beyond merely saving a UI setting.
After strict Codex model/effort acknowledgment checks were added, the same isolated
DeepSeek max execution again returned HTTP 200 / OK with effort max on the wire.

## Default effort: current selection can survive model changes

The pinned Codex ACP 1.12.0 bridge preserves the previous model's reasoning
value when the new model supports it. Consequently, `currentValue` after a
model switch alone does not identify the new model's default.

The bridge already supports the following capability negotiation:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": { "version": 1, "capabilities": ["recommendedValue"] }
      }
    }
  }
}
```

With this capability the `thought_level` option includes its authoritative
default under `_meta.jetbrains.air.recommendedValue`. Remi now requests and
reads it without changing the active selected effort. A retained value without
recommendation metadata is not reported as a discovered default.

A second real ACP discovery after this fix compared every visible model's
default with the loaded app-server catalog: all nine visible models matched.
`gpt-reserve` is hidden from the normal ACP selector; it appears only in the
`includeHidden: true` app-server comparison below. The raw directory marks it
`visibility: hide`, `supported_in_api: true`; the other nine entries use
`visibility: list`. The plain `/v1/models` list includes both `gpt-reserve` and
`codex-auto-review`, despite the latter being absent from the native directory.

## GPT catalog comparison

`model_catalog_json` replaces the bundled catalog as a whole. These are actual
`model/list` results from separate bundled/catalog homes, including hidden
models for the membership comparison.

| Model | Bundled default | Gateway default | Supported efforts in both |
| --- | --- | --- | --- |
| gpt-6-astra | low | medium | low, medium, high, xhigh, max, ultra |
| gpt-5.6-sol | low | low | low, medium, high, xhigh, max, ultra |
| gpt-5.6-terra | medium | medium | low, medium, high, xhigh, max, ultra |
| gpt-5.6-luna | medium | medium | low, medium, high, xhigh, max |
| gpt-5.5 | medium | medium | low, medium, high, xhigh |

The common five GPT models retain their effort sets. `gpt-6-astra` changes its
default from `low` to the gateway's `medium`. The gateway adds hidden
`gpt-reserve` (default `medium`; low/medium/high/xhigh/max) and the four DeepSeek
models. Bundled 0.155.0 entries `gpt-daybreak-blue-latest`,
`gpt-daybreak-red-latest`, `gpt-5.4`, and `codex-auto-review` are absent after
replacement. These membership/default changes are deliberate consequences of
using the authoritative gateway catalog, not a claim of identical GPT behavior.

## GPT instruction replacement is observable

For each model in each catalog, a new ACP process/thread started with that
model already set in its isolated `config.toml`. This avoids confusing a model
switch with the original thread's instruction context. The engine's HTTP
request was captured locally and rejected before any GPT upstream call.

All five common GPT models had changed instruction content. For the new GPT
models, Codex sends the model instructions in `input` developer messages;
`gpt-5.5` uses the top-level `instructions` field. The table records the first
model-instruction developer message's serialized content length/hash, or the
`instructions` string for `gpt-5.5`. Lengths are characters, not bytes.

| Model | Bundled length → gateway length | Bundled SHA-256 → gateway SHA-256 |
| --- | --- | --- |
| gpt-6-astra | 21,521 → 21,680 | `9be8fa70a63f9fb0cd553aeb55813908185d811a4671e31c1ca74ae55d3f3485` → `cd3f98c2a2c3671a0756d9e5d91d2ffad252dcbaadf781109f3604629b19193d` |
| gpt-5.6-sol | 17,942 → 17,942 | `1db94d2423a329e4781686762ab39e416ce1008d50673a85bf0f1533d8c8e9af` → `f8d87b1be1b1f236c961fe2fa6686cea1db1a139cbac4860eddb006c948c4a3b` |
| gpt-5.6-terra | 17,942 → 17,942 | `1db94d2423a329e4781686762ab39e416ce1008d50673a85bf0f1533d8c8e9af` → `f8d87b1be1b1f236c961fe2fa6686cea1db1a139cbac4860eddb006c948c4a3b` |
| gpt-5.6-luna | 17,942 → 17,942 | `1db94d2423a329e4781686762ab39e416ce1008d50673a85bf0f1533d8c8e9af` → `f8d87b1be1b1f236c961fe2fa6686cea1db1a139cbac4860eddb006c948c4a3b` |
| gpt-5.5 | 21,175 → 21,459 | `ba541a21430b9022991112de200a7ba30246e79ab78e4eff9d6f134a855a92ad` → `2351631dfc5644dc5a45eaaca4139475bd02810ee6cb792d058b551559b3242e` |

These hashes demonstrate replacement, not a quality assessment of either
instruction template. GPT response quality under those templates is **未验证**.

## Regression checks and remaining coverage

```sh
bun test tests/unit/acp/acp-session-negotiation.test.ts tests/unit/acp/providers.test.ts
```

The ACP regressions cover independent model defaults, recommendation metadata
when current effort persists, omitted unknown defaults, absent versus explicitly
empty selectors, arbitrary advertised effort values, wire ordering of
`set_config_option` before `session/prompt`, explicit model rejection and mismatched
model/effort acknowledgment without any prompt, and existing Claude negotiation.
The complete ACP suite finished with 196 pass / 0 fail / 519 assertions (13 files).
Result: 78 passed, 0 failed, 186 assertions. `bunx tsc --noEmit` also completed
with no errors after integrating the type-compatible metadata fields.

The initial implementation runs checked `deepseek-flash` at `max`; independent
QA subsequently verified `low` (see the follow-up below). Real requests at
`high`, live Claude inference, and GPT upstream inference remain **未验证**. This
isolated verification manually prepared the catalog/home; deployment to the
production daemon, production `/api/models` and browser readback, and continuity
of a real running user task across an upgrade are **未验证**. No deployment is
part of MUL-330's current authorization.

## QA follow-up: authoritative selectable membership

QA found that the ordinary list advertised `codex-auto-review` while the loaded
native execution catalog omitted it. The first implementation filtered hidden
entries but retained ordinary-only IDs as capability-unknown, allowing users to
save a model that ACP could not select. As confirmed by the task owner, that
route was not selectable before this PR either: the old ACP path could silently
continue with the previous model. The strict selection check exposed the problem;
it did not introduce the prior inability to select that route. The earlier
`includeHidden: true` bundled comparison is not a list of normal ACP choices.

The server now uses the native catalog's visible API-capable entries as Codex's
selectable set. IDs and effort values are not hardcoded. An ordinary-only model
will become selectable automatically if a later native catalog advertises it.
`model_catalog_status: ready` makes even an empty selectable set authoritative;
`error` preserves the ordinary inventory with capability-loading errors. Old
snapshots missing the new marker trigger immediate discovery after upgrade.
Custom Runtime connections retain their own model catalogs; Claude is unchanged.

API validation and task claiming consume that same target catalog, including
Agents with no effort override. Saved absent models show **不在执行目录 / 不可执行**
in the editor without replacing their model or effort. Unrelated metadata edits
may resend the unchanged selection. Rejected models do not block a runnable
Agent behind them in the queue, and catalog changes do not cancel running tasks.

### Real gateway and local HTTP API rerun

Executed at **2026-09-18 10:51:15 UTC** with Bun 1.3.14. The modified server used
an in-memory SQLite store and a loopback HTTP listener. Its production discovery
function and HTTP transport read the existing real gateway using the local key
in-process; no shared configuration, production data, or upstream prompt changed.
The listener and in-memory store were closed afterward. Only safe output fields
were captured; neither credentials nor instruction templates were persisted.

| Check | Observed result |
| --- | --- |
| `GET /v1/models` | HTTP 200, 11 ordinary entries |
| `GET /backend-api/codex/models` | HTTP 200, 10 native entries, 395,186 UTF-8 bytes (394,730 characters) |
| Native response SHA-256 | `65ef7c2624c0af69295543c46233eda6c6bac986280b7317e9521a602bf90b2e` |
| Actual HTTP `GET /api/models` | `ready`, 9 selectable entries; same result for workspace, Runtime, execution group and Agent-owner scopes |
| Removed ordinary-only route | `codex-auto-review` absent from all four API lists |
| Hidden native route | `gpt-reserve` absent from all four API lists |
| `deepseek-flash` | `supported`, low/high/max, default high in all four API responses |
| API create with absent model and no effort | HTTP 400, `code: model_not_in_execution_catalog` |
| Metadata-only update resending saved absent model/effort | HTTP 200, saved `codex-auto-review` / `high` unchanged |
| Claim saved absent model with no effort | null claim; task stays queued, no dispatch |

The nine selectable IDs were gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra,
gpt-5.6-luna, gpt-5.5, deepseek-flash, deepseek-v4-pro, deepseek-v4-flash,
and deepseek-v4.1-flash. These names are observations, not implementation rules.

### Independent evidence and remaining limits

QA's separate report (`cmt_am7bnhayi20s`) verified an actual DeepSeek **low**
request: `reasoning.effort=low`, upstream HTTP 200 / OK, pinned ACP 1.12.0 and
Codex 0.155.0. That adds to this implementer's two max executions above; this
membership follow-up did not repeat inference because it changes selection and
validation, not ACP transmission. DeepSeek **high**, GPT/Claude live inference,
GPT instruction quality, and real tasks spanning an upgrade remain **未验证**.

QA's PPE browser was redirected to login despite a local unauthenticated API.
No deployment or browser retest was performed in this follow-up; real desktop
page readback remains **未验证**, while component tests cover saved-value status
and four-language text. This local API rerun does not claim production verification.

Queued-task wait diagnostics remain a follow-up: a rejection by one Runtime does
not mean a healthy sibling cannot claim the task. Reusing the task wait reason
would require fleet-wide aggregation and clearing rules, beyond this membership
fix. Tasks still wait while their only target has persistent capability errors.

## QA follow-up: shared validity and actual Runtime membership

The next review found three remaining failure boundaries: Server accepted a
partial native document that the daemon rejected; failed daemon reports mixed
ordinary inventory IDs into the bundled executable members; and pre-native
snapshots were still selectable while their asynchronous refresh was pending.

Server discovery and daemon loading now call the same strict
`validCodexNativeCatalog` contract. Missing required native fields reject the
whole document on both sides, including a malformed hidden member. The parser
regression intentionally replaces the old "missing required levels means
unknown" assumption with whole-catalog failure; explicit empty levels remain
`unsupported`, and an absent optional default stays absent.

Runtime reports separately retain catalog health and the models actually found
by ACP. A failed native download no longer adds inventory-only IDs to this
executable membership or erases a working bundled model's efforts/default.
The API may retain inventory entries for display, with `execution_status` set
to `unavailable`; create validation and task claims use that status even without
an explicit effort. The old regression that allowed a failed inventory-only
model to be created and claimed is deliberately corrected, with positive bundled
GPT assertions retained. An unrefreshed snapshot reports an unknown execution
state and cannot authorize a new model selection.

### Real gateway rerun with the shared strict contract

Executed at **2026-09-18 11:35:13 UTC**, Bun **1.3.14**. Production
`discoverGatewayModels` and `publicRelayHttpRequest` read both real gateway
endpoints into an in-memory SQLite store. A loopback-only HTTP API served the
modified application. The key was read in-process from local Codex auth; no
credential, native response body, or instruction template was written to the
verification files or this repository. The listener and database were closed.

The healthy Runtime report in this rerun was a **local fixture derived from the
same fetched native response**, including the new catalog provenance marker.
The daemon loader was given that exact captured response to verify matching
acceptance and byte preservation. This rerun did not start ACP or issue model
inference; the earlier real ACP/max and independent QA/low evidence above still
provides that execution coverage.

| Check | Observed result |
| --- | --- |
| Ordinary endpoint | HTTP 200, 11 entries, 1,110 bytes |
| Native endpoint | HTTP 200, 10 entries, 395,186 bytes |
| Shared strict validator | **10/10** individual entries valid; complete document valid |
| Daemon loading the same document | `loaded`; original bytes preserved |
| Workspace / Runtime / execution group / Agent-owner HTTP catalogs | All `ready`, all **9 models**, each `execution_status: available` |
| Absent and hidden routes | `codex-auto-review` and `gpt-reserve` absent in every scope |
| DeepSeek Flash in every scope | `available`, low/high/max, default high |
| New absent-route Agent | HTTP 400, `model_not_in_execution_catalog` |
| Unrelated edit of a saved absent-route Agent | HTTP 200; original model and high effort retained |

Ordinary response SHA-256:
`02e0b40897bacd5de4cd448238d3b610e3e894d5920cb13296e588108a9dc767`.
Native response SHA-256:
`65ef7c2624c0af69295543c46233eda6c6bac986280b7317e9521a602bf90b2e`.
The native response is unchanged from the previous rerun, and unifying validation
to the strict daemon contract still accepts all ten current gateway entries.

### Controlled daemon failure against that same real ready snapshot

After the live discovery, the local store kept its real `ready` snapshot while a
controlled Runtime report used production `runtimeModelsWithCatalogError` with
one bundled GPT member and a simulated HTTP 503. This is a **failure injection**,
not a claim that the live gateway returned 503.

The persisted Runtime member list contained only `gpt-5.6-sol`; DeepSeek was
absent from it. The HTTP API retained DeepSeek for display as `unavailable`,
while bundled GPT remained `available`. For automatic, fixed-Runtime and
execution-group bindings, creating DeepSeek with no effort returned HTTP 400
`model_not_in_execution_catalog`. Existing equivalent Agents were ineligible;
their tasks stayed queued with **zero `task:dispatch` events**. A GPT Agent with
explicit high effort returned HTTP 201 and its task was claimed past those
queued tasks, producing the sole dispatch event. No executor processed that
local test task.

Real browser readback remains **未验证** (tracked separately by MUL-334), as do
DeepSeek high inference, GPT/Claude live inference, GPT template quality, and
continuity of real running tasks across an upgrade. This rerun changes no
production state, shared relay configuration, deployment, or running session.
