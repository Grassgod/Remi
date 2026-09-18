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

The real execution checked `deepseek-flash` at `max`. Real requests at `low` and
`high`, live Claude inference, and GPT upstream inference are **未验证**. This
isolated verification manually prepared the catalog/home; deployment to the
production daemon, production `/api/models` and browser readback, and continuity
of a real running user task across an upgrade are **未验证**. No deployment is
part of MUL-330's current authorization.
