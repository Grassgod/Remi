# ADR 0002: Repository wiki list returns metadata; bodies are fetched explicitly

## Status

Accepted (MUL-387, child of MUL-383 §6 C.3). The transitional User-Agent shim
described below is removed by a follow-up issue once the daemon fleet has
upgraded; see "Consequences".

## Context

`GET /api/workspaces/:id/repos/:repositoryId/wiki` is served by
`RepositoryWikiService.list()`. In `MULTIREMI_PROJECT_KNOWLEDGE_MODE=openviking`
(production) it runs `Promise.all(docs.map(hydrateTolerant))`, one OpenViking
`content/read` per document at roughly 0.7 s each. Explorer's read-only
diagnosis on 209 (MUL-383, 2026-09-26) measured 236 calls in a day with
p50 1.99 s, p95 13.8 s and max 22.9 s while `db_ms` stayed at 4–6 ms. The
largest repositories hold 138–146 pages.

Callers that actually read `body` from the list response:

- the web repository wiki page and knowledge page render the selected
  document straight from the list row;
- `remi wiki status|pull|push` feed every remote body into the three-way
  merge against `.multiremi/wiki-base`;
- `remi wiki lint` needs every body of every repository in a project;
- the legacy migration in `api/routers/knowledge.ts` and the internal
  `backlinks` / `hydrateTaskWiki` paths (server-internal, unchanged here).

Two constraints shape the fix. The platform (API + Web) and the daemon CLI
upgrade separately, and the daemon CLI shipped in v0.2.82 parses a missing
`body` as `""` (`wiki-working-copy.ts:616`) while sending no version header
at all (only `Authorization` / `Content-Type`; Bun's default
`User-Agent: Bun/<version>` is the only distinguishing mark). A server that
silently stops sending bodies would make that CLI merge against empty remote
text and could discard content. Second, the route must reach p95 < 200 ms on
209, which rules out any design that still reads OpenViking on the default
path.

## Decision

1. **The list is metadata only.** Without query parameters the route returns
   the DB rows (`id`, `path`, `version`, `content_sha256`, `sync_status`, …)
   and omits `body` entirely. Omitting the field, rather than sending `""`,
   keeps "not included" distinguishable from "empty document".
2. **Bodies are an explicit, bounded request.** `include_body=true` requires
   `ids=` with 1–20 unique document ids; more than 20, or `include_body`
   without `ids`, is a 400. The service reads at most 4 bodies concurrently
   and is strict: an unreadable document fails the request with 503 instead of
   returning an empty body. `ids=` alone filters the metadata list. `q=` keeps
   its existing search contract and cannot be combined with either parameter.
   The parameter is spelled `include_body` to match `include_body` on
   `GET /api/projects/:id/docs` and the `include_closed` / `include_archived`
   family, amending the `?include=body` wording in the MUL-383 plan.
3. **Legacy CLIs get today's response through a transitional shim.** The
   router (not the service) serves the old full-body, tolerant response when
   the request `User-Agent` starts with `Bun/` — that is, a CLI predating this
   change. The new CLI identifies itself with `User-Agent: remi-cli/<VERSION>`
   on every request and therefore takes the metadata path. Requests without a
   User-Agent (tests, curl) take the metadata path. An environment switch
   `MULTIREMI_REPOSITORY_WIKI_LEGACY_LIST=auto|always|never` (default `auto`)
   forces the old behaviour for every caller (`always`) or disables the sniff
   (`never`) without a redeploy.
4. **The CLI reuses its baseline instead of re-reading unchanged pages.**
   `remi wiki status|pull|push` fetch the metadata list, compare each manifest
   entry's `version` with the remote row, and only request bodies (in `ids=`
   batches of ≤ 20, ≤ 2 batches in flight per repository) for documents whose
   version changed or which are new. Unchanged documents use the
   checksum-verified baseline in `.multiremi/wiki-base` as the remote text.
   This is sound because every update increments `version`
   (`repository-wiki-repo.ts:195`) and the operator restore path verifies the
   restored object against the current `content_sha256`, so equal version
   implies equal body. `remi wiki lint` uses the same batch primitive for all
   pages; `remi wiki repository list <repo>` prints metadata by default and
   exposes `--include-body` / `--ids` mirroring the API.

## Alternatives considered

- **Two releases: add `?view=summary` first, flip the default later.** Leaves
  the default contract slow for at least one more release, and the flip has
  exactly the same compatibility window against any daemon that is offline
  during the gate and comes back with an old CLI — with no mitigation. The
  shim converges automatically and stays safe for unidentified clients until
  it is deliberately deleted.
- **Server-side body cache keyed by `contentUri` + `contentSha256`.** Keeps
  the contract, but every publish and every API restart produces cold misses
  above 200 ms, the browser still downloads 140+ bodies to show one page, and
  it contradicts the MUL-383 direction that list endpoints carry metadata
  (C.2 strips bodies from the knowledge lists the same way). It remains a
  reasonable later addition inside `hydrate()` for `backlinks` and the claim
  path, which this ADR does not touch.
- **Paginating `include_body` (20 per page) instead of `ids=`.** For a
  146-page pull that is 8 sequential pages of ~3.5 s each, slower than today;
  `ids=` lets the CLI request only what changed.
- **Sending `body: ""` instead of omitting it.** Indistinguishable from an
  empty page for every consumer; the failure mode this change exists to
  remove.

## Consequences

- **Positive:** the default path performs no OpenViking read, so the route's
  latency is the DB query plus serialisation. Browsers stop downloading whole
  wikis to render one page. Steady-state `remi wiki status|push` reads only
  the pages that changed since the last sync.
- **Negative:** the web pages gain one request per selected document
  (`GET .../wiki/:ref`, ~0.7 s at current OpenViking latency, cached per
  document by the query client). Client-side full-text filtering of
  repository wiki bodies on the knowledge page is dropped; title, summary and
  tags remain.
- **Negative:** a cold `remi wiki pull` with no manifest (outside a
  daemon-prepared task workspace) fetches every body in batches and costs
  about what the list costs today; the daemon prepares the manifest for task
  workspaces, so this is the rare path.
- **Negative:** the shim is a User-Agent branch in a router and must not be
  allowed to outlive its purpose. Removal gate: every runtime reported by
  `remi runtime list` has `cli_version` at or above the release carrying the
  `remi-cli/` User-Agent, and nginx logs show no `Bun/` requests on the route
  for a week. A misclassified Bun client only receives the slow, complete
  response, never a truncated one.
- **Neutral / open:** a new CLI talking to an older server receives bodies it
  did not ask for; the CLI must tolerate a superset response. `backlinks`,
  `hydrateTaskWiki` and the write path still hydrate every page and are out of
  scope here (MUL-383 C.5 owns the claim path).
