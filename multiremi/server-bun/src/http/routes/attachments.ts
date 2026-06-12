/**
 * Attachment routes (READ path / metadata only) — port of the Go file handler's
 * GET /api/attachments/{id} (GetAttachmentByID) and the per-issue list
 * GET /api/issues/{id}/attachments (ListAttachments). File upload, download
 * streaming, content preview and S3 are intentionally NOT ported.
 *
 * Behind the /api/* JWT gate; scoped to a workspace via the X-Workspace-ID
 * header + a membership check (multi-tenancy).
 *
 * The per-issue list is exposed here as GET /api/attachments?issue_id=<uuid>
 * to keep this router self-contained (the Go list lives under the issues
 * subtree). Both routes return the same AttachmentResponse shape.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getMembership } from "../../db/queries/issues.js";
import {
  createAttachment,
  getAttachment,
  listAttachmentsByIssue,
  type Attachment,
} from "../../db/queries/attachments.js";
import type { Storage } from "../../storage/storage.js";
import { LocalStorage } from "../../storage/local.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB defensive cap

/** Default blob store for self-host: a local dir (MULTIMIRA_STORAGE_DIR or temp). */
function defaultStorage(): Storage {
  return new LocalStorage(process.env.MULTIMIRA_STORAGE_DIR ?? join(tmpdir(), "multimira-attachments"));
}

/** The metadata-only download path (matches Go attachmentDownloadPath). */
function attachmentDownloadPath(id: string): string {
  return `/api/attachments/${id}/download`;
}

/**
 * Mirrors the Go AttachmentResponse struct (snake_case JSON). The Bun rewrite
 * has no CloudFront signer, so download_url is always the server-relative
 * /api/attachments/{id}/download path (Go's default when CFSigner is nil).
 * Nullable foreign keys (issue/comment/chat) serialize as null when absent,
 * matching Go's *string omitted-as-null encoding.
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
    download_url: attachmentDownloadPath(a.id),
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt,
  };
}

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

export function attachmentRoutes(db?: Db, storage: Storage = defaultStorage()): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Upload: POST /api/attachments (multipart form, field "file"; optional
  // issue_id / comment_id). Stores the blob in Storage + a metadata row.
  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field is required" }, 400);
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.byteLength === 0) return c.json({ error: "file is empty" }, 400);
    if (data.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: "file too large" }, 413);

    const issueId = form.get("issue_id");
    if (typeof issueId === "string" && issueId && !UUID_RE.test(issueId)) return c.json({ error: "invalid issue_id" }, 400);
    const commentId = form.get("comment_id");
    if (typeof commentId === "string" && commentId && !UUID_RE.test(commentId)) return c.json({ error: "invalid comment_id" }, 400);

    const key = crypto.randomUUID();
    const contentType = file.type || "application/octet-stream";
    const filename = file.name || "upload";
    const url = await storage.upload(key, data, contentType, filename);

    const row = await createAttachment(db, {
      id: key,
      workspaceId: ws,
      issueId: typeof issueId === "string" && issueId ? issueId : null,
      commentId: typeof commentId === "string" && commentId ? commentId : null,
      uploaderType: "member",
      uploaderId: c.get("user").sub,
      filename,
      url,
      contentType,
      sizeBytes: data.byteLength,
    });
    bus.publish({ type: "attachment.created", workspaceId: ws, payload: { id: row.id, issue_id: row.issueId } });
    return c.json(attachmentToResponse(row), 201);
  });

  // Download: GET /api/attachments/:id/download — stream the blob bytes.
  r.get("/:id/download", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid attachment id" }, 400);
    const found = await getAttachment(db, ws, id);
    if (!found) return c.json({ error: "attachment not found" }, 404);

    const blob = await storage.read(storage.keyFromUrl(found.url));
    if (!blob) return c.json({ error: "blob not found" }, 404);
    // Cast: Bun types Uint8Array as <ArrayBufferLike>, which the DOM BodyInit
    // lib type doesn't accept directly though the runtime handles it fine.
    return new Response(blob.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": found.contentType || blob.contentType,
        "Content-Disposition": `attachment; filename="${(found.filename || blob.filename).replace(/"/g, "")}"`,
        "Content-Length": String(blob.data.byteLength),
      },
    });
  });

  // Per-issue list: GET /api/attachments?issue_id=<uuid> (Go ListAttachments).
  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const issueId = c.req.query("issue_id");
    if (!issueId || !UUID_RE.test(issueId)) {
      return c.json({ error: "issue_id query param required" }, 400);
    }
    const attachments = await listAttachmentsByIssue(db, ws, issueId);
    return c.json(attachments.map(attachmentToResponse));
  });

  // Single by id: GET /api/attachments/:id (Go GetAttachmentByID).
  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid attachment id" }, 400);

    const found = await getAttachment(db, ws, id);
    if (!found) return c.json({ error: "attachment not found" }, 404);
    return c.json(attachmentToResponse(found));
  });

  return r;
}
