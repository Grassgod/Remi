# Issue key results — metadata contract

A session result (`POST /api/issues/:id/sessions/:sessionId/results`) carries a free-form
`metadata` object. Two keys inside it are a *convention*, not a constraint: the store persists
whatever is sent and every reader degrades instead of failing.

## `metadata.kind`

One of `mr` | `branch` | `report` | `deploy` | `decision` | `doc` | `other`.

- Absent or unknown value → readers treat it as `other` (generic icon, generic label).
- The CLI (`remi session result publish --type <kind>`) rejects a value outside the list
  with a usage error that names the valid kinds — the agent gets told, the API stays open.
- `branch` is not offered by the CLI: the daemon publishes it itself after auto-checking-out an
  issue task's repos (worker/daemon.ts `publishBranchArtifact`), with the worktree branch as the
  title and a `metadata.worktrees` list of `{ repo_url, branch, path }`.

## `metadata.refs`

`[{ "type": string, "value": string }]` — the same shape as project-doc refs.

- `type` is open (`issue` | `task` | `url` | `file` today). An unknown type renders as plain text.
- Anything that is not an array → no refs. A non-object entry, or an entry with an empty
  `value`, is dropped rather than failing the whole result.
- The CLI accepts repeatable `--ref <type>:<value>` (a bare `http(s)` URL is taken as `url:`),
  sharing the parser with `project doc create/update`.

## Where it is read

- `packages/core/issues/session-results.ts` — `sessionResultKind()` / `sessionResultRefs()`,
  the lenient readers used by the UI.
- `packages/views/issues/components/issue-key-results-section.tsx` — 关键结果 panel section
  (icon by kind, refs as badges).
