/**
 * Issue-extras routes — port of the Go handlers the frontend was 404ing on:
 *
 *   GET    /api/issues/:id/children          (issue.go ListChildIssues)
 *   GET    /api/issues/:id/labels            (label.go ListLabelsForIssue)
 *   POST   /api/issues/:id/labels            (label.go AttachLabel)
 *   DELETE /api/issues/:id/labels/:labelId   (label.go DetachLabel)
 *   GET    /api/issues/:id/attachments       (file.go  ListAttachments)
 *
 * Declared on absolute paths in a standalone factory so it composes alongside
 * issueRoutes without editing that file (same shape as subscriberRoutes /
 * issueMetadataRoutes). Behind the /api/* JWT gate; scoped to a workspace via
 * X-Workspace-ID + a membership check (multi-tenancy). The :id param accepts a
 * UUID or a human identifier ("MUL-123"), resolved by getIssueByIdentifier —
 * authorization always flows through the issue: if it's not in the caller's
 * workspace, none of its children/labels/attachments are visible.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue } from "../../db/schema.js";
import { getIssueByIdentifier, getMembership, getWorkspacePrefix } from "../../db/queries/issues.js";
import { getLabel, type Label } from "../../db/queries/labels.js";
import {
  attachLabelToIssue,
  detachLabelFromIssue,
  listChildIssues,
  listLabelsByIssue,
} from "../../db/queries/issueExtras.js";
import { listAttachmentsByIssue, type Attachment } from "../../db/queries/attachments.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/** snake_case issue shape (mirrors Go IssueResponse / routes/issues.ts). */
function issueToResponse(i: Issue, prefix: string) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    number: i.number,
    identifier: `${prefix}-${i.number}`,
    title: i.title,
    description: i.description,
    status: i.status,
    priority: i.priority,
    assignee_type: i.assigneeType,
    assignee_id: i.assigneeId,
    creator_type: i.creatorType,
    creator_id: i.creatorId,
    parent_issue_id: i.parentIssueId,
    project_id: i.projectId,
    position: i.position,
    start_date: i.startDate,
    due_date: i.dueDate,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    metadata: i.metadata ?? {},
  };
}

/** snake_case label shape (mirrors Go LabelResponse / routes/labels.ts). */
function labelToResponse(l: Label) {
  return {
    id: l.id,
    workspace_id: l.workspaceId,
    name: l.name,
    color: l.color,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

/**
 * snake_case attachment shape (mirrors Go AttachmentResponse and the local
 * copy in routes/attachments.ts). The Bun rewrite has no CloudFront signer, so
 * download_url is the server-relative download path (Go's CFSigner-nil
 * default). Nullable foreign keys serialize as null, matching Go's *string.
 */
function attachmentToResponse(a: Attachment) {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    issue_id: a.issueId,
    comment_id: a.commentId,
    chat_session_id: a.chatSessionId,
    chat_message_id: a.chatMessageId,
    uploader_type: a.uploaderType,
    uploader_id: a.uploaderId,
    filename: a.filename,
    url: a.url,
    download_url: `/api/attachments/${a.id}/download`,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt,
  };
}

/**
 * Read the issue's current label list and broadcast issue_labels:changed (the
 * Go protocol.EventIssueLabelsChanged) so other clients update their chips.
 * Mirrors the Go post-mutation flow: if the read failed the mutation is
 * already committed, so Go returns 200 `{}` (no labels key) and skips the
 * broadcast rather than overwriting subscribers with a wrong empty list —
 * callers refetch via query invalidation.
 */
async function labelsChanged(db: Db, wsId: string, issueId: string) {
  let labels: Label[];
  try {
    labels = await listLabelsByIssue(db, wsId, issueId);
  } catch (err) {
    console.warn("issueExtras: list labels after mutation failed:", err);
    return {};
  }
  const resp = labels.map(labelToResponse);
  bus.publish({
    type: "issue_labels:changed",
    workspaceId: wsId,
    payload: { issue_id: issueId, labels: resp },
  });
  return { labels: resp };
}

export function issueExtrasRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/issues/:id/children -> { issues: [...] } (Go ListChildIssues).
  r.get("/api/issues/:id/children", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const [children, prefix] = await Promise.all([
      listChildIssues(db, found.id),
      getWorkspacePrefix(db, ws),
    ]);
    return c.json({ issues: children.map((i) => issueToResponse(i, prefix)) });
  });

  // GET /api/issues/:id/labels -> { labels: [...] } (Go ListLabelsForIssue).
  r.get("/api/issues/:id/labels", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const labels = await listLabelsByIssue(db, ws, found.id);
    return c.json({ labels: labels.map(labelToResponse) });
  });

  // POST /api/issues/:id/labels with body { label_id } -> { labels: [...] }
  // (Go AttachLabel). Both the issue and the label must be in this workspace.
  r.post("/api/issues/:id/labels", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    // Body validation precedes the issue load (mirrors the Go handler order).
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const labelId = typeof body.label_id === "string" ? body.label_id : "";
    if (!labelId) return c.json({ error: "label_id is required" }, 400);

    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    if (!UUID_RE.test(labelId)) return c.json({ error: "invalid label_id" }, 400);
    const label = await getLabel(db, ws, labelId);
    if (!label) return c.json({ error: "label not found" }, 404);

    await attachLabelToIssue(db, found.id, label.id);
    return c.json(await labelsChanged(db, ws, found.id));
  });

  // DELETE /api/issues/:id/labels/:labelId -> { labels: [...] } (Go DetachLabel).
  // The label is verified in-workspace first so a foreign labelId yields an
  // explicit 404 instead of a silent no-op 200.
  r.delete("/api/issues/:id/labels/:labelId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const labelId = c.req.param("labelId");
    if (!UUID_RE.test(labelId)) return c.json({ error: "invalid label id" }, 400);
    const label = await getLabel(db, ws, labelId);
    if (!label) return c.json({ error: "label not found" }, 404);

    await detachLabelFromIssue(db, found.id, label.id);
    return c.json(await labelsChanged(db, ws, found.id));
  });

  // GET /api/issues/:id/attachments -> top-level array (Go ListAttachments).
  r.get("/api/issues/:id/attachments", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const attachments = await listAttachmentsByIssue(db, ws, found.id);
    return c.json(attachments.map(attachmentToResponse));
  });

  return r;
}
