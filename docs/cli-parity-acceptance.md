# CLI parity acceptance report

This report maps the CLI parity target to executable evidence on the final
feature branch. Exact run totals are recorded in the MUL-70 delivery comment;
the named tests below are part of `release-build-check.yml` unless noted.

## Coverage summary

- 32 user API domains: the 31 top-level resources plus Attachment under
  `issue attachment` and `comment attachment`.
- 425 Registry commands: 409 native/capability entries and 16 compatibility
  passthrough entries.
- 46 deprecated aliases, all with lifecycle metadata and a canonical replacement.
- 589 server routes: 521 mapped to executable commands, 68 justified exemptions,
  and 0 planned or unexplained gaps. The CI ratchet is fixed at 0.
- Exemptions are limited to internal daemon protocol, callbacks/webhooks,
  WebSocket transport, pure UI behavior, updater internals, and public bootstrap
  assets. Each exemption has a fixed category and a non-empty reason.

## Acceptance matrix

| Requirement | Evidence | Result |
| --- | --- | --- |
| Every command has registered parameters and generated help | `cli-capabilities-manifest.test.ts` renders help for every visible Registry entry and checks every positional/option; `multiremi-cli-dispatch.test.ts` drives the shipped dispatcher | Pass |
| Every capability command declares table and JSON contracts | `cli-capabilities-manifest.test.ts` checks `table|json|jsonl`, auth, paging, workspace, and destructive confirmation on every capability entry; `cli-context/resources/collaboration/agent-extensions/operations.test.ts` execute representative renderers | Pass |
| Human, Task, Daemon, Share, and Anonymous authorization | `multiremi-api-cli.test.ts` provides the five-identity template; the three `multiremi-cli-*-auth.test.ts` suites cover domain-specific allow/deny rules | Pass |
| Destructive commands require confirmation | Registry-wide assertion in `cli-capabilities-manifest.test.ts`; domain execution checks in `cli-resources`, `cli-collaboration`, `cli-agent-extensions`, and `cli-operations` | Pass |
| Homepage "hello" performs zero Git requests | `multiremi-daemon-smoke.test.ts`: `starts homepage Chat with zero Git work while preserving Issue auto-checkout` | Pass |
| `repo list` works while Git is offline | `cli-resources.test.ts`: `lists repositories from the API without contacting the local Git helper` | Pass |
| Checkout touches one repository and returns timeout/failure as tool errors | `cli-resources.test.ts` checkout resolver/timeout tests plus the homepage Chat daemon smoke with two configured repositories | Pass |
| A stale native Chat session recovers from product history | `multiremi-store-task-routing`, `multiremi-store-chat`, `multiremi-store-daemon-wire`, `agent-runtime-send-options`, and daemon smoke `resumes chat tasks...` | Pass |
| All 32 API domains are mapped with no unexplained gap | `cli-capabilities-manifest.test.ts` and `bun run cli:capabilities:check`: 521 mapped / 68 exempt / 0 missing / 589 total | Pass |
| TypeScript, full tests, release checks, four-platform CLI archives, and API/Web images | Final MUL-70 delivery gate on fixed Bun 1.3.14; the full suite isolates host-global Git hooks and provider credentials so environment state cannot change the result | Pass; see final run totals |

The old `multiremi-cli-help.test.ts` parsed switch source text and issue usage
strings. It was removed after the Registry became the command source of truth.
Its replacement is the Registry/manifest/help contract in
`cli-capabilities-manifest.test.ts`, which checks commands and aliases in both
directions and renders every visible command's declared parameters.

## Behavior changes requiring release approval

| Change | Affected caller | Regression evidence |
| --- | --- | --- |
| Task tokens cannot manage Workspace, Member, Invite, Token, sibling Project, or repository configuration; current Project knowledge writes remain | Agents running with Task credentials | `multiremi-api-cli.test.ts` safe-directory/current-project knowledge test |
| Workspace writes require Human owner/admin; Project archive/restore/resource writes require Human Workspace membership | Human PAT users with insufficient Workspace role | resource-domain auth tests and `multiremi-multiuser-auth.test.ts` |
| Invitation details are visible only to the invitee or a member of that Workspace | Unrelated authenticated users holding an invitation ID | `multiremi-multiuser-auth.test.ts` invitation visibility assertions |
| Task tokens can mutate their current Issue, create child Issues, comment across visible Issues, and publish the current Session result, but cannot update/delete/assign sibling Issues or run batch Issue mutations | Agents coordinating across Issues | `multiremi-cli-collaboration-auth.test.ts` and collaboration contracts |
| Task tokens see only Agent display fields and cannot manage Agent/Squad/Skill/Plugin or read Agent instructions, env, args, MCP, and private bindings | Agents using the safe Agent directory | `multiremi-cli-agent-extensions-auth.test.ts` and store auth tests |
| Task tokens cannot manage Runtime, Autopilot, cloud Runtime, Billing, Platform, Lark, or SCM; collaboration inbox/dashboard reads remain | Agents using operational APIs | `multiremi-cli-operations-auth.test.ts` |
| Daemon tokens gain only a read-only directory of Runtime records bound to their exact daemon identity | Runtime daemon processes | `multiremi-cli-operations-auth.test.ts` exact-machine test |
| Homepage Chat no longer receives Workspace repos and performs no automatic sync/checkout; Issue tasks retain automatic checkout | Homepage Chat users and Issue agents | homepage Chat daemon smoke cross-checks Chat and Issue task behavior |
| Only `agent_error.stale_session` on a Chat task clears the dead lineage and creates one bounded cold retry from product history | Chat sessions whose provider conversation disappeared | task-routing negative cases, 64-message/64-KiB transcript tests, daemon no-replay test, and stale recovery smoke |

These changes must be reviewed as one release decision. Capability negotiation
allows the platform and daemon CLI to be enabled together without treating a
platform deployment as an automatic daemon upgrade.

## Release boundary

The feature branch is published in PR #8, but this work does not merge, release,
or deploy it. Platform release and daemon CLI release remain separate procedures.
Final activation requires explicit approval after reviewing the behavior-change
table above.
