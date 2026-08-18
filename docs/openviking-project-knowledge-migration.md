# OpenViking Project Knowledge Migration Runbook

This runbook moves Multiremi project Wiki and Memory bodies from SQL to OpenViking. SQL remains the control plane for ownership, authorization, stable IDs, URIs, hashes, versions, and migration state.

## Invariants

- OpenViking is the only body and semantic-search source after cutover.
- Browsers, CLI clients, daemons, and agents call Multiremi Server. They never receive the OpenViking API key.
- Every URI is generated under the authenticated workspace and project. User-supplied absolute URIs are not accepted.
- A failed OpenViking operation returns an explicit error. It never falls back to writing a new SQL body.
- Backfill identity is `(doc_id, version, sha256)`. Re-running backfill or `--resume` does not create a second document.
- SQL bodies are retained unchanged as rollback snapshots during `shadow`. Their deletion is a separate manual operation and is not implemented by this migration command.

## Configuration

Configure these variables only on Multiremi Server:

```bash
MULTIREMI_PROJECT_KNOWLEDGE_MODE=sql
MULTIREMI_OPENVIKING_URL=http://127.0.0.1:1933
MULTIREMI_OPENVIKING_API_KEY=<server-secret>
MULTIREMI_OPENVIKING_TIMEOUT_MS=30000
MULTIREMI_OPENVIKING_MAX_RETRIES=2
```

`MULTIREMI_PROJECT_KNOWLEDGE_MODE` accepts `sql`, `shadow`, or `openviking`. A non-SQL mode refuses to start without an API key.

Before migration, back up the SQL database and the OpenViking data, vector-store, and object-store directories as one consistency set. Record the backup timestamp and application commit.

## Phase 1: SQL Baseline

1. Deploy the schema and service changes with mode `sql`.
2. Confirm the REST, frontend, and top-level `remi memory` / `remi wiki` workflows.
3. Check control-plane counts:

```bash
remi project knowledge status --workspace <workspace>
remi project knowledge backfill --dry-run --workspace <workspace>
```

In SQL mode, status reports `openviking: not_configured`; normal reads and writes remain on SQL. Dry-run needs no OpenViking connection. Real backfill begins only after entering shadow mode.

## Phase 2: Shadow

1. Restart Multiremi Server with `MULTIREMI_PROJECT_KNOWLEDGE_MODE=shadow`.
2. Run a dry run, then backfill:

```bash
remi project knowledge backfill --dry-run --workspace <workspace>
remi project knowledge backfill --workspace <workspace>
```

3. An interrupted job resumes only unfinished rows:

```bash
remi project knowledge backfill --resume --workspace <workspace>
remi project knowledge retry-failed --workspace <workspace>
```

4. Verify every current body and control-plane checksum:

```bash
remi project knowledge verify --workspace <workspace>
remi project knowledge status --workspace <workspace>
```

Do not cut over unless `openviking` is `ready`, `failed` and `pending` are zero, and verification has zero failures. Inspect OpenViking snapshot history for representative documents, including Chinese content, refs, tags, Wiki pages, and Memory entries.

During shadow, SQL remains the read source and receives the rollback copy. OpenViking write failures are recorded as `failed`; use `retry-failed` after fixing the dependency.

## Phase 3: OpenViking Cutover

1. Take a final SQL and OpenViking backup.
2. Stop writers or use a short maintenance window.
3. Run `backfill --resume`, `verify`, and `status` again.
4. Restart all Multiremi Server instances with `MULTIREMI_PROJECT_KNOWLEDGE_MODE=openviking`.
5. Exercise Wiki read/write/history/delete, Memory remember/recall/forget/backlinks, task claim intake export, and an Agent MCP recall followed by read.

After cutover, new bodies and revision bodies must be empty in SQL. Only control metadata changes there. Monitor HTTP 503/502 responses, OpenViking latency, `sync_status`, checksum failures, snapshot failures, and semantic-search project isolation.

## Rollback

Rollback is valid only while the frozen SQL bodies still cover the desired recovery point:

1. Stop writers.
2. Record failed OpenViking URIs and snapshot OIDs.
3. Restart Multiremi Server in `sql` mode against the pre-cutover SQL backup or frozen rollback snapshot.
4. Validate REST and CLI reads before reopening writes.

Do not copy partially updated OpenViking bodies back into SQL automatically. If writes occurred after cutover, export and reconcile them explicitly before rollback; otherwise those writes will be lost.

## Later Cleanup

SQL body cleanup requires a separate reviewed change and explicit operator confirmation. Before cleanup, retain tested backups for the agreed recovery window, prove that all server instances use `openviking`, verify counts and hashes again, and document how OpenViking backups are restored. This runbook deliberately provides no destructive cleanup command.
