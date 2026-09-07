# Scheduled Project and Repository Targets

A schedule can select projects and repositories together. It creates one independent task per target, without creating Issues or giving the agent workspace-wide knowledge write access.

## Configuration

Use **Schedule > Run sequentially per target** when creating an automation, or add a schedule trigger to an existing event automation. Each selection is independent:

- `all: true, ids: []` resolves the current active catalog at each firing, including later additions.
- `all: false, ids: [...]` selects exactly those IDs.
- `all: false, ids: []` excludes that target kind.
- Project selection does not implicitly select its repositories.
- The optional schedule prompt overrides the automation description for scheduled target runs only.

CLI: `remi autopilot trigger create <autopilot> --file schedule.json`:

```json
{
  "kind": "schedule",
  "cron_expression": "0 3 * * *",
  "timezone": "Asia/Shanghai",
  "schedule_targets": {
    "projects": { "all": true, "ids": [] },
    "repositories": { "all": true, "ids": [] },
    "prompt": "Use llm-wiki-lint to maintain the single bound target."
  }
}
```

Use `remi autopilot trigger update <autopilot> <trigger> --file schedule.json` to replace selections (omit `kind` on update). An empty selection is rejected; `schedule_targets: null` restores an untargeted schedule when compatible with the automation's execution mode. A targeted schedule cannot create Issues. It can coexist with `trigger_issue` system-event automations: the event still reuses its Issue, while the schedule creates standalone tasks.

`remi autopilot run <autopilot> --data '{"trigger_id":"<schedule-trigger>"}'` starts the configured schedule manually. When no trigger is supplied, the first enabled targeted schedule is selected; pass an explicit trigger ID when a rule has multiple schedules. The same unfinished schedule batch is reused rather than expanded again.

## Execution and Scope

The server snapshots targets and instructions when the schedule fires. Run rows begin as `queued`; only one scheduled target task per automation is dispatched at a time. The scheduler checks durable rows on every tick (normally 30 seconds), so completion, failure and cancellation allow the next target to proceed after restart as well. Existing active event runs of the same automation are allowed to finish before a scheduled target starts.

Paused automations do not dispatch new targets. Deleted/archived targets, disabled triggers and unavailable assignees are skipped when their turn arrives. Changed selections are rechecked before dispatch; new targets join on the next schedule firing. A currently executing task is not cancelled by editing a schedule.

Each task is bound to its server-owned run target. Projects receive project context; repositories receive their repository Wiki context. Scheduled target tasks do not eagerly clone source repositories. `remi context` exposes `current.schedule_target`. Knowledge submission and publishing still enforce the selected target and existing publisher role/plugin requirements. A Project task cannot write its repositories' Wikis or another Project; a repository task cannot write a Project Wiki. Prompt text or user-provided run payload cannot grant a target.

## Run History

The existing run list shows target kind/name and queued/running/completed/failed/skipped states. Started tasks open their normal execution transcript. `completed` means the task ended, not that every knowledge finding was fixed; use compilation outputs and the task report for publication evidence.

Use `remi autopilot run list <autopilot> --limit 100 --offset 0 --output json` to page through runs. Responses include `schedule_target` and `schedule_batch_id`.

The platform must be upgraded for new schedule configuration and durable queue processing. Existing daemon protocol fields carry the project/Wiki context and prompt; no new daemon release is required for this feature alone. No production automation is changed automatically by the migration.
