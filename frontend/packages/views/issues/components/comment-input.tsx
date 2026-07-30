"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Reply, X } from "lucide-react";
import { ContentEditor, type ContentEditorRef, useFileDropZone, FileDropOverlay } from "../../editor";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { SubmitButton } from "@multiremi/ui/components/common/submit-button";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { api } from "@multiremi/core/api";
import type { Attachment } from "@multiremi/core/types";
import { enterKey, formatShortcut, modKey } from "@multiremi/core/platform";
import { useCommentDraftStore } from "@multiremi/core/issues/stores";
import { useT } from "../../i18n";

/**
 * The message this composer is answering. The session stream has one composer,
 * so "reply" is a context it carries rather than a second input: set by a
 * message row's toolbar, shown as a chip above the editor, cleared on send or
 * on ×. `strippedPreview` is plain text (see `quotePreview`) — the chip is one
 * line and raw markdown would spend it on link targets.
 */
interface ReplyTarget {
  commentId: string;
  authorLabel: string;
  strippedPreview: string;
}

interface CommentInputProps {
  issueId: string;
  onSubmit: (content: string, attachmentIds?: string[]) => Promise<void>;
  /**
   * Names the session the comment will land in ("Comment in Review…").
   * Falls back to the generic prompt while no session is resolved yet —
   * a placeholder that names nothing beats one that names the wrong thing.
   */
  placeholder?: string;
  /** When set, the next send lands as a reply to this message. */
  replyTo?: ReplyTarget | null;
  /** Clears `replyTo` — the next send goes back to being a new message. */
  onCancelReply?: () => void;
}

function CommentInput({ issueId, onSubmit, placeholder, replyTo, onCancelReply }: CommentInputProps) {
  const { t } = useT("issues");
  const editorRef = useRef<ContentEditorRef>(null);
  // Read the persisted draft once on mount. ContentEditor only honors
  // `defaultValue` at mount time, so this snapshot drives both the editor's
  // initial content and the submit-button enable state — without this the
  // button would be disabled even though the editor visibly contains text.
  const draftKey = `new:${issueId}` as const;
  const initialDraft = useCommentDraftStore.getState().getDraft(draftKey);
  const [isEmpty, setIsEmpty] = useState(() => !initialDraft?.trim());
  const [submitting, setSubmitting] = useState(false);
  // Attachments uploaded in this composer session. Drives both:
  //  - submit-time `attachment_ids` payload (filtered to URLs still in markdown)
  //  - the editor's AttachmentDownloadProvider, so file-card Eye buttons can
  //    resolve text/code/markdown previews that require the attachment id.
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const { uploadWithToast } = useFileUpload(api);
  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => editorRef.current?.uploadFile(f)),
  });

  // Draft persistence. Hydrate from store on mount via `defaultValue` above
  // (ContentEditorRef has no setContent, so this is the only injection point).
  // Flush on every onUpdate (debounced upstream) + visibilitychange/pagehide
  // so tab close / mobile background doesn't lose work. Cleared on submit.
  const setDraft = useCommentDraftStore((s) => s.setDraft);
  const clearDraft = useCommentDraftStore((s) => s.clearDraft);
  useEffect(() => {
    const flush = () => {
      const md = editorRef.current?.getMarkdown();
      if (md && md.trim().length > 0) setDraft(draftKey, md);
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, [draftKey, setDraft]);

  const handleUpload = useCallback(async (file: File) => {
    const result = await uploadWithToast(file, { issueId });
    if (result) {
      setPendingAttachments((prev) => [...prev, result]);
    }
    return result;
  }, [uploadWithToast, issueId]);

  const handleSubmit = async () => {
    const content = editorRef.current?.getMarkdown()?.replace(/(\n\s*)+$/, "").trim();
    if (!content || submitting) return;
    // Only send attachment IDs for uploads still present in the content.
    const activeIds = pendingAttachments
      .filter((a) => content.includes(a.url))
      .map((a) => a.id);
    setSubmitting(true);
    try {
      await onSubmit(content, activeIds.length > 0 ? activeIds : undefined);
      editorRef.current?.clearContent();
      setIsEmpty(true);
      setPendingAttachments([]);
      clearDraft(draftKey);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      {...dropZoneProps}
      className="relative flex flex-col rounded-lg bg-card pb-8 ring-1 ring-border"
    >
      {replyTo && (
        <div className="flex min-w-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
          <Reply className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => $.comment.parent_ref, {
              author: replyTo.authorLabel,
              preview: replyTo.strippedPreview,
            })}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label={t(($) => $.comment.cancel_reply_aria)}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        <ContentEditor
          ref={editorRef}
          defaultValue={initialDraft}
          placeholder={placeholder ?? t(($) => $.comment.leave_comment_placeholder)}
          onUpdate={(md) => {
            setIsEmpty(!md.trim());
            // Debounced upstream (debounceMs=100). Persist on every tick so a
            // reload or scroll-out-of-viewport restores work to the keystroke.
            if (md.trim().length > 0) setDraft(draftKey, md);
            else clearDraft(draftKey);
          }}
          onSubmit={handleSubmit}
          onUploadFile={handleUpload}
          debounceMs={100}
          currentIssueId={issueId}
          attachments={pendingAttachments}
        />
      </div>
      <div className="absolute bottom-1 right-1.5 flex items-center gap-1">
        <FileUploadButton
          size="sm"
          multiple
          onSelect={(file) => editorRef.current?.uploadFile(file)}
        />
        <SubmitButton
          onClick={handleSubmit}
          disabled={isEmpty}
          loading={submitting}
          tooltip={`${t(($) => $.comment.send_tooltip)} · ${formatShortcut(modKey, enterKey)}`}
        />
      </div>
      {isDragOver && <FileDropOverlay />}
    </div>
  );
}

export { CommentInput, type ReplyTarget };
