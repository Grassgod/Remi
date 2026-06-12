---
name: multimira-autopilots
description: Use when creating, updating, inspecting, triggering, or debugging Multimira autopilots. Covers the full chain: schedule/webhook/manual trigger, create_issue vs run_only execution, agent/squad leader admission, runs, created issues/tasks, webhook URL rotation, and side-effect boundaries.
user-invocable: false
allowed-tools: Bash(multimira *)
---

# Multimira Autopilots

## Quick start

Autopilots are durable automations. Read before mutating:

```bash
multimira autopilot list --output json
multimira autopilot get <autopilot-id> --output json
multimira autopilot runs <autopilot-id> --output json
```

Do not run `trigger`, `delete`, `trigger-delete`, or `trigger-rotate-url` to test. Those are real side effects.

## Core model

An autopilot is not an agent. It is a rule that dispatches work to an agent, or to a squad's leader agent.

The chain is: trigger fires (`schedule`, `webhook`, or `manual`) -> `autopilot_run` row -> `execution_mode` decides output -> assignee readiness check -> issue/task execution -> run status sync.

Execution modes:

- `create_issue` creates a Multimira issue, making the run visible as issue state.
- `run_only` creates an agent task directly. No issue is created; any durable
  report location has to come from other task context or instructions.

`issue-title-template` only supports `{{date}}`. Do not invent `{{trigger_id}}`, `{{branch}}`, or other variables.

## CLI

```bash
multimira autopilot list --output json
multimira autopilot get <autopilot-id> --output json
multimira autopilot create --title "<title>" --description "<task prompt>" --agent <agent-name-or-id> --mode create_issue|run_only --output json
multimira autopilot update <autopilot-id> --status active|paused --output json
multimira autopilot runs <autopilot-id> --output json
multimira autopilot trigger-add <autopilot-id> --kind schedule --cron "0 9 * * *" --timezone Asia/Shanghai --output json
multimira autopilot trigger-add <autopilot-id> --kind webhook --label "ci" --output json
multimira autopilot trigger <autopilot-id> --output json
multimira autopilot trigger-rotate-url <autopilot-id> <trigger-id> --yes --output json
```

Use `trigger` only when the user explicitly asks for a manual run. Use `trigger-rotate-url` only when rotating a webhook URL; the old URL stops being valid.

Webhook trigger output can include a URL/token. Do not paste webhook tokens or signing material into comments, logs, docs, or PRs. Redact secrets.

## Debugging

For "why didn't it run":

1. `multimira autopilot get <id> --output json` — status, mode, assignee, triggers.
2. `multimira autopilot runs <id> --output json` — run status and failure reason.
3. If assigned to a squad, inspect the squad: `multimira squad get <squad-id> --output json`; execution goes to the leader.
4. Inspect the target agent/runtime: `multimira agent get <agent-id> --output json` and `multimira runtime list --output json`.
5. For `create_issue`, inspect the created issue if the run records one.

## Side effects

These mutate durable state or start work: `create`, `update`, `delete`, trigger add/update/delete/rotate, `trigger`, and webhook calls to `/api/webhooks/autopilots/{token}`.

More source-backed details: `references/autopilots-source-map.md`.
