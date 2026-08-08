// Wire serializers for the attachments domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type { MultiremiAttachment } from "@multiremi/contracts/types.js";

export function issueDetailAttachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    issue_id: attachment.issueId,
    comment_id: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: `/api/attachments/${attachment.id}/download`,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
  };
}

export function attachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  const downloadUrl = `/api/attachments/${attachment.id}/download`;
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    workspaceId: attachment.workspaceId,
    issue_id: attachment.issueId,
    issueId: attachment.issueId,
    comment_id: attachment.commentId,
    commentId: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chatSessionId: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    chatMessageId: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploaderType: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    uploaderId: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: downloadUrl,
    downloadUrl,
    content_type: attachment.contentType,
    contentType: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    sizeBytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
    createdAt: attachment.createdAt,
  };
}

export function chatAttachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    issue_id: attachment.issueId,
    comment_id: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: `/api/attachments/${attachment.id}/download`,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
  };
}
