import type { Hono } from "hono";
import {
  MAX_UPLOAD_SIZE,
  createUploadAttachmentId,
  currentWorkspaceRole,
  denyAttachmentAccess,
  denyCurrentUserWorkspaceAccess,
  denyCurrentUserCommentAccess,
  detectContentTypeFromFilename,
  loadChatSessionForCurrentUser,
  localAttachmentFileResponse,
  readJson,
  safeFilename,
  stringFormValue,
  uploadAbsolutePath,
  uploadRelativePath,
  uploadedAttachmentPath,
} from "../helpers.js";
import { attachmentCompatibilityResponse, cleanString, currentRequestUserId } from "../wire/index.js";
import type { CreateAttachmentInput } from "@multiremi/contracts/types.js";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouterDeps } from "./deps.js";

export function registerAttachmentRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    return c.json({ attachment });
  });
  app.post("/api/multiremi/attachments", async (c) => {
    const body = await readJson<CreateAttachmentInput>(c);
    const commentId = cleanString(body.commentId ?? body.comment_id);
    if (commentId) {
      const denied = denyCurrentUserCommentAccess(c, store, commentId);
      if (denied) return denied;
    }
    const workspaceId = cleanString(body.workspaceId) ?? cleanString(body.workspace_id) ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ attachment: store.createAttachment(body) }, 201);
  });

  app.post("/api/upload-file", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file field" }, 400);
    if (file.size > MAX_UPLOAD_SIZE) return c.json({ error: "file too large" }, 413);
    const issueRef = stringFormValue(form.get("issueId") ?? form.get("issue_id"));
    const issue = issueRef ? store.getIssueByRef(issueRef) : null;
    if (issueRef && !issue) return c.json({ error: "invalid issue_id" }, 403);
    const commentId = stringFormValue(form.get("commentId") ?? form.get("comment_id"));
    const comment = commentId ? store.getIssueComment(commentId) : null;
    if (commentId && !comment) return c.json({ error: "invalid comment_id" }, 403);
    if (commentId) {
      const denied = denyCurrentUserCommentAccess(c, store, commentId);
      if (denied) return denied;
    }
    if (issue && comment && comment.issueId !== issue.id) return c.json({ error: "invalid comment_id" }, 403);
    const chatSessionId = stringFormValue(form.get("chatSessionId") ?? form.get("chat_session_id"));
    const chatSession = chatSessionId ? loadChatSessionForCurrentUser(c, store, chatSessionId) : null;
    if (chatSession instanceof Response) return chatSession;
    const workspaceId = issue?.workspaceId
      ?? (comment ? store.getIssue(comment.issueId)?.workspaceId : null)
      ?? (chatSession ? chatSession.session.workspaceId : null)
      ?? stringFormValue(form.get("workspaceId") ?? form.get("workspace_id"))
      ?? c.req.header("X-Workspace-ID")
      ?? "local";
    // Go file.go UploadFile validates workspace membership before writing. The chat
    // path is already gated by loadChatSessionForCurrentUser; gate every other path
    // so a token scoped to another workspace cannot create rows/files in this one.
    const uploadDenied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (uploadDenied) return uploadDenied;
    const uploaderType = stringFormValue(form.get("uploaderType") ?? form.get("uploader_type")) ?? "member";
    const uploaderId = stringFormValue(form.get("uploaderId") ?? form.get("uploader_id")) ?? "local";
    const attachmentId = createUploadAttachmentId();
    const safeName = safeFilename(file.name || "upload.bin");
    const relativePath = uploadRelativePath(workspaceId, attachmentId, safeName);
    const absolutePath = uploadAbsolutePath(relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, new Uint8Array(await file.arrayBuffer()));
    const attachment = store.createAttachment({
      id: attachmentId,
      workspaceId,
      issueId: issue?.id ?? comment?.issueId ?? null,
      commentId,
      chatSessionId: chatSession?.session.id ?? null,
      uploaderType,
      uploaderId,
      filename: safeName,
      url: `/api/attachments/${attachmentId}/content`,
      contentType: file.type || detectContentTypeFromFilename(safeName),
      sizeBytes: file.size,
    });
    return c.json({ attachment, ...attachmentCompatibilityResponse(attachment) });
  });

  app.get("/api/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    return c.json({ attachment, ...attachmentCompatibilityResponse(attachment) });
  });

  app.get("/api/attachments/:id/download", async (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    if (!attachment.url.startsWith("/api/attachments/")) {
      return c.redirect(attachment.url);
    }
    return localAttachmentFileResponse(attachment);
  });

  app.get("/api/attachments/:id/content", async (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    if (!attachment.url.startsWith("/api/attachments/")) {
      return c.redirect(attachment.url);
    }
    return localAttachmentFileResponse(attachment);
  });

  app.delete("/api/attachments/:id", async (c) => {
    const existing = store.getAttachment(c.req.param("id"));
    if (!existing) return c.json({ ok: true });
    const denied = denyAttachmentAccess(c, store, existing);
    if (denied) return denied;
    // Go file.go DeleteAttachment: only the uploader or a workspace admin/owner may
    // delete a non-chat attachment. Chat attachments are already creator-gated by
    // denyAttachmentAccess above (the creator is the uploader).
    if (!existing.chatSessionId) {
      const role = currentWorkspaceRole(c, store, existing.workspaceId);
      const isUploader = existing.uploaderType === "member" && existing.uploaderId === currentRequestUserId(c);
      const isAdmin = role === "owner" || role === "admin";
      if (!isUploader && !isAdmin) {
        return c.json({ error: "not authorized to delete this attachment" }, 403);
      }
    }
    const attachment = store.deleteAttachment(c.req.param("id"));
    if (!attachment) return c.json({ ok: true });
    if (attachment.url.startsWith("/api/attachments/")) {
      const filePath = uploadedAttachmentPath(attachment);
      if (filePath) await unlink(filePath).catch(() => undefined);
    }
    return c.json({ ok: true, attachment });
  });
}
