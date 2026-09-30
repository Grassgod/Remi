---
title: Realtime v2 release and rollback checklist
status: active
summary: Order and verification for the v2 integration release; production changes require separate authorization.
---

# Realtime v2 release and rollback checklist

This checklist records the order agreed in MUL-403 plan 5/6. It does not authorize
deploying, changing nginx, restarting services, or deleting data. Record the
release tag, CI head, database backup, and each verification result before the
operator starts the separately approved cutover.

## Release order

1. A-0 and B1 establish trace and conversation-log contracts and storage.
2. C1/C2/C4/C5 add the server Hub, read paths, and Feishu delivery units while
   old routes still work. Verify the new paths before any consumer switches.
3. Publish A-6 with C2 integration and the C6 Feishu trace subscription. Drain
   active tasks and verify cursor continuation and the subscription `closed` end
   signal. A-6, B5, and C12 belong to the same v2 integration release.
4. Publish C3/C7/C8/C9/C10/C11 together: realtime frames, browser replica,
   reveal behavior, Issue and Chat lists, and lazy task trace readers.
5. Publish B5 and C12 in that same release: remove the old task/chat reads,
   frames, frontend fetches, and CLI implementations. Check the route snapshot,
   CLI capability manifest, CI zero-jump and replica jobs, and the independent
   Issue/Chat/trace browser matrix before declaring the cutover complete.

Deleting the old tables is a separate last step owned by B. It requires a fresh
backup and explicit approval; it is not part of this release checklist.

## Routing checks

Before cutover, an authorized operator must inspect the effective nginx config
on 209 with a read-only `nginx -T` and record the upstream for all three paths:
`/api/trace/ws`, `/api/tasks/<task-id>/trace`, and
`/api/shares/<share-id>/tasks/<task-id>/trace`. They must reach the runtime API
process, including WebSocket upgrade for the first path. A repository config or
successful UI response alone does not prove the effective 209 routing. Verify
that `isRuntimeAllowedPath` in `packages/server/src/config/api-role.ts` accepts
all three, and that the UI role rejects them. Do not mark this check complete
until the effective 209 configuration is observed.

## Rollback

Before old-table deletion, revert the platform updater to the preceding release
image as one unit, including the old frontend, API, and daemon behavior. Confirm
the old routes and frames work together and the old package ignores the new
browser replica. Do not mix old frontend assets with the new API. A-6 and C6
must roll back together to restore heartbeat claiming and the former CoT path.

If only C5 outbound delivery misbehaves after release, first set
`MULTIREMI_FEISHU_OUTBOUND_KINDS=0`; keep the schema and version in place. If a
full old-version rollback is required, stop writers and claimers, drain active
Task streams, take a backup, and follow the rehearsed
[Feishu outbound restore procedure](../feishu-outbound-kind-migration.md).
Its SQLite and PostgreSQL scripts restore the legacy `task_id` unique key while
retaining a complete C5 archive. Reconcile any deliveries written during the
old-version window before swapping the archive back to C5.

After old-table deletion, an image rollback alone is unsafe. Restore the old
tables from the approved backup and reconcile the conversation-log delta with
B's reverse-fill procedure before starting the old image. If that reverse-fill
is unavailable or cannot be verified, stop and forward-fix instead. Never
delete the C5 archive or the old tables as part of an unapproved rollback.
