import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import type { Hono } from "hono";
import {
  MAX_UPLOAD_SIZE,
  createUploadAttachmentId,
  currentWorkspaceRole,
  denyAttachmentAccess,
  denyAttachmentCreationAccess,
  denyCurrentUserCommentAccess,
  detectContentTypeFromFilename,
  loadChatSessionForCurrentUser,
  issueMutationActor,
  localAttachmentFileResponse,
  readJson,
  safeFilename,
  stringFormValue,
  uploadAbsolutePath,
  uploadRelativePath,
  uploadedAttachmentPath,
} from "../helpers.js";
import { attachmentCompatibilityResponse, cleanString } from "../wire/index.js";
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
    const issueId = cleanString(body.issueId ?? body.issue_id);
    const commentId = cleanString(body.commentId ?? body.comment_id);
    const chatSessionId = cleanString(body.chatSessionId ?? body.chat_session_id);
    const chatMessageId = cleanString(body.chatMessageId ?? body.chat_message_id);
    const comment = commentId ? store.getIssueComment(commentId) : null;
    const chatMessage = chatMessageId ? store.getChatMessage(chatMessageId) : null;
    const explicitWorkspaceId = cleanString(body.workspaceId) ?? cleanString(body.workspace_id)
      ?? (issueId ? store.getIssue(issueId)?.workspaceId : null)
      ?? (comment ? store.getIssue(comment.issueId)?.workspaceId : null)
      ?? (chatSessionId ? store.getChatSession(chatSessionId)?.workspaceId : null)
      ?? (chatMessage ? store.getChatSession(chatMessage.chatSessionId)?.workspaceId : null);
    const workspaceId = resolveRequestWorkspaceId(c, store, explicitWorkspaceId);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyAttachmentCreationAccess(c, store, workspaceId, body);
    if (denied) return denied;
    const { actorType: uploaderType, actorId: uploaderId } = issueMutationActor(c, {
      actorType: body.uploaderType ?? body.uploader_type,
      actorId: body.uploaderId ?? body.uploader_id,
    });
    return c.json({ attachment: store.createAttachment({ ...body, workspaceId, uploaderType, uploaderId }) }, 201);
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
    const explicitWorkspaceId = issue?.workspaceId
      ?? (comment ? store.getIssue(comment.issueId)?.workspaceId : null)
      ?? (chatSession ? chatSession.session.workspaceId : null)
      ?? stringFormValue(form.get("workspaceId") ?? form.get("workspace_id"));
    const workspaceId = resolveRequestWorkspaceId(c, store, explicitWorkspaceId);
    if (workspaceId instanceof Response) return workspaceId;
    // All supplied references must belong to the authorized workspace before
    // writing a file, even when the caller can access each resource separately.
    const uploadDenied = denyAttachmentCreationAccess(c, store, workspaceId, {
      issueId: issue?.id ?? comment?.issueId ?? null,
      commentId,
      chatSessionId: chatSession?.session.id ?? null,
    });
    if (uploadDenied) return uploadDenied;
    const { actorType: uploaderType, actorId: uploaderId } = issueMutationActor(c, {
      actorType: stringFormValue(form.get("uploaderType") ?? form.get("uploader_type")) ?? undefined,
      actorId: stringFormValue(form.get("uploaderId") ?? form.get("uploader_id")),
    });
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
      const caller = issueMutationActor(c);
      const isUploader = existing.uploaderType === caller.actorType && existing.uploaderId === caller.actorId;
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
